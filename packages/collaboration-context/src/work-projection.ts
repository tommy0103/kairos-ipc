import type { EndpointUri } from "../../protocol/src/index.ts";
import { currentArtifacts, openDelegations } from "./reducer.ts";
import type {
  AgentWorkloadItem,
  AgentWorkSummary,
  Artifact,
  ArtifactSummary,
  BuildBoardColumn,
  BuildBoardColumnKey,
  BuildBoardItem,
  BuildBoardProjection,
  CollaborationState,
  Delegation,
  ApprovalRequest,
  ReviewQueueItem,
  SessionDetailProjection,
  SessionWorkProjection,
  SourceRef,
  Task,
  TraceRef,
  WorkAction,
  WorkBlocker,
  WorkPhase,
} from "./types.ts";

interface PhaseResult {
  phase: WorkPhase;
  reason: string;
}

export function renderSessionWorkProjection(state: CollaborationState): SessionWorkProjection | undefined {
  const session = state.session;
  if (!session) return undefined;

  const tasks = Object.values(state.tasks);
  const primaryTask = tasks[0];
  const activeDelegations = Object.values(state.delegations).filter((delegation) => !isSynthesisDelegation(delegation));
  const artifacts = currentArtifacts(state);
  const blockers = workBlockers(state);
  const phase = workPhase(state, primaryTask, blockers);
  const latestArtifact = latestCurrentArtifact([...artifacts, ...Object.values(state.artifacts).filter((artifact) => artifact.status === "revision_requested")]);
  const latestArtifactSummary = latestArtifact ? artifactSummary(latestArtifact, 320) : undefined;
  const buildBoard = buildBoardProjection(state);

  return {
    session_id: session.id,
    title: session.title ?? primaryTask?.title ?? titleFromOrigin(session.origin) ?? "Untitled session",
    objective: session.objective,
    acceptance_criteria: session.acceptance_criteria ?? primaryTask?.acceptance_criteria ?? [],
    phase: phase.phase,
    phase_label: phaseLabel(phase.phase),
    phase_reason: phase.reason,
    owner: primaryTask?.owner ?? originOwner(session.origin),
    status: session.status === "open" ? primaryTask?.status ?? session.status : session.status,
    agents: activeDelegations.map((delegation) => agentWorkSummary(delegation, state)),
    current_work: currentWorkText(state),
    latest_report: latestArtifactSummary?.text,
    latest_artifact: latestArtifactSummary,
    ...(buildBoard ? { build_board: buildBoard } : {}),
    blockers,
    actions: workActions(session.origin, latestArtifact, blockers),
    origin: session.origin,
    source_refs: session.source_refs,
    trace_refs: state.trace_refs,
    updated_at: session.updated_at ?? latestEventTime(state) ?? session.created_at,
  };
}

export function renderSessionWorkProjections(states: CollaborationState[]): SessionWorkProjection[] {
  return states
    .map(renderSessionWorkProjection)
    .filter((item): item is SessionWorkProjection => Boolean(item))
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
}

export function renderSessionDetailProjection(state: CollaborationState): SessionDetailProjection | undefined {
  const session = renderSessionWorkProjection(state);
  if (!session) return undefined;
  return {
    session,
    tasks: Object.values(state.tasks),
    delegations: Object.values(state.delegations),
    artifacts: Object.values(state.artifacts),
    barriers: Object.values(state.barriers),
    decisions: state.decisions,
    constraints: state.constraints,
    questions: Object.values(state.questions),
    approvals: Object.values(state.approvals),
    validations: Object.values(state.validations),
    notes: Object.values(state.notes),
    trace_refs: state.trace_refs,
  };
}

