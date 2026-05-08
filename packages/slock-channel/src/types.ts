import type { EndpointUri } from "../../protocol/src/index.ts";

export const SLOCK_MESSAGE_MIME = "application/vnd.slock.message+json";
export const SLOCK_CHANNEL_EVENT_MIME = "application/vnd.slock.channel-event+json";
export const SLOCK_AGENT_RUN_MIME = "application/vnd.slock.agent-run+json";
export const SLOCK_MESSAGE_DELTA_MIME = "application/vnd.slock.message-delta+json";
export const SLOCK_AGENT_RESULT_MIME = "application/vnd.slock.agent-result+json";
export const SLOCK_PROJECTION_MIME = "application/vnd.slock.projection+json";
export const SLOCK_APPROVAL_REQUEST_MIME = "application/vnd.slock.approval-request+json";
export const SLOCK_APPROVAL_RESULT_MIME = "application/vnd.slock.approval-result+json";
export const SLOCK_SHELL_EXEC_MIME = "application/vnd.slock.shell-exec+json";
export const SLOCK_SHELL_RESULT_MIME = "application/vnd.slock.shell-result+json";

export interface SlockMessageInput {
  text: string;
  mentions?: EndpointUri[];
  thread_id?: string | null;
  reply_to_id?: string | null;
}

export interface SlockMessageUpdateInput {
  message_id: string;
  text: string;
}

export interface SlockTypingStartedInput {
  thread_id?: string | null;
}

export interface SlockSubscriptionClosedInput {
  subscriber?: EndpointUri;
  reason?: string;
}

export interface SlockCancelAgentRunRequest {
  message_id: string;
  reason?: string;
}

export interface SlockCancelAgentRunResult {
  cancelled: boolean;
  message_id: string;
  agent?: EndpointUri;
  agents?: EndpointUri[];
  reason?: string;
}

export interface SlockProjectionInput {
  sender: EndpointUri;
  text: string;
  thread_id?: string | null;
  reply_to_id?: string | null;
  kind?: "agent" | "system";
  source_event_id?: string;
  title?: string;
}

export interface SlockMessage {
  id: string;
  channel: EndpointUri;
  sender: EndpointUri;
  text: string;
  mentions: EndpointUri[];
  thread_id: string | null;
  reply_to_id: string | null;
  kind: "human" | "agent" | "system";
  created_at: string;
  updated_at?: string;
}

export interface SlockHistoryRequest {
  limit?: number;
  until_id?: string;
  thread_id?: string | null;
}

export interface SlockHistoryResult {
  messages: SlockMessage[];
}

export interface SlockChannelEvent {
  type:
    | "message_created"
    | "message_updated"
    | "message_delta"
    | "agent_run_started"
    | "agent_run_finished"
    | "typing_started"
    | "approval_requested"
    | "approval_resolved"
    | "subscription_closed"
    | "agent_error"
    | "agent_cancelled";
  channel: EndpointUri;
  message?: SlockMessage;
  delta?: {
    thread_id: string;
    text: string;
    source: EndpointUri;
    kind?: "text" | "status";
    metadata?: Record<string, unknown>;
  };
  run?: SlockAgentRunEvent;
  error?: {
    code: string;
    message: string;
    source: EndpointUri;
  };
  cancelled?: {
    message_id: string;
    agent: EndpointUri;
    reason?: string;
  };
  typing?: {
    source: EndpointUri;
    thread_id?: string | null;
  };
  subscription?: {
    subscriber: EndpointUri;
    reason?: string;
  };
  approval?: SlockApprovalEvent;
  id?: string;
  result?: SlockApprovalResult;
}

export interface SlockAgentRunEvent {
  run_id: string;
  message_id: string;
  thread_id?: string | null;
  agent: EndpointUri;
  state: "started" | "completed" | "errored" | "cancelled";
  started_at?: string;
  finished_at?: string;
  final_message_id?: string;
  reason?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface SlockAgentRun {
  channel: EndpointUri;
  message_id: string;
  run_id?: string;
  thread_id?: string | null;
  text: string;
  sender: EndpointUri;
  session_id?: string;
  delegation_id?: string;
  purpose?: "delegation" | "synthesis" | "review" | "handoff";
  context_text?: string;
  source_refs?: unknown[];
  artifact_refs?: string[];
  barrier_refs?: string[];
}

export interface SlockAgentResult {
  summary: string;
  final_text?: string;
  final_message_id?: string;
  cancelled?: boolean;
  reason?: string;
}

export interface SlockApprovalRequest {
  id?: string;
  risk: string;
  summary: string;
  metadata?: Record<string, unknown>;
  proposed_call: {
    target: EndpointUri;
    action: string;
    payload: unknown;
  };
}

export interface SlockApprovalEvent {
  id: string;
  request: SlockApprovalRequest;
  source: EndpointUri;
  created_at: string;
}

export interface SlockApprovalResult {
  approved: boolean;
  grant_ttl_ms?: number;
  reason?: string;
  grant?: SlockCapabilityGrant;
}

export interface SlockCapabilityGrant {
  id: string;
  token: string;
  source: EndpointUri;
  target: EndpointUri;
  actions: string[];
  issued_at: string;
  expires_at: string;
  approval_id?: string;
  risk?: string;
}

export interface SlockApprovalWithdrawRequest {
  id: string;
  reason?: string;
}

export interface SlockApprovalWithdrawResult {
  withdrawn: boolean;
  id: string;
  reason?: string;
}

export interface SlockShellExecRequest {
  command: string;
  args?: string[];
  cwd?: string;
  approval_grant?: SlockCapabilityGrant;
}

export interface SlockShellExecResult {
  command: string;
  args: string[];
  cwd: string;
  exit_code: number;
  stdout: string;
  stderr: string;
}
