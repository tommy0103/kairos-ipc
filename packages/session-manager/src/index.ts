import { createCorrelationId, type EndpointUri } from "../../protocol/src/index.ts";
import { createNode, IpcCallError, type IpcNode } from "../../sdk/src/index.ts";
import {
  barrierIsSatisfied,
  createEmptyCollaborationState,
  reduceCollaborationEvent,
  renderForAgent,
  sourceRefKey,
  type Artifact,
  type CollaborationEvent,
  type CollaborationState,
  type Delegation,
  type ReplyBarrier,
  type SourceRef,
  type Task,
} from "../../collaboration-context/src/index.ts";
import {
  SLOCK_AGENT_RUN_MIME,
  SLOCK_PROJECTION_MIME,
  type SlockAgentResult,
  type SlockAgentRun,
  type SlockAgentRunEvent,
  type SlockCancelAgentRunRequest,
  type SlockCancelAgentRunResult,
  type SlockMessage,
  type SlockProjectionInput,
} from "../../slock-channel/src/index.ts";
import {
  KAIROS_SESSION_MANAGER_URI,
  KAIROS_SESSION_ROUTE_MIME,
  KAIROS_SESSION_STATE_MIME,
  type SessionManagerAttachSourceRequest,
  type SessionManagerRenderContextRequest,
  type SessionManagerResolveRequest,
  type SessionManagerResolveResult,
  type SessionManagerRouteMessageRequest,
  type SessionManagerRouteMessageResult,
  type SessionManagerSessionSnapshot,
  type SessionManagerSubmitArtifactRequest,
} from "./types.ts";

export * from "./types.ts";

export interface SessionManagerOptions {
  uri?: EndpointUri;
  default_agent_ttl_ms?: number;
  coordinator_uri?: EndpointUri;
}

export interface SessionRecord {
  id: string;
  uri: EndpointUri;
  events: CollaborationEvent[];
  state: CollaborationState;
}

export interface SessionManagerEndpoint {
  node: IpcNode;
  sessions: Map<string, SessionRecord>;
  getSession(id: string): SessionRecord | undefined;
}

interface ActiveSessionRun {
  session_id: string;
  delegation_id: string;
  agent: EndpointUri;
  message: SlockMessage;
  correlation_id: string;
  started_at: string;
  cancel_requested?: boolean;
  reason?: string;
}

const DEFAULT_AGENT_TTL_MS = 600000;