export function renderReviewQueue(states: CollaborationState[]): ReviewQueueItem[] {
  return states.flatMap((state) => {
    const session = state.session;
    if (!session) return [];
    const items: ReviewQueueItem[] = [];

    for (const artifact of Object.values(state.artifacts)) {
      if (artifact.status !== "submitted" && artifact.status !== "revision_requested") continue;
      items.push({
        id: `artifact:${artifact.id}`,
        kind: "artifact",
        session_id: session.id,
        title: artifact.title ?? artifact.kind.replace(/_/g, " "),
        producer: artifact.author,
        required_action: artifact.status === "revision_requested" ? "Review revised artifact" : "Review artifact",
        consequence: "Accept it, reject it, or request a revision before handoff.",
        source_refs: artifact.source_refs,
        trace_refs: artifact.trace_refs ?? [],
        actions: [
          { kind: "review_artifact", label: "Review artifact", target: artifact.id },
          { kind: "open_trace", label: "Open trace", target: artifact.id },
        ],
        created_at: artifact.updated_at ?? artifact.created_at,
      });
    }

    for (const approval of Object.values(state.approvals)) {
      if (approval.status !== "pending") continue;
      items.push({
        id: `approval:${approval.id}`,
        kind: "approval",
        session_id: session.id,
        title: `${labelFromUri(approval.tool_endpoint)} ${approval.action}`,
        producer: approval.requester,
        required_action: "Resolve approval",
        consequence: approval.risk === "destructive" ? "Approving permits a destructive action." : "Approving lets the blocked tool call continue.",
        source_refs: approval.source_refs,
        trace_refs: approval.trace_refs ?? [],
        actions: [
          { kind: "resolve_approval", label: "Resolve approval", target: approval.id },
          { kind: "open_trace", label: "Open trace", target: approval.id },
        ],
        created_at: approval.created_at,
      });
    }

    for (const question of Object.values(state.questions)) {
      if (question.status !== "asked") continue;
      items.push({
        id: `question:${question.id}`,
        kind: "question",
        session_id: session.id,
        title: `Question for ${labelFromUri(question.to)}`,
        producer: question.from,
        required_action: "Answer question",
        consequence: "The answer becomes a question-answer artifact and may unblock the session.",
        source_refs: question.about_refs ?? [],
        trace_refs: [],
        actions: [{ kind: "answer_question", label: "Answer question", target: question.id }],
      });
    }

    for (const validation of Object.values(state.validations)) {
      if (validation.status !== "requested" && validation.status !== "failed") continue;
      items.push({
        id: `validation:${validation.id}`,
        kind: "validation",
        session_id: session.id,
        title: validation.summary ?? `Validation ${validation.status}`,
        producer: validation.requester,
        required_action: validation.status === "failed" ? "Handle failed validation" : "Record validation",
        consequence: validation.status === "failed" ? "Fix, rerun, or record a decision before handoff." : "A validation result can move the session toward handoff.",
        source_refs: validation.source_refs,
        trace_refs: validation.trace_refs ?? [],
        actions: [
          { kind: "record_validation", label: "Record validation", target: validation.id },
          { kind: "open_trace", label: "Open trace", target: validation.id },
        ],
        created_at: validation.updated_at ?? validation.created_at,
      });
    }

    return items;
  }).sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
}

