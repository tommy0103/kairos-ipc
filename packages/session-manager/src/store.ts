import type { EndpointUri } from "../../protocol/src/index.ts";
import {
  createEmptyCollaborationState,
  reduceCollaborationEvent,
  sourceRefKey,
  type CollaborationEvent,
  type SourceRef,
  type Task,
} from "../../collaboration-context/src/index.ts";
import type { SlockMessage } from "../../slock-channel/src/index.ts";
import { isDmChannel, messageSourceRef, sessionIdForMessage, sessionUri, slug, taskTitle, threadKey } from "./helpers.ts";
import type { SessionManagerResolveRequest, SessionManagerSessionSnapshot, SessionRecord } from "./types.ts";

export interface ActiveSessionRun {
  session_id: string;
  delegation_id: string;
  agent: EndpointUri;
  message: SlockMessage;
  correlation_id: string;
  started_at: string;
  cancel_requested?: boolean;
  reason?: string;
}

interface SessionStoreOptions {
  coordinator_uri?: EndpointUri;
  hasDelegationForAssignee?: (record: SessionRecord, assignee: EndpointUri) => boolean;
  onEventAppended?: (record: SessionRecord, event: CollaborationEvent) => void;
}

export function createSessionStore(options: SessionStoreOptions = {}) {
  const sessions = new Map<string, SessionRecord>();
  const sourceIndex = new Map<string, string>();
  const threadIndex = new Map<string, string>();
  const activeChannelSessionIndex = new Map<EndpointUri, string>();
  const activeRunsByMessage = new Map<string, Map<EndpointUri, ActiveSessionRun>>();
  let eventCounter = 1;
  let artifactCounter = 1;
  let questionCounter = 1;
  let noteCounter = 1;
  let compactionCounter = 1;
  let approvalCounter = 1;
  let validationCounter = 1;
  let explicitSessionCounter = 1;

  function createSessionForMessage(message: SlockMessage, sourceRef: SourceRef): SessionRecord {
    return createSession(sessionIdForMessage(message), sourceRef);
  }

  function createSession(id: string, sourceRef: SourceRef): SessionRecord {
    if (sessions.has(id)) {
      throw new Error(`session already exists: ${id}`);
    }
    const createdAt = new Date().toISOString();
    const record: SessionRecord = {
      id,
      uri: sessionUri(id),
      events: [],
      state: createEmptyCollaborationState(),
      compactions: [],
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

  function createManualTask(record: SessionRecord, title: string, owner: EndpointUri, sourceRef: SourceRef): void {
    const at = new Date().toISOString();
    const task: Task = {
      id: `task_${slug(record.id)}_${Object.keys(record.state.tasks).length + 1}`,
      session_id: record.id,
      title: taskTitle(title),
      owner,
      status: "open",
      source_refs: [sourceRef],
    };
    appendEvent(record, { type: "task_created", task }, at);
  }

  function appendEvent(
    record: SessionRecord,
    event: Omit<CollaborationEvent, "id" | "at">,
    at = new Date().toISOString(),
  ): CollaborationEvent {
    const next = { id: `event_${eventCounter++}`, at, ...event } as CollaborationEvent;
    record.events.push(next);
    record.state = reduceCollaborationEvent(record.state, next);
    options.onEventAppended?.(record, next);
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

  function detachSource(record: SessionRecord, sourceRef: SourceRef, reason?: string): void {
    const key = sourceRefKey(sourceRef);
    if (!record.state.source_refs.some((ref) => sourceRefKey(ref) === key)) {
      return;
    }
    appendEvent(record, { type: "source_detached", session_id: record.id, source_ref: sourceRef, reason });
    if (sourceIndex.get(key) === record.id) {
      sourceIndex.delete(key);
    }
    if (sourceRef.kind === "channel_message") {
      const messageKey = threadKey(sourceRef.channel, sourceRef.message_id);
      if (threadIndex.get(messageKey) === record.id) {
        threadIndex.delete(messageKey);
      }
    }
  }

  function resolveMessageSession(message: SlockMessage, agents: EndpointUri[] = []): SessionRecord | undefined {
    const direct = sourceIndex.get(sourceRefKey(messageSourceRef(message)));
    if (direct) return openSession(direct);
    const threadId = message.thread_id ?? message.reply_to_id;
    if (threadId) {
      const threadSessionId = threadIndex.get(threadKey(message.channel, threadId));
      if (threadSessionId) return openSession(threadSessionId);
    }
    if (shouldAttachToActiveChannelSession(message, agents)) {
      const activeSessionId = activeChannelSessionIndex.get(message.channel);
      if (activeSessionId) return openSession(activeSessionId);
    }
    return undefined;
  }

  function openSession(sessionId: string): SessionRecord | undefined {
    const record = sessions.get(sessionId);
    return record?.state.session?.status === "open" ? record : undefined;
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
    indexSourceRef(sessionId, sourceRef);
    threadIndex.set(threadKey(message.channel, message.thread_id ?? message.id), sessionId);
    threadIndex.set(threadKey(message.channel, message.id), sessionId);
    activeChannelSessionIndex.set(message.channel, sessionId);
  }

  function indexSourceRef(sessionId: string, sourceRef: SourceRef): void {
    sourceIndex.set(sourceRefKey(sourceRef), sessionId);
    if (sourceRef.kind === "channel_message") {
      threadIndex.set(threadKey(sourceRef.channel, sourceRef.message_id), sessionId);
      activeChannelSessionIndex.set(sourceRef.channel, sessionId);
    }
  }

  function shouldAttachToActiveChannelSession(message: SlockMessage, agents: EndpointUri[]): boolean {
    if (message.kind !== "human" || message.thread_id || message.reply_to_id || !activeChannelSessionIndex.has(message.channel)) {
      return false;
    }
    const activeSessionId = activeChannelSessionIndex.get(message.channel);
    const activeSession = activeSessionId ? sessions.get(activeSessionId) : undefined;
    if (activeSession?.state.session?.status !== "open") {
      return false;
    }
    if (isDmChannel(message.channel)) {
      return true;
    }
    if (agents.length === 0) {
      return true;
    }
    if (activeSession && agents.some((agent) => options.hasDelegationForAssignee?.(activeSession, agent))) {
      return true;
    }
    return Boolean(options.coordinator_uri && agents.every((agent) => agent === options.coordinator_uri));
  }

  function clearActiveSession(sessionId: string): void {
    for (const [channel, activeSessionId] of activeChannelSessionIndex) {
      if (activeSessionId === sessionId) {
        activeChannelSessionIndex.delete(channel);
      }
    }
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
      compactions: record.compactions,
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

  function nextQuestionId(sessionId: string): string {
    return `${sessionId}_question_${questionCounter++}`;
  }

  function nextNoteId(sessionId: string): string {
    return `${sessionId}_note_${noteCounter++}`;
  }

  function nextCompactionId(sessionId: string): string {
    return `${sessionId}_compaction_${compactionCounter++}`;
  }

  function nextApprovalId(sessionId: string): string {
    return `${sessionId}_approval_${approvalCounter++}`;
  }

  function nextValidationId(sessionId: string): string {
    return `${sessionId}_validation_${validationCounter++}`;
  }

  function nextExplicitSessionId(seed: string): string {
    let id = `session_${slug(seed)}_${explicitSessionCounter++}`;
    while (sessions.has(id)) {
      id = `session_${slug(seed)}_${explicitSessionCounter++}`;
    }
    return id;
  }

  function ensureSourceIsUnowned(sourceRef: SourceRef): void {
    const owner = sourceIndex.get(sourceRefKey(sourceRef));
    if (owner) {
      throw new Error(`source already belongs to session ${owner}; use move_source to reassign it`);
    }
  }

  return {
    sessions,
    activeRunsByMessage,
    createSessionForMessage,
    createSession,
    createManualTask,
    appendEvent,
    attachSource,
    detachSource,
    resolveMessageSession,
    openSession,
    resolveSessionId,
    indexMessage,
    indexSourceRef,
    clearActiveSession,
    requiredSession,
    snapshot,
    rememberActiveRun,
    forgetActiveRun,
    nextArtifactId,
    nextQuestionId,
    nextNoteId,
    nextCompactionId,
    nextApprovalId,
    nextValidationId,
    nextExplicitSessionId,
    ensureSourceIsUnowned,
  };
}
