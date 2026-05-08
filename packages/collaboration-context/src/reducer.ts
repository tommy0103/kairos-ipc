import type {
  Artifact,
  CollaborationEvent,
  CollaborationQuestion,
  CollaborationState,
  Delegation,
  ReplyBarrier,
  SourceRef,
  Task,
} from "./types.ts";

export function createEmptyCollaborationState(): CollaborationState {
  return {
    source_refs: [],
    tasks: {},
    delegations: {},
    artifacts: {},
    questions: {},
    barriers: {},
    decisions: [],
    active_runs: {},
    emitted_projection_event_ids: [],
  };
}

export function reduceCollaborationEvents(events: CollaborationEvent[]): CollaborationState {
  return events.reduce(reduceCollaborationEvent, createEmptyCollaborationState());
}

export function reduceCollaborationEvent(state: CollaborationState, event: CollaborationEvent): CollaborationState {
  switch (event.type) {
    case "session_created":
      return {
        ...state,
        session: event.session,
        source_refs: uniqueSourceRefs([...state.source_refs, event.session.origin, ...event.session.source_refs]),
      };
    case "source_attached":
      return {
        ...state,
        session: state.session ? touchSession(addSessionSourceRef(state.session, event.source_ref), event.at) : state.session,
        source_refs: uniqueSourceRefs([...state.source_refs, event.source_ref]),
      };
    case "task_created":
      return { ...state, tasks: { ...state.tasks, [event.task.id]: event.task } };
    case "task_updated":
      return { ...state, tasks: patchRecord(state.tasks, event.task_id, event.patch) };
    case "delegation_created":
      return { ...state, delegations: { ...state.delegations, [event.delegation.id]: event.delegation } };
    case "delegation_started": {
      const existing = state.delegations[event.delegation_id];
      const delegation = existing ? patchDelegation(existing, {
        status: "running",
        correlation_id: event.correlation_id,
        started_at: event.started_at ?? event.at,
        updated_at: event.at,
      }) : existing;
      return {
        ...state,
        delegations: delegation ? { ...state.delegations, [event.delegation_id]: delegation } : state.delegations,
        active_runs: delegation
          ? {
            ...state.active_runs,
            [event.correlation_id]: {
              delegation_id: event.delegation_id,
              assignee: delegation.assignee,
              correlation_id: event.correlation_id,
            },
          }
          : state.active_runs,
      };
    }
    case "delegation_updated":
      return { ...state, delegations: patchRecord(state.delegations, event.delegation_id, event.patch) };
    case "artifact_submitted": {
      const delegations = event.delegation_id
        ? patchRecord(state.delegations, event.delegation_id, {
          status: "submitted",
          submitted_artifact_id: event.artifact.id,
          updated_at: event.at,
        })
        : state.delegations;
      const activeRuns = { ...state.active_runs };
      if (event.delegation_id) {
        for (const [correlationId, run] of Object.entries(activeRuns)) {
          if (run.delegation_id === event.delegation_id) {
            delete activeRuns[correlationId];
          }
        }
      }
      return {
        ...state,
        delegations,
        artifacts: { ...state.artifacts, [event.artifact.id]: event.artifact },
        active_runs: activeRuns,
        source_refs: uniqueSourceRefs([...state.source_refs, ...event.artifact.source_refs, { kind: "artifact", artifact_id: event.artifact.id }]),
      };
    }
    case "question_asked":
      return { ...state, questions: { ...state.questions, [event.question.id]: event.question } };
    case "question_answered":
      return { ...state, questions: patchQuestionAnswered(state.questions, event.question_id, event.answer_artifact_id) };
    case "decision_recorded":
      return {
        ...state,
        decisions: [...state.decisions, event.decision],
        source_refs: uniqueSourceRefs([...state.source_refs, ...event.source_refs]),
      };
    case "barrier_created":
      return { ...state, barriers: { ...state.barriers, [event.barrier.id]: event.barrier } };
    case "barrier_updated":
      return { ...state, barriers: patchRecord(state.barriers, event.barrier_id, event.patch) };
    case "barrier_satisfied":
      return { ...state, barriers: patchRecord(state.barriers, event.barrier_id, { status: "satisfied", updated_at: event.at }) };
    case "agent_run_cancelled": {
      const active = state.active_runs[event.correlation_id];
      const activeRuns = { ...state.active_runs };
      delete activeRuns[event.correlation_id];
      return {
        ...state,
        active_runs: activeRuns,
        delegations: active
          ? patchRecord(state.delegations, active.delegation_id, { status: "cancelled", error: event.reason, updated_at: event.at })
          : state.delegations,
      };
    }
    case "projection_emitted":
      return { ...state, emitted_projection_event_ids: [...state.emitted_projection_event_ids, event.source_event_id] };
  }
}