export function renderAgentWorkload(states: CollaborationState[]): AgentWorkloadItem[] {
  const byAgent = new Map<EndpointUri, AgentWorkloadItem>();
  for (const state of states) {
    for (const delegation of Object.values(state.delegations)) {
      if (isSynthesisDelegation(delegation)) continue;
      const existing = byAgent.get(delegation.assignee) ?? {
        agent: delegation.assignee,
        sessions: [],
        blockers: [],
      };
      const summary = agentWorkSummary(delegation, state);
      existing.sessions.push(summary);
      existing.blockers.push(...workBlockers(state).filter((blocker) => blocker.waiting_for?.includes(delegation.assignee)));
      if (summary.latest_tool_call) existing.latest_tool_call = summary.latest_tool_call;
      const latestNote = Object.values(state.notes)
        .filter((note) => note.from === delegation.assignee && (note.visibility === "human" || note.visibility === "all"))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (latestNote) existing.latest_report = latestNote.text;
      byAgent.set(delegation.assignee, existing);
    }
  }
  return [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}

const buildColumnLabels: Record<BuildBoardColumnKey, string> = {
  todo: "To do",
  building: "Building",
  review: "Review",
  validate: "Validate",
  done: "Done",
};

const buildColumnOrder: BuildBoardColumnKey[] = ["todo", "building", "review", "validate", "done"];

function buildBoardProjection(state: CollaborationState): BuildBoardProjection | undefined {
  const writeOperations = writeOperationSummaries(state);
  const buildIntent = hasBuildIntent(state) || writeOperations.length > 0;
  if (!buildIntent) return undefined;

  const columns = buildColumnOrder.map((key): BuildBoardColumn => ({ key, label: buildColumnLabels[key], items: [] }));
  const byColumn = new Map(columns.map((column) => [column.key, column.items]));
  const delegations = Object.values(state.delegations).filter((delegation) => !isSynthesisDelegation(delegation));
  const tasks = Object.values(state.tasks);

  for (const task of tasks) {
    const taskDelegations = delegations.filter((delegation) => delegation.task_id === task.id);
    if (task.status === "completed" || task.status === "cancelled") {
      pushBuildItem(byColumn, "done", taskBuildItem(task));
    } else if (taskDelegations.length === 0) {
      pushBuildItem(byColumn, "todo", taskBuildItem(task));
    }
  }

  for (const delegation of delegations) {
    if (delegation.status === "pending" || delegation.status === "running" || delegation.status === "failed" || delegation.status === "cancelled") {
      pushBuildItem(byColumn, "building", delegationBuildItem(delegation));
    } else if (delegation.status === "submitted" && !delegation.submitted_artifact_id) {
      pushBuildItem(byColumn, "review", delegationBuildItem(delegation));
    }
  }

  for (const approval of Object.values(state.approvals)) {
    if (approval.status === "pending" && isWriteAction(approval.action, approval.tool_endpoint)) {
      pushBuildItem(byColumn, "building", approvalBuildItem(approval));
    }
  }

  for (const artifact of Object.values(state.artifacts)) {
    if (artifact.status === "submitted" || artifact.status === "revision_requested" || artifact.status === "rejected") {
      pushBuildItem(byColumn, "review", artifactBuildItem(artifact));
    } else if (artifact.status === "accepted" || artifact.status === "superseded") {
      pushBuildItem(byColumn, "done", artifactBuildItem(artifact));
    }
  }

  for (const validation of Object.values(state.validations)) {
    if (validation.status === "requested" || validation.status === "running" || validation.status === "failed") {
      pushBuildItem(byColumn, "validate", {
        id: validation.id,
        kind: "validation",
        title: validation.summary ?? `Validation ${validation.status}`,
        status: validation.status,
        owner: validation.requester,
        agent: validation.validator,
        summary: validation.artifact_id ?? validation.task_id,
        source_refs: validation.source_refs,
        trace_refs: validation.trace_refs ?? [],
      });
    } else if (validation.status === "passed") {
      pushBuildItem(byColumn, "done", {
        id: validation.id,
        kind: "validation",
        title: validation.summary ?? "Validation passed",
        status: validation.status,
        owner: validation.requester,
        agent: validation.validator,
        source_refs: validation.source_refs,
        trace_refs: validation.trace_refs ?? [],
      });
    }
  }

  const active = state.session?.status === "open" && columns.some((column) => column.key !== "done" && column.items.length > 0);
  return {
    active,
    reason: writeOperations.length > 0 ? "Write operations detected." : "Build-oriented task or delegation detected.",
    write_operations: writeOperations,
    columns,
  };
}

function pushBuildItem(columns: Map<BuildBoardColumnKey, BuildBoardItem[]>, column: BuildBoardColumnKey, item: BuildBoardItem): void {
  columns.get(column)?.push(item);
}

function taskBuildItem(task: Task): BuildBoardItem {
  return {
    id: task.id,
    kind: "task",
    title: task.title,
    status: task.status,
    owner: task.owner,
    summary: task.acceptance_criteria?.join(" · "),
    source_refs: task.source_refs,
    trace_refs: task.trace_refs ?? [],
  };
}

function delegationBuildItem(delegation: Delegation): BuildBoardItem {
  return {
    id: delegation.id,
    kind: "delegation",
    title: delegation.role_label ?? delegation.role ?? `Work for ${labelFromUri(delegation.assignee)}`,
    status: delegation.status,
    owner: delegation.assignee,
    agent: delegation.assignee,
    summary: clip(delegation.instruction, 220),
    source_refs: delegation.source_refs,
    trace_refs: delegation.trace_refs ?? [],
  };
}

function approvalBuildItem(approval: ApprovalRequest): BuildBoardItem {
  return {
    id: approval.id,
    kind: "approval",
    title: `${labelFromUri(approval.tool_endpoint)} ${approval.action}`,
    status: approval.status,
    owner: "human://user/local",
    agent: approval.requester,
    summary: approval.payload_summary,
    source_refs: approval.source_refs,
    trace_refs: approval.trace_refs ?? [],
  };
}

function artifactBuildItem(artifact: Artifact): BuildBoardItem {
  return {
    id: artifact.id,
    kind: "artifact",
    title: artifact.title ?? artifact.kind.replace(/_/g, " "),
    status: artifact.status,
    owner: artifact.author,
    agent: artifact.author,
    summary: artifactText(artifact, 220),
    source_refs: artifact.source_refs,
    trace_refs: artifact.trace_refs ?? [],
  };
}

function writeOperationSummaries(state: CollaborationState): ToolCallSummary[] {
  const operations: ToolCallSummary[] = [];
  const seen = new Set<string>();
  const push = (operation: ToolCallSummary): void => {
    const key = `${operation.endpoint}:${operation.action}:${operation.payload_summary ?? ""}:${operation.status ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    operations.push(operation);
  };

  for (const approval of Object.values(state.approvals)) {
    if (!isWriteAction(approval.action, approval.tool_endpoint)) continue;
    push({
      endpoint: approval.tool_endpoint,
      action: approval.action,
      payload_summary: approval.payload_summary,
      status: approvalToolStatus(approval.status),
      trace_ref: approval.trace_refs?.[0],
    });
  }

  for (const trace of state.trace_refs) {
    if (!trace.endpoint || !trace.action || !isWriteAction(trace.action, trace.endpoint)) continue;
    push({
      endpoint: trace.endpoint,
      action: trace.action,
      payload_summary: trace.label,
      status: trace.severity === "error" ? "failed" : undefined,
      trace_ref: trace,
    });
  }

  return operations.slice(-6);
}

function approvalToolStatus(status: ApprovalRequest["status"]): ToolCallSummary["status"] {
  if (status === "approved") return "completed";
  if (status === "rejected" || status === "expired") return "failed";
  return status;
}

function hasBuildIntent(state: CollaborationState): boolean {
  return Object.values(state.artifacts).some((artifact) => artifact.kind === "patch")
    || Object.values(state.tasks).some((task) => buildTextPattern.test([task.title, ...(task.acceptance_criteria ?? [])].join(" ")))
    || Object.values(state.delegations).some((delegation) => buildTextPattern.test([
      delegation.role,
      delegation.role_label,
      delegation.instruction,
      delegation.expected_output,
    ].filter(Boolean).join(" ")));
}

const buildTextPattern = /\b(build|implement|fix|refactor|edit|write|change|add|remove|create|update|migrate|patch|ship|test)\b|实现|修复|改造|重构|编辑|写入|修改|新增|删除|迁移|补齐|落地|测试/iu;

function isWriteAction(action: string, endpoint?: EndpointUri): boolean {
  const normalized = action.toLowerCase();
  if (normalized === "write" || normalized === "edit" || normalized === "exec") return true;
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) return true;
  return Boolean(endpoint?.includes("shell") && normalized.includes("exec"));
}

function workPhase(state: CollaborationState, task: Task | undefined, blockers: WorkBlocker[]): PhaseResult {
  if (state.session?.status && state.session.status !== "open") return { phase: "done", reason: `Session is ${state.session.status}.` };
  if (!task) return { phase: "intake", reason: "Session exists but no task has been created." };
  if (task.status === "completed" || task.status === "cancelled") return { phase: "done", reason: `Primary task is ${task.status}.` };

  const failed = blockers.find((blocker) => blocker.kind === "failed_delegation" || blocker.kind === "failed_validation");
  if (failed) return { phase: failed.kind === "failed_validation" ? "validate" : "execute", reason: failed.label };

  const humanGate = blockers.find((blocker) => blocker.kind === "pending_approval" || blocker.kind === "pending_question");
  if (humanGate) return { phase: "decision", reason: humanGate.label };

  if (hasActiveDelegation(state)) return { phase: "execute", reason: "At least one delegation is pending or running." };
  if (hasPendingValidation(state)) return { phase: "validate", reason: "Validation is requested or running." };

  const artifactForReview = Object.values(state.artifacts).find((artifact) => artifact.status === "submitted" || artifact.status === "revision_requested");
  if (artifactForReview) return { phase: "review", reason: `${artifactForReview.title ?? artifactForReview.id} is ready for review.` };

  if (hasOpenBarrier(state)) return { phase: "execute", reason: "An open barrier is waiting for required participants." };
  if (Object.values(state.delegations).some(isSynthesisDelegation)) return { phase: "handoff", reason: "Final synthesis or handoff has been requested." };
  return { phase: "plan", reason: "Task exists and is ready to be delegated or planned." };
}

function phaseLabel(phase: WorkPhase): string {
  switch (phase) {
    case "intake":
      return "Intake";
    case "shape":
      return "Shape";
    case "plan":
      return "Plan";
    case "execute":
      return "Execute";
    case "review":
      return "Review";
    case "validate":
      return "Validate";
    case "decision":
      return "Decision";
    case "handoff":
      return "Handoff";
    case "done":
      return "Done";
  }
}

function agentWorkSummary(delegation: Delegation, state: CollaborationState): AgentWorkSummary {
  return {
    session_id: delegation.session_id,
    session_title: state.session?.title ?? Object.values(state.tasks)[0]?.title,
    agent: delegation.assignee,
    status: delegation.status,
    delegation_id: delegation.id,
    role: delegation.role,
    role_label: delegation.role_label,
    artifact_id: delegation.submitted_artifact_id,
    current_work: clip(delegation.instruction, 180),
    latest_tool_call: latestToolCallForDelegation(state, delegation),
  };
}

function latestToolCallForDelegation(state: CollaborationState, delegation: Delegation): AgentWorkSummary["latest_tool_call"] {
  const traces = [...(delegation.trace_refs ?? []), ...state.trace_refs];
  const trace = [...traces].reverse().find((item) => {
    return item.correlation_id === delegation.correlation_id || item.object_ref === `delegation:${delegation.id}`;
  });
  return trace?.endpoint && trace.action
    ? { endpoint: trace.endpoint, action: trace.action, payload_summary: trace.label, trace_ref: trace }
    : undefined;
}

function workBlockers(state: CollaborationState): WorkBlocker[] {
  const blockers: WorkBlocker[] = [];
  for (const barrier of Object.values(state.barriers)) {
    if (barrier.status !== "open") continue;
    const replied = new Set(Object.keys(barrier.replies));
    const waitingFor = barrier.expected_from.filter((agent) => !replied.has(agent));
    blockers.push({
      kind: "waiting_for_artifact",
      label: waitingFor.length > 0 ? `Waiting for ${waitingFor.map(labelFromUri).join(", ")}` : "Waiting for barrier",
      ref_id: barrier.id,
      waiting_for: waitingFor,
    });
  }

  for (const question of Object.values(state.questions)) {
    if (question.status !== "asked") continue;
    blockers.push({
      kind: "pending_question",
      label: `Question for ${labelFromUri(question.to)}`,
      ref_id: question.id,
      waiting_for: [question.to],
    });
  }

  for (const approval of Object.values(state.approvals)) {
    if (approval.status !== "pending") continue;
    blockers.push({
      kind: "pending_approval",
      label: `Approval pending for ${labelFromUri(approval.tool_endpoint)} ${approval.action}`,
      ref_id: approval.id,
      waiting_for: ["human://user/local"],
    });
  }

  for (const validation of Object.values(state.validations)) {
    if (validation.status === "requested" || validation.status === "running") {
      blockers.push({
        kind: "pending_validation",
        label: validation.summary ?? `Validation ${validation.status}`,
        ref_id: validation.id,
        waiting_for: validation.validator ? [validation.validator] : undefined,
      });
    }
    if (validation.status === "failed") {
      blockers.push({ kind: "failed_validation", label: validation.summary ?? "Validation failed", ref_id: validation.id });
    }
  }

  for (const artifact of Object.values(state.artifacts)) {
    if (artifact.status !== "revision_requested") continue;
    blockers.push({ kind: "revision_requested", label: `Revision requested for ${artifact.title ?? artifact.id}`, ref_id: artifact.id, waiting_for: [artifact.author] });
  }

  for (const delegation of Object.values(state.delegations)) {
    if (delegation.status !== "failed") continue;
    blockers.push({
      kind: "failed_delegation",
      label: `${labelFromUri(delegation.assignee)} failed`,
      ref_id: delegation.id,
    });
  }

  return blockers;
}

function workActions(origin: SourceRef | undefined, latestArtifact: Artifact | undefined, blockers: WorkBlocker[]): WorkAction[] {
  const actions: WorkAction[] = [];
  if (origin?.kind === "channel_message") {
    actions.push({ kind: "open_thread", label: "Open thread", target: `${origin.channel}#${origin.message_id}` });
  }
  if (latestArtifact) {
    actions.push({ kind: "review_artifact", label: "Review artifact", target: latestArtifact.id });
  }
  if (blockers.some((blocker) => blocker.kind === "pending_approval")) {
    actions.push({ kind: "resolve_approval", label: "Resolve approval" });
  }
  if (blockers.some((blocker) => blocker.kind === "pending_question")) {
    actions.push({ kind: "answer_question", label: "Answer question" });
  }
  actions.push({ kind: "open_trace", label: "Open trace" });
  return actions;
}

function currentWorkText(state: CollaborationState): string | undefined {
  const current = openDelegations(state).find((delegation) => !isSynthesisDelegation(delegation));
  return current ? clip(current.instruction, 360) : undefined;
}

function latestCurrentArtifact(artifacts: Artifact[]): Artifact | undefined {
  return [...artifacts].sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at))[0];
}

