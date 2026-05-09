import { createCorrelationId, type EndpointUri, type EnvelopePayload } from "../../protocol/src/index.ts";
import { createNode, IpcCallError, type IpcNode } from "../../sdk/src/index.ts";
import { inferMentions, type MentionAliases } from "./mentions.ts";
import {
  SLOCK_AGENT_RESULT_MIME,
  SLOCK_AGENT_RUN_MIME,
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_DELTA_MIME,
  SLOCK_MESSAGE_MIME,
  SLOCK_PROJECTION_MIME,
  type SlockAgentResult,
  type SlockAgentRun,
  type SlockAgentRunEvent,
  type SlockApprovalEvent,
  type SlockApprovalResult,
  type SlockCancelAgentRunRequest,
  type SlockCancelAgentRunResult,
  type SlockChannelEvent,
  type SlockHistoryRequest,
  type SlockHistoryResult,
  type SlockMessage,
  type SlockMessageInput,
  type SlockMessageUpdateInput,
  type SlockProjectionInput,
  type SlockSubscriptionClosedInput,
  type SlockTypingStartedInput,
} from "./types.ts";

export interface SlockChannelOptions {
  uri: EndpointUri;
  mention_aliases?: MentionAliases;
  default_mentions?: EndpointUri[];
  history_limit?: number;
  default_agent_ttl_ms?: number;
  session_manager_uri?: EndpointUri;
}

export interface SlockChannelEndpoint {
  node: IpcNode;
  messages: SlockMessage[];
  subscribers: Set<EndpointUri>;
}

