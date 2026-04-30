import type { EndpointUri } from "../../protocol/src/index.ts";

export const SLOCK_MESSAGE_MIME = "application/vnd.slock.message+json";
export const SLOCK_CHANNEL_EVENT_MIME = "application/vnd.slock.channel-event+json";
export const SLOCK_AGENT_RUN_MIME = "application/vnd.slock.agent-run+json";
export const SLOCK_MESSAGE_DELTA_MIME = "application/vnd.slock.message-delta+json";
export const SLOCK_AGENT_RESULT_MIME = "application/vnd.slock.agent-result+json";
export const SLOCK_APPROVAL_REQUEST_MIME = "application/vnd.slock.approval-request+json";
export const SLOCK_APPROVAL_RESULT_MIME = "application/vnd.slock.approval-result+json";
export const SLOCK_SHELL_EXEC_MIME = "application/vnd.slock.shell-exec+json";
export const SLOCK_SHELL_RESULT_MIME = "application/vnd.slock.shell-result+json";

export interface SlockMessageInput {
  text: string;
  mentions?: EndpointUri[];
  thread_id?: string | null;
}

export interface SlockMessage {
  id: string;
  channel: EndpointUri;
  sender: EndpointUri;
  text: string;
  mentions: EndpointUri[];
  thread_id: string | null;
  kind: "human" | "agent" | "system";
  created_at: string;
}

export interface SlockChannelEvent {
  type: "message_created" | "message_delta" | "agent_error";
  channel: EndpointUri;
  message?: SlockMessage;
  delta?: {
    thread_id: string;
    text: string;
    source: EndpointUri;
  };
  error?: {
    code: string;
    message: string;
    source: EndpointUri;
  };
}

export interface SlockAgentRun {
  channel: EndpointUri;
  message_id: string;
  text: string;
  sender: EndpointUri;
}

export interface SlockAgentResult {
  summary: string;
  final_text?: string;
  final_message_id?: string;
}

export interface SlockApprovalRequest {
  id?: string;
  risk: string;
  summary: string;
  proposed_call: {
    target: EndpointUri;
    action: string;
    payload: unknown;
  };
}

export interface SlockApprovalResult {
  approved: boolean;
  grant_ttl_ms?: number;
  reason?: string;
}

export interface SlockShellExecRequest {
  command: string;
  args?: string[];
  cwd?: string;
}

export interface SlockShellExecResult {
  command: string;
  args: string[];
  cwd: string;
  exit_code: number;
  stdout: string;
  stderr: string;
}
