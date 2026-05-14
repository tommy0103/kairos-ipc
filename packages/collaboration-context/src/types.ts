import type { EndpointUri } from "../../protocol/src/index.ts";

export const KAIROS_COLLABORATION_EVENT_MIME = "application/vnd.kairos.collaboration-event+json";
export const KAIROS_CONTEXT_RENDER_REQUEST_MIME = "application/vnd.kairos.context-render-request+json";
export const KAIROS_ARTIFACT_MIME = "application/vnd.kairos.artifact+json";

export type CollaborationStatus = "open" | "completed" | "cancelled" | "archived";
export type TaskStatus = "open" | "blocked" | "completed" | "cancelled";
export type DelegationStatus = "pending" | "running" | "submitted" | "superseded" | "failed" | "cancelled";
export type ArtifactStatus = "draft" | "submitted" | "accepted" | "superseded" | "rejected" | "revision_requested";
export type ArtifactKind = "evaluation" | "summary" | "research_note" | "patch" | "decision_record" | "question_answer" | "validation_result" | "final_synthesis";
export type QuestionStatus = "asked" | "answered" | "cancelled";
export type CollaborationNoteVisibility = "human" | "agents" | "all";
export type CollaborationNotePurpose = "progress" | "final_summary";
export type BarrierMode = "all" | "any" | "quorum" | "all_or_timeout";
export type BarrierStatus = "open" | "satisfied" | "timed_out" | "cancelled" | "failed";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired";
export type ApprovalRisk = "low" | "medium" | "high" | "destructive";
export type ValidationStatus = "requested" | "running" | "passed" | "failed" | "cancelled";

export type SourceRef =
  | { kind: "channel_message"; channel: EndpointUri; message_id: string }
  | { kind: "artifact"; artifact_id: string }
  | { kind: "ipc_envelope"; trace_id?: string; correlation_id?: string; msg_id?: string }
  | { kind: "file"; uri: string; version?: string }
  | { kind: "external"; uri: string; label?: string };

export interface CollaborationSession {
  id: string;
  origin: SourceRef;
  source_refs: SourceRef[];
  status: CollaborationStatus;
  title?: string;
  objective?: string;
  acceptance_criteria?: string[];
  created_at: string;
  updated_at?: string;
}

export interface Task {
  id: string;
  session_id: string;
  title: string;
  owner: EndpointUri;
  status: TaskStatus;
  source_refs: SourceRef[];
  trace_refs?: TraceRef[];
  acceptance_criteria?: string[];
  updated_at?: string;
}

export interface Delegation {
  id: string;
  session_id: string;
  task_id: string;
  assignee: EndpointUri;
  role?: string;
  role_label?: string;
  instruction: string;
  expected_output?: string;
  status: DelegationStatus;
  source_refs: SourceRef[];
  trace_refs?: TraceRef[];
  correlation_id?: string;
  started_at?: string;
  submitted_artifact_id?: string;
  updated_at?: string;
  error?: string;
  question_id?: string;
  validation_id?: string;
}

export interface Artifact {
  id: string;
  session_id: string;
  author: EndpointUri;
  kind: ArtifactKind;
  title?: string;
  content: unknown;
  status: ArtifactStatus;
  relates_to?: string[];
  supersedes?: string;
  review?: ArtifactReview;
  source_refs: SourceRef[];
  trace_refs?: TraceRef[];
  created_at: string;
  updated_at?: string;
}

export interface ArtifactReview {
  reviewer: EndpointUri;
  status: Extract<ArtifactStatus, "accepted" | "rejected" | "revision_requested">;
  note?: string;
  reviewed_at: string;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
}

export interface CollaborationQuestion {
  id: string;
  session_id: string;
  from: EndpointUri;
  to: EndpointUri;
  question: string;
  about_refs?: SourceRef[];
  status: QuestionStatus;
  answer_artifact_id?: string;
}

export interface CollaborationNote {
  id: string;
  session_id: string;
  from: EndpointUri;
  to?: EndpointUri[];
  visibility: CollaborationNoteVisibility;
  purpose?: CollaborationNotePurpose;
  text: string;
  delegation_id?: string;
  source_refs: SourceRef[];
  created_at: string;
}