export function createSlockChannel(options: SlockChannelOptions): SlockChannelEndpoint {
  const node = createNode(options.uri);
  const messages: SlockMessage[] = [];
  const subscribers = new Set<EndpointUri>();
  const subscriptionCorrelations = new Map<EndpointUri, string | undefined>();
  const activeRuns = new Map<string, Map<EndpointUri, { correlation_id: string; started_at: string; cancel_requested?: boolean; reason?: string }>>();
  const mentionAliases = options.mention_aliases ?? {};
  const defaultMentions = uniqueAgentUris(options.default_mentions ?? []);
  const historyLimit = options.history_limit ?? 100;
  const agentTtlMs = options.default_agent_ttl_ms ?? 600000;
  let nextMessageId = 1;

  node.action(
    "subscribe",
    {
      description: "Subscribe to channel events.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (_payload, context) => {
      const subscriber = context.envelope.header.reply_to ?? context.envelope.header.source;
      subscribers.add(subscriber);
      subscriptionCorrelations.set(subscriber, context.envelope.header.correlation_id);
      return { mime_type: "application/json", data: { subscribed: true, channel: options.uri } };
    },
  );

  node.action<SlockHistoryRequest, SlockHistoryResult>(
    "history",
    {
      description: "Return recent channel messages.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readHistoryRequest(payload.data, 50);
      return { mime_type: "application/json", data: { messages: selectHistory(request) } };
    },
  );

  node.action<SlockMessageInput>(
    "post_message",
    {
      description: "Append a message and trigger mention routing.",
      accepts: SLOCK_MESSAGE_MIME,
      returns: SLOCK_MESSAGE_MIME,
    },
    async (payload, context) => {
      const input = payload.data;
      const threadId = input.thread_id ?? null;
      const kind: SlockMessage["kind"] = context.envelope.header.source.startsWith("agent://") ? "agent" : "human";
      const inferredMentions = inferMentions(input.text, input.mentions, mentionAliases);
      const threadMentions = inferredMentions.length > 0 ? [] : inferThreadMentions(threadId);
      const mentions = inferredMentions.length > 0
        ? inferredMentions
        : threadMentions.length > 0
          ? threadMentions
          : kind === "human"
            ? defaultMentions
            : [];
      const message = appendMessage({
        sender: context.envelope.header.source,
        text: input.text,
        mentions,
        thread_id: threadId,
        reply_to_id: input.reply_to_id ?? threadId,
        kind,
      });

      broadcast("message_created", { message });

      if (options.session_manager_uri && kind === "human") {
        void routeMessageToSessionManager(message, {
          session_id: input.session_id,
          new_session: input.new_session,
        });
      } else {
        for (const agentUri of message.mentions) {
          void runMentionedAgent(agentUri, message);
        }
      }

      return { mime_type: SLOCK_MESSAGE_MIME, data: message };
    },
  );

  node.action<SlockProjectionInput, SlockMessage>(
    "publish_projection",
    {
      description: "Append a session-owned projection into the channel without mention routing.",
      accepts: SLOCK_PROJECTION_MIME,
      returns: SLOCK_MESSAGE_MIME,
    },
    async (payload) => {
      const projection = readProjectionInput(payload.data);
      const message = appendMessage({
        sender: projection.sender,
        text: projection.text,
        mentions: [],
        thread_id: projection.thread_id ?? null,
        reply_to_id: projection.reply_to_id ?? projection.thread_id ?? null,
        kind: projection.kind ?? (projection.sender.startsWith("agent://") ? "agent" : "system"),
        projection: {
          presentation: projection.presentation ?? "message",
          source_event_id: projection.source_event_id,
          title: projection.title,
          author: projection.author ?? projection.sender,
          session_id: projection.session_id,
          artifact_id: projection.artifact_id,
        },
      });

      broadcast("message_created", { message });
      return { mime_type: SLOCK_MESSAGE_MIME, data: message };
    },
  );

  node.action<SlockMessageUpdateInput>(
    "update_message",
    {
      description: "Update a channel message and broadcast message_updated.",
      accepts: "application/json",
      returns: SLOCK_MESSAGE_MIME,
    },
    async (payload) => {
      const request = readMessageUpdate(payload.data);
      const message = messages.find((message) => message.id === request.message_id);
      if (!message) {
        throw new Error(`message not found: ${request.message_id}`);
      }

      message.text = request.text;
      message.updated_at = new Date().toISOString();
      broadcast("message_updated", { message });
      return { mime_type: SLOCK_MESSAGE_MIME, data: message };
    },
  );

  node.action<SlockTypingStartedInput>(
    "typing_started",
    {
      description: "Broadcast that an endpoint started typing in this channel.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload, context) => {
      const request = readTypingStarted(payload.data);
      broadcast("typing_started", {
        typing: {
          source: context.envelope.header.source,
          thread_id: request.thread_id ?? null,
        },
      });
      return { mime_type: "application/json", data: { typing: true, channel: options.uri } };
    },
  );

  node.action<SlockSubscriptionClosedInput>(
    "unsubscribe",
    {
      description: "Close a channel subscription and send subscription_closed as a terminal event.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload, context) => {
      const request = readSubscriptionClosed(payload.data);
      const subscriber = request.subscriber ?? context.envelope.header.reply_to ?? context.envelope.header.source;
      sendSubscriptionClosed(subscriber, request.reason);
      subscribers.delete(subscriber);
      subscriptionCorrelations.delete(subscriber);
      return { mime_type: "application/json", data: { unsubscribed: true, channel: options.uri, subscriber } };
    },
  );

  node.action<SlockApprovalEvent>(
    "publish_approval_requested",
    {
      description: "Broadcast a pending human approval request into the channel event stream.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const approval = readApprovalEvent(payload.data);
      broadcast("approval_requested", { approval });
      return { mime_type: "application/json", data: { published: true, id: approval.id } };
    },
  );

  node.action<{ id: string; result: SlockApprovalResult }>(
    "publish_approval_resolved",
    {
      description: "Broadcast a human approval resolution into the channel event stream.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const resolution = readApprovalResolution(payload.data);
      broadcast("approval_resolved", { id: resolution.id, result: resolution.result });
      return { mime_type: "application/json", data: { published: true, id: resolution.id } };
    },
  );

  node.action<SlockCancelAgentRunRequest, SlockCancelAgentRunResult>(
    "cancel_agent_run",
    {
      description: "Cancel the active agent stream started by a channel message.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readCancelAgentRunRequest(payload.data);
      if (options.session_manager_uri) {
        try {
          const result = await node.call<SlockCancelAgentRunRequest, SlockCancelAgentRunResult>(
            options.session_manager_uri,
            "cancel_agent_run",
            { mime_type: "application/json", data: request },
            { ttl_ms: 5000, timeout_ms: 5000 },
          );
          return { mime_type: "application/json", data: result.data };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          broadcast("agent_error", { error: { code: "SESSION_CANCEL_FAILED", message, source: options.session_manager_uri } });
          return {
            mime_type: "application/json",
            data: {
              cancelled: false,
              message_id: request.message_id,
              reason: message,
            },
          };
        }
      }

      const runs = activeRuns.get(request.message_id);
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
      for (const [agentUri, run] of runs) {
        run.cancel_requested = true;
        run.reason = reason;
        node.cancel(agentUri, {
          mime_type: "application/json",
          data: { message_id: request.message_id, reason },
        }, { correlation_id: run.correlation_id });
        broadcast("agent_cancelled", {
          cancelled: {
            message_id: request.message_id,
            agent: agentUri,
            reason,
          },
        });
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

  node.action<SlockAgentRunEvent>(
    "publish_agent_run_started",
    {
      description: "Broadcast that a session-owned agent run started.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const run = readAgentRunEvent(payload.data, "started");
      broadcast("agent_run_started", { run });
      return { mime_type: "application/json", data: { published: true, run_id: run.run_id } };
    },
  );

  node.action<SlockAgentRunEvent>(
    "publish_agent_run_finished",
    {
      description: "Broadcast that a session-owned agent run finished.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const run = readAgentRunEvent(payload.data);
      broadcast("agent_run_finished", { run });
      return { mime_type: "application/json", data: { published: true, run_id: run.run_id } };
    },
  );

  node.action<{ message_id: string; agent: EndpointUri; reason?: string }>(
    "publish_agent_cancelled",
    {
      description: "Broadcast that a session-owned agent run was cancelled.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const cancelled = readAgentCancelled(payload.data);
      broadcast("agent_cancelled", { cancelled });
      return { mime_type: "application/json", data: { published: true, message_id: cancelled.message_id } };
    },
  );

  node.action<{ code?: string; message: string; source: EndpointUri }>(
    "publish_agent_error",
    {
      description: "Broadcast a session-owned agent error.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const error = readAgentError(payload.data);
      broadcast("agent_error", { error });
      return { mime_type: "application/json", data: { published: true, source: error.source } };
    },
  );

  node.onEmit("message_delta", async (payload, context) => {
    if (payload.mime_type !== SLOCK_MESSAGE_DELTA_MIME || !isRecord(payload.data)) {
      return;
    }

    broadcast("message_delta", {
      delta: {
        thread_id: String(payload.data.thread_id ?? ""),
        text: String(payload.data.text ?? ""),
        source: context.envelope.header.source,
        kind: payload.data.kind === "status" ? "status" : "text",
        ...(isRecord(payload.data.metadata) ? { metadata: payload.data.metadata } : {}),
      },
    });
  });

  return { node, messages, subscribers };

  function appendMessage(input: {
    sender: EndpointUri;
    text: string;
    mentions?: EndpointUri[];
    thread_id?: string | null;
    reply_to_id?: string | null;
    kind: SlockMessage["kind"];
    projection?: SlockMessage["projection"];
  }): SlockMessage {
    const message: SlockMessage = {
      id: `channel_msg_${nextMessageId++}`,
      channel: options.uri,
      sender: input.sender,
      text: input.text,
      mentions: input.mentions ?? [],
      thread_id: input.thread_id ?? null,
      reply_to_id: input.reply_to_id ?? null,
      kind: input.kind,
      created_at: new Date().toISOString(),
      projection: input.projection,
    };

    messages.push(message);
    while (messages.length > historyLimit) {
      messages.shift();
    }
    return message;
  }

  function inferThreadMentions(threadId: string | null): EndpointUri[] {
    if (!threadId) {
      return [];
    }

    const mentions = new Set<EndpointUri>();
    for (const message of messages) {
      if (message.id !== threadId && message.thread_id !== threadId) {
        continue;
      }

      for (const mention of message.mentions) {
        if (mention.startsWith("agent://")) {
          mentions.add(mention);
        }
      }

      if (message.kind === "agent" && message.sender.startsWith("agent://")) {
        mentions.add(message.sender);
      }
    }

    return [...mentions];
  }

  function broadcast(type: SlockChannelEvent["type"], event: Omit<SlockChannelEvent, "type" | "channel">): void {
    const payload: EnvelopePayload<SlockChannelEvent> = {
      mime_type: SLOCK_CHANNEL_EVENT_MIME,
      data: { type, channel: options.uri, ...event },
    };

    for (const subscriber of subscribers) {
      try {
        node.emit(subscriber, type, payload, { correlation_id: subscriptionCorrelations.get(subscriber) });
      } catch {
        // Late async agent/tool completions can arrive while the channel endpoint is closing.
      }
    }
  }

  function sendSubscriptionClosed(subscriber: EndpointUri, reason?: string): void {
    const payload: EnvelopePayload<SlockChannelEvent> = {
      mime_type: SLOCK_CHANNEL_EVENT_MIME,
      data: {
        type: "subscription_closed",
        channel: options.uri,
        subscription: { subscriber, reason },
      },
    };

    try {
      node.end(subscriber, "subscription_closed", payload, { correlation_id: subscriptionCorrelations.get(subscriber) });
    } catch {
      // The subscriber may already be gone by the time an unsubscribe is processed.
    }
  }

  async function runMentionedAgent(agentUri: EndpointUri, message: SlockMessage): Promise<void> {
    const correlationId = createCorrelationId("conv");
    const startedAt = new Date().toISOString();
    const runs = activeRuns.get(message.id) ?? new Map<EndpointUri, { correlation_id: string; started_at: string; cancel_requested?: boolean; reason?: string }>();
    activeRuns.set(message.id, runs);
    runs.set(agentUri, { correlation_id: correlationId, started_at: startedAt });
    broadcast("agent_run_started", {
      run: {
        run_id: correlationId,
        message_id: message.id,
        thread_id: message.thread_id,
        agent: agentUri,
        state: "started",
        started_at: startedAt,
      },
    });

    try {
      const result = await node.call<SlockAgentRun, SlockAgentResult>(
        agentUri,
        "run",
        {
          mime_type: SLOCK_AGENT_RUN_MIME,
          data: {
            channel: options.uri,
            message_id: message.id,
            run_id: correlationId,
            thread_id: message.thread_id,
            text: stripMentions(message.text),
            sender: message.sender,
          },
        },
        { correlation_id: correlationId, ttl_ms: agentTtlMs, timeout_ms: agentTtlMs },
      );

      const final = result.data;
      const activeRun = activeRuns.get(message.id)?.get(agentUri);
      if (final.cancelled || activeRun?.cancel_requested) {
        const reason = final.reason ?? activeRun?.reason;
        if (!activeRun?.cancel_requested) {
          broadcast("agent_cancelled", {
            cancelled: {
              message_id: message.id,
              agent: agentUri,
              reason,
            },
          });
        }
        broadcast("agent_run_finished", {
          run: {
            run_id: correlationId,
            message_id: message.id,
            thread_id: message.thread_id,
            agent: agentUri,
            state: "cancelled",
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            reason,
          },
        });
        return;
      }

      const finalMessage = appendMessage({
        sender: agentUri,
        text: final.final_text ?? final.summary,
        thread_id: message.thread_id ?? message.id,
        reply_to_id: message.id,
        kind: "agent",
      });
      final.final_message_id = finalMessage.id;
      broadcast("message_created", { message: finalMessage });
      broadcast("agent_run_finished", {
        run: {
          run_id: correlationId,
          message_id: message.id,
          thread_id: message.thread_id,
          agent: agentUri,
          state: "completed",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          final_message_id: finalMessage.id,
        },
      });
    } catch (error) {
      const code = error instanceof IpcCallError ? error.code : "AGENT_RUN_FAILED";
      const messageText = error instanceof Error ? error.message : "agent run failed";
      broadcast("agent_error", { error: { code, message: messageText, source: agentUri } });
      broadcast("agent_run_finished", {
        run: {
          run_id: correlationId,
          message_id: message.id,
          thread_id: message.thread_id,
          agent: agentUri,
          state: "errored",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          error: { code, message: messageText },
        },
      });
    } finally {
      const runs = activeRuns.get(message.id);
      runs?.delete(agentUri);
      if (runs?.size === 0) {
        activeRuns.delete(message.id);
      }
    }
  }

  async function routeMessageToSessionManager(message: SlockMessage, route: { session_id?: string; new_session?: boolean } = {}): Promise<void> {
    if (!options.session_manager_uri) return;
    try {
      await node.call(
        options.session_manager_uri,
        "create_or_attach_session",
        {
          mime_type: "application/json",
          data: {
            message,
            mentions: message.mentions,
            ...(route.session_id ? { session_id: route.session_id } : {}),
            ...(route.new_session ? { new_session: true } : {}),
          },
        },
        { ttl_ms: 5000, timeout_ms: 5000 },
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      broadcast("agent_error", { error: { code: "SESSION_ROUTE_FAILED", message: messageText, source: options.session_manager_uri } });
    }
  }

  function selectHistory(request: Required<Pick<SlockHistoryRequest, "limit">> & Omit<SlockHistoryRequest, "limit">): SlockMessage[] {
    let selected = messages;
    if (request.until_id) {
      const index = selected.findIndex((message) => message.id === request.until_id);
      selected = index >= 0 ? selected.slice(0, index + 1) : selected;
    }

    if (request.thread_id) {
      selected = selected.filter((message) => message.id === request.thread_id || message.thread_id === request.thread_id);
    }

    return selected.slice(-request.limit);
  }
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

function readProjectionInput(value: unknown): SlockProjectionInput {
  if (!isRecord(value) || typeof value.sender !== "string" || typeof value.text !== "string") {
    throw new Error("publish_projection requires sender and text");
  }
  return {
    sender: value.sender,
    text: value.text,
    thread_id: typeof value.thread_id === "string" ? value.thread_id : value.thread_id === null ? null : undefined,
    reply_to_id: typeof value.reply_to_id === "string" ? value.reply_to_id : value.reply_to_id === null ? null : undefined,
    kind: value.kind === "agent" || value.kind === "system" ? value.kind : undefined,
    source_event_id: typeof value.source_event_id === "string" ? value.source_event_id : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    presentation: value.presentation === "final_report" ? "final_report" : value.presentation === "artifact" ? "artifact" : value.presentation === "message" ? "message" : undefined,
    author: typeof value.author === "string" ? value.author : undefined,
    session_id: typeof value.session_id === "string" ? value.session_id : undefined,
    artifact_id: typeof value.artifact_id === "string" ? value.artifact_id : undefined,
  };
}

function readAgentRunEvent(value: unknown, expectedState?: SlockAgentRunEvent["state"]): SlockAgentRunEvent {
  if (!isRecord(value) || typeof value.run_id !== "string" || typeof value.message_id !== "string" || typeof value.agent !== "string") {
    throw new Error("agent run event requires run_id, message_id, and agent");
  }
  const state = typeof value.state === "string" && isAgentRunState(value.state) ? value.state : expectedState;
  if (!state) {
    throw new Error("agent run event requires a valid state");
  }
  if (expectedState && state !== expectedState) {
    throw new Error(`agent run event state must be ${expectedState}`);
  }
  return {
    run_id: value.run_id,
    message_id: value.message_id,
    thread_id: typeof value.thread_id === "string" ? value.thread_id : value.thread_id === null ? null : undefined,
    agent: value.agent,
    state,
    started_at: typeof value.started_at === "string" ? value.started_at : undefined,
    finished_at: typeof value.finished_at === "string" ? value.finished_at : undefined,
    final_message_id: typeof value.final_message_id === "string" ? value.final_message_id : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    error: isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string"
      ? { code: value.error.code, message: value.error.message }
      : undefined,
  };
}

function readAgentCancelled(value: unknown): { message_id: string; agent: EndpointUri; reason?: string } {
  if (!isRecord(value) || typeof value.message_id !== "string" || typeof value.agent !== "string") {
    throw new Error("publish_agent_cancelled requires message_id and agent");
  }
  return {
    message_id: value.message_id,
    agent: value.agent,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

function readAgentError(value: unknown): { code: string; message: string; source: EndpointUri } {
  if (!isRecord(value) || typeof value.message !== "string" || typeof value.source !== "string") {
    throw new Error("publish_agent_error requires message and source");
  }
  return {
    code: typeof value.code === "string" ? value.code : "AGENT_RUN_FAILED",
    message: value.message,
    source: value.source,
  };
}

function readMessageUpdate(value: unknown): SlockMessageUpdateInput {
  if (!isRecord(value) || typeof value.message_id !== "string" || value.message_id.trim().length === 0) {
    throw new Error("update_message requires message_id");
  }
  if (typeof value.text !== "string") {
    throw new Error("update_message requires text");
  }
  return { message_id: value.message_id, text: value.text };
}

function readTypingStarted(value: unknown): SlockTypingStartedInput {
  if (!isRecord(value)) {
    return {};
  }
  return { thread_id: typeof value.thread_id === "string" ? value.thread_id : value.thread_id === null ? null : undefined };
}

function readSubscriptionClosed(value: unknown): SlockSubscriptionClosedInput {
  if (!isRecord(value)) {
    return {};
  }
  return {
    subscriber: typeof value.subscriber === "string" ? value.subscriber : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

function readApprovalEvent(value: unknown): SlockApprovalEvent {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.request) || typeof value.source !== "string") {
    throw new Error("publish_approval_requested requires id, request, and source");
  }
  return {
    id: value.id,
    request: value.request as SlockApprovalEvent["request"],
    source: value.source,
    created_at: typeof value.created_at === "string" ? value.created_at : new Date().toISOString(),
  };
}

function readApprovalResolution(value: unknown): { id: string; result: SlockApprovalResult } {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.result)) {
    throw new Error("publish_approval_resolved requires id and result");
  }
  return { id: value.id, result: value.result as SlockApprovalResult };
}

function readHistoryRequest(
  value: unknown,
  fallbackLimit: number,
): Required<Pick<SlockHistoryRequest, "limit">> & Omit<SlockHistoryRequest, "limit"> {
  if (!isRecord(value)) {
    return { limit: fallbackLimit };
  }

  return {
    limit: readLimit(value.limit, fallbackLimit),
    until_id: typeof value.until_id === "string" ? value.until_id : undefined,
    thread_id: typeof value.thread_id === "string" ? value.thread_id : value.thread_id === null ? null : undefined,
  };
}

function readLimit(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(500, Math.trunc(value)));
  }
  return fallback;
}

function stripMentions(text: string): string {
  return text.replace(/(^|\s)@\S+/g, " ").trim();
}

function uniqueAgentUris(uris: EndpointUri[]): EndpointUri[] {
  return [...new Set(uris.filter((uri) => uri.startsWith("agent://")))];
}

function isAgentRunState(value: string): value is SlockAgentRunEvent["state"] {
  return value === "started" || value === "completed" || value === "errored" || value === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
