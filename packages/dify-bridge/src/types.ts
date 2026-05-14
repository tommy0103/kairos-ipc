import type { EndpointUri } from "../../protocol/src/index.ts";
import type { SourceRef, TraceRef } from "../../collaboration-context/src/index.ts";
import type { IpcNode } from "../../sdk/src/index.ts";
import type { SlockHumanEndpoint } from "../../slock-human/src/index.ts";
import type { TraceView } from "../../slock-ui-bridge/src/trace-viewer.ts";

export interface DifyBridgeOptions {
  uri?: EndpointUri;
  human_node: IpcNode;
  session_manager_uri: EndpointUri;
  human_endpoint?: SlockHumanEndpoint;
  trace_path?: string;
  auth_token?: string;
  allow_unauthenticated?: boolean;
  allowed_origins?: string[];
  max_body_bytes?: number;
}

export interface DifySourceMetadata {
  app_id?: string;
  conversation_id?: string;
  message_id?: string;
  user_id?: string;
  workflow_run_id?: string;
}

export interface DifyCreateSessionRequest {
  title?: string;
  objective?: string;
  acceptance_criteria?: string[];
  source?: DifySourceMetadata;
}

export interface DifyPostMessageRequest {
  text?: string;
  source?: DifySourceMetadata;
}

export interface DifyChatRequest {
  message: string;
  title?: string;
  agents?: EndpointUri[];
  acceptance_criteria?: string[];
  expected_output?: string;
  source?: DifySourceMetadata;
}

export interface DifyStartRunRequest {
  instruction: string;
  agents: EndpointUri[];
  mode?: "parallel" | "sequential";
  expected_output?: string;
  synthesis_requested?: boolean;
  delegation_plan?: DifyDelegationPlanItem[];
  source?: DifySourceMetadata;
}

export interface DifyDelegationPlanItem {
  assignee: EndpointUri;
  role?: string;
  role_label?: string;
  instruction?: string;
  expected_output?: string;
}

export interface DifyCreateSessionResponse {
  session_id: string;
  session_uri: EndpointUri;
  status?: string;
}

export interface DifySessionSummary {
  session_id: string;
  session_uri?: EndpointUri;
  title?: string;
  objective?: string;
  phase?: string;
  status?: string;
  agents: EndpointUri[];
  latest_summary?: string;
  latest_artifact?: DifyArtifactMetadata;
  blockers: string[];
  pending_approvals: DifyApprovalSummary[];
  trace_refs: TraceRef[];
}

export interface DifyStartRunResponse {
  session_id: string;
  runs: DifyRunSummary[];
  task_id?: string;
  barrier_id?: string;
  mode?: "parallel" | "sequential";
  status_url: string;
}

export interface DifyChatResponse {
  session_id: string;
  runs: DifyRunSummary[];
  status_url: string;
  text: string;
}

export interface DifyRunSummary {
  agent: EndpointUri;
  delegation_id: string;
  status?: string;
}

export interface DifyCancelRunRequest {
  session_id?: string;
  reason?: string;
}

export interface DifyCancelRunResponse {
  cancelled: boolean;
  session_id: string;
  delegation_id: string;
  agent?: EndpointUri;
  reason?: string;
}

export interface DifyArtifactListResponse {
  session_id: string;
  artifacts: DifyArtifactMetadata[];
}

export interface DifyArtifactMetadata {
  id: string;
  session_id: string;
  author: EndpointUri;
  kind: string;
  title?: string;
  status?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
}

export interface DifyArtifactDetail extends DifyArtifactMetadata {
  content: unknown;
  review?: DifyArtifactReview;
  relates_to?: string[];
}

export interface DifyArtifactReview {
  reviewer: EndpointUri;
  status: "accepted" | "rejected" | "revision_requested";
  note?: string;
  reviewed_at: string;
}

export interface DifyReviewArtifactRequest {
  session_id?: string;
  status: "accepted" | "rejected" | "revision_requested";
  note?: string;
  reviewer?: EndpointUri;
  revision_instruction?: string;
  rerun?: boolean;
  source?: DifySourceMetadata;
}

export interface DifyReviewArtifactResponse {
  session_id: string;
  artifact_id: string;
  status: "accepted" | "rejected" | "revision_requested";
  note?: string;
}

export interface DifyApprovalListResponse {
  session_id: string;
  approvals: DifyApprovalSummary[];
}

export interface DifyApprovalSummary {
  id: string;
  session_id: string;
  requester: EndpointUri;
  tool_endpoint: EndpointUri;
  action: string;
  risk: string;
  payload_summary: string;
  status: string;
  created_at?: string;
  resolved_at?: string;
  resolved_by?: EndpointUri;
  resolution_note?: string;
}

export interface DifyResolveApprovalRequest {
  session_id?: string;
  status?: "approved" | "rejected" | "cancelled" | "expired";
  approved?: boolean;
  resolved_by?: EndpointUri;
  resolution_note?: string;
}

export interface DifyResolveApprovalResponse {
  session_id: string;
  approval_id: string;
  status: string;
}

export interface DifyTraceResult {
  available: boolean;
  trace_path?: string;
  view: TraceView;
}

export interface DifyApiError {
  error: {
    code: string;
    message: string;
  };
}
