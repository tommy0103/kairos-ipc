<script setup lang="ts">
import { Activity, Bot, Check, ChevronRight, CornerDownRight, MessageSquare, RefreshCw, Search, Send, ShieldAlert, TerminalSquare, X } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";

type EndpointUri = string;
type ActiveView = "chat" | "agent" | "trace";
type RowClass = "delta" | "error";
type RunState = "active" | "cancelling" | "cancelled" | "completed";
type ToolState = "running" | "completed" | "errored";
type AgentStatusState = "running" | "streaming" | "completed" | "errored" | "cancelled";
type AgentStatusVisualState = AgentStatusState | "waiting";
type EndpointKind = "agent" | "app" | "plugin" | "local" | "unknown";

interface SlockUiBridgeChannel {
  uri: EndpointUri;
  label?: string;
  kind?: "channel" | "dm";
}

interface SlockMessage {
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

interface SlockMessageDelta {
  thread_id: string;
  text: string;
  source: EndpointUri;
  kind?: "text" | "status";
  metadata?: Record<string, unknown>;
}

interface SlockAgentRunEvent {
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

interface SlockApprovalRequest {
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

interface SlockApprovalEvent {
  id: string;
  request: SlockApprovalRequest;
  source: EndpointUri;
  created_at: string;
}

interface SlockCapabilityGrant {
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

interface SlockApprovalResult {
  approved: boolean;
  grant_ttl_ms?: number;
  reason?: string;
  grant?: SlockCapabilityGrant;
}

interface SlockChannelEvent {
  type:
    | "bridge_connected"
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
  channel?: EndpointUri;
  channels?: SlockUiBridgeChannel[];
  message?: SlockMessage;
  delta?: SlockMessageDelta;
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

interface TraceViewerEvent extends Record<string, unknown> {
  id: string;
  index: number;
  label: string;
  detail: string;
  group_key: string;
  direction: "request" | "response" | "stream" | "lifecycle" | "event";
  endpoint_flow: string;
  relation_summary: string;
  relations: TraceViewerRelation[];
  causal_depth: number;
  causal_parent_id?: string;
  timestamp?: string;
  event?: string;
  msg_id?: string;
  correlation_id?: string | null;
  source?: string;
  target?: string;
  op_code?: string;
  action?: string | null;
  route_result?: string;
  error_reason?: string | null;
  payload_kind?: string;
  payload_size?: number;
  channel?: string;
  message_id?: string;
  thread_id?: string | null;
  approval_id?: string;
  approval_risk?: string;
  approval_target?: string;
  approval_action?: string;
  approval_decision?: boolean;
  shell_command?: string;
  shell_exit_code?: number;
}

interface TraceViewerRelation {
  kind: "thread" | "message" | "correlation" | "approval" | "tool" | "grant" | "channel" | "reply";
  value: string;
  label: string;
}

interface TraceViewerGroupSummary {
  event_count: number;
  first_timestamp?: string;
  last_timestamp?: string;
  route_results: Record<string, number>;
  approvals: number;
  rejected_approvals: number;
  endpoints: string[];
  relations: TraceViewerRelation[];
  requests: number;
  responses: number;
  streams: number;
  failures: number;
}

interface TraceViewerGroup {
  id: string;
  kind: "thread" | "correlation" | "approval" | "endpoint" | "event";
  title: string;
  events: TraceViewerEvent[];
  summary: TraceViewerGroupSummary;
}

interface TraceViewerStats {
  total_events: number;
  group_count: number;
  approvals: number;
  rejected_approvals: number;
  shell_calls: number;
  route_results: Record<string, number>;
}

interface TraceViewerResponse {
  available: boolean;
  trace_path?: string | null;
  events?: TraceViewerEvent[];
  groups?: TraceViewerGroup[];
  stats?: TraceViewerStats;
}

interface TraceState {
  available: boolean;
  loading: boolean;
  error: string;
  tracePath: string | null;
  events: TraceViewerEvent[];
  groups: TraceViewerGroup[];
  stats: TraceViewerStats;
}

interface ToolMetadata extends Record<string, unknown> {
  type: "tool_call";
  tool_call_id: string;
  name: string;
  state?: string;
  arguments?: unknown;
  result?: unknown;
}

interface SimpleRow {
  rowType: "simple";
  id: string;
  className: RowClass;
  meta: string;
  text: string;
  renderedId?: string;
  threadReply?: boolean;
}

interface MessageRow {
  rowType: "message";
  id: string;
  message: SlockMessage;
  threadReply: boolean;
  runState: RunState;
}

interface ToolRow {
  rowType: "tool";
  id: string;
  channel?: EndpointUri;
  source: EndpointUri;
  threadId: string;
  threadReply: boolean;
  receivedAt?: string;
  sequence?: number;
  toolCallId: string;
  state: ToolState;
  name: string;
  preview: string;
  argumentsText: string;
  open: boolean;
  resultSummary?: string;
  resultText?: string;
  approval?: SlockApprovalEvent;
  approvalResult?: SlockApprovalResult;
}

interface AgentStatusRow {
  rowType: "agent-status";
  id: string;
  channel?: EndpointUri;
  source: EndpointUri;
  threadId: string;
  threadReply: boolean;
  receivedAt?: string;
  sequence?: number;
  runId?: string;
  messageId?: string;
  startedAt?: string;
  finishedAt?: string;
  lastActivityAt?: string;
  finalMessageId?: string;
  errorMessage?: string;
  state: AgentStatusState;
  text: string;
  synthetic?: boolean;
}

interface ApprovalRow {
  rowType: "approval";
  id: string;
  approval: SlockApprovalEvent;
}

type UiRow = SimpleRow | MessageRow | ApprovalRow | AgentStatusRow;
type AgentActivityRow = ToolRow | AgentStatusRow;

const timeline = ref<HTMLDivElement | null>(null);
const messageInput = ref<HTMLTextAreaElement | null>(null);
const status = ref("connecting");
const channels = ref<SlockUiBridgeChannel[]>([]);
const activeChannel = ref<SlockUiBridgeChannel | null>(null);
const rows = ref<UiRow[]>([]);
const agentActivityRows = ref<AgentActivityRow[]>([]);
const knownAgents = ref<EndpointUri[]>([]);
const activeView = ref<ActiveView>("chat");
const activeAgentUri = ref<EndpointUri | null>(null);
const messageText = ref("@pi read package.json and summarize the scripts");
const activeThreadId = ref<string | null>(null);
const activeReplyToId = ref<string | null>(null);
const activeThreadLabel = ref("");
const clockTick = ref(Date.now());
const traceLimit = ref(250);
const traceQuery = ref("");
const traceState = reactive<TraceState>({
  available: false,
  loading: false,
  error: "",
  tracePath: null,
  events: [],
  groups: [],
  stats: emptyTraceStats(),
});

const rendered = new Set<string>();
const streamRows = new Map<string, SimpleRow>();
const statusRows = new Map<string, AgentStatusRow>();
const toolRows = new Map<string, ToolRow>();
const approvalById = new Map<string, SlockApprovalEvent>();
const pendingToolApprovals = new Map<string, SlockApprovalEvent>();
const typingTimers = new Map<string, number>();
let nextEphemeralRowId = 1;
let nextAgentStatusRowId = 1;
let nextOperationSequence = 1;
let events: EventSource | undefined;
let clockTimer: number | undefined;

const channelTitle = computed(() => activeChannel.value ? channelLabel(activeChannel.value) : "Slock");
const latestOperations = computed(() => agentActivityRows.value
  .slice()
  .sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0))
  .slice(0, 14));
const currentOperation = computed(() => latestOperations.value[0] ?? null);
const previousOperations = computed(() => latestOperations.value.slice(1));
const activeAgentRows = computed(() => agentActivityRows.value.filter((row) => row.source === activeAgentUri.value));
const activeAgentToolCount = computed(() => activeAgentRows.value.filter((row) => row.rowType === "tool").length);
const activeAgentApprovalCount = computed(() => activeAgentRows.value.filter((row) => row.rowType === "tool" && row.approval).length);
const activeOperationCount = computed(() => agentActivityRows.value.filter((row) => row.rowType === "tool" ? row.state === "running" : row.state === "running" || row.state === "streaming").length);
const pendingApprovalCount = computed(() => rows.value.filter((row) => row.rowType === "approval").length
  + agentActivityRows.value.filter((row) => row.rowType === "tool" && Boolean(row.approval) && !row.approvalResult).length);
const traceStatus = computed(() => {
  if (traceState.loading) return "loading trace";
  if (traceState.error) return "trace error";
  if (!traceState.available) return "trace unavailable";
  return `${traceState.stats.total_events} events in ${traceState.stats.group_count} groups`;
});
const traceIssueCount = computed(() => traceState.events.filter((event) => traceIsIssue(event)).length);
const workspaceTitle = computed(() => {
  if (activeView.value === "trace") return "Trace";
  if (activeView.value === "agent") return activeAgentUri.value ?? "Agent";
  return channelTitle.value;
});
const workspaceStatus = computed(() => {
  if (activeView.value === "trace") return traceStatus.value;
  if (activeView.value === "agent") return "agent dashboard";
  return status.value;
});

onMounted(() => {
  clockTimer = window.setInterval(() => {
    clockTick.value = Date.now();
  }, 1000);
  events = new EventSource("/events");
  events.onopen = () => setStatus("connected");
  events.onerror = () => setStatus("reconnecting");
  events.onmessage = (message) => renderEvent(JSON.parse(message.data) as SlockChannelEvent);

  loadChannels().catch((error: unknown) => appendSimpleRow("error", "bridge", errorMessage(error)));
});

onBeforeUnmount(() => {
  events?.close();
  if (clockTimer) window.clearInterval(clockTimer);
  for (const timer of typingTimers.values()) window.clearTimeout(timer);
});

function setStatus(value: string): void {
  status.value = value;
}

function channelLabel(channel: SlockUiBridgeChannel): string {
  const label = channel.label || channel.uri.split("/").filter(Boolean).pop() || channel.uri;
  return (channel.kind === "dm" ? "@ " : "# ") + label;
}

function channelUrl(path: string): string {
  const url = new URL(path, window.location.origin);
  if (activeChannel.value) url.searchParams.set("channel", activeChannel.value.uri);
  return url.pathname + url.search;
}

async function switchChannel(uri: EndpointUri): Promise<void> {
  const next = channels.value.find((channel) => channel.uri === uri);
  if (!next) return;
  if (activeChannel.value?.uri === next.uri) {
    showChat();
    return;
  }
  activeChannel.value = next;
  showChat();
  clearActiveThread(false);
  resetTimeline();
  await loadHistory().catch((error: unknown) => appendSimpleRow("error", "bridge", errorMessage(error)));
}

function showChat(): void {
  activeView.value = "chat";
  activeAgentUri.value = null;
}

function openAgentDashboard(uri: EndpointUri): void {
  rememberAgent(uri);
  activeAgentUri.value = uri;
  activeView.value = "agent";
}

function openTraceViewer(): void {
  activeAgentUri.value = null;
  activeView.value = "trace";
  void refreshTrace();
}

function rememberAgent(uri: EndpointUri): void {
  if (!uri.startsWith("agent://") || knownAgents.value.includes(uri)) return;
  knownAgents.value = [...knownAgents.value, uri];
}

function agentLabel(uri: EndpointUri): string {
  return "@ " + (uri.split("/").filter(Boolean).pop() || uri);
}

function endpointLabel(uri: EndpointUri): string {
  const parts = uri.split("/").filter(Boolean);
  return parts.at(-1) ?? uri;
}

function messageActorLabel(message: SlockMessage): string {
  if (message.kind === "human") return endpointLabel(message.sender);
  if (message.kind === "agent") return "@" + endpointLabel(message.sender);
  return endpointLabel(message.sender);
}

function messageRoleLabel(message: SlockMessage): string {
  if (message.kind === "human") return "human";
  if (message.kind === "agent") return "agent";
  return "system";
}

function messageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function resetTimeline(): void {
  for (const timer of typingTimers.values()) window.clearTimeout(timer);
  rendered.clear();
  streamRows.clear();
  statusRows.clear();
  toolRows.clear();
  agentActivityRows.value = [];
  knownAgents.value = [];
  approvalById.clear();
  pendingToolApprovals.clear();
  typingTimers.clear();
  rows.value = [];
  nextOperationSequence = 1;
}

function insertRow<T extends UiRow>(row: T): T {
  const reactiveRow = reactive(row) as T;
  rows.value.push(reactiveRow);
  scrollTimeline();
  return reactiveRow;
}

function insertAgentActivityRow<T extends AgentActivityRow>(row: T): T {
  row.receivedAt = row.receivedAt ?? new Date().toISOString();
  row.sequence = row.sequence ?? nextOperationSequence++;
  const reactiveRow = reactive(row) as T;
  agentActivityRows.value.push(reactiveRow);
  rememberAgent(row.source);
  return reactiveRow;
}

function ensureAgentStatusRow(row: Omit<AgentStatusRow, "rowType" | "id">): AgentStatusRow {
  const id = statusKeyFromParts(row.source, row.threadId);
  let existing = statusRows.get(id);
  if (!existing) {
    existing = insertRow({
      rowType: "agent-status",
      id,
      ...row,
    });
    statusRows.set(id, existing);
    return existing;
  }

  existing.channel = row.channel;
  existing.threadReply = row.threadReply;
  existing.receivedAt = row.receivedAt ?? existing.receivedAt;
  existing.sequence = row.sequence ?? existing.sequence;
  existing.runId = row.runId ?? existing.runId;
  existing.messageId = row.messageId ?? existing.messageId;
  existing.startedAt = row.startedAt ?? existing.startedAt;
  existing.finishedAt = row.finishedAt ?? existing.finishedAt;
  existing.lastActivityAt = row.lastActivityAt ?? row.receivedAt ?? existing.lastActivityAt;
  existing.finalMessageId = row.finalMessageId ?? existing.finalMessageId;
  existing.errorMessage = row.errorMessage ?? existing.errorMessage;
  existing.state = row.state;
  existing.text = row.text;
  existing.synthetic = row.synthetic;
  scrollTimeline();
  return existing;
}

function ensureAgentStatusRowForTool(row: ToolRow): void {
  const id = statusKeyFromParts(row.source, row.threadId);
  const existing = statusRows.get(id);
  const receivedAt = row.receivedAt ?? new Date().toISOString();

  if (!existing) {
    ensureAgentStatusRow({
      channel: row.channel,
      source: row.source,
      threadId: row.threadId,
      threadReply: row.threadReply,
      messageId: row.threadId,
      receivedAt,
      lastActivityAt: receivedAt,
      state: row.state === "errored" ? "errored" : "running",
      text: row.state === "errored" ? "Tool call failed." : row.state === "running" ? "Using tool." : "Tool call completed.",
      synthetic: true,
    });
    return;
  }

  const wasCompleted = existing.state === "completed";
  existing.channel = row.channel;
  existing.threadReply = row.threadReply;
  existing.messageId = existing.messageId ?? row.threadId;
  existing.lastActivityAt = receivedAt;
  if (row.state === "running") {
    existing.state = "running";
    if (existing.synthetic || wasCompleted) {
      existing.text = "Using tool.";
      existing.synthetic = true;
    }
  } else if (row.state === "errored") {
    existing.state = "errored";
    if (existing.synthetic) existing.text = "Tool call failed.";
  } else if (existing.synthetic) {
    existing.text = "Tool call completed.";
  }
  scrollTimeline();
}

function appendSimpleRow(className: RowClass, meta: string, text: string, id?: string): SimpleRow | undefined {
  if (id && rendered.has(id)) return undefined;
  if (id) rendered.add(id);
  return insertRow({
    rowType: "simple",
    id: id ?? `row:${nextEphemeralRowId++}`,
    className,
    meta,
    text,
    renderedId: id,
  });
}

function removeRow(id: string): void {
  rendered.delete(id);
  rows.value = rows.value.filter((row) => row.id !== id);
}

function streamKey(delta: SlockMessageDelta): string {
  return "stream:" + delta.source + ":" + delta.thread_id;
}

function statusKeyFromParts(source: EndpointUri, threadId: string): string {
  return "agent-status:" + source + ":" + threadId;
}

function toolKeyFromParts(source: EndpointUri, threadId: string, toolCallId: string): string {
  return "tool:" + source + ":" + threadId + ":" + toolCallId;
}

function toolKey(delta: SlockMessageDelta, tool: ToolMetadata): string {
  return toolKeyFromParts(delta.source, delta.thread_id, tool.tool_call_id);
}

function approvalToolKey(approval: SlockApprovalEvent): string | undefined {
  const metadata = approval.request.metadata;
  if (!isRecord(metadata) || typeof metadata.thread_id !== "string" || typeof metadata.tool_call_id !== "string") {
    return undefined;
  }
  return toolKeyFromParts(approval.source, metadata.thread_id, metadata.tool_call_id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isToolMetadata(value: unknown): value is ToolMetadata {
  return isRecord(value)
    && value.type === "tool_call"
    && typeof value.tool_call_id === "string"
    && typeof value.name === "string";
}

function agentStatusState(metadata: unknown): AgentStatusState {
  if (!isRecord(metadata)) return "running";
  const state = metadata.phase_state;
  return state === "streaming" || state === "completed" || state === "errored" ? state : "running";
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength - 1) + "..." : value;
}

function compactText(value: unknown): string {
  if (isRecord(value) || Array.isArray(value)) return formatValue(value).replace(/\s+/g, " ").trim();
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function toolPreview(tool: ToolMetadata): string {
  const args = isRecord(tool.arguments) ? tool.arguments : {};
  if (typeof args.path === "string") return args.path;
  if (typeof args.command === "string") {
    const argv = Array.isArray(args.args) ? args.args.filter((item): item is string => typeof item === "string") : [];
    return truncate([args.command, ...argv].join(" "), 120);
  }
  return truncate(formatValue(tool.arguments).replace(/\s+/g, " "), 120);
}

function formatShellResult(result: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("exit_code: " + String(result.exit_code ?? ""));
  if (typeof result.cwd === "string") lines.push("cwd: " + result.cwd);
  if (typeof result.stdout === "string" && result.stdout.length > 0) {
    lines.push("", "stdout:", result.stdout.trimEnd());
  }
  if (typeof result.stderr === "string" && result.stderr.length > 0) {
    lines.push("", "stderr:", result.stderr.trimEnd());
  }
  return lines.join("\n");
}

function unwrapIpcResult(value: unknown): unknown {
  return isRecord(value) && typeof value.mime_type === "string" && Object.prototype.hasOwnProperty.call(value, "data")
    ? value.data
    : value;
}

function formatShellResultSummary(result: Record<string, unknown>): string {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const parts = ["exit " + String(result.exit_code ?? "")];
  if (stdout.length > 0) parts.push("stdout " + stdout.length + " chars");
  if (stderr.length > 0) parts.push("stderr " + stderr.length + " chars");
  return parts.join(" | ");
}

function formatToolResultSummary(tool: ToolMetadata): string {
  const parsed = parseJsonMaybe(tool.result);
  const data = unwrapIpcResult(parsed);
  if (isRecord(data) && typeof data.exit_code === "number") {
    return formatShellResultSummary(data);
  }
  if (isRecord(data) && typeof data.status === "number" && typeof data.final_url === "string") {
    const title = typeof data.title === "string" && data.title.length > 0 ? " | " + data.title : "";
    return String(data.status) + (data.ok === false ? " failed" : " ok") + title;
  }
  if (isRecord(data) && typeof data.ok === "boolean") {
    return data.ok ? "ok" : "failed";
  }
  if (isRecord(data) && Object.prototype.hasOwnProperty.call(data, "result")) {
    return "result: " + truncate(compactText(data.result), 120);
  }
  return truncate(compactText(data), 120) || "completed";
}

function formatToolResult(tool: ToolMetadata): string {
  const parsed = parseJsonMaybe(tool.result);
  const data = unwrapIpcResult(parsed);
  if (isRecord(data) && typeof data.exit_code === "number") {
    return formatShellResult(data);
  }
  return formatValue(parsed);
}

function grantSummary(result?: SlockApprovalResult): string {
  const grant = result?.grant;
  if (!isRecord(grant)) return "";
  const actions = Array.isArray(grant.actions) ? grant.actions.filter((action): action is string => typeof action === "string").join(",") : "";
  const target = typeof grant.target === "string" ? grant.target : "target";
  const expires = typeof grant.expires_at === "string" ? grant.expires_at : "";
  return "grant " + target + (actions ? " " + actions : "") + (expires ? " until " + expires : "");
}

function diffPreview(approval: SlockApprovalEvent): string {
  const call = approval.request.proposed_call;
  const payload = call?.payload;
  if (!isRecord(call) || call.action !== "edit" || !isRecord(payload)) return "";
  if (typeof payload.old_text !== "string" || typeof payload.new_text !== "string") return "";
  const path = typeof payload.path === "string" ? payload.path : "file";
  const oldLines = payload.old_text.split("\n").map((line) => "- " + line);
  const newLines = payload.new_text.split("\n").map((line) => "+ " + line);
  return ["--- " + path, "+++ " + path, ...oldLines, ...newLines].join("\n");
}

function approvalRiskLabel(approval: SlockApprovalEvent): string {
  switch (approval.request.risk) {
    case "file_write":
      return "File write";
    case "file_edit":
      return "File edit";
    case "shell_exec":
      return "Shell command";
    case "memory_write":
      return "Memory write";
    case "memory_admin":
      return "Memory admin";
    default:
      return approval.request.risk.replace(/_/g, " ");
  }
}

function approvalCallLine(approval: SlockApprovalEvent): string {
  const call = approval.request.proposed_call;
  return call.target + " " + call.action;
}

function approvalPayload(approval: SlockApprovalEvent): unknown {
  return approval.request.proposed_call.payload;
}

function approvalPayloadSummary(approval: SlockApprovalEvent): string {
  const call = approval.request.proposed_call;
  const payload = approvalPayload(approval);
  if (!isRecord(payload)) return truncate(compactText(payload), 160);

  if (call.action === "exec" && typeof payload.command === "string") {
    const argv = Array.isArray(payload.args) ? payload.args.filter((item): item is string => typeof item === "string") : [];
    return truncate([payload.command, ...argv].join(" "), 160);
  }
  if ((call.action === "write" || call.action === "edit") && typeof payload.path === "string") {
    return payload.path;
  }
  if ((call.action === "summarize" || call.action === "record_tool_result" || call.action === "vector_store") && typeof payload.scope === "string") {
    const operation = typeof payload.operation === "string" ? " / " + payload.operation : "";
    return payload.scope + operation;
  }
  return truncate(formatValue(payload).replace(/\s+/g, " "), 160);
}

function approvalDetailChips(approval: SlockApprovalEvent): string[] {
  const call = approval.request.proposed_call;
  const payload = approvalPayload(approval);
  const chips = [approvalCallLine(approval)];
  if (isRecord(payload)) {
    if (typeof payload.path === "string") chips.push(payload.path);
    if (typeof payload.cwd === "string") chips.push("cwd " + payload.cwd);
    if (typeof payload.content === "string") chips.push(payload.content.length + " chars");
    if (typeof payload.old_text === "string" && typeof payload.new_text === "string") {
      chips.push(payload.old_text.length + " -> " + payload.new_text.length + " chars");
    }
    if (Array.isArray(payload.trajectories)) chips.push(payload.trajectories.length + " trajectories");
    if (call.action === "record_tool_result" && typeof payload.tool_name === "string") chips.push(payload.tool_name);
  }
  return [...new Set(chips.filter((chip) => chip.length > 0))];
}

function approvalRawPayload(approval: SlockApprovalEvent): string {
  return formatValue(approval.request.proposed_call.payload);
}

function toolNameFromApproval(approval: SlockApprovalEvent): string {
  const metadata = approval.request.metadata;
  if (isRecord(metadata) && typeof metadata.tool_name === "string") return metadata.tool_name;
  return approval.request.proposed_call.action;
}

function toolPreviewFromApproval(approval: SlockApprovalEvent): string {
  const call = approval.request.proposed_call;
  return call.target + " " + call.action;
}

function createToolRowForApproval(id: string, approval: SlockApprovalEvent): ToolRow | undefined {
  const metadata = approval.request.metadata;
  if (!isRecord(metadata) || typeof metadata.thread_id !== "string" || typeof metadata.tool_call_id !== "string") return undefined;
  const row = insertAgentActivityRow({
    rowType: "tool",
    id,
    channel: typeof metadata.channel === "string" ? metadata.channel : activeChannel.value?.uri,
    source: approval.source,
    threadId: metadata.thread_id,
    threadReply: Boolean(metadata.thread_id),
    toolCallId: metadata.tool_call_id,
    state: "running",
    name: toolNameFromApproval(approval),
    preview: toolPreviewFromApproval(approval),
    argumentsText: formatValue(approval.request.proposed_call.payload),
    open: true,
  });
  toolRows.set(id, row);
  return row;
}

function renderToolDelta(delta: SlockMessageDelta, tool: ToolMetadata): void {
  const id = toolKey(delta, tool);
  let row = toolRows.get(id);
  if (!row) {
    row = insertAgentActivityRow({
      rowType: "tool",
      id,
      channel: activeChannel.value?.uri,
      source: delta.source,
      threadId: delta.thread_id,
      threadReply: Boolean(delta.thread_id),
      toolCallId: tool.tool_call_id,
      state: "running",
      name: tool.name,
      preview: toolPreview(tool),
      argumentsText: formatValue(tool.arguments),
      open: false,
    });
    toolRows.set(id, row);
  }

  updateToolRow(row, tool);
  const pendingApproval = pendingToolApprovals.get(id);
  if (pendingApproval) {
    attachApprovalToToolRow(row, pendingApproval);
  }
  ensureAgentStatusRowForTool(row);
}

function updateToolRow(row: ToolRow, tool: ToolMetadata): void {
  const state = tool.state === "completed" || tool.state === "errored" ? tool.state : "running";
  row.state = state;
  row.name = tool.name;
  row.preview = toolPreview(tool);
  row.argumentsText = formatValue(tool.arguments);
  row.open = state === "running" && Boolean(row.approval);

  if (state !== "running" && Object.prototype.hasOwnProperty.call(tool, "result")) {
    row.resultSummary = formatToolResultSummary(tool);
    row.resultText = formatToolResult(tool);
  }
}

function attachApprovalToToolRow(row: ToolRow, approval: SlockApprovalEvent): void {
  removeApprovalRow(approval.id);
  row.approval = approval;
  row.approvalResult = undefined;
  row.open = true;
  ensureAgentStatusRowForTool(row);
}

function updateToolApproval(row: ToolRow, result: SlockApprovalResult): boolean {
  if (!row.approval) return false;
  row.approvalResult = result;
  return true;
}

function removeApprovalRow(id: string): void {
  removeRow("approval:" + id);
}

function appendApproval(approval: SlockApprovalEvent): void {
  const id = "approval:" + approval.id;
  if (rendered.has(id)) return;
  rendered.add(id);
  insertRow({ rowType: "approval", id, approval });
}

function renderApprovalRequested(approval: SlockApprovalEvent): void {
  rememberAgent(approval.source);
  approvalById.set(approval.id, approval);
  const key = approvalToolKey(approval);
  if (key) {
    pendingToolApprovals.set(key, approval);
    const row = toolRows.get(key) ?? createToolRowForApproval(key, approval);
    if (row) {
      attachApprovalToToolRow(row, approval);
      scrollTimeline();
      return;
    }
  }

  appendApproval(approval);
}

function renderApprovalResolved(id: string, result: SlockApprovalResult): void {
  const approval = approvalById.get(id);
  const key = approval ? approvalToolKey(approval) : undefined;
  if (key) {
    const row = toolRows.get(key);
    pendingToolApprovals.delete(key);
    if (row && updateToolApproval(row, result)) {
      removeApprovalRow(id);
      approvalById.delete(id);
      return;
    }
  }

  removeApprovalRow(id);
  approvalById.delete(id);
  const summary = grantSummary(result);
  appendSimpleRow("delta", "approval", (result.approved ? "Approved" : "Denied") + (summary ? "\n" + summary : ""));
}

function renderAgentRunStarted(run: SlockAgentRunEvent): void {
  rememberAgent(run.agent);
  const receivedAt = run.started_at ?? new Date().toISOString();
  const activity: AgentStatusRow = insertAgentActivityRow({
    rowType: "agent-status",
    id: `agent-run:${run.run_id}:started`,
    channel: activeChannel.value?.uri,
    source: run.agent,
    threadId: run.message_id,
    threadReply: Boolean(run.thread_id),
    runId: run.run_id,
    messageId: run.message_id,
    startedAt: receivedAt,
    lastActivityAt: receivedAt,
    state: "running",
    text: "Run started.",
  });

  ensureAgentStatusRow({
    channel: activity.channel,
    source: activity.source,
    threadId: activity.threadId,
    threadReply: activity.threadReply,
    receivedAt: activity.receivedAt,
    sequence: activity.sequence,
    runId: run.run_id,
    messageId: run.message_id,
    startedAt: receivedAt,
    lastActivityAt: receivedAt,
    state: "running",
    text: "Run started.",
    synthetic: false,
  });
}

function renderAgentRunFinished(run: SlockAgentRunEvent): void {
  rememberAgent(run.agent);
  const receivedAt = run.finished_at ?? new Date().toISOString();
  const state = run.state === "started" ? "running" : run.state;
  const text = agentRunText(run);
  const activity: AgentStatusRow = insertAgentActivityRow({
    rowType: "agent-status",
    id: `agent-run:${run.run_id}:finished`,
    channel: activeChannel.value?.uri,
    source: run.agent,
    threadId: run.message_id,
    threadReply: Boolean(run.thread_id),
    runId: run.run_id,
    messageId: run.message_id,
    startedAt: run.started_at,
    finishedAt: receivedAt,
    lastActivityAt: receivedAt,
    finalMessageId: run.final_message_id,
    errorMessage: run.error?.message,
    state,
    text,
  });

  ensureAgentStatusRow({
    channel: activity.channel,
    source: activity.source,
    threadId: activity.threadId,
    threadReply: activity.threadReply,
    receivedAt: activity.receivedAt,
    sequence: activity.sequence,
    runId: run.run_id,
    messageId: run.message_id,
    startedAt: run.started_at,
    finishedAt: receivedAt,
    lastActivityAt: receivedAt,
    finalMessageId: run.final_message_id,
    errorMessage: run.error?.message,
    state,
    text,
    synthetic: false,
  });
}

function agentRunText(run: SlockAgentRunEvent): string {
  if (run.state === "completed") return "Run completed.";
  if (run.state === "cancelled") return "Run cancelled" + (run.reason ? ": " + run.reason : ".");
  if (run.state === "errored") return run.error?.message ? "Run failed: " + run.error.message : "Run failed.";
  return "Run started.";
}

function renderMessage(message: SlockMessage): void {
  if (message.kind === "agent") rememberAgent(message.sender);
  if (message.kind === "agent" && message.thread_id) {
    const runId = message.reply_to_id || message.thread_id;
    markRunFinished(runId, "completed");
    const id = "stream:" + message.sender + ":" + runId;
    streamRows.delete(id);
    removeRow(id);
  }
  if (rendered.has(message.id)) return;
  rendered.add(message.id);
  insertRow({
    rowType: "message",
    id: message.id,
    message,
    threadReply: Boolean(message.thread_id),
    runState: "active",
  });
}

function renderMessageUpdated(message: SlockMessage): void {
  const row = rows.value.find((entry): entry is MessageRow => entry.rowType === "message" && entry.message.id === message.id);
  if (!row) {
    renderMessage(message);
    return;
  }

  row.message = message;
  row.threadReply = Boolean(message.thread_id);
}

function renderTypingStarted(typing: { source: EndpointUri; thread_id?: string | null }): void {
  const source = typing.source || "channel";
  const id = "typing:" + source + ":" + (typing.thread_id ?? "");
  let row = rows.value.find((entry): entry is SimpleRow => entry.rowType === "simple" && entry.id === id);
  if (!row) {
    row = appendSimpleRow("delta", source, "typing...", id);
  }

  const currentTimer = typingTimers.get(id);
  if (currentTimer) window.clearTimeout(currentTimer);
  typingTimers.set(id, window.setTimeout(() => {
    typingTimers.delete(id);
    removeRow(id);
  }, 2000));
}

function renderSubscriptionClosed(subscription: { subscriber: EndpointUri; reason?: string }): void {
  setStatus("subscription closed");
  const reason = subscription.reason ? ": " + subscription.reason : "";
  appendSimpleRow("delta", subscription.subscriber || "channel", "Subscription closed" + reason);
}

function setActiveThread(message: SlockMessage): void {
  activeThreadId.value = message.thread_id || message.id;
  activeReplyToId.value = message.id;
  activeThreadLabel.value = "Thread: " + truncate(compactText(message.text) || activeThreadId.value, 96);
  nextTick(() => messageInput.value?.focus());
}

function clearActiveThread(focus = true): void {
  activeThreadId.value = null;
  activeReplyToId.value = null;
  activeThreadLabel.value = "";
  if (focus) nextTick(() => messageInput.value?.focus());
}

function markRunFinished(messageId: string, state: "cancelled" | "completed"): void {
  const row = rows.value.find((entry): entry is MessageRow => entry.rowType === "message" && entry.message.id === messageId);
  if (!row) return;
  row.runState = state;
}

function markAgentStatusCancelled(agent: EndpointUri, messageId: string, reason?: string): void {
  const row = statusRows.get(statusKeyFromParts(agent, messageId));
  if (!row) return;
  const receivedAt = new Date().toISOString();
  row.state = "cancelled";
  row.finishedAt = row.finishedAt ?? receivedAt;
  row.lastActivityAt = receivedAt;
  row.text = "Run cancelled" + (reason ? ": " + reason : ".");
  row.synthetic = false;
}

function renderDelta(delta: SlockMessageDelta): void {
  rememberAgent(delta.source);
  if (delta.kind === "status") {
    if (isToolMetadata(delta.metadata)) {
      renderToolDelta(delta, delta.metadata);
      return;
    }

    const state = agentStatusState(delta.metadata);

    const activityRow: AgentStatusRow = insertAgentActivityRow({
      rowType: "agent-status",
      id: `agent-status:${nextAgentStatusRowId++}`,
      channel: activeChannel.value?.uri,
      source: delta.source,
      threadId: delta.thread_id,
      threadReply: Boolean(delta.thread_id),
      state,
      text: delta.text,
    });

    ensureAgentStatusRow({
      channel: activityRow.channel,
      source: activityRow.source,
      threadId: activityRow.threadId,
      threadReply: activityRow.threadReply,
      messageId: activityRow.threadId,
      receivedAt: activityRow.receivedAt,
      sequence: activityRow.sequence,
      lastActivityAt: activityRow.receivedAt,
      state,
      text: delta.text,
      synthetic: false,
    });
    return;
  }

  const id = streamKey(delta);
  let row = streamRows.get(id);
  if (!row) {
    row = appendSimpleRow("delta", delta.source, delta.text, id);
    if (!row) return;
    if (delta.thread_id) row.threadReply = true;
    streamRows.set(id, row);
    return;
  }

  row.text += delta.text;
  scrollTimeline();
}

function renderEvent(event: SlockChannelEvent): void {
  if (event.type === "bridge_connected") {
    return;
  }
  if (event.channel && activeChannel.value && event.channel !== activeChannel.value.uri) {
    return;
  }
  if (event.type === "message_created" && event.message) {
    renderMessage(event.message);
    return;
  }
  if (event.type === "message_updated" && event.message) {
    renderMessageUpdated(event.message);
    return;
  }
  if (event.type === "message_delta" && event.delta) {
    renderDelta(event.delta);
    return;
  }
  if (event.type === "agent_run_started" && event.run) {
    renderAgentRunStarted(event.run);
    return;
  }
  if (event.type === "agent_run_finished" && event.run) {
    renderAgentRunFinished(event.run);
    return;
  }
  if (event.type === "typing_started" && event.typing) {
    renderTypingStarted(event.typing);
    return;
  }
  if (event.type === "subscription_closed" && event.subscription) {
    renderSubscriptionClosed(event.subscription);
    return;
  }
  if (event.type === "agent_error" && event.error) {
    rememberAgent(event.error.source);
    appendSimpleRow("error", event.error.source, event.error.code + ": " + event.error.message);
    return;
  }
  if (event.type === "agent_cancelled" && event.cancelled) {
    rememberAgent(event.cancelled.agent);
    markRunFinished(event.cancelled.message_id, "cancelled");
    markAgentStatusCancelled(event.cancelled.agent, event.cancelled.message_id, event.cancelled.reason);
    appendSimpleRow("delta", event.cancelled.agent, "Cancelled" + (event.cancelled.reason ? ": " + event.cancelled.reason : ""));
    return;
  }
  if (event.type === "approval_requested" && event.approval) {
    renderApprovalRequested(event.approval);
    return;
  }
  if (event.type === "approval_resolved" && event.id && event.result) {
    renderApprovalResolved(event.id, event.result);
  }
}

async function decideApproval(id: string, approved: boolean): Promise<void> {
  const response = await fetch("/api/approvals/" + encodeURIComponent(id), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved }),
  });
  if (!response.ok) {
    appendSimpleRow("error", "approval", await response.text());
  }
}

async function cancelRun(messageId: string, row: MessageRow): Promise<void> {
  row.runState = "cancelling";
  const response = await fetch(channelUrl("/api/runs/" + encodeURIComponent(messageId) + "/cancel"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: activeChannel.value?.uri, reason: "user cancelled" }),
  });
  if (!response.ok) {
    row.runState = "active";
    appendSimpleRow("error", "cancel", await response.text());
  }
}