function patchRecord<T extends { id: string }>(records: Record<string, T>, id: string, patch: Partial<T>): Record<string, T> {
  const existing = records[id];
  if (!existing) return records;
  return { ...records, [id]: { ...existing, ...patch } };
}

function patchDelegation(delegation: Delegation, patch: Partial<Delegation>): Delegation {
  return { ...delegation, ...patch };
}

function patchQuestionAnswered(
  questions: Record<string, CollaborationQuestion>,
  id: string,
  answerArtifactId: string,
): Record<string, CollaborationQuestion> {
  const existing = questions[id];
  if (!existing) return questions;
  return { ...questions, [id]: { ...existing, status: "answered", answer_artifact_id: answerArtifactId } };
}

function addSessionSourceRef(session: NonNullable<CollaborationState["session"]>, sourceRef: SourceRef) {
  return { ...session, source_refs: uniqueSourceRefs([...session.source_refs, sourceRef]) };
}

function touchSession(session: NonNullable<CollaborationState["session"]>, at: string) {
  return { ...session, updated_at: at };
}

export function uniqueSourceRefs(sourceRefs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const unique: SourceRef[] = [];
  for (const sourceRef of sourceRefs) {
    const key = sourceRefKey(sourceRef);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(sourceRef);
  }
  return unique;
}

export function sourceRefKey(sourceRef: SourceRef): string {
  switch (sourceRef.kind) {
    case "channel_message":
      return `channel_message:${sourceRef.channel}:${sourceRef.message_id}`;
    case "artifact":
      return `artifact:${sourceRef.artifact_id}`;
    case "ipc_envelope":
      return `ipc_envelope:${sourceRef.trace_id ?? ""}:${sourceRef.correlation_id ?? ""}:${sourceRef.msg_id ?? ""}`;
    case "file":
      return `file:${sourceRef.uri}:${sourceRef.version ?? ""}`;
    case "external":
      return `external:${sourceRef.uri}:${sourceRef.label ?? ""}`;
  }
}

export function barrierIsSatisfied(barrier: ReplyBarrier): boolean {
  const replyCount = Object.keys(barrier.replies).length;
  if (barrier.status !== "open") return barrier.status === "satisfied";
  if (barrier.mode === "any") return replyCount > 0;
  if (barrier.mode === "quorum") return replyCount >= (barrier.quorum ?? barrier.expected_from.length);
  return barrier.expected_from.every((expected) => Boolean(barrier.replies[expected]));
}

export function currentArtifacts(state: CollaborationState): Artifact[] {
  return Object.values(state.artifacts).filter((artifact) => artifact.status === "submitted" || artifact.status === "accepted");
}

export function openDelegations(state: CollaborationState): Delegation[] {
  return Object.values(state.delegations).filter((delegation) => delegation.status === "pending" || delegation.status === "running");
}

export function openTasks(state: CollaborationState): Task[] {
  return Object.values(state.tasks).filter((task) => task.status === "open" || task.status === "blocked");
}