export interface ApprovalRequest {
  id: string;
  session_id: string;
  requester: EndpointUri;
  tool_endpoint: EndpointUri;
  action: string;
  risk: ApprovalRisk;
  payload_summary: string;
  source_refs: SourceRef[];
  trace_refs?: TraceRef[];
  status: ApprovalStatus;
  created_at: string;
  resolved_at?: string;
  resolved_by?: EndpointUri;
  resolution_note?: string;
}

export interface ValidationRecord {
  id: string;
  session_id: string;
  task_id?: string;
  artifact_id?: string;
  requester: EndpointUri;
  validator?: EndpointUri;
  status: ValidationStatus;
  summary?: string;
  source_refs: SourceRef[];
  trace_refs?: TraceRef[];
  created_at: string;
  updated_at?: string;
}

export interface CollaborationDecision {
  id: string;
  session_id: string;
  decider: EndpointUri;
  decision: unknown;
  source_refs: SourceRef[];
  trace_refs?: TraceRef[];
  relates_to?: string[];
  supersedes?: string;
  created_at: string;
}

export interface CollaborationConstraint {
  id: string;
  session_id: string;
  constraint: unknown;
  source_refs: SourceRef[];
  created_at: string;
}

export interface TraceRef {
  trace_id?: string;
  correlation_id?: string;
  msg_id?: string;
  endpoint?: EndpointUri;
  action?: string;
  label: string;
  severity?: "info" | "warning" | "error";
  object_ref?: string;
}

export interface ReplyBarrier {
  id: string;
  session_id: string;
  task_id?: string;
  source_ref: SourceRef;
  owner: EndpointUri;
  expected_from: EndpointUri[];
  notify: EndpointUri[];
  mode: BarrierMode;
  quorum?: number;
  timeout_ms?: number;
  synthesis_requested?: boolean;
  synthesis_reason?: string;
  trace_refs?: TraceRef[];
  status: BarrierStatus;
  replies: Record<EndpointUri, string>;
  wake_artifact_id?: string;
  created_at: string;
  updated_at?: string;
}