async function loadHistory(): Promise<void> {
  if (!activeChannel.value) return;
  const response = await fetch(channelUrl("/api/history"));
  if (!response.ok) throw new Error(await response.text());
  const body = await response.json() as { messages?: SlockMessage[] };
  for (const message of body.messages ?? []) renderMessage(message);
}

async function loadChannels(): Promise<void> {
  const response = await fetch("/api/channels");
  if (!response.ok) throw new Error(await response.text());
  const body = await response.json() as { channels?: SlockUiBridgeChannel[]; default_channel?: string };
  channels.value = Array.isArray(body.channels) ? body.channels : [];
  activeChannel.value = channels.value.find((channel) => channel.uri === body.default_channel) || channels.value[0] || null;
  if (!activeChannel.value) throw new Error("no channels configured");
  await loadHistory();
}

async function refreshHistory(): Promise<void> {
  await loadHistory().catch((error: unknown) => appendSimpleRow("error", "bridge", errorMessage(error)));
}

function emptyTraceStats(): TraceViewerStats {
  return {
    total_events: 0,
    group_count: 0,
    approvals: 0,
    rejected_approvals: 0,
    shell_calls: 0,
    route_results: {},
  };
}

function traceApiUrl(): string {
  const url = new URL("/api/trace", window.location.origin);
  const limit = Number.isFinite(traceLimit.value) && traceLimit.value > 0 ? Math.min(Math.floor(traceLimit.value), 1000) : 250;
  url.searchParams.set("limit", String(limit));
  const query = traceQuery.value.trim();
  if (query) url.searchParams.set("q", query);
  return url.pathname + url.search;
}