export function createSessionManager(options: SessionManagerOptions = {}): SessionManagerEndpoint {
  const uri = options.uri ?? KAIROS_SESSION_MANAGER_URI;
  const node = createNode(uri);
  const sessions = new Map<string, SessionRecord>();
  const sourceIndex = new Map<string, string>();
  const threadIndex = new Map<string, string>();
  const activeRunsByMessage = new Map<string, Map<EndpointUri, ActiveSessionRun>>();
  const agentTtlMs = options.default_agent_ttl_ms ?? DEFAULT_AGENT_TTL_MS;
  let eventCounter = 1;
  let artifactCounter = 1;

  node.action<SessionManagerRouteMessageRequest, SessionManagerRouteMessageResult>(
    "create_or_attach_session",
    {
      description: "Create or attach a collaboration session for a human-facing Slock message, then route explicit agent delegations.",
      accepts: ["application/json", KAIROS_SESSION_ROUTE_MIME],
      returns: KAIROS_SESSION_ROUTE_MIME,
    },
    async (payload) => {
      const request = readRouteMessageRequest(payload.data);
      const message = request.message;
      const sourceRef = messageSourceRef(message);
      let record = resolveMessageSession(message);
      const created = !record;
      if (!record) {
        record = createSessionForMessage(message, sourceRef);
      } else {
        attachSource(record, sourceRef, "message attached to collaboration session");
      }
      indexMessage(record.id, message, sourceRef);

      const agents = uniqueAgentUris(request.mentions ?? message.mentions);
      const createdDelegations = message.kind === "human" && agents.length > 0
        ? createDelegationsForMessage(record, message, sourceRef, agents)
        : { delegationIds: [], barrierId: undefined };

      for (const delegationId of createdDelegations.delegationIds) {
        void runDelegation(record.id, delegationId, message);
      }

      return {
        mime_type: KAIROS_SESSION_ROUTE_MIME,
        data: {
          session_id: record.id,
          session_uri: record.uri,
          created,
          attached: !created,
          source_ref: sourceRef,
          delegations_created: createdDelegations.delegationIds,
          barrier_id: createdDelegations.barrierId,
        },
      };
    },
  );

  node.action<SessionManagerResolveRequest, SessionManagerResolveResult>(
    "resolve_session",
    {
      description: "Resolve the collaboration session that owns a source ref, channel message, or Slock thread.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readResolveRequest(payload.data);
      const sessionId = resolveSessionId(request);
      return {
        mime_type: "application/json",
        data: sessionId ? { session_id: sessionId, session_uri: sessionUri(sessionId) } : {},
      };
    },
  );

  node.action<SessionManagerAttachSourceRequest, SessionManagerSessionSnapshot>(
    "attach_source",
    {
      description: "Attach a source ref or Slock message to an existing collaboration session.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload) => {
      const request = readAttachSourceRequest(payload.data);
      const sourceRef = request.source_ref ?? (request.message ? messageSourceRef(request.message) : undefined);
      if (!sourceRef) {
        throw new Error("attach_source requires source_ref or message");
      }
      const sessionId = request.session_id ?? resolveSessionId({ source_ref: sourceRef }) ?? (request.message ? resolveMessageSession(request.message)?.id : undefined);
      const record = requiredSession(sessionId);
      attachSource(record, sourceRef, request.reason);
      if (request.message) {
        indexMessage(record.id, request.message, sourceRef);
      } else {
        sourceIndex.set(sourceRefKey(sourceRef), record.id);
      }
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerRenderContextRequest>(
    "render_context",
    {
      description: "Render audience-specific collaboration context for an agent run.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readRenderContextRequest(payload.data);
      const record = requiredSession(request.session_id);
      return {
        mime_type: "application/json",
        data: renderForAgent(record.state, request),
      };
    },
  );

  node.action<SessionManagerSubmitArtifactRequest, SessionManagerSessionSnapshot>(
    "submit_artifact",
    {
      description: "Submit a structured artifact to a collaboration session and update waiting barriers.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload, context) => {
      const request = readSubmitArtifactRequest(payload.data);
      const record = requiredSession(request.session_id);
      const artifact = normalizeSubmittedArtifact(record, request, context.envelope.header.source);
      const artifactEvent = appendEvent(record, {
        type: "artifact_submitted",
        artifact,
        delegation_id: request.delegation_id,
      });
      updateBarriersForArtifact(record, artifact, request.delegation_id, artifactEvent.at);
      if (request.project !== false) {
        void projectArtifact(record, artifact, artifactEvent.id, originMessageRef(record.state));
      }
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<{ session_id: string }, SessionManagerSessionSnapshot>(
    "get_session_state",
    {
      description: "Return a collaboration session's append-only events and current reduced state.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload) => {
      const sessionId = readSessionId(payload.data);
      const record = requiredSession(sessionId);
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<unknown, { sessions: Array<{ session_id: string; session_uri: EndpointUri; status?: string }> }>(
    "list_sessions",
    {
      description: "List collaboration sessions currently owned by this session manager.",
      accepts: "application/json",
      returns: "application/json",
    },
    async () => ({
      mime_type: "application/json",
      data: {
        sessions: [...sessions.values()].map((record) => ({
          session_id: record.id,
          session_uri: record.uri,
          status: record.state.session?.status,
        })),
      },
    }),
  );

  node.action<SlockCancelAgentRunRequest, SlockCancelAgentRunResult>(
    "cancel_agent_run",
    {
      description: "Cancel active agent delegations that were started from a Slock message.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readCancelAgentRunRequest(payload.data);
      const runs = activeRunsByMessage.get(request.message_id);
      if (!runs || runs.size === 0) {
        return {
          mime_type: "application/json",
          data: {
            cancelled: false,
            message_id: request.message_id,
            reason: "agent run is not active",
          },
        };
      }

      const reason = request.reason ?? "cancelled";
      const agents = [...runs.keys()];
      for (const [agent, run] of runs) {
        run.cancel_requested = true;
        run.reason = reason;
        const record = sessions.get(run.session_id);
        if (record) {
          appendEvent(record, {
            type: "agent_run_cancelled",
            session_id: run.session_id,
            correlation_id: run.correlation_id,
            reason,
          });
        }
        node.cancel(agent, { mime_type: "application/json", data: { message_id: request.message_id, reason } }, { correlation_id: run.correlation_id });
        void publishAgentCancelled(run.message.channel, { message_id: request.message_id, agent, reason });
      }

      return {
        mime_type: "application/json",
        data: {
          cancelled: true,
          message_id: request.message_id,
          agent: agents[0],
          ...(agents.length > 1 ? { agents } : {}),
          reason,
        },
      };
    },
  );

  return {
    node,
    sessions,
    getSession: (id) => sessions.get(id),
  };

  function createSessionForMessage(message: SlockMessage, sourceRef: SourceRef): SessionRecord {
    const id = sessionIdForMessage(message);
    const createdAt = new Date().toISOString();
    const record: SessionRecord = {
      id,
      uri: sessionUri(id),
      events: [],
      state: createEmptyCollaborationState(),
    };
    sessions.set(id, record);
    appendEvent(record, {
      type: "session_created",
      session: {
        id,
        origin: sourceRef,
        source_refs: [sourceRef],
        status: "open",
        created_at: createdAt,
      },
    }, createdAt);
    sourceIndex.set(sourceRefKey(sourceRef), id);
    return record;
  }

  function createDelegationsForMessage(
    record: SessionRecord,
    message: SlockMessage,
    sourceRef: SourceRef,
    agents: EndpointUri[],
  ): { delegationIds: string[]; barrierId?: string } {
    const at = new Date().toISOString();
    const task: Task = {
      id: `${idPrefix("task", message)}_${record.events.length + 1}`,
      session_id: record.id,
      title: taskTitle(message.text),
      owner: message.sender,
      status: "open",
      source_refs: [sourceRef],
    };
    appendEvent(record, { type: "task_created", task }, at);

    const delegationIds: string[] = [];
    agents.forEach((agent, index) => {
      const delegation: Delegation = {
        id: `${idPrefix("delegation", message)}_${index + 1}`,
        session_id: record.id,
        task_id: task.id,
        assignee: agent,
        instruction: delegationInstruction(message, agent),
        expected_output: "Submit a concise artifact that can stand alone in the collaboration session.",
        status: "pending",
        source_refs: [sourceRef],
      };
      delegationIds.push(delegation.id);
      appendEvent(record, { type: "delegation_created", delegation }, at);
    });

    if (delegationIds.length === 0) {
      return { delegationIds };
    }

    const barrier: ReplyBarrier = {
      id: `${idPrefix("barrier", message)}_1`,
      session_id: record.id,
      task_id: task.id,
      source_ref: sourceRef,
      owner: message.sender,
      expected_from: agents,
      notify: options.coordinator_uri ? [options.coordinator_uri] : [],
      mode: "all",
      status: "open",
      replies: {},
      created_at: at,
    };
    appendEvent(record, { type: "barrier_created", barrier }, at);
    return { delegationIds, barrierId: barrier.id };
  }

  async function runDelegation(sessionId: string, delegationId: string, message: SlockMessage): Promise<void> {
    const record = sessions.get(sessionId);
    const delegation = record?.state.delegations[delegationId];
    if (!record || !delegation) {
      return;
    }

    const correlationId = createCorrelationId("sess");
    const startedAt = new Date().toISOString();
    appendEvent(record, {
      type: "delegation_started",
      session_id: sessionId,
      delegation_id: delegationId,
      correlation_id: correlationId,
      started_at: startedAt,
    }, startedAt);

    const run: ActiveSessionRun = {
      session_id: sessionId,
      delegation_id: delegationId,
      agent: delegation.assignee,
      message,
      correlation_id: correlationId,
      started_at: startedAt,
    };
    rememberActiveRun(run);
    await publishAgentRun(message.channel, "publish_agent_run_started", {
      run_id: correlationId,
      message_id: message.id,
      thread_id: message.thread_id,
      agent: delegation.assignee,
      state: "started",
      started_at: startedAt,
    });

    try {
      const context = renderForAgent(record.state, {
        audience: delegation.assignee,
        purpose: "delegation",
        delegation_id: delegation.id,
      });
      const result = await node.call<SlockAgentRun, SlockAgentResult>(
        delegation.assignee,
        "run",
        {
          mime_type: SLOCK_AGENT_RUN_MIME,
          data: {
            channel: message.channel,
            message_id: message.id,
            run_id: correlationId,
            thread_id: message.thread_id,
            text: context.text,
            sender: message.sender,
            session_id: sessionId,
            delegation_id: delegation.id,
            purpose: "delegation",
            context_text: context.text,
            source_refs: context.source_refs,
            artifact_refs: context.artifact_refs,
            barrier_refs: context.barrier_refs,
          },
        },
        { correlation_id: correlationId, ttl_ms: agentTtlMs, timeout_ms: agentTtlMs },
      );

      const final = result.data;
      if (final.cancelled || run.cancel_requested) {
        if (!run.cancel_requested) {
          appendEvent(record, {
            type: "agent_run_cancelled",
            session_id: sessionId,
            correlation_id: correlationId,
            reason: final.reason,
          });
          await publishAgentCancelled(message.channel, { message_id: message.id, agent: delegation.assignee, reason: final.reason });
        }
        await publishAgentRun(message.channel, "publish_agent_run_finished", {
          run_id: correlationId,
          message_id: message.id,
          thread_id: message.thread_id,
          agent: delegation.assignee,
          state: "cancelled",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          reason: final.reason ?? run.reason,
        });
        return;
      }

      const artifact: Artifact = {
        id: nextArtifactId(record.id),
        session_id: sessionId,
        author: delegation.assignee,
        kind: "summary",
        title: `Response from ${labelFromUri(delegation.assignee)}`,
        content: {
          summary: final.summary,
          final_text: final.final_text ?? final.summary,
        },
        status: "submitted",
        relates_to: [delegation.id, delegation.task_id],
        source_refs: [{ kind: "ipc_envelope", correlation_id: correlationId }],
        created_at: new Date().toISOString(),
      };
      const artifactEvent = appendEvent(record, { type: "artifact_submitted", artifact, delegation_id: delegation.id });
      updateBarriersForArtifact(record, artifact, delegation.id, artifactEvent.at);
      const finalMessage = await projectArtifact(record, artifact, artifactEvent.id, messageSourceRef(message));
      await publishAgentRun(message.channel, "publish_agent_run_finished", {
        run_id: correlationId,
        message_id: message.id,
        thread_id: message.thread_id,
        agent: delegation.assignee,
        state: "completed",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        final_message_id: finalMessage?.id,
      });
    } catch (error) {
      const code = error instanceof IpcCallError ? error.code : "AGENT_RUN_FAILED";
      const messageText = error instanceof Error ? error.message : "agent run failed";
      if (run.cancel_requested) {
        await publishAgentRun(message.channel, "publish_agent_run_finished", {
          run_id: correlationId,
          message_id: message.id,
          thread_id: message.thread_id,
          agent: delegation.assignee,
          state: "cancelled",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          reason: run.reason,
        });
        return;
      }
      appendEvent(record, {
        type: "delegation_updated",
        session_id: sessionId,
        delegation_id: delegation.id,
        patch: { status: "failed", error: messageText, updated_at: new Date().toISOString() },
      });
      await publishAgentError(message.channel, { code, message: messageText, source: delegation.assignee });
      await publishAgentRun(message.channel, "publish_agent_run_finished", {
        run_id: correlationId,
        message_id: message.id,
        thread_id: message.thread_id,
        agent: delegation.assignee,
        state: "errored",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: { code, message: messageText },
      });
    } finally {
      forgetActiveRun(run);
    }
  }

  function appendEvent(
    record: SessionRecord,
    event: Omit<CollaborationEvent, "id" | "at">,
    at = new Date().toISOString(),
  ): CollaborationEvent {
    const next = { id: `event_${eventCounter++}`, at, ...event } as CollaborationEvent;
    record.events.push(next);
    record.state = reduceCollaborationEvent(record.state, next);
    return next;
  }

  function attachSource(record: SessionRecord, sourceRef: SourceRef, reason?: string): void {
    const key = sourceRefKey(sourceRef);
    if (sourceIndex.get(key) === record.id || record.state.source_refs.some((ref) => sourceRefKey(ref) === key)) {
      return;
    }
    appendEvent(record, { type: "source_attached", session_id: record.id, source_ref: sourceRef, reason });
    sourceIndex.set(key, record.id);
  }

  function updateBarriersForArtifact(record: SessionRecord, artifact: Artifact, delegationId: string | undefined, at = new Date().toISOString()): void {
    const delegation = delegationId ? record.state.delegations[delegationId] : undefined;
    const assignee = delegation?.assignee ?? artifact.author;
    const barriers = Object.values(record.state.barriers).filter((barrier) => {
      if (barrier.status !== "open") return false;
      if (!barrier.expected_from.includes(assignee)) return false;
      return !delegation || barrier.task_id === delegation.task_id;
    });

    for (const barrier of barriers) {
      appendEvent(record, {
        type: "barrier_updated",
        session_id: record.id,
        barrier_id: barrier.id,
        patch: {
          replies: { ...barrier.replies, [assignee]: artifact.id },
          updated_at: at,
        },
      }, at);
      const updated = record.state.barriers[barrier.id];
      if (updated && barrierIsSatisfied(updated)) {
        appendEvent(record, { type: "barrier_satisfied", session_id: record.id, barrier_id: barrier.id }, at);
      }
    }
  }

  async function projectArtifact(
    record: SessionRecord,
    artifact: Artifact,
    sourceEventId: string,
    sourceRef: SourceRef | undefined,
  ): Promise<{ id: string } | undefined> {
    const channelSource = sourceRef?.kind === "channel_message" ? sourceRef : originMessageRef(record.state);
    if (!channelSource) {
      return undefined;
    }
    const text = artifactText(artifact);
    if (!text.trim()) {
      return undefined;
    }

    try {
      const result = await node.call<SlockProjectionInput, { id: string }>(
        channelSource.channel,
        "publish_projection",
        {
          mime_type: SLOCK_PROJECTION_MIME,
          data: {
            sender: artifact.author,
            text,
            thread_id: channelSource.message_id,
            reply_to_id: channelSource.message_id,
            kind: artifact.author.startsWith("agent://") ? "agent" : "system",
            source_event_id: sourceEventId,
            title: artifact.title,
          },
        },
        { ttl_ms: 5000, timeout_ms: 5000 },
      );
      appendEvent(record, { type: "projection_emitted", session_id: record.id, target: channelSource.channel, source_event_id: sourceEventId });
      return result.data;
    } catch {
      return undefined;
    }
  }

  async function publishAgentRun(channel: EndpointUri, action: "publish_agent_run_started" | "publish_agent_run_finished", run: SlockAgentRunEvent): Promise<void> {
    try {
      await node.call(channel, action, { mime_type: "application/json", data: run }, { ttl_ms: 5000, timeout_ms: 5000 });
    } catch {
      // Channel projection is best effort; collaboration state remains the source of truth.
    }
  }

  async function publishAgentCancelled(channel: EndpointUri, cancelled: { message_id: string; agent: EndpointUri; reason?: string }): Promise<void> {
    try {
      await node.call(channel, "publish_agent_cancelled", { mime_type: "application/json", data: cancelled }, { ttl_ms: 5000, timeout_ms: 5000 });
    } catch {
      // Best effort UI projection.
    }
  }

  async function publishAgentError(channel: EndpointUri, error: { code: string; message: string; source: EndpointUri }): Promise<void> {
    try {
      await node.call(channel, "publish_agent_error", { mime_type: "application/json", data: error }, { ttl_ms: 5000, timeout_ms: 5000 });
    } catch {
      // Best effort UI projection.
    }
  }

  function resolveMessageSession(message: SlockMessage): SessionRecord | undefined {
    const direct = sourceIndex.get(sourceRefKey(messageSourceRef(message)));
    if (direct) return sessions.get(direct);
    const threadId = message.thread_id ?? message.reply_to_id;
    if (threadId) {
      const threadSessionId = threadIndex.get(threadKey(message.channel, threadId));
      if (threadSessionId) return sessions.get(threadSessionId);
    }
    return undefined;
  }

  function resolveSessionId(request: SessionManagerResolveRequest): string | undefined {
    if (request.source_ref) {
      return sourceIndex.get(sourceRefKey(request.source_ref));
    }
    if (request.channel && request.message_id) {
      return sourceIndex.get(sourceRefKey({ kind: "channel_message", channel: request.channel, message_id: request.message_id }));
    }
    if (request.channel && request.thread_id) {
      return threadIndex.get(threadKey(request.channel, request.thread_id));
    }
    return undefined;
  }

  function indexMessage(sessionId: string, message: SlockMessage, sourceRef: SourceRef): void {
    sourceIndex.set(sourceRefKey(sourceRef), sessionId);
    threadIndex.set(threadKey(message.channel, message.thread_id ?? message.id), sessionId);
    threadIndex.set(threadKey(message.channel, message.id), sessionId);
  }

  function requiredSession(sessionId: string | undefined): SessionRecord {
    if (!sessionId) {
      throw new Error("session_id is required");
    }
    const record = sessions.get(sessionId);
    if (!record) {
      throw new Error(`session not found: ${sessionId}`);
    }
    return record;
  }

  function snapshot(record: SessionRecord): SessionManagerSessionSnapshot {
    return {
      session_id: record.id,
      session_uri: record.uri,
      events: record.events,
      state: record.state,
    };
  }

  function rememberActiveRun(run: ActiveSessionRun): void {
    const runs = activeRunsByMessage.get(run.message.id) ?? new Map<EndpointUri, ActiveSessionRun>();
    activeRunsByMessage.set(run.message.id, runs);
    runs.set(run.agent, run);
  }

  function forgetActiveRun(run: ActiveSessionRun): void {
    const runs = activeRunsByMessage.get(run.message.id);
    runs?.delete(run.agent);
    if (runs?.size === 0) {
      activeRunsByMessage.delete(run.message.id);
    }
  }

  function nextArtifactId(sessionId: string): string {
    return `${sessionId}_artifact_${artifactCounter++}`;
  }
}

function readRouteMessageRequest(value: unknown): SessionManagerRouteMessageRequest {
  if (!isRecord(value) || !isSlockMessage(value.message)) {
    throw new Error("create_or_attach_session requires a Slock message");
  }
  return {
    message: value.message,
    mentions: Array.isArray(value.mentions) ? value.mentions.filter((item): item is EndpointUri => typeof item === "string") : undefined,
  };
}

function readResolveRequest(value: unknown): SessionManagerResolveRequest {
  if (!isRecord(value)) {
    return {};
  }
  return {
    source_ref: isSourceRef(value.source_ref) ? value.source_ref : undefined,
    channel: typeof value.channel === "string" ? value.channel : undefined,
    message_id: typeof value.message_id === "string" ? value.message_id : undefined,
    thread_id: typeof value.thread_id === "string" ? value.thread_id : value.thread_id === null ? null : undefined,
  };
}

function readAttachSourceRequest(value: unknown): SessionManagerAttachSourceRequest {
  if (!isRecord(value)) {
    throw new Error("attach_source requires an object payload");
  }
  return {
    session_id: typeof value.session_id === "string" ? value.session_id : undefined,
    message: isSlockMessage(value.message) ? value.message : undefined,
    source_ref: isSourceRef(value.source_ref) ? value.source_ref : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

function readRenderContextRequest(value: unknown): SessionManagerRenderContextRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || typeof value.audience !== "string") {
    throw new Error("render_context requires session_id and audience");
  }
  const purpose = value.purpose === "synthesis" || value.purpose === "review" || value.purpose === "handoff" ? value.purpose : "delegation";
  return {
    session_id: value.session_id,
    audience: value.audience,
    purpose,
    delegation_id: typeof value.delegation_id === "string" ? value.delegation_id : undefined,
  };
}

function readSubmitArtifactRequest(value: unknown): SessionManagerSubmitArtifactRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || !isRecord(value.artifact)) {
    throw new Error("submit_artifact requires session_id and artifact");
  }
  if (typeof value.artifact.author !== "string" || typeof value.artifact.kind !== "string" || !("content" in value.artifact)) {
    throw new Error("submit_artifact artifact requires author, kind, and content");
  }
  return {
    session_id: value.session_id,
    delegation_id: typeof value.delegation_id === "string" ? value.delegation_id : undefined,
    artifact: value.artifact as SessionManagerSubmitArtifactRequest["artifact"],
    project: value.project === false ? false : undefined,
  };
}

function readCancelAgentRunRequest(value: unknown): SlockCancelAgentRunRequest {
  if (!isRecord(value) || typeof value.message_id !== "string" || value.message_id.trim().length === 0) {
    throw new Error("cancel_agent_run requires message_id");
  }
  return {
    message_id: value.message_id,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

function readSessionId(value: unknown): string {
  if (!isRecord(value) || typeof value.session_id !== "string" || value.session_id.trim().length === 0) {
    throw new Error("session_id is required");
  }
  return value.session_id;
}

function normalizeSubmittedArtifact(
  record: SessionRecord,
  request: SessionManagerSubmitArtifactRequest,
  source: EndpointUri,
): Artifact {
  const artifact = request.artifact;
  return {
    id: typeof artifact.id === "string" ? artifact.id : `${record.id}_artifact_external_${Date.now()}`,
    session_id: record.id,
    author: artifact.author ?? source,
    kind: artifact.kind,
    title: artifact.title,
    content: artifact.content,
    status: artifact.status ?? "submitted",
    relates_to: artifact.relates_to,
    source_refs: artifact.source_refs ?? [],
    created_at: artifact.created_at ?? new Date().toISOString(),
  };
}

function messageSourceRef(message: SlockMessage): SourceRef {
  return { kind: "channel_message", channel: message.channel, message_id: message.id };
}

function originMessageRef(state: CollaborationState): Extract<SourceRef, { kind: "channel_message" }> | undefined {
  const origin = state.session?.origin;
  return origin?.kind === "channel_message" ? origin : undefined;
}

function sessionUri(sessionId: string): EndpointUri {
  return `app://kairos/session/${encodeURIComponent(sessionId)}`;
}

function sessionIdForMessage(message: SlockMessage): string {
  return `session_${slug(`${message.channel}_${message.id}`)}`;
}

function idPrefix(prefix: string, message: SlockMessage): string {
  return `${prefix}_${slug(`${message.channel}_${message.id}`)}`;
}

function threadKey(channel: EndpointUri, threadId: string): string {
  return `${channel}:${threadId}`;
}

function uniqueAgentUris(uris: EndpointUri[]): EndpointUri[] {
  return [...new Set(uris.filter((uri) => uri.startsWith("agent://")))];
}

function taskTitle(text: string): string {
  const stripped = stripMentions(text).replace(/\s+/g, " ").trim();
  if (!stripped) return "Agent collaboration task";
  return stripped.length > 72 ? `${stripped.slice(0, 69)}...` : stripped;
}

function delegationInstruction(message: SlockMessage, agent: EndpointUri): string {
  const request = stripMentions(message.text) || message.text;
  return [
    `You are responsible for the part of this collaboration assigned to ${agent}.`,
    "Use the session context as the source of truth. Return a self-contained artifact for your delegation.",
    "",
    `Human request:\n${request}`,
  ].join("\n");
}

function artifactText(artifact: Artifact): string {
  const content = artifact.content;
  if (typeof content === "string") return content;
  if (isRecord(content)) {
    if (typeof content.final_text === "string") return content.final_text;
    if (typeof content.text === "string") return content.text;
    if (typeof content.summary === "string") return content.summary;
  }
  try {
    return JSON.stringify(content, null, 2) ?? "";
  } catch {
    return String(content);
  }
}

function stripMentions(text: string): string {
  return text.replace(/(^|\s)@\S+/g, " ").trim();
}

function labelFromUri(uri: EndpointUri): string {
  const parts = uri.split("/").filter(Boolean);
  return decodeURIComponent(parts.at(-1) ?? uri);
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "session";
}

function isSlockMessage(value: unknown): value is SlockMessage {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.channel === "string"
    && typeof value.sender === "string"
    && typeof value.text === "string"
    && Array.isArray(value.mentions)
    && (value.kind === "human" || value.kind === "agent" || value.kind === "system");
}

function isSourceRef(value: unknown): value is SourceRef {
  return isRecord(value) && typeof value.kind === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
