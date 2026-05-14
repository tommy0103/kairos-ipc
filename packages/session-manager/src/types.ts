import type { EndpointUri } from "../../protocol/src/index.ts";
import type { IpcNode } from "../../sdk/src/index.ts";
import type {
  Artifact,
  ArtifactReview,
  CollaborationStatus,
  CollaborationNote,
  CollaborationNotePurpose,
  CollaborationNoteVisibility,
  CollaborationQuestion,
  ContextCompaction,
  CollaborationEvent,
  CollaborationState,
  AgentWorkloadItem,
  ApprovalRequest,
  ApprovalRisk,
  ApprovalStatus,
  RenderForAgentRequest,
  RenderedAgentContext,
  ReviewQueueItem,
  SessionDetailProjection,
  SessionWorkProjection,
  SourceRef,
  TraceRef,
  ValidationRecord,
  ValidationStatus,
} from "../../collaboration-context/src/index.ts";
import type { SlockMessage } from "../../slock-channel/src/index.ts";

export const KAIROS_SESSION_MANAGER_URI = "app://kairos/session-manager" as EndpointUri;
export const KAIROS_SESSION_ROUTE_MIME = "application/vnd.kairos.session-route+json";
export const KAIROS_SESSION_STATE_MIME = "application/vnd.kairos.session-state+json";
export const KAIROS_DASHBOARD_EVENT_MIME = "application/vnd.kairos.dashboard-event+json";

export interface SessionManagerOptions {
  uri?: EndpointUri;
  default_agent_ttl_ms?: number;
  coordinator_uri?: EndpointUri;
  agent_event_channel_uri?: EndpointUri;
}

export interface SessionRecord {
  id: string;
  uri: EndpointUri;
  events: CollaborationEvent[];
  state: CollaborationState;
  compactions: ContextCompaction[];
}

export interface SessionManagerEndpoint {
  node: IpcNode;
  sessions: Map<string, SessionRecord>;
  getSession(id: string): SessionRecord | undefined;
}

export interface SessionManagerRouteMessageRequest {
  message: SlockMessage;
  mentions?: EndpointUri[];
  session_id?: string;
  new_session?: boolean;
  title?: string;
  objective?: string;
  acceptance_criteria?: string[];
  delegation_plan?: SessionManagerDelegationPlanItem[];
}

export interface SessionManagerDelegationPlanItem {
  assignee: EndpointUri;
  role?: string;
  role_label?: string;
  instruction?: string;
  expected_output?: string;
}

export type SessionManagerDelegationMode = "parallel" | "sequential";

export interface SessionManagerStartDelegationsRequest {
  session_id: string;
  task_id?: string;
  task_title?: string;
  owner?: EndpointUri;
  instruction: string;
  expected_output?: string;
  mode?: SessionManagerDelegationMode;
  synthesis_requested?: boolean;
  synthesis_reason?: string;
  source_refs?: SourceRef[];
  delegations: SessionManagerDirectDelegationItem[];
}

export interface SessionManagerDirectDelegationItem {
  assignee: EndpointUri;
  role?: string;
  role_label?: string;
  instruction?: string;
  expected_output?: string;
}

export interface SessionManagerStartDelegationsResult {
  session_id: string;
  task_id: string;
  delegation_ids: string[];
  barrier_id?: string;
  mode: SessionManagerDelegationMode;
}

export interface SessionManagerCancelDelegationRunRequest {
  session_id: string;
  delegation_id: string;
  reason?: string;
}

export interface SessionManagerCancelDelegationRunResult {
  cancelled: boolean;
  session_id: string;
  delegation_id: string;
  agent?: EndpointUri;
  reason?: string;
}

export interface SessionManagerRouteMessageResult {
  session_id: string;
  session_uri: EndpointUri;
  created: boolean;
  attached: boolean;
  source_ref: SourceRef;
  delegations_created: string[];
  barrier_id?: string;
}

export interface SessionManagerResolveRequest {
  source_ref?: SourceRef;
  channel?: EndpointUri;
  message_id?: string;
  thread_id?: string | null;
}

export interface SessionManagerResolveResult {
  session_id?: string;
  session_uri?: EndpointUri;
}

export interface SessionManagerAttachSourceRequest {
  session_id?: string;
  message?: SlockMessage;
  source_ref?: SourceRef;
  reason?: string;
}

export interface SessionManagerCreateSessionRequest {
  session_id?: string;
  title?: string;
  objective?: string;
  acceptance_criteria?: string[];
  owner?: EndpointUri;
  message?: SlockMessage;
  source_ref?: SourceRef;
}

export interface SessionManagerUpdateSessionGoalRequest {
  session_id: string;
  title?: string;
  objective?: string;
  acceptance_criteria?: string[];
  constraints?: unknown[];
  source_refs?: SourceRef[];
}

export interface SessionManagerCloseSessionRequest {
  session_id: string;
  status?: Extract<CollaborationStatus, "completed" | "cancelled" | "archived">;
  reason?: string;
}

export interface SessionManagerReopenSessionRequest {
  session_id: string;
  reason?: string;
}

export interface SessionManagerMoveSourceRequest {
  to_session_id: string;
  from_session_id?: string;
  message?: SlockMessage;
  source_ref?: SourceRef;
  reason?: string;
}

export interface SessionManagerSubmitArtifactRequest {
  session_id: string;
  delegation_id?: string;
  artifact: Partial<Artifact> & Pick<Artifact, "author" | "kind" | "content">;
  project?: boolean;
}

export interface SessionManagerReviewArtifactRequest {
  session_id: string;
  artifact_id: string;
  status: ArtifactReview["status"];
  note?: string;
  reviewer?: EndpointUri;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
  revision_instruction?: string;
  rerun?: boolean;
}