async function refreshTrace(): Promise<void> {
  traceState.loading = true;
  traceState.error = "";

  try {
    const response = await fetch(traceApiUrl());
    if (!response.ok) throw new Error(await response.text());
    const body = await response.json() as TraceViewerResponse;
    traceState.available = Boolean(body.available);
    traceState.tracePath = body.trace_path ?? null;
    traceState.events = Array.isArray(body.events) ? body.events : [];
    traceState.groups = Array.isArray(body.groups) ? body.groups : [];
    traceState.stats = body.stats ?? emptyTraceStats();
  } catch (error) {
    traceState.error = errorMessage(error);
  } finally {
    traceState.loading = false;
  }
}

async function submitMessage(): Promise<void> {
  const text = messageText.value.trim();
  if (!text) return;
  messageText.value = "";
  const response = await fetch(channelUrl("/api/messages"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel: activeChannel.value?.uri,
      text,
      thread_id: activeThreadId.value,
      reply_to_id: activeReplyToId.value,
    }),
  });
  if (!response.ok) {
    appendSimpleRow("error", "bridge", await response.text());
  }
}

function canCancel(row: MessageRow): boolean {
  return row.message.kind === "human" && Array.isArray(row.message.mentions) && row.message.mentions.length > 0;
}

function cancelDisabled(row: MessageRow): boolean {
  return row.runState !== "active";
}