export type CollaborationEvent =
  | { id: string; type: "session_created"; at: string; session: CollaborationSession }
  | { id: string; type: "session_updated"; at: string; session_id: string; patch: Partial<CollaborationSession> }
  | { id: string; type: "source_attached"; at: string; session_id: string; source_ref: SourceRef; reason?: string }
  | { id: string; type: "source_detached"; at: string; session_id: string; source_ref: SourceRef; reason?: string }
  | { id: string; type: "acceptance_criteria_recorded"; at: string; session_id: string; criteria: string[]; source_refs?: SourceRef[] }
  | { id: string; type: "scope_updated"; at: string; session_id: string; objective?: string; title?: string; source_refs?: SourceRef[] }
  | { id: string; type: "constraint_recorded"; at: string; session_id: string; constraint_id?: string; constraint: unknown; source_refs?: SourceRef[] }
  | { id: string; type: "task_created"; at: string; task: Task }
  | { id: string; type: "task_updated"; at: string; session_id: string; task_id: string; patch: Partial<Task> }
  | { id: string; type: "delegation_created"; at: string; delegation: Delegation }
  | { id: string; type: "delegation_started"; at: string; session_id: string; delegation_id: string; correlation_id: string; started_at?: string }
  | { id: string; type: "delegation_updated"; at: string; session_id: string; delegation_id: string; patch: Partial<Delegation> }
  | { id: string; type: "artifact_submitted"; at: string; artifact: Artifact; delegation_id?: string }
  | { id: string; type: "artifact_updated"; at: string; session_id: string; artifact_id: string; patch: Partial<Artifact> }
  | { id: string; type: "artifact_reviewed"; at: string; session_id: string; artifact_id: string; review: ArtifactReview }
  | { id: string; type: "question_asked"; at: string; question: CollaborationQuestion }
  | { id: string; type: "question_answered"; at: string; session_id: string; question_id: string; answer_artifact_id: string }
  | { id: string; type: "note_posted"; at: string; note: CollaborationNote }
  | { id: string; type: "approval_requested"; at: string; approval: ApprovalRequest }
  | { id: string; type: "approval_resolved"; at: string; session_id: string; approval_id: string; patch: Partial<ApprovalRequest> }
  | { id: string; type: "validation_requested"; at: string; validation: ValidationRecord }
  | { id: string; type: "validation_started"; at: string; session_id: string; validation_id: string; validator?: EndpointUri }
  | { id: string; type: "validation_recorded"; at: string; session_id: string; validation_id: string; patch: Partial<ValidationRecord> }
  | { id: string; type: "validation_failed"; at: string; session_id: string; validation_id: string; summary?: string; trace_refs?: TraceRef[] }
  | { id: string; type: "decision_recorded"; at: string; session_id: string; decision: CollaborationDecision | unknown; source_refs: SourceRef[]; trace_refs?: TraceRef[]; decider?: EndpointUri; relates_to?: string[]; supersedes?: string }
  | { id: string; type: "barrier_created"; at: string; barrier: ReplyBarrier }
  | { id: string; type: "barrier_updated"; at: string; session_id: string; barrier_id: string; patch: Partial<ReplyBarrier> }
  | { id: string; type: "barrier_satisfied"; at: string; session_id: string; barrier_id: string }
  | { id: string; type: "barrier_timed_out"; at: string; session_id: string; barrier_id: string }
  | { id: string; type: "synthesis_requested"; at: string; session_id: string; task_id?: string; reason?: string; source_refs?: SourceRef[] }
  | { id: string; type: "handoff_recorded"; at: string; session_id: string; artifact_id: string; source_refs?: SourceRef[] }
  | { id: string; type: "agent_run_cancelled"; at: string; session_id: string; correlation_id: string; reason?: string }
  | { id: string; type: "projection_emitted"; at: string; session_id: string; target: EndpointUri; source_event_id: string }
  | { id: string; type: "trace_linked"; at: string; session_id: string; object_ref?: string; trace_ref: TraceRef };

export interface CollaborationState {
  session?: CollaborationSession;
  source_refs: SourceRef[];
  tasks: Record<string, Task>;
  delegations: Record<string, Delegation>;
  artifacts: Record<string, Artifact>;
  questions: Record<string, CollaborationQuestion>;
  notes: Record<string, CollaborationNote>;
  approvals: Record<string, ApprovalRequest>;
  validations: Record<string, ValidationRecord>;
  barriers: Record<string, ReplyBarrier>;
  decisions: CollaborationDecision[];
  constraints: CollaborationConstraint[];
  trace_refs: TraceRef[];
  active_runs: Record<string, { delegation_id: string; assignee: EndpointUri; correlation_id: string }>;
  emitted_projection_event_ids: string[];
}

export interface RenderForAgentRequest {
  audience: EndpointUri;
  purpose: "delegation" | "synthesis" | "review" | "validation" | "handoff";
  delegation_id?: string;
}

export interface RenderedAgentContext {
  session_id: string;
  audience: EndpointUri;
  purpose: RenderForAgentRequest["purpose"];
  text: string;
  source_refs: SourceRef[];
  artifact_refs: string[];
  barrier_refs: string[];
}

export interface ContextCompaction {
  id: string;
  session_id: string;
  audience?: EndpointUri;
  purpose: RenderForAgentRequest["purpose"];
  covers_refs: SourceRef[];
  cursor: {
    before_event_id?: string;
    before_time_ms?: number;
  };
  summary_text: string;
  structured_digest?: {
    claims?: unknown[];
    decisions?: unknown[];
    open_questions?: unknown[];
    artifact_refs?: string[];
    barrier_refs?: string[];
  };
  created_at: string;
  created_by?: EndpointUri;
  created_from_model?: string;
}

export interface HumanProjectionItem {
  kind: "artifact" | "barrier" | "task" | "session" | "approval" | "validation" | "decision";
  id: string;
  author?: EndpointUri;
  title: string;
  text: string;
  source_event_id?: string;
}