function artifactSummary(artifact: Artifact, maxLength: number): ArtifactSummary {
  return {
    artifact_id: artifact.id,
    title: artifact.title ?? artifact.kind.replace(/_/g, " "),
    author: artifact.author,
    kind: artifact.kind,
    status: artifact.status,
    text: artifactText(artifact, maxLength),
  };
}

function hasActiveDelegation(state: CollaborationState): boolean {
  return Object.values(state.delegations).some((delegation) => {
    return !isSynthesisDelegation(delegation) && (delegation.status === "pending" || delegation.status === "running");
  });
}

function hasPendingValidation(state: CollaborationState): boolean {
  return Object.values(state.validations).some((validation) => validation.status === "requested" || validation.status === "running");
}

function hasOpenBarrier(state: CollaborationState): boolean {
  return Object.values(state.barriers).some((barrier) => barrier.status === "open");
}

function latestEventTime(state: CollaborationState): string | undefined {
  const times = [
    ...Object.values(state.artifacts).map((artifact) => artifact.updated_at ?? artifact.created_at),
    ...Object.values(state.delegations).map((delegation) => delegation.updated_at ?? delegation.started_at).filter((value): value is string => Boolean(value)),
    ...Object.values(state.barriers).map((barrier) => barrier.updated_at ?? barrier.created_at),
    ...Object.values(state.approvals).map((approval) => approval.resolved_at ?? approval.created_at),
    ...Object.values(state.validations).map((validation) => validation.updated_at ?? validation.created_at),
    ...state.decisions.map((decision) => decision.created_at),
  ];
  return times.sort().at(-1);
}

function titleFromOrigin(origin: SourceRef): string | undefined {
  if (origin.kind === "external") return origin.label ?? origin.uri;
  if (origin.kind === "file") return origin.uri;
  return undefined;
}

function originOwner(origin: SourceRef): EndpointUri {
  if (origin.kind === "external" && origin.uri.includes("://")) return origin.uri;
  return "human://user/local";
}

function artifactText(artifact: Artifact, maxLength: number): string {
  const content = artifact.content;
  if (typeof content === "string") return clip(content, maxLength);
  if (isRecord(content)) {
    if (typeof content.final_text === "string") return clip(content.final_text, maxLength);
    if (typeof content.text === "string") return clip(content.text, maxLength);
    if (typeof content.summary === "string") return clip(content.summary, maxLength);
  }
  try {
    return clip(JSON.stringify(content), maxLength);
  } catch {
    return clip(String(content), maxLength);
  }
}

function isSynthesisDelegation(delegation: Delegation): boolean {
  return delegation.id.startsWith("delegation_synthesis_") || delegation.role === "synthesis";
}

function labelFromUri(uri: EndpointUri): string {
  const parts = uri.split("/").filter(Boolean);
  return decodeURIComponent(parts.at(-1) ?? uri);
}

function clip(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