function cancelLabel(row: MessageRow): string {
  if (row.runState === "cancelling") return "Cancelling";
  if (row.runState === "cancelled") return "Cancelled";
  if (row.runState === "completed") return "Completed";
  return "Cancel";
}

function approvalState(row: ToolRow): "pending" | "approved" | "denied" {
  if (!row.approvalResult) return "pending";
  return row.approvalResult.approved ? "approved" : "denied";
}

function approvalLabel(row: ToolRow): string {
  if (!row.approvalResult) return "approval required";
  return row.approvalResult.approved ? "approved" : "denied";
}

function agentStatusLabel(row: AgentStatusRow): string {
  if (agentStatusVisualState(row) === "waiting") return "waiting";
  return row.state === "streaming" ? "active" : row.state;
}

function agentStatusVisualState(row: AgentStatusRow): AgentStatusVisualState {
  return pendingStatusApprovals(row).length > 0 ? "waiting" : row.state;
}

function pendingStatusApprovals(row: AgentStatusRow): ToolRow[] {
  return statusToolRows(row).filter((tool) => Boolean(tool.approval) && !tool.approvalResult);
}

function agentStatusMetaChips(row: AgentStatusRow): string[] {
  const chips: string[] = [];
  const duration = agentRunDuration(row);
  const tools = statusToolRows(row).length;
  const pending = pendingStatusApprovals(row).length;
  if (duration) chips.push("elapsed " + duration);
  if (row.lastActivityAt) chips.push("last " + compactTime(row.lastActivityAt));
  chips.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  if (pending) chips.push(`${pending} approval${pending === 1 ? "" : "s"}`);
  if (row.runId) chips.push("run " + shortRunId(row.runId));
  return chips;
}

