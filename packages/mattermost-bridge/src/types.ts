import type { EndpointUri } from "../../protocol/src/index.ts";
import type { SourceRef } from "../../collaboration-context/src/index.ts";
import type { IpcNode } from "../../sdk/src/index.ts";

export type MattermostResponseType = "ephemeral" | "in_channel";
export type MattermostActionType = "button" | "select";
export type MattermostDialogElementType = "text" | "textarea" | "select" | "radio" | "bool" | "username" | "channel";

export interface MattermostBridgeOptions {
  uri?: EndpointUri;
  human_node: IpcNode;
  session_manager_uri: EndpointUri;
  mattermost_base_url: string;
  bot_token: string;
  slash_command_token?: string;
  allowed_team_ids?: string[];
  allowed_user_ids?: string[];
  allowed_origins?: string[];
  require_origin?: boolean;
  bridge_public_url?: string;
  trace_path?: string;
  max_body_bytes?: number;
  max_json_body_bytes?: number;
  max_form_body_bytes?: number;
  mattermost_request_timeout_ms?: number;
  callback_token_ttl_ms?: number;
  max_projection_posts?: number;
}

export interface MattermostBotClientOptions {
  mattermost_base_url: string;
  bot_token: string;
  timeout_ms?: number;
  fetch?: typeof fetch;
}

export interface MattermostSourceMetadata {
  team_id: string;
  channel_id: string;
  post_id?: string;
  user_id?: string;
  action?: string;
}

export interface MattermostSlashCallback {
  token?: string;
  team_id: string;
  team_domain?: string;
  channel_id: string;
  channel_name?: string;
  post_id?: string;
  user_id: string;
  user_name?: string;
  command: string;
  text?: string;
  response_url?: string;
  trigger_id?: string;
}

export interface MattermostIntegrationContext {
  action?: string;
  session_id?: string;
  artifact_id?: string;
  approval_id?: string;
  question_id?: string;
  task_id?: string;
  delegation_id?: string;
  source_ref?: SourceRef;
  [key: string]: unknown;
}

export interface MattermostInteractiveActionCallback {
  user_id: string;
  user_name?: string;
  team_id: string;
  team_domain?: string;
  channel_id: string;
  channel_name?: string;
  post_id?: string;
  trigger_id?: string;
  type?: string;
  context?: MattermostIntegrationContext;
  selected_option?: string;
  selected_options?: string[];
}

export interface MattermostDialogSubmission {
  type?: string;
  callback_id?: string;
  state?: string;
  user_id: string;
  user_name?: string;
  team_id: string;
  team_domain?: string;
  channel_id: string;
  channel_name?: string;
  submission: Record<string, string | boolean | string[] | undefined>;
  cancelled?: boolean;
}

export interface MattermostCommandResponse {
  response_type?: MattermostResponseType;
  text?: string;
  username?: string;
  icon_url?: string;
  props?: Record<string, unknown>;
  attachments?: MattermostAttachment[];
}

export interface MattermostActionResponse {
  ephemeral_text?: string;
  update?: MattermostActionUpdate;
  skip_slack_parsing?: boolean;
}

export interface MattermostActionErrorResponse {
  error: { message: string };
}

export interface MattermostActionUpdate {
  message?: string;
  props?: Record<string, unknown>;
}

export interface MattermostPost {
  id?: string;
  channel_id: string;
  root_id?: string;
  message: string;
  props?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface MattermostCreatePostRequest extends MattermostPost {}

export interface MattermostUpdatePostRequest {
  id?: string;
  channel_id?: string;
  root_id?: string;
  message?: string;
  props?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface MattermostPostResponse extends MattermostPost {
  id: string;
  create_at?: number;
  update_at?: number;
  user_id?: string;
}

export interface MattermostAttachment {
  id?: number | string;
  fallback?: string;
  color?: string;
  pretext?: string;
  author_name?: string;
  author_link?: string;
  author_icon?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: MattermostAttachmentField[];
  actions?: MattermostAction[];
  footer?: string;
  props?: Record<string, unknown>;
}

export interface MattermostAttachmentField {
  title: string;
  value: string;
  short?: boolean;
}

export interface MattermostAction {
  id?: string;
  name: string;
  type: MattermostActionType;
  style?: "default" | "primary" | "success" | "warning" | "danger";
  options?: MattermostActionOption[];
  integration: MattermostActionIntegration;
}

export interface MattermostActionOption {
  text: string;
  value: string;
}

export interface MattermostActionIntegration {
  url: string;
  context?: MattermostIntegrationContext;
}

export interface MattermostDialogRequest {
  trigger_id: string;
  url: string;
  dialog: MattermostDialog;
}

export interface MattermostDialog {
  callback_id?: string;
  title: string;
  introduction_text?: string;
  icon_url?: string;
  elements: MattermostDialogElement[];
  submit_label?: string;
  notify_on_cancel?: boolean;
  state?: string;
}

export interface MattermostDialogElement {
  display_name: string;
  name: string;
  type: MattermostDialogElementType;
  subtype?: string;
  default?: string | boolean | string[];
  placeholder?: string;
  help_text?: string;
  optional?: boolean;
  min_length?: number;
  max_length?: number;
  options?: MattermostActionOption[];
}

export interface MattermostDialogResponse {
  error?: string;
  errors?: Record<string, string>;
}

export interface MattermostCardActionUrls {
  action_url?: string;
  artifact_url?: string;
  trace_url?: string;
}
