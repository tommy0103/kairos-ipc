<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";

type EndpointUri = string;
type RowClass = "delta" | "error";
type RunState = "active" | "cancelling" | "cancelled" | "completed";
type ToolState = "running" | "completed" | "errored";

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
  toolCallId: string;
  state: ToolState;
  name: string;
  preview: string;
  argumentsText: string;
  open: boolean;
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
  text: string;
}

interface ApprovalRow {
  rowType: "approval";
  id: string;
  approval: SlockApprovalEvent;
}

type UiRow = SimpleRow | MessageRow | ToolRow | ApprovalRow;
type AgentActivityRow = ToolRow | AgentStatusRow;

const timeline = ref<HTMLDivElement | null>(null);
const messageInput = ref<HTMLTextAreaElement | null>(null);
const status = ref("connecting");
const channels = ref<SlockUiBridgeChannel[]>([]);
const activeChannel = ref<SlockUiBridgeChannel | null>(null);
const rows = ref<UiRow[]>([]);
const agentActivityRows = ref<AgentActivityRow[]>([]);
const knownAgents = ref<EndpointUri[]>([]);
const activeView = ref<"chat" | "agent">("chat");
const activeAgentUri = ref<EndpointUri | null>(null);
const messageText = ref("@pi read package.json and summarize the scripts");
const activeThreadId = ref<string | null>(null);
const activeReplyToId = ref<string | null>(null);
const activeThreadLabel = ref("");

const rendered = new Set<string>();
const streamRows = new Map<string, SimpleRow>();
const toolRows = new Map<string, ToolRow>();
const approvalById = new Map<string, SlockApprovalEvent>();
const pendingToolApprovals = new Map<string, SlockApprovalEvent>();
const typingTimers = new Map<string, number>();
let nextEphemeralRowId = 1;
let nextAgentStatusRowId = 1;
let events: EventSource | undefined;

const channelTitle = computed(() => activeChannel.value ? channelLabel(activeChannel.value) : "Slock");
const workspaceTitle = computed(() => activeView.value === "agent" ? activeAgentUri.value ?? "Agent" : channelTitle.value);
const workspaceStatus = computed(() => activeView.value === "agent" ? "agent dashboard" : status.value);
const activeAgentRows = computed(() => agentActivityRows.value.filter((row) => row.source === activeAgentUri.value));
const activeAgentToolCount = computed(() => activeAgentRows.value.filter((row) => row.rowType === "tool").length);
const activeAgentApprovalCount = computed(() => activeAgentRows.value.filter((row) => row.rowType === "tool" && row.approval).length);

onMounted(() => {
  events = new EventSource("/events");
  events.onopen = () => setStatus("connected");
  events.onerror = () => setStatus("reconnecting");
  events.onmessage = (message) => renderEvent(JSON.parse(message.data) as SlockChannelEvent);

  loadChannels().catch((error: unknown) => appendSimpleRow("error", "bridge", errorMessage(error)));
});