function agentRunDuration(row: AgentStatusRow): string {
  const started = parseTimeMs(row.startedAt);
  if (started === undefined) return "";
  const finished = parseTimeMs(row.finishedAt);
  const end = finished ?? clockTick.value;
  return formatDurationMs(Math.max(0, end - started));
}

function parseTimeMs(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return "<1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function compactTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "00:00:00";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortRunId(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function operationTitle(row: AgentActivityRow): string {
  return row.rowType === "agent-status" ? row.text : `${toolInlineEndpointLabel(row)} ${toolInlineAction(row)}`;
}

function operationDetail(row: AgentActivityRow): string {
  if (row.rowType === "agent-status") {
    const duration = agentRunDuration(row);
    const tools = statusToolRows(row).length;
    return [endpointLabel(row.source), duration, `${tools} tools`].filter(Boolean).join(" · ");
  }
  return toolInlinePayload(row) || row.resultSummary || row.toolCallId;
}

function operationState(row: AgentActivityRow): string {
  return row.rowType === "agent-status" ? agentStatusLabel(row) : row.state;
}

function operationTime(row: AgentActivityRow): string {
  if (!row.receivedAt) return "00:00:00";
  const date = new Date(row.receivedAt);
  if (Number.isNaN(date.getTime())) return "00:00:00";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function operationSequence(row: AgentActivityRow): string {
  return "#" + String(row.sequence ?? 0).padStart(2, "0");
}

function operationIcon(row: AgentActivityRow): "status" | "approval" | "tool" | "terminal" {
  if (row.rowType === "agent-status") return "status";
  if (row.approval && !row.approvalResult) return "approval";
  return row.name.includes("shell") || row.preview.startsWith("exec") ? "terminal" : "tool";
}

function endpointKind(uri: string): EndpointKind {
  if (uri.startsWith("agent://")) return "agent";
  if (uri.startsWith("app://")) return "app";
  if (uri.startsWith("plugin://")) return "plugin";
  if (uri.startsWith("local://")) return "local";
  return "unknown";
}

function endpointDisplayLabel(uri: string): string {
  const schemeIndex = uri.indexOf("://");
  return schemeIndex >= 0 ? uri.slice(schemeIndex + 3) : uri;
}

function toolCallParts(row: ToolRow): { endpoint: string; action: string; payload: unknown } {
  const args = toolArguments(row);
  const approvalCall = row.approval?.request.proposed_call;
  const endpoint = isRecord(args) && typeof args.target === "string"
    ? args.target
    : approvalCall?.target ?? row.preview;
  const action = isRecord(args) && typeof args.action === "string"
    ? args.action
    : approvalCall?.action ?? row.name;
  const payload = isRecord(args) && Object.prototype.hasOwnProperty.call(args, "payload")
    ? args.payload
    : approvalCall?.payload;
  return { endpoint, action, payload };
}

function toolInlineEndpoint(row: ToolRow): string {
  return toolCallParts(row).endpoint || endpointLabel(row.source);
}

function toolInlineEndpointLabel(row: ToolRow): string {
  return endpointDisplayLabel(toolInlineEndpoint(row));
}

function toolInlineEndpointKind(row: ToolRow): EndpointKind {
  return endpointKind(toolInlineEndpoint(row));
}

function toolInlineAction(row: ToolRow): string {
  return toolCallParts(row).action || row.name;
}

function toolInlinePayload(row: ToolRow): string {
  const payload = toolCallParts(row).payload;
  if (payload === undefined) return "";
  return truncate(compactText(payload), 180);
}

function statusToolRows(row: AgentStatusRow): ToolRow[] {
  return agentActivityRows.value
    .filter((entry): entry is ToolRow => entry.rowType === "tool" && entry.source === row.source && entry.threadId === row.threadId)
    .slice()
    .sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0));
}

function currentStatusToolList(row: AgentStatusRow): ToolRow[] {
  const current = statusToolRows(row)[0];
  return current ? [current] : [];
}

function previousStatusTools(row: AgentStatusRow): ToolRow[] {
  return statusToolRows(row).slice(1);
}

function toolArguments(row: ToolRow): unknown {
  return parseJsonMaybe(row.argumentsText);
}

function toolTarget(row: ToolRow): string {
  const args = toolArguments(row);
  if (isRecord(args) && typeof args.target === "string") return args.target;
  if (row.approval) return row.approval.request.proposed_call.target;
  return row.preview;
}

function toolOperation(row: ToolRow): string {
  const args = toolArguments(row);
  if (isRecord(args) && typeof args.action === "string") return row.name + " / " + args.action;
  return row.name;
}

function fallbackDash(value?: string): string {
  return value && value.length > 0 ? value : "-";
}

function traceMetric(value: number | undefined): number {
  return typeof value === "number" ? value : 0;
}

function traceRouteCount(route: string): number {
  return traceState.stats.route_results[route] ?? 0;
}

