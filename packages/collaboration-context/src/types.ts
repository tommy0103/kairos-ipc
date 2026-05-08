import type { EndpointUri } from "../../protocol/src/index.ts";

export const KAIROS_COLLABORATION_EVENT_MIME = "application/vnd.kairos.collaboration-event+json";
export const KAIROS_CONTEXT_RENDER_REQUEST_MIME = "application/vnd.kairos.context-render-request+json";
export const KAIROS_ARTIFACT_MIME = "application/vnd.kairos.artifact+json";

export type CollaborationStatus = "open" | "completed" | "cancelled" | "archived";
export type TaskStatus = "open" | "blocked" | "completed" | "cancelled";
export type DelegationStatus = "pending" | "running" | "submitted" | "superseded" | "failed" | "cancelled";
export type ArtifactStatus = "draft" | "submitted" | "accepted" | "superseded" | "rejected";
export type ArtifactKind = "evaluation" | "summary" | "research_note" | "patch" | "decision_record" | "question_answer";
export type QuestionStatus = "asked" | "answered" | "cancelled";
export type BarrierMode = "all" | "any" | "quorum" | "all_or_timeout";
export type BarrierStatus = "open" | "satisfied" | "timed_out" | "cancelled" | "failed";

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
}

export interface Delegation {
  id: string;
  session_id: string;
  task_id: string;
  assignee: EndpointUri;
  instruction: string;
  expected_output?: string;
  status: DelegationStatus;
  source_refs: SourceRef[];
  correlation_id?: string;
  started_at?: string;
  submitted_artifact_id?: string;
  updated_at?: string;
  error?: string;
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
  source_refs: SourceRef[];
  created_at: string;
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
  status: BarrierStatus;
  replies: Record<EndpointUri, string>;
  wake_artifact_id?: string;
  created_at: string;
  updated_at?: string;
}

export type CollaborationEvent =
  | { id: string; type: "session_created"; at: string; session: CollaborationSession }
  | { id: string; type: "source_attached"; at: string; session_id: string; source_ref: SourceRef; reason?: string }
  | { id: string; type: "task_created"; at: string; task: Task }
  | { id: string; type: "task_updated"; at: string; session_id: string; task_id: string; patch: Partial<Task> }
  | { id: string; type: "delegation_created"; at: string; delegation: Delegation }
  | { id: string; type: "delegation_started"; at: string; session_id: string; delegation_id: string; correlation_id: string; started_at?: string }
  | { id: string; type: "delegation_updated"; at: string; session_id: string; delegation_id: string; patch: Partial<Delegation> }
  | { id: string; type: "artifact_submitted"; at: string; artifact: Artifact; delegation_id?: string }
  | { id: string; type: "question_asked"; at: string; question: CollaborationQuestion }
  | { id: string; type: "question_answered"; at: string; session_id: string; question_id: string; answer_artifact_id: string }
  | { id: string; type: "decision_recorded"; at: string; session_id: string; decision: unknown; source_refs: SourceRef[] }
  | { id: string; type: "barrier_created"; at: string; barrier: ReplyBarrier }
  | { id: string; type: "barrier_updated"; at: string; session_id: string; barrier_id: string; patch: Partial<ReplyBarrier> }
  | { id: string; type: "barrier_satisfied"; at: string; session_id: string; barrier_id: string }
  | { id: string; type: "agent_run_cancelled"; at: string; session_id: string; correlation_id: string; reason?: string }
  | { id: string; type: "projection_emitted"; at: string; session_id: string; target: EndpointUri; source_event_id: string };

export interface CollaborationState {
  session?: CollaborationSession;
  source_refs: SourceRef[];
  tasks: Record<string, Task>;
  delegations: Record<string, Delegation>;
  artifacts: Record<string, Artifact>;
  questions: Record<string, CollaborationQuestion>;
  barriers: Record<string, ReplyBarrier>;
  decisions: unknown[];
  active_runs: Record<string, { delegation_id: string; assignee: EndpointUri; correlation_id: string }>;
  emitted_projection_event_ids: string[];
}

export interface RenderForAgentRequest {
  audience: EndpointUri;
  purpose: "delegation" | "synthesis" | "review" | "handoff";
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

export interface HumanProjectionItem {
  kind: "artifact" | "barrier" | "task" | "session";
  id: string;
  author?: EndpointUri;
  title: string;
  text: string;
  source_event_id?: string;
}