onBeforeUnmount(() => {
  events?.close();
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

function rememberAgent(uri: EndpointUri): void {
  if (!uri.startsWith("agent://") || knownAgents.value.includes(uri)) return;
  knownAgents.value = [...knownAgents.value, uri];
}

function agentLabel(uri: EndpointUri): string {
  return "@ " + (uri.split("/").filter(Boolean).pop() || uri);
}

function resetTimeline(): void {
  for (const timer of typingTimers.values()) window.clearTimeout(timer);
  rendered.clear();
  streamRows.clear();
  toolRows.clear();
  agentActivityRows.value = [];
  knownAgents.value = [];
  approvalById.clear();
  pendingToolApprovals.clear();
  typingTimers.clear();
  rows.value = [];
}

function insertRow<T extends UiRow>(row: T): T {
  const reactiveRow = reactive(row) as T;
  rows.value.push(reactiveRow);
  scrollTimeline();
  return reactiveRow;
}

function insertAgentActivityRow<T extends AgentActivityRow>(row: T): T {
  const reactiveRow = reactive(row) as T;
  agentActivityRows.value.push(reactiveRow);
  rememberAgent(row.source);
  return reactiveRow;
}

function ensureToolRowInChat(row: ToolRow): void {
  if (rows.value.some((entry) => entry.rowType === "tool" && entry.id === row.id)) return;
  rows.value.push(row);
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

function formatToolResult(tool: ToolMetadata): string {
  const parsed = parseJsonMaybe(tool.result);
  if (tool.name === "exec" && isRecord(parsed)) {
    return formatShellResult(parsed);
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
}

function updateToolRow(row: ToolRow, tool: ToolMetadata): void {
  const state = tool.state === "completed" || tool.state === "errored" ? tool.state : "running";
  row.state = state;
  row.name = tool.name;
  row.preview = toolPreview(tool);
  row.argumentsText = formatValue(tool.arguments);
  row.open = state === "running" && Boolean(row.approval);

  if (state !== "running" && Object.prototype.hasOwnProperty.call(tool, "result")) {
    row.resultText = formatToolResult(tool);
  }
}

function attachApprovalToToolRow(row: ToolRow, approval: SlockApprovalEvent): void {
  removeApprovalRow(approval.id);
  row.approval = approval;
  row.approvalResult = undefined;
  row.open = true;
  ensureToolRowInChat(row);
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

function renderDelta(delta: SlockMessageDelta): void {
  rememberAgent(delta.source);
  if (delta.kind === "status") {
    if (isToolMetadata(delta.metadata)) {
      renderToolDelta(delta, delta.metadata);
      return;
    }

    insertAgentActivityRow({
      rowType: "agent-status",
      id: `agent-status:${nextAgentStatusRowId++}`,
      channel: activeChannel.value?.uri,
      source: delta.source,
      threadId: delta.thread_id,
      text: delta.text,
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
  <main class="shell">
    <section class="sidebar" aria-label="Channels">
      <div class="brand">Slock IPC</div>
      <div class="nav-label">Channels</div>
      <div class="channel-list">
        <button
          v-for="channel in channels"
          :key="channel.uri"
          class="channel"
          :class="{ active: activeView === 'chat' && activeChannel?.uri === channel.uri }"
          type="button"
          @click="switchChannel(channel.uri)"
        >
          {{ channelLabel(channel) }}
        </button>
      </div>
      <div v-if="knownAgents.length" class="nav-label nav-label-spaced">Agents</div>
      <div v-if="knownAgents.length" class="channel-list">
        <button
          v-for="agent in knownAgents"
          :key="agent"
          class="channel"
          :class="{ active: activeView === 'agent' && activeAgentUri === agent }"
          type="button"
          @click="openAgentDashboard(agent)"
        >
          {{ agentLabel(agent) }}
        </button>
      </div>
    </section>

    <section class="workspace" :aria-label="activeView === 'agent' ? 'Agent dashboard' : 'Channel'">
      <header class="topbar">
        <div>
          <div class="channel-title">{{ workspaceTitle }}</div>
          <div class="status">{{ workspaceStatus }}</div>
        </div>
        <button v-if="activeView === 'chat'" class="ghost" type="button" @click="refreshHistory">Refresh</button>
        <button v-else class="ghost" type="button" @click="showChat">Channel</button>
      </header>

      <div v-if="activeView === 'chat'" ref="timeline" class="timeline" aria-live="polite">
        <template v-for="row in rows" :key="row.id">
          <div
            v-if="row.rowType === 'message'"
            class="message"
            :class="{ 'thread-reply': row.threadReply }"
            :data-rendered-id="row.message.id"
          >
            <div class="meta">{{ row.message.sender }}</div>
            <div class="text">
              <span>{{ row.message.text }}</span>
              <div class="message-actions">
                <button
                  v-if="canCancel(row)"
                  type="button"
                  :data-run-cancel-for="row.message.id"
                  :disabled="cancelDisabled(row)"
                  @click="cancelRun(row.message.id, row)"
                >
                  {{ cancelLabel(row) }}
                </button>
                <button type="button" @click="setActiveThread(row.message)">Reply</button>
              </div>
            </div>
          </div>

          <div
            v-else-if="row.rowType === 'simple'"
            :class="[row.className, { 'thread-reply': row.threadReply }]"
            :data-rendered-id="row.renderedId"
          >
            <div class="meta">{{ row.meta }}</div>
            <div class="text">{{ row.text }}</div>
          </div>

          <div
            v-else-if="row.rowType === 'tool'"
            class="tool-call"
            :class="{ 'thread-reply': row.threadReply }"
            :data-tool-call-id="row.toolCallId"
            :data-state="row.state"
          >
            <div class="meta">{{ row.source }}</div>
            <details class="tool-details" :open="row.open" @toggle="syncToolOpen(row, $event)">
              <summary class="tool-summary">
                <span class="tool-state" :data-state="row.state">{{ row.state }}</span>
                <span class="tool-name">{{ row.name }}</span>
                <span class="tool-preview">{{ row.preview }}</span>
              </summary>

              <div v-if="row.approval" class="tool-section tool-approval" :data-approval-id="row.approval.id">
                <div class="approval-header">
                  <span class="approval-status" :data-state="approvalState(row)">{{ approvalLabel(row) }}</span>
                  <span class="grant-summary">{{ grantSummary(row.approvalResult) }}</span>
                </div>
                <template v-if="diffPreview(row.approval)">
                  <div class="tool-section-label">Diff Preview</div>
                  <pre class="tool-pre">{{ diffPreview(row.approval) }}</pre>
                </template>
                <div class="approval-actions">
                  <button
                    type="button"
                    data-decision="approve"
                    :disabled="Boolean(row.approvalResult)"
                    @click="decideApproval(row.approval.id, true)"
                  >Approve</button>
                  <button
                    type="button"
                    data-decision="deny"
                    :disabled="Boolean(row.approvalResult)"
                    @click="decideApproval(row.approval.id, false)"
                  >Deny</button>
                </div>
              </div>

              <div v-if="row.resultText !== undefined" class="tool-section tool-result-section">
                <div class="tool-section-label">Result</div>
                <pre class="tool-pre tool-result">{{ row.resultText }}</pre>
              </div>
            </details>
          </div>

          <div v-else class="approval" :data-approval-id="row.approval.id">
            <div class="meta">{{ row.approval.request.risk }}</div>
            <div class="text">
              <div>{{ row.approval.request.summary }}</div>
              <div class="approval-actions">
                <button type="button" data-decision="approve" @click="decideApproval(row.approval.id, true)">Approve</button>
                <button type="button" data-decision="deny" @click="decideApproval(row.approval.id, false)">Deny</button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div v-else class="agent-dashboard">
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
              <span class="tool-state" data-state="running">status</span>
              <span class="dashboard-primary">{{ row.text }}</span>
              <span class="dashboard-secondary">runtime</span>
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

                  <div class="tool-section">
                    <div class="tool-section-label">Arguments</div>
                    <pre class="tool-pre">{{ row.argumentsText }}</pre>
                  </div>

                  <div v-if="row.approval" class="tool-section tool-approval" :data-approval-id="row.approval.id">
                    <div class="approval-header">
                      <span class="approval-status" :data-state="approvalState(row)">{{ approvalLabel(row) }}</span>
                      <span class="grant-summary">{{ grantSummary(row.approvalResult) }}</span>
                    </div>
                    <template v-if="diffPreview(row.approval)">
                      <div class="tool-section-label">Diff Preview</div>
                      <pre class="tool-pre">{{ diffPreview(row.approval) }}</pre>
                    </template>
                    <div v-if="!row.approvalResult" class="approval-actions">
                      <button type="button" data-decision="approve" @click="decideApproval(row.approval.id, true)">Approve</button>
                      <button type="button" data-decision="deny" @click="decideApproval(row.approval.id, false)">Deny</button>
                    </div>
                  </div>

                  <div v-if="row.resultText !== undefined" class="tool-section tool-result-section">
                    <div class="tool-section-label">Result</div>
                    <pre class="tool-pre tool-result">{{ row.resultText }}</pre>
                  </div>
                </div>
              </details>
            </article>
          </template>
        </div>
      </div>

      <form v-if="activeView === 'chat'" class="composer" @submit.prevent="submitMessage">
        <div v-if="activeThreadId" class="thread-context">
          <span class="thread-label">{{ activeThreadLabel }}</span>
          <button class="ghost" type="button" @click="clearActiveThread()">Clear</button>
        </div>
        <textarea ref="messageInput" v-model="messageText" rows="2" autocomplete="off" />
        <button type="submit">Send</button>
      </form>
    </section>
  </main>
</template>