export interface SessionManagerRequestApprovalRequest {
  session_id: string;
  requester?: EndpointUri;
  tool_endpoint: EndpointUri;
  action: string;
  risk?: ApprovalRisk;
  payload_summary: string;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
}

export interface SessionManagerResolveApprovalRequest {
  session_id: string;
  approval_id: string;
  status?: Exclude<ApprovalStatus, "pending">;
  approved?: boolean;
  resolved_by?: EndpointUri;
  resolution_note?: string;
  trace_refs?: TraceRef[];
}

export interface SessionManagerRequestValidationRequest {
  session_id: string;
  task_id?: string;
  artifact_id?: string;
  requester?: EndpointUri;
  validator?: EndpointUri;
  summary?: string;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
  run?: boolean;
}

export interface SessionManagerRunValidationRequest {
  session_id: string;
  validation_id: string;
  validator?: EndpointUri;
}

export interface SessionManagerRecordValidationRequest {
  session_id: string;
  validation_id: string;
  status: Exclude<ValidationStatus, "requested">;
  summary?: string;
  validator?: EndpointUri;
  artifact?: Partial<Artifact> & Pick<Artifact, "author" | "content">;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
}

export interface SessionManagerRequestSynthesisRequest {
  session_id: string;
  task_id?: string;
  barrier_id?: string;
  reason?: string;
  source_refs?: SourceRef[];
}

export interface SessionManagerAskQuestionRequest {
  session_id: string;
  to: EndpointUri;
  from?: EndpointUri;
  question: string;
  about_refs?: SourceRef[];
}

export interface SessionManagerAnswerQuestionRequest {
  session_id: string;
  question_id: string;
  artifact?: Partial<Artifact> & Pick<Artifact, "author" | "content">;
  answer?: string;
  project?: boolean;
}

export interface SessionManagerReportMessageRequest {
  session_id: string;
  text: string;
  delegation_id?: string;
  to?: EndpointUri[];
  visibility?: CollaborationNoteVisibility;
  purpose?: CollaborationNotePurpose;
  source_refs?: SourceRef[];
  project?: boolean;
}

export interface SessionManagerReportMessageResult {
  session_id: string;
  note: CollaborationNote;
  projected_message_id?: string;
}

export interface SessionManagerRecordDecisionRequest {
  session_id: string;
  decision: unknown;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
  decider?: EndpointUri;
  relates_to?: string[];
  supersedes?: string;
}

export interface SessionManagerLinkTraceRequest {
  session_id: string;
  object_ref?: string;
  trace_ref: TraceRef;
}

export interface SessionManagerRecordContextCompactionRequest extends Omit<ContextCompaction, "id" | "created_at"> {
  id?: string;
  created_at?: string;
}

export interface SessionManagerListContextCompactionsRequest {
  session_id: string;
  audience?: EndpointUri;
  purpose?: RenderForAgentRequest["purpose"];
}

export interface SessionManagerListContextCompactionsResult {
  compactions: ContextCompaction[];
}

export interface SessionManagerWorkSessionsResult {
  sessions: SessionWorkProjection[];
}

export interface SessionManagerDashboardSubscriptionRequest {
  session_id?: string;
  include_snapshot?: boolean;
  include_detail?: boolean;
}

export interface SessionManagerDashboardUnsubscribeRequest {
  subscriber?: EndpointUri;
  reason?: string;
}

export interface SessionManagerDashboardSubscriptionResult {
  subscribed: boolean;
  subscriber: EndpointUri;
  session_id?: string;
}

export interface SessionManagerDashboardUnsubscribeResult {
  unsubscribed: boolean;
  subscriber: EndpointUri;
  reason?: string;
}

export interface SessionManagerDashboardSnapshot {
  at: string;
  sequence: number;
  sessions: SessionWorkProjection[];
  review_queue: ReviewQueueItem[];
  agent_workload: AgentWorkloadItem[];
  session_id?: string;
  detail?: SessionDetailProjection;
}

export type SessionManagerDashboardEvent =
  | (SessionManagerDashboardSnapshot & {
    type: "dashboard_snapshot";
  })
  | (SessionManagerDashboardSnapshot & {
    type: "session_updated";
    session_id: string;
    session?: SessionWorkProjection;
    source_event: {
      id: string;
      type: CollaborationEvent["type"];
      at: string;
    };
  })
  | {
    type: "dashboard_subscription_closed";
    at: string;
    sequence: number;
    subscriber: EndpointUri;
    reason?: string;
  };

export type SessionManagerDashboardSnapshotResult = SessionManagerDashboardSnapshot;

export interface SessionManagerWorkSessionResult {
  session?: SessionWorkProjection;
}

export interface SessionManagerSessionDetailResult {
  session?: SessionDetailProjection;
}

export interface SessionManagerReviewQueueResult {
  items: ReviewQueueItem[];
}

export interface SessionManagerAgentWorkloadResult {
  agents: AgentWorkloadItem[];
}

export interface SessionManagerQuestionResult {
  question: CollaborationQuestion;
  delegation_id?: string;
}

export interface SessionManagerApprovalResult {
  approval: ApprovalRequest;
}

export interface SessionManagerValidationResult {
  validation: ValidationRecord;
  artifact_id?: string;
  delegation_id?: string;
}

export interface SessionManagerSessionSnapshot {
  session_id: string;
  session_uri: EndpointUri;
  events: CollaborationEvent[];
  state: CollaborationState;
  compactions: ContextCompaction[];
}

export interface SessionManagerRenderContextRequest extends RenderForAgentRequest {
  session_id: string;
}

export type SessionManagerRenderContextResult = RenderedAgentContext;