function formatTraceTime(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function traceEndpoint(event: TraceViewerEvent): string {
  const source = traceString(event.source);
  const target = traceString(event.target);
  if (source || target) return `${source || "unknown"} -> ${target || "unknown"}`;
  return traceString(event.uri) || "-";
}

function traceOperation(event: TraceViewerEvent): string {
  const op = traceString(event.op_code);
  const action = traceString(event.action);
  if (op && action) return `${op} ${action}`;
  return op || action || traceString(event.event) || "-";
}

function traceRoute(event: TraceViewerEvent): string {
  return traceString(event.route_result) || traceString(event.event) || "event";
}

function traceIsIssue(event: TraceViewerEvent): boolean {
  const route = traceRoute(event);
  return route === "rejected" || route === "dropped" || route === "parse_error" || Boolean(traceString(event.error_reason));
}

function traceTone(event: TraceViewerEvent): "issue" | "response" | "stream" | "event" {
  if (traceIsIssue(event)) return "issue";
  const direction = traceDirection(event);
  if (direction === "response") return "response";
  if (direction === "stream") return "stream";
  return "event";
}

function traceDirection(event: TraceViewerEvent): string {
  return traceString(event.direction) || "event";
}

function traceFlow(event: TraceViewerEvent): string {
  return traceString(event.endpoint_flow) || traceEndpoint(event);
}

function tracePrimaryLine(event: TraceViewerEvent): string {
  const operation = traceOperation(event);
  const flow = traceFlow(event);
  return operation + (flow !== "-" ? " · " + flow : "");
}

function traceGroupLabel(event: TraceViewerEvent): string {
  const group = traceString(event.group_key);
  if (!group) return "ungrouped";
  const separator = group.indexOf(":");
  return separator >= 0 ? group.slice(separator + 1) : group;
}

function traceDepthStyle(event: TraceViewerEvent): Record<string, string> {
  const depth = typeof event.causal_depth === "number" ? Math.max(0, Math.min(event.causal_depth, 5)) : 0;
  return {
    "--trace-band": `${depth * 18 + 12}px`,
    "--trace-indent": `${depth * 10}px`,
  };
}

function traceParent(event: TraceViewerEvent): string {
  return traceString(event.causal_parent_id);
}

function traceRelations(event: TraceViewerEvent): TraceViewerRelation[] {
  return Array.isArray(event.relations) ? event.relations : [];
}

function traceGroupRelations(group: TraceViewerGroup): TraceViewerRelation[] {
  return Array.isArray(group.summary.relations) ? group.summary.relations : [];
}

function filterTraceRelation(relation: TraceViewerRelation): void {
  traceQuery.value = relation.value;
  void refreshTrace();
}

function traceChips(event: TraceViewerEvent): string[] {
  const chips = [
    traceString(event.payload_kind),
    traceString(event.channel),
    traceString(event.approval_risk),
    traceString(event.approval_target),
    typeof event.approval_decision === "boolean" ? (event.approval_decision ? "approved" : "denied") : "",
    typeof event.shell_exit_code === "number" ? `exit ${event.shell_exit_code}` : "",
    typeof event.payload_size === "number" ? `${event.payload_size} bytes` : "",
  ];
  return chips.filter((chip) => chip.length > 0);
}

function traceGroupRange(group: TraceViewerGroup): string {
  const first = formatTraceTime(group.summary.first_timestamp);
  const last = formatTraceTime(group.summary.last_timestamp);
  return first === last ? first : `${first} - ${last}`;
}

function traceEndpointSummary(group: TraceViewerGroup): string {
  if (!group.summary.endpoints.length) return "-";
  return group.summary.endpoints.slice(0, 3).join(" | ") + (group.summary.endpoints.length > 3 ? " ..." : "");
}

function traceString(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function syncToolOpen(row: ToolRow, event: Event): void {
  row.open = event.target instanceof HTMLDetailsElement ? event.target.open : row.open;
}

function scrollTimeline(): void {
  void nextTick(() => {
    if (timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <main class="app-shell">
    <aside class="navigation-rail" aria-label="Workspace navigation">
      <div class="brand-lockup">
        <span class="brand-glyph" aria-hidden="true"><MessageSquare :size="18" /></span>
        <span class="brand-copy">
          <span class="brand-name">Kairos</span>
          <span class="brand-caption">Slock bridge</span>
        </span>
      </div>

      <section class="nav-section" aria-label="Rooms">
        <div class="nav-heading">
          <span>Rooms</span>
          <span>{{ channels.length }}</span>
        </div>
        <div class="nav-list">
          <button
            v-for="channel in channels"
            :key="channel.uri"
            class="nav-item"
            :class="{ active: activeView === 'chat' && activeChannel?.uri === channel.uri }"
            type="button"
            @click="switchChannel(channel.uri)"
          >
            <MessageSquare v-if="channel.kind !== 'dm'" :size="16" aria-hidden="true" />
            <Bot v-else :size="16" aria-hidden="true" />
            <span>{{ channelLabel(channel) }}</span>
          </button>
        </div>
      </section>

      <section class="nav-section" aria-label="Agents">
        <div class="nav-heading">
          <span>Agents</span>
          <span>{{ knownAgents.length }}</span>
        </div>
        <div v-if="knownAgents.length" class="nav-list">
          <button
            v-for="agent in knownAgents"
            :key="agent"
            class="nav-item"
            :class="{ active: activeView === 'agent' && activeAgentUri === agent }"
            type="button"
            @click="openAgentDashboard(agent)"
          >
            <Bot :size="16" aria-hidden="true" />
            <span>{{ agentLabel(agent) }}</span>
          </button>
        </div>
        <div v-else class="nav-empty">Agents appear after a run starts.</div>
      </section>

      <section class="nav-section nav-section-bottom" aria-label="Observe">
        <div class="nav-heading">
          <span>Observe</span>
        </div>
        <div class="nav-list">
          <button
            class="nav-item"
            :class="{ active: activeView === 'trace' }"
            type="button"
            @click="openTraceViewer"
          >
            <Activity :size="16" aria-hidden="true" />
            <span>Trace</span>
          </button>
        </div>
      </section>
    </aside>

    <section class="workspace" :aria-label="activeView === 'agent' ? 'Agent dashboard' : activeView === 'trace' ? 'Trace viewer' : 'Channel'">
      <header class="topbar">
        <div class="workspace-heading">
          <p class="workspace-kicker">{{ activeView === 'chat' ? 'Room' : activeView === 'agent' ? 'Agent' : 'Observe' }}</p>
          <h1>{{ workspaceTitle }}</h1>
          <p>{{ workspaceStatus }}</p>
        </div>
        <div class="topbar-actions">
          <button v-if="activeView === 'chat'" class="ghost icon-label" type="button" @click="refreshHistory">
            <RefreshCw :size="15" aria-hidden="true" />
            <span>Refresh</span>
          </button>
          <button v-else-if="activeView === 'trace'" class="ghost icon-label" type="button" :disabled="traceState.loading" @click="refreshTrace">
            <RefreshCw :size="15" aria-hidden="true" />
            <span>Refresh</span>
          </button>
          <button v-else class="ghost icon-label" type="button" @click="showChat">
            <MessageSquare :size="15" aria-hidden="true" />
            <span>Channel</span>
          </button>
        </div>
      </header>

      <div v-if="activeView === 'chat'" class="collab-layout">
        <section class="conversation-pane" aria-label="Conversation">
          <div ref="timeline" class="timeline" aria-live="polite">
            <div v-if="!rows.length" class="timeline-empty">
              <div class="empty-title">No messages in this room yet</div>
              <div class="empty-copy">Start with a mention, then agent replies, tool calls, and approvals will stay in the same timeline.</div>
            </div>

            <template v-for="row in rows" :key="row.id">
              <article
                v-if="row.rowType === 'message'"
                class="message-row message"
                :class="{ 'thread-reply': row.threadReply }"
                :data-kind="row.message.kind"
                :data-rendered-id="row.message.id"
              >
                <div class="actor-cell">
                  <span class="actor-avatar" :data-kind="row.message.kind">{{ messageActorLabel(row.message).slice(0, 1).toUpperCase() }}</span>
                  <span class="actor-meta">
                    <span class="sender">{{ messageActorLabel(row.message) }}</span>
                    <span class="meta">{{ messageRoleLabel(row.message) }} · {{ messageTime(row.message.created_at) }}</span>
                  </span>
                </div>
                <div class="message-body">
                  <div class="text">{{ row.message.text }}</div>
                  <div class="message-actions">
                    <button
                      v-if="canCancel(row)"
                      class="subtle-button"
                      type="button"
                      :data-run-cancel-for="row.message.id"
                      :disabled="cancelDisabled(row)"
                      @click="cancelRun(row.message.id, row)"
                    >
                      <X v-if="row.runState === 'active'" :size="14" aria-hidden="true" />
                      <Check v-else :size="14" aria-hidden="true" />
                      <span>{{ cancelLabel(row) }}</span>
                    </button>
                    <button class="subtle-button" type="button" @click="setActiveThread(row.message)">
                      <CornerDownRight :size="14" aria-hidden="true" />
                      <span>Reply</span>
                    </button>
                  </div>
                </div>
              </article>

              <article
                v-else-if="row.rowType === 'simple'"
                :class="['system-row', row.className, { 'thread-reply': row.threadReply }]"
                :data-rendered-id="row.renderedId"
              >
                <div class="actor-cell compact">
                  <span class="activity-dot" :data-state="row.className"></span>
                  <span class="meta">{{ endpointLabel(row.meta) }}</span>
                </div>
                <div class="message-body">
                  <div class="text">{{ row.text }}</div>
                </div>
              </article>

              <article
                v-else-if="row.rowType === 'agent-status'"
                class="agent-status-row"
                :class="['activity-row', { 'thread-reply': row.threadReply }]"
                :data-state="agentStatusVisualState(row)"
              >
                <div class="actor-cell compact">
                  <span class="actor-avatar agent-avatar"><Bot :size="15" aria-hidden="true" /></span>
                  <span class="actor-meta">
                    <span class="sender">{{ endpointLabel(row.source) }}</span>
                    <span class="meta">agent status</span>
                  </span>
                </div>
                <div class="agent-status-block">
                  <div class="agent-status-text">
                    <span class="tool-state" :data-state="agentStatusVisualState(row)">{{ agentStatusLabel(row) }}</span>
                    <span>{{ row.text }}</span>
                  </div>
                  <div class="agent-run-meta">
                    <span v-for="chip in agentStatusMetaChips(row)" :key="chip" :title="chip.startsWith('run ') ? row.runId : undefined">{{ chip }}</span>
                  </div>

                  <details
                    v-for="currentTool in currentStatusToolList(row)"
                    :key="currentTool.id"
                    class="agent-current-tool"
                    :open="currentTool.open"
                    :data-state="currentTool.state"
                    @toggle="syncToolOpen(currentTool, $event)"
                  >
                    <summary class="agent-current-tool-summary">
                      <ChevronRight class="details-chevron" :size="15" aria-hidden="true" />
                      <span class="endpoint-kind-icon" :data-kind="toolInlineEndpointKind(currentTool)" :title="toolInlineEndpoint(currentTool)">
                        <Bot v-if="toolInlineEndpointKind(currentTool) === 'agent'" :size="15" aria-hidden="true" />
                        <MessageSquare v-else-if="toolInlineEndpointKind(currentTool) === 'app'" :size="15" aria-hidden="true" />
                        <TerminalSquare v-else :size="15" aria-hidden="true" />
                      </span>
                      <span class="tool-inline-summary">
                        <span class="tool-endpoint" :title="toolInlineEndpoint(currentTool)">{{ toolInlineEndpointLabel(currentTool) }}</span>
                        <span class="tool-action">{{ toolInlineAction(currentTool) }}</span>
                        <span v-if="toolInlinePayload(currentTool)" class="tool-payload">{{ toolInlinePayload(currentTool) }}</span>
                      </span>
                    </summary>

                    <div class="agent-tool-detail-body">
                      <div class="tool-call-detail">
                        <span>endpoint</span>
                        <code>{{ toolInlineEndpoint(currentTool) }}</code>
                        <span>action</span>
                        <code>{{ toolInlineAction(currentTool) }}</code>
                        <span v-if="toolInlinePayload(currentTool)">payload</span>
                        <pre v-if="toolInlinePayload(currentTool)" class="tool-pre inline-payload">{{ toolInlinePayload(currentTool) }}</pre>
                        <span>arguments</span>
                        <pre class="tool-pre inline-payload">{{ currentTool.argumentsText }}</pre>
                        <span v-if="currentTool.resultText !== undefined">result</span>
                        <pre v-if="currentTool.resultText !== undefined" class="tool-pre inline-payload">{{ currentTool.resultText }}</pre>
                      </div>

                      <div v-if="currentTool.approval" class="tool-section tool-approval" :data-approval-id="currentTool.approval.id">
                        <div class="approval-header">
                          <span class="approval-status" :data-state="approvalState(currentTool)">{{ approvalLabel(currentTool) }}</span>
                          <span class="grant-summary">{{ grantSummary(currentTool.approvalResult) }}</span>
                        </div>
                        <div class="approval-card">
                          <div class="approval-summary-line">{{ approvalRiskLabel(currentTool.approval) }}: {{ currentTool.approval.request.summary }}</div>
                          <div class="approval-target-line">{{ approvalPayloadSummary(currentTool.approval) }}</div>
                          <div class="approval-chip-row">
                            <span v-for="chip in approvalDetailChips(currentTool.approval)" :key="chip" class="approval-chip">{{ chip }}</span>
                          </div>
                        </div>
                        <template v-if="diffPreview(currentTool.approval)">
                          <div class="tool-section-label">Diff Preview</div>
                          <pre class="tool-pre">{{ diffPreview(currentTool.approval) }}</pre>
                        </template>
                        <details class="raw-details">
                          <summary>Raw payload</summary>
                          <pre class="tool-pre">{{ approvalRawPayload(currentTool.approval) }}</pre>
                        </details>
                        <div class="approval-actions">
                          <button
                            type="button"
                            data-decision="approve"
                            :disabled="Boolean(currentTool.approvalResult)"
                            @click="decideApproval(currentTool.approval.id, true)"
                          >
                            <Check :size="14" aria-hidden="true" />
                            <span>Approve</span>
                          </button>
                          <button
                            type="button"
                            data-decision="deny"
                            :disabled="Boolean(currentTool.approvalResult)"
                            @click="decideApproval(currentTool.approval.id, false)"
                          >
                            <X :size="14" aria-hidden="true" />
                            <span>Deny</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </details>

                  <details v-if="previousStatusTools(row).length" class="previous-tool-calls agent-tool-history">
                    <summary>
                      <span>Tool history</span>
                      <span>{{ previousStatusTools(row).length }}</span>
                    </summary>
                    <div class="previous-tool-list">
                      <details
                        v-for="previous in previousStatusTools(row)"
                        :key="previous.id"
                        class="previous-tool-call"
                      >
                        <summary>
                          <span class="tool-state" :data-state="previous.state">{{ previous.state }}</span>
                          <span class="tool-inline-summary">
                            <span class="endpoint-kind-icon compact" :data-kind="toolInlineEndpointKind(previous)" :title="toolInlineEndpoint(previous)">
                              <Bot v-if="toolInlineEndpointKind(previous) === 'agent'" :size="13" aria-hidden="true" />
                              <MessageSquare v-else-if="toolInlineEndpointKind(previous) === 'app'" :size="13" aria-hidden="true" />
                              <TerminalSquare v-else :size="13" aria-hidden="true" />
                            </span>
                            <span class="tool-endpoint" :title="toolInlineEndpoint(previous)">{{ toolInlineEndpointLabel(previous) }}</span>
                            <span class="tool-action">{{ toolInlineAction(previous) }}</span>
                            <span v-if="toolInlinePayload(previous)" class="tool-payload">{{ toolInlinePayload(previous) }}</span>
                          </span>
                        </summary>
                        <div class="tool-call-detail previous-tool-detail">
                          <span>endpoint</span>
                          <code>{{ toolInlineEndpoint(previous) }}</code>
                          <span>action</span>
                          <code>{{ toolInlineAction(previous) }}</code>
                          <span v-if="toolInlinePayload(previous)">payload</span>
                          <pre v-if="toolInlinePayload(previous)" class="tool-pre inline-payload">{{ toolInlinePayload(previous) }}</pre>
                          <span>arguments</span>
                          <pre class="tool-pre inline-payload">{{ previous.argumentsText }}</pre>
                          <span v-if="previous.resultText !== undefined">result</span>
                          <pre v-if="previous.resultText !== undefined" class="tool-pre inline-payload">{{ previous.resultText }}</pre>
                        </div>
                      </details>
                    </div>
                  </details>
                </div>
              </article>

              <article v-else-if="row.rowType === 'approval'" class="approval approval-row" :data-approval-id="row.approval.id">
                <div class="actor-cell compact">
                  <span class="actor-avatar approval-avatar"><ShieldAlert :size="15" aria-hidden="true" /></span>
                  <span class="actor-meta">
                    <span class="sender">Approval</span>
                    <span class="meta">{{ row.approval.request.risk }}</span>
                  </span>
                </div>
                <div class="message-body">
                  <div class="approval-card">
                    <div class="approval-summary-line">{{ approvalRiskLabel(row.approval) }}: {{ row.approval.request.summary }}</div>
                    <div class="approval-target-line">{{ approvalPayloadSummary(row.approval) }}</div>
                    <div class="approval-chip-row">
                      <span v-for="chip in approvalDetailChips(row.approval)" :key="chip" class="approval-chip">{{ chip }}</span>
                    </div>
                  </div>
                  <div class="approval-actions">
                    <button type="button" data-decision="approve" @click="decideApproval(row.approval.id, true)">
                      <Check :size="14" aria-hidden="true" />
                      <span>Approve</span>
                    </button>
                    <button type="button" data-decision="deny" @click="decideApproval(row.approval.id, false)">
                      <X :size="14" aria-hidden="true" />
                      <span>Deny</span>
                    </button>
                  </div>
                  <details class="raw-details compact">
                    <summary>Raw payload</summary>
                    <pre class="tool-pre">{{ approvalRawPayload(row.approval) }}</pre>
                  </details>
                </div>
              </article>
            </template>
          </div>

          <form class="composer" @submit.prevent="submitMessage">
            <div v-if="activeThreadId" class="thread-context">
              <CornerDownRight :size="15" aria-hidden="true" />
              <span class="thread-label">{{ activeThreadLabel }}</span>
              <button class="icon-button" type="button" aria-label="Clear thread" @click="clearActiveThread()">
                <X :size="15" aria-hidden="true" />
              </button>
            </div>
            <textarea ref="messageInput" v-model="messageText" rows="2" autocomplete="off" placeholder="Message an agent or the room" />
            <button class="send-button" type="submit">
              <Send :size="16" aria-hidden="true" />
              <span>Send</span>
            </button>
          </form>
        </section>

        <aside class="operations-pane" aria-label="Agent operations">
          <div class="operations-header">
            <div>
              <p class="panel-kicker">Live work</p>
              <h2>Operations</h2>
            </div>
            <span class="operation-count">{{ latestOperations.length }}</span>
          </div>

          <div class="operations-stats">
            <div>
              <span class="stat-value">{{ activeOperationCount }}</span>
              <span class="stat-label">active</span>
            </div>
            <div>
              <span class="stat-value">{{ pendingApprovalCount }}</span>
              <span class="stat-label">pending</span>
            </div>
            <div>
              <span class="stat-value">{{ knownAgents.length }}</span>
              <span class="stat-label">agents</span>
            </div>
          </div>

          <div v-if="currentOperation" class="operations-order">
            <span>Current</span>
            <span>Received</span>
          </div>

          <div v-if="currentOperation" class="operation-list current-operation" aria-label="Current operation">
            <article class="operation-item" :data-state="operationState(currentOperation)">
              <span class="operation-time">
                <span class="operation-sequence">{{ operationSequence(currentOperation) }}</span>
                <span class="operation-clock">{{ operationTime(currentOperation) }}</span>
              </span>
              <span class="operation-icon" :data-kind="operationIcon(currentOperation)">
                <Activity v-if="operationIcon(currentOperation) === 'status'" :size="15" aria-hidden="true" />
                <ShieldAlert v-else-if="operationIcon(currentOperation) === 'approval'" :size="15" aria-hidden="true" />
                <TerminalSquare v-else-if="operationIcon(currentOperation) === 'terminal'" :size="15" aria-hidden="true" />
                <Bot v-else :size="15" aria-hidden="true" />
              </span>
              <span class="operation-copy">
                <span class="operation-title">{{ operationTitle(currentOperation) }}</span>
                <span class="operation-detail">{{ operationDetail(currentOperation) }}</span>
              </span>
              <span class="operation-state">{{ operationState(currentOperation) }}</span>
            </article>
          </div>

          <details v-if="previousOperations.length" class="operation-archive">
            <summary>
              <span>Previous operations</span>
              <span>{{ previousOperations.length }}</span>
            </summary>
            <div class="operation-list archived-operations" aria-label="Previous operations">
              <article
                v-for="row in previousOperations"
                :key="row.id"
                class="operation-item"
                :data-state="operationState(row)"
              >
                <span class="operation-time">
                  <span class="operation-sequence">{{ operationSequence(row) }}</span>
                  <span class="operation-clock">{{ operationTime(row) }}</span>
                </span>
                <span class="operation-icon" :data-kind="operationIcon(row)">
                  <Activity v-if="operationIcon(row) === 'status'" :size="15" aria-hidden="true" />
                  <ShieldAlert v-else-if="operationIcon(row) === 'approval'" :size="15" aria-hidden="true" />
                  <TerminalSquare v-else-if="operationIcon(row) === 'terminal'" :size="15" aria-hidden="true" />
                  <Bot v-else :size="15" aria-hidden="true" />
                </span>
                <span class="operation-copy">
                  <span class="operation-title">{{ operationTitle(row) }}</span>
                  <span class="operation-detail">{{ operationDetail(row) }}</span>
                </span>
                <span class="operation-state">{{ operationState(row) }}</span>
              </article>
            </div>
          </details>
          <div v-if="!currentOperation" class="operations-empty">
            <Activity :size="16" aria-hidden="true" />
            <span>No agent activity yet.</span>
          </div>

          <button class="trace-link" type="button" @click="openTraceViewer">
            <Activity :size="15" aria-hidden="true" />
            <span>Open trace</span>
          </button>
        </aside>
      </div>

      <div v-else-if="activeView === 'agent'" class="agent-dashboard">
        <div class="dashboard-summary">
          <div class="metric">
            <div class="metric-label">activities</div>
            <div class="metric-value">{{ activeAgentRows.length }}</div>
          </div>
          <div class="metric">
            <div class="metric-label">tool calls</div>
            <div class="metric-value">{{ activeAgentToolCount }}</div>
          </div>
          <div class="metric">
            <div class="metric-label">approvals</div>
            <div class="metric-value">{{ activeAgentApprovalCount }}</div>
          </div>
        </div>

        <div class="dashboard-list">
          <div class="dashboard-list-header">
            <span>Status</span>
            <span>Operation</span>
            <span>Target</span>
            <span>Thread</span>
            <span>Channel</span>
          </div>
          <template v-for="row in activeAgentRows" :key="row.id">
            <article v-if="row.rowType === 'agent-status'" class="dashboard-status">
              <span class="tool-state" :data-state="agentStatusVisualState(row)">{{ agentStatusLabel(row) }}</span>
              <span class="dashboard-primary">{{ row.text }}</span>
              <span class="dashboard-secondary">{{ agentRunDuration(row) || 'runtime' }}</span>
              <span class="dashboard-mono">{{ row.threadId }}</span>
              <span class="dashboard-muted">{{ fallbackDash(row.channel) }}</span>
            </article>

            <article v-else class="dashboard-tool" :data-state="row.state">
              <details class="dashboard-details" :open="row.open" @toggle="syncToolOpen(row, $event)">
                <summary class="dashboard-row-summary">
                  <span class="tool-state" :data-state="row.state">{{ row.state }}</span>
                  <span class="dashboard-primary">
                    <span class="tool-name">{{ toolOperation(row) }}</span>
                    <span class="tool-preview">{{ row.preview }}</span>
                  </span>
                  <span class="dashboard-secondary">{{ toolTarget(row) }}</span>
                  <span class="dashboard-mono">{{ row.threadId }}</span>
                  <span class="dashboard-muted">{{ fallbackDash(row.channel) }}</span>
                </summary>

                <div class="dashboard-detail-body">
                  <div class="dashboard-meta">
                    <span>{{ row.toolCallId }}</span>
                    <span>{{ row.threadId }}</span>
                    <span v-if="row.channel">{{ row.channel }}</span>
                  </div>

                  <details class="raw-details tool-section">
                    <summary>Arguments</summary>
                    <pre class="tool-pre">{{ row.argumentsText }}</pre>
                  </details>

                  <div v-if="row.approval" class="tool-section tool-approval" :data-approval-id="row.approval.id">
                    <div class="approval-header">
                      <span class="approval-status" :data-state="approvalState(row)">{{ approvalLabel(row) }}</span>
                      <span class="grant-summary">{{ grantSummary(row.approvalResult) }}</span>
                    </div>
                    <div class="approval-card">
                      <div class="approval-summary-line">{{ approvalRiskLabel(row.approval) }}: {{ row.approval.request.summary }}</div>
                      <div class="approval-target-line">{{ approvalPayloadSummary(row.approval) }}</div>
                      <div class="approval-chip-row">
                        <span v-for="chip in approvalDetailChips(row.approval)" :key="chip" class="approval-chip">{{ chip }}</span>
                      </div>
                    </div>
                    <template v-if="diffPreview(row.approval)">
                      <div class="tool-section-label">Diff Preview</div>
                      <pre class="tool-pre">{{ diffPreview(row.approval) }}</pre>
                    </template>
                    <details class="raw-details">
                      <summary>Raw payload</summary>
                      <pre class="tool-pre">{{ approvalRawPayload(row.approval) }}</pre>
                    </details>
                    <div v-if="!row.approvalResult" class="approval-actions">
                      <button type="button" data-decision="approve" @click="decideApproval(row.approval.id, true)">
                        <Check :size="14" aria-hidden="true" />
                        <span>Approve</span>
                      </button>
                      <button type="button" data-decision="deny" @click="decideApproval(row.approval.id, false)">
                        <X :size="14" aria-hidden="true" />
                        <span>Deny</span>
                      </button>
                    </div>
                  </div>

                  <div v-if="row.resultText !== undefined" class="tool-section tool-result-section">
                    <div class="tool-section-label">Result</div>
                    <div class="tool-result-summary">{{ row.resultSummary }}</div>
                    <details v-if="row.resultText !== row.resultSummary" class="raw-details">
                      <summary>Result detail</summary>
                      <pre class="tool-pre tool-result">{{ row.resultText }}</pre>
                    </details>
                  </div>
                </div>
              </details>
            </article>
          </template>
          <div v-if="!activeAgentRows.length" class="dashboard-empty">
            <div class="dashboard-empty-title">No activity yet</div>
            <div class="dashboard-empty-text">Agent status and tool calls will appear here during a run.</div>
          </div>
        </div>
      </div>

      <div v-else-if="activeView === 'trace'" class="trace-view">
        <div class="trace-controls">
          <label class="trace-filter">
            <span><Search :size="13" aria-hidden="true" /> Search</span>
            <input v-model="traceQuery" class="trace-input" type="search" autocomplete="off" @keydown.enter.prevent="refreshTrace" />
          </label>
          <label class="trace-filter trace-limit">
            <span>Limit</span>
            <input v-model.number="traceLimit" class="trace-input" type="number" min="1" max="1000" step="25" @keydown.enter.prevent="refreshTrace" />
          </label>
          <button class="ghost icon-label" type="button" :disabled="traceState.loading" @click="refreshTrace">
            <RefreshCw :size="15" aria-hidden="true" />
            <span>Apply</span>
          </button>
        </div>

        <div v-if="traceState.tracePath" class="trace-path">{{ traceState.tracePath }}</div>

        <div class="trace-glance" aria-label="Trace summary">
          <span class="trace-glance-chip" :data-tone="traceIssueCount ? 'issue' : 'ok'">
            <span>{{ traceIssueCount }}</span>
            <span>issues</span>
          </span>
          <span class="trace-glance-chip">
            <span>{{ traceMetric(traceState.stats.total_events) }}</span>
            <span>events</span>
          </span>
          <span class="trace-glance-chip">
            <span>{{ traceMetric(traceState.stats.approvals) }}</span>
            <span>approvals</span>
          </span>
          <span class="trace-glance-chip">
            <span>{{ traceRouteCount('dropped') + traceRouteCount('rejected') }}</span>
            <span>blocked</span>
          </span>
          <span class="trace-glance-note">{{ traceMetric(traceState.stats.group_count) }} relation groups</span>
        </div>

        <div v-if="traceState.error" class="trace-empty trace-error">{{ traceState.error }}</div>
        <div v-else-if="!traceState.available" class="trace-empty">Trace is not configured for this bridge.</div>
        <div v-else-if="!traceState.events.length" class="trace-empty">No trace events yet.</div>
        <div v-else class="trace-event-stream" aria-label="Trace event stream">
          <article
            v-for="event in traceState.events"
            :key="event.id"
            class="trace-event"
            :data-route="traceRoute(event)"
            :data-direction="traceDirection(event)"
            :data-tone="traceTone(event)"
            :style="traceDepthStyle(event)"
          >
            <div class="trace-event-rail" aria-hidden="true">
              <span class="trace-lane"><span class="trace-node"></span></span>
            </div>
            <div class="trace-event-body">
              <div class="trace-event-main">
                <span class="trace-time">{{ formatTraceTime(event.timestamp) }}</span>
                <span class="trace-route-badge" :data-route="traceRoute(event)">{{ traceRoute(event) }}</span>
                <span class="trace-direction">{{ traceDirection(event) }}</span>
                <span class="trace-primary">{{ tracePrimaryLine(event) }}</span>
              </div>
              <div class="trace-event-detail">
                <span class="trace-detail-title">{{ event.label }}</span>
                <span v-if="event.detail" class="trace-detail-text">{{ event.detail }}</span>
              </div>
              <div class="trace-event-meta">
                <button class="trace-relation-chip compact" type="button" @click="traceQuery = traceGroupLabel(event); refreshTrace()">
                  group {{ traceGroupLabel(event) }}
                </button>
                <span v-if="traceParent(event)" class="trace-chip">parent {{ traceParent(event) }}</span>
                <button
                  v-for="relation in traceRelations(event)"
                  :key="relation.kind + ':' + relation.value"
                  class="trace-relation-chip compact"
                  type="button"
                  @click="filterTraceRelation(relation)"
                >
                  {{ relation.label }}
                </button>
                <span v-for="chip in traceChips(event)" :key="chip" class="trace-chip">{{ chip }}</span>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  </main>
</template>