export type WorkPhase = "intake" | "shape" | "plan" | "execute" | "review" | "validate" | "decision" | "handoff" | "done";

export type WorkBlockerKind = "waiting_for_artifact" | "pending_question" | "pending_approval" | "pending_validation" | "failed_validation" | "failed_delegation" | "revision_requested";
export type WorkActionKind = "open_thread" | "review_artifact" | "answer_question" | "resolve_approval" | "record_validation" | "request_revision" | "request_synthesis" | "open_trace";

export interface AgentWorkSummary {
  session_id: string;
  session_title?: string;
  agent: EndpointUri;
  status: DelegationStatus;
  delegation_id: string;
  role?: string;
  role_label?: string;
  artifact_id?: string;
  current_work?: string;
  latest_tool_call?: ToolCallSummary;
}

export interface ToolCallSummary {
  endpoint: EndpointUri;
  action: string;
  payload_summary?: string;
  status?: "pending" | "running" | "completed" | "failed" | "cancelled";
  trace_ref?: TraceRef;
}

export type BuildBoardColumnKey = "todo" | "building" | "review" | "validate" | "done";

export interface BuildBoardItem {
  id: string;
  kind: "task" | "delegation" | "artifact" | "approval" | "validation";
  title: string;
  status: string;
  owner?: EndpointUri;
  agent?: EndpointUri;
  summary?: string;
  source_refs: SourceRef[];
  trace_refs: TraceRef[];
}

export interface BuildBoardColumn {
  key: BuildBoardColumnKey;
  label: string;
  items: BuildBoardItem[];
}

export interface BuildBoardProjection {
  active: boolean;
  reason: string;
  write_operations: ToolCallSummary[];
  columns: BuildBoardColumn[];
}

export interface WorkBlocker {
  kind: WorkBlockerKind;
  label: string;
  ref_id?: string;
  waiting_for?: EndpointUri[];
}

export interface WorkAction {
  kind: WorkActionKind;
  label: string;
  target?: string;
}

export interface ArtifactSummary {
  artifact_id: string;
  title: string;
  author: EndpointUri;
  kind: ArtifactKind;
  status: ArtifactStatus;
  text: string;
}

export interface SessionWorkProjection {
  session_id: string;
  title: string;
  objective?: string;
  acceptance_criteria: string[];
  phase: WorkPhase;
  phase_label: string;
  phase_reason: string;
  owner: EndpointUri;
  status: CollaborationStatus | TaskStatus;
  agents: AgentWorkSummary[];
  current_work?: string;
  latest_report?: string;
  latest_artifact?: ArtifactSummary;
  build_board?: BuildBoardProjection;
  blockers: WorkBlocker[];
  actions: WorkAction[];
  origin?: SourceRef;
  source_refs: SourceRef[];
  trace_refs: TraceRef[];
  updated_at?: string;
}

export interface SessionDetailProjection {
  session: SessionWorkProjection;
  tasks: Task[];
  delegations: Delegation[];
  artifacts: Artifact[];
  barriers: ReplyBarrier[];
  decisions: CollaborationDecision[];
  constraints: CollaborationConstraint[];
  questions: CollaborationQuestion[];
  approvals: ApprovalRequest[];
  validations: ValidationRecord[];
  notes: CollaborationNote[];
  trace_refs: TraceRef[];
}

export type ReviewQueueItemKind = "artifact" | "approval" | "question" | "validation" | "decision";

export interface ReviewQueueItem {
  id: string;
  kind: ReviewQueueItemKind;
  session_id: string;
  title: string;
  producer?: EndpointUri;
  required_action: string;
  consequence: string;
  source_refs: SourceRef[];
  trace_refs: TraceRef[];
  actions: WorkAction[];
  created_at?: string;
}

export interface AgentWorkloadItem {
  agent: EndpointUri;
  sessions: AgentWorkSummary[];
  latest_report?: string;
  blockers: WorkBlocker[];
  latest_tool_call?: ToolCallSummary;
}
