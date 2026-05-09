import type {
  Artifact,
  ApprovalRequest,
  CollaborationConstraint,
  CollaborationDecision,
  CollaborationEvent,
  CollaborationQuestion,
  CollaborationState,
  Delegation,
  ReplyBarrier,
  SourceRef,
  Task,
  TraceRef,
  ValidationRecord,
} from "./types.ts";

export function createEmptyCollaborationState(): CollaborationState {
  return {
    source_refs: [],
    tasks: {},
    delegations: {},
    artifacts: {},
    questions: {},
    notes: {},
    approvals: {},
    validations: {},
    barriers: {},
    decisions: [],
    constraints: [],
    trace_refs: [],
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
    case "session_updated":
      return {
        ...state,
        session: state.session ? { ...state.session, ...event.patch, updated_at: event.at } : state.session,
      };
    case "source_attached":
      return {
        ...state,
        session: state.session ? touchSession(addSessionSourceRef(state.session, event.source_ref), event.at) : state.session,
        source_refs: uniqueSourceRefs([...state.source_refs, event.source_ref]),
      };
    case "source_detached":
      return {
        ...state,
        session: state.session ? touchSession(removeSessionSourceRef(state.session, event.source_ref), event.at) : state.session,
        source_refs: removeSourceRef(state.source_refs, event.source_ref),
      };
    case "acceptance_criteria_recorded":
      return {
        ...state,
        session: state.session
          ? touchSession({ ...state.session, acceptance_criteria: event.criteria }, event.at)
          : state.session,
        tasks: patchAllOpenTasks(state.tasks, { acceptance_criteria: event.criteria, updated_at: event.at }),
        source_refs: uniqueSourceRefs([...state.source_refs, ...(event.source_refs ?? [])]),
      };
    case "scope_updated":
      return {
        ...state,
        session: state.session
          ? touchSession({ ...state.session, objective: event.objective ?? state.session.objective, title: event.title ?? state.session.title }, event.at)
          : state.session,
        source_refs: uniqueSourceRefs([...state.source_refs, ...(event.source_refs ?? [])]),
      };
    case "constraint_recorded":
      const constraint = normalizeConstraint(event, state.constraints.length + 1);
      return {
        ...state,
        constraints: [...state.constraints, constraint],
        source_refs: uniqueSourceRefs([...state.source_refs, ...(event.source_refs ?? [])]),
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
    case "artifact_updated":
      return { ...state, artifacts: patchRecord(state.artifacts, event.artifact_id, event.patch) };
    case "artifact_reviewed":
      return {
        ...state,
        artifacts: patchRecord(state.artifacts, event.artifact_id, {
          status: event.review.status,
          review: event.review,
          updated_at: event.at,
          source_refs: uniqueSourceRefs([
            ...(state.artifacts[event.artifact_id]?.source_refs ?? []),
            ...(event.review.source_refs ?? []),
          ]),
          trace_refs: uniqueTraceRefs([
            ...(state.artifacts[event.artifact_id]?.trace_refs ?? []),
            ...(event.review.trace_refs ?? []),
          ]),
        }),
        source_refs: uniqueSourceRefs([...state.source_refs, ...(event.review.source_refs ?? [])]),
        trace_refs: uniqueTraceRefs([...state.trace_refs, ...(event.review.trace_refs ?? [])]),
      };
    case "question_asked":
      return { ...state, questions: { ...state.questions, [event.question.id]: event.question } };
    case "question_answered":
      return { ...state, questions: patchQuestionAnswered(state.questions, event.question_id, event.answer_artifact_id) };
    case "note_posted":
      return { ...state, notes: { ...state.notes, [event.note.id]: event.note } };
    case "approval_requested":
      return {
        ...state,
        approvals: { ...state.approvals, [event.approval.id]: event.approval },
        source_refs: uniqueSourceRefs([...state.source_refs, ...event.approval.source_refs]),
        trace_refs: uniqueTraceRefs([...state.trace_refs, ...(event.approval.trace_refs ?? [])]),
      };
    case "approval_resolved":
      return {
        ...state,
        approvals: patchRecord(state.approvals, event.approval_id, { ...event.patch, resolved_at: event.patch.resolved_at ?? event.at }),
        trace_refs: uniqueTraceRefs([...state.trace_refs, ...(event.patch.trace_refs ?? [])]),
      };
    case "validation_requested":
      return {
        ...state,
        validations: { ...state.validations, [event.validation.id]: event.validation },
        source_refs: uniqueSourceRefs([...state.source_refs, ...event.validation.source_refs]),
        trace_refs: uniqueTraceRefs([...state.trace_refs, ...(event.validation.trace_refs ?? [])]),
      };
    case "validation_started":
      return {
        ...state,
        validations: patchRecord(state.validations, event.validation_id, { status: "running", validator: event.validator, updated_at: event.at }),
      };
    case "validation_recorded":
      return {
        ...state,
        validations: patchRecord(state.validations, event.validation_id, { ...event.patch, updated_at: event.at }),
        trace_refs: uniqueTraceRefs([...state.trace_refs, ...(event.patch.trace_refs ?? [])]),
      };
    case "validation_failed":
      return {
        ...state,
        validations: patchRecord(state.validations, event.validation_id, { status: "failed", summary: event.summary, trace_refs: event.trace_refs, updated_at: event.at }),
        trace_refs: uniqueTraceRefs([...state.trace_refs, ...(event.trace_refs ?? [])]),
      };
    case "decision_recorded":
      const decision = normalizeDecision(event, state.decisions.length + 1);
      return {
        ...state,
        decisions: [...state.decisions, decision],
        source_refs: uniqueSourceRefs([...state.source_refs, ...event.source_refs]),
        trace_refs: uniqueTraceRefs([...state.trace_refs, ...(event.trace_refs ?? decision.trace_refs ?? [])]),
      };
    case "barrier_created":
      return { ...state, barriers: { ...state.barriers, [event.barrier.id]: event.barrier } };
    case "barrier_updated":
      return { ...state, barriers: patchRecord(state.barriers, event.barrier_id, event.patch) };
    case "barrier_satisfied":
      return { ...state, barriers: patchRecord(state.barriers, event.barrier_id, { status: "satisfied", updated_at: event.at }) };
    case "barrier_timed_out":
      return { ...state, barriers: patchRecord(state.barriers, event.barrier_id, { status: "timed_out", updated_at: event.at }) };
    case "synthesis_requested":
      return {
        ...state,
        barriers: markTaskBarriersForSynthesis(state.barriers, event.task_id, event.reason, event.at),
        source_refs: uniqueSourceRefs([...state.source_refs, ...(event.source_refs ?? [])]),
      };
    case "handoff_recorded":
      return {
        ...state,
        artifacts: patchRecord(state.artifacts, event.artifact_id, { kind: "final_synthesis", status: "accepted", updated_at: event.at }),
        session: state.session ? touchSession({ ...state.session, status: "completed" }, event.at) : state.session,
        source_refs: uniqueSourceRefs([...state.source_refs, ...(event.source_refs ?? []), { kind: "artifact", artifact_id: event.artifact_id }]),
      };
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
    case "trace_linked":
      return linkTraceRef(state, event.object_ref, event.trace_ref);
  }
}

function linkTraceRef(state: CollaborationState, objectRef: string | undefined, traceRef: TraceRef): CollaborationState {
  const traceRefs = uniqueTraceRefs([...state.trace_refs, traceRef]);
  if (!objectRef) {
    return { ...state, trace_refs: traceRefs };
  }

  const [kind, id] = objectRef.split(":", 2);
  if (kind === "artifact" && id && state.artifacts[id]) {
    const artifact = state.artifacts[id];
    return {
      ...state,
      trace_refs: traceRefs,
      artifacts: {
        ...state.artifacts,
        [id]: { ...artifact, trace_refs: uniqueTraceRefs([...(artifact.trace_refs ?? []), traceRef]) },
      },
    };
  }
  if (kind === "delegation" && id && state.delegations[id]) {
    const delegation = state.delegations[id];
    return {
      ...state,
      trace_refs: traceRefs,
      delegations: {
        ...state.delegations,
        [id]: { ...delegation, trace_refs: uniqueTraceRefs([...(delegation.trace_refs ?? []), traceRef]) },
      },
    };
  }
  if (kind === "task" && id && state.tasks[id]) {
    const task = state.tasks[id];
    return {
      ...state,
      trace_refs: traceRefs,
      tasks: {
        ...state.tasks,
        [id]: { ...task, trace_refs: uniqueTraceRefs([...(task.trace_refs ?? []), traceRef]) },
      },
    };
  }
  if (kind === "barrier" && id && state.barriers[id]) {
    const barrier = state.barriers[id];
    return {
      ...state,
      trace_refs: traceRefs,
      barriers: {
        ...state.barriers,
        [id]: { ...barrier, trace_refs: uniqueTraceRefs([...(barrier.trace_refs ?? []), traceRef]) },
      },
    };
  }
  if (kind === "approval" && id && state.approvals[id]) {
    const approval = state.approvals[id];
    return {
      ...state,
      trace_refs: traceRefs,
      approvals: {
        ...state.approvals,
        [id]: { ...approval, trace_refs: uniqueTraceRefs([...(approval.trace_refs ?? []), traceRef]) },
      },
    };
  }
  if (kind === "validation" && id && state.validations[id]) {
    const validation = state.validations[id];
    return {
      ...state,
      trace_refs: traceRefs,
      validations: {
        ...state.validations,
        [id]: { ...validation, trace_refs: uniqueTraceRefs([...(validation.trace_refs ?? []), traceRef]) },
      },
    };
  }
  if (kind === "decision" && id) {
    return {
      ...state,
      trace_refs: traceRefs,
      decisions: state.decisions.map((decision) => {
        return decision.id === id ? { ...decision, trace_refs: uniqueTraceRefs([...(decision.trace_refs ?? []), traceRef]) } : decision;
      }),
    };
  }

  return { ...state, trace_refs: traceRefs };
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

function patchAllOpenTasks(tasks: Record<string, Task>, patch: Partial<Task>): Record<string, Task> {
  return Object.fromEntries(Object.entries(tasks).map(([id, task]) => {
    return [id, task.status === "open" || task.status === "blocked" ? { ...task, ...patch } : task];
  }));
}

function normalizeDecision(
  event: Extract<CollaborationEvent, { type: "decision_recorded" }>,
  index: number,
): CollaborationDecision {
  if (isRecord(event.decision)
    && typeof event.decision.id === "string"
    && typeof event.decision.session_id === "string"
    && typeof event.decision.decider === "string"
    && "decision" in event.decision
    && Array.isArray(event.decision.source_refs)
    && typeof event.decision.created_at === "string") {
    return event.decision as CollaborationDecision;
  }

  return {
    id: `decision_${index}`,
    session_id: event.session_id,
    decider: event.decider ?? "human://user/local",
    decision: event.decision,
    source_refs: event.source_refs,
    trace_refs: event.trace_refs,
    relates_to: event.relates_to,
    supersedes: event.supersedes,
    created_at: event.at,
  };
}

function normalizeConstraint(
  event: Extract<CollaborationEvent, { type: "constraint_recorded" }>,
  index: number,
): CollaborationConstraint {
  return {
    id: event.constraint_id ?? `constraint_${index}`,
    session_id: event.session_id,
    constraint: event.constraint,
    source_refs: event.source_refs ?? [],
    created_at: event.at,
  };
}

function markTaskBarriersForSynthesis(
  barriers: Record<string, ReplyBarrier>,
  taskId: string | undefined,
  reason: string | undefined,
  at: string,
): Record<string, ReplyBarrier> {
  const next: Record<string, ReplyBarrier> = {};
  for (const [id, barrier] of Object.entries(barriers)) {
    next[id] = !taskId || barrier.task_id === taskId
      ? { ...barrier, synthesis_requested: true, synthesis_reason: reason ?? barrier.synthesis_reason ?? "explicit synthesis request", updated_at: at }
      : barrier;
  }
  return next;
}

function addSessionSourceRef(session: NonNullable<CollaborationState["session"]>, sourceRef: SourceRef) {
  return { ...session, source_refs: uniqueSourceRefs([...session.source_refs, sourceRef]) };
}

function removeSessionSourceRef(session: NonNullable<CollaborationState["session"]>, sourceRef: SourceRef) {
  return { ...session, source_refs: removeSourceRef(session.source_refs, sourceRef) };
}

function removeSourceRef(sourceRefs: SourceRef[], sourceRef: SourceRef): SourceRef[] {
  const removedKey = sourceRefKey(sourceRef);
  return sourceRefs.filter((item) => sourceRefKey(item) !== removedKey);
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

export function uniqueTraceRefs(traceRefs: TraceRef[]): TraceRef[] {
  const seen = new Set<string>();
  const unique: TraceRef[] = [];
  for (const traceRef of traceRefs) {
    const key = traceRefKey(traceRef);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(traceRef);
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

export function traceRefKey(traceRef: TraceRef): string {
  return [
    traceRef.trace_id ?? "",
    traceRef.correlation_id ?? "",
    traceRef.msg_id ?? "",
    traceRef.endpoint ?? "",
    traceRef.action ?? "",
    traceRef.object_ref ?? "",
    traceRef.label,
  ].join(":");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
