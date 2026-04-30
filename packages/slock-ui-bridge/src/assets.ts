export function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Slock IPC</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="shell">
      <section class="sidebar" aria-label="Channels">
        <div class="brand">Slock IPC</div>
        <button class="channel active" type="button"># general</button>
      </section>
      <section class="workspace" aria-label="Channel">
        <header class="topbar">
          <div>
            <div class="channel-title"># general</div>
            <div class="status" id="status">connecting</div>
          </div>
          <button class="ghost" id="refresh" type="button">Refresh</button>
        </header>
        <div class="timeline" id="timeline" aria-live="polite"></div>
        <form class="composer" id="composer">
          <textarea id="message" name="message" rows="2" autocomplete="off">@pi read package.json and summarize the scripts</textarea>
          <button type="submit">Send</button>
        </form>
      </section>
    </main>
    <script src="/app.js" type="module"></script>
  </body>
</html>`;
}

export function renderCss(): string {
  return `:root {
  color-scheme: light;
  --bg: #f6f7f8;
  --panel: #ffffff;
  --line: #d7dde2;
  --text: #182026;
  --muted: #60707c;
  --accent: #237a57;
  --accent-strong: #176346;
  --warn: #9a6400;
  --delta: #f2f7fb;
  --tool: #f4f7f1;
  --tool-line: #cbd7c4;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

button, textarea { font: inherit; }

.shell {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  border-right: 1px solid var(--line);
  background: #20272d;
  color: #f7fafc;
  padding: 16px 12px;
}

.brand {
  font-weight: 700;
  margin: 2px 8px 18px;
}

.channel {
  width: 100%;
  height: 36px;
  border: 0;
  border-radius: 6px;
  text-align: left;
  padding: 0 10px;
  background: transparent;
  color: #c8d2da;
  cursor: pointer;
}

.channel.active {
  background: #34414a;
  color: #ffffff;
}

.workspace {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-width: 0;
  min-height: 100vh;
  background: var(--panel);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 64px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--line);
}

.channel-title { font-weight: 700; }
.status { color: var(--muted); font-size: 12px; margin-top: 2px; }

.ghost {
  height: 34px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #ffffff;
  color: var(--text);
  padding: 0 12px;
  cursor: pointer;
}

.timeline {
  overflow: auto;
  padding: 8px 0;
}

.message, .delta, .error, .approval, .tool-call {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  gap: 12px;
  padding: 9px 20px;
  border-bottom: 1px solid #eef1f3;
}

.message:hover, .delta:hover, .tool-call:hover { background: #fafbfc; }
.delta { background: var(--delta); color: #304554; }
.error { color: var(--warn); background: #fff8ea; }
.approval { background: #f9f6ef; }
.tool-call { background: var(--tool); color: #26372c; }

.meta {
  color: var(--muted);
  min-width: 0;
  overflow-wrap: anywhere;
}

.sender {
  color: var(--text);
  font-weight: 700;
}

.text {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.message-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.message-actions button {
  height: 28px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #ffffff;
  color: var(--text);
  padding: 0 10px;
  cursor: pointer;
}

.message-actions button:disabled {
  cursor: default;
  color: var(--muted);
}

.approval-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.approval-actions button {
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #ffffff;
  color: var(--text);
  padding: 0 10px;
  cursor: pointer;
}

.approval-actions button[data-decision="approve"] {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}

.tool-details {
  min-width: 0;
}

.tool-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
}

.tool-state {
  flex: 0 0 auto;
  min-width: 74px;
  border: 1px solid var(--tool-line);
  border-radius: 999px;
  padding: 1px 8px 2px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

.tool-state[data-state="running"] {
  border-color: #a9c8b8;
  color: var(--accent-strong);
}

.tool-state[data-state="completed"] {
  border-color: #b9c5ba;
  color: #4c6956;
}

.tool-state[data-state="errored"] {
  border-color: #d7b36a;
  color: var(--warn);
}

.tool-name {
  flex: 0 0 auto;
  font-weight: 700;
}

.tool-preview {
  min-width: 0;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-section {
  margin-top: 8px;
  border-left: 2px solid var(--tool-line);
  padding-left: 10px;
}

.tool-section-label {
  margin-bottom: 3px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}

.tool-pre {
  max-height: 240px;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

.tool-approval {
  border-left-color: #d1bea0;
}

.approval-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.approval-status {
  flex: 0 0 auto;
  border: 1px solid #d1bea0;
  border-radius: 999px;
  padding: 1px 8px 2px;
  color: var(--warn);
  font-size: 12px;
}

.approval-status[data-state="approved"] {
  border-color: #a9c8b8;
  color: var(--accent-strong);
}

.approval-status[data-state="denied"] {
  border-color: #d7b36a;
  color: var(--warn);
}

.composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 86px;
  gap: 10px;
  padding: 14px 20px 18px;
  border-top: 1px solid var(--line);
  background: #fbfcfd;
}

textarea {
  width: 100%;
  min-height: 46px;
  max-height: 160px;
  resize: vertical;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px 12px;
  color: var(--text);
  background: #ffffff;
}

.composer button {
  height: 46px;
  border: 0;
  border-radius: 6px;
  background: var(--accent);
  color: #ffffff;
  font-weight: 700;
  cursor: pointer;
}

.composer button:hover { background: var(--accent-strong); }

@media (max-width: 720px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar { display: none; }
  .message, .delta, .error, .approval, .tool-call { grid-template-columns: 1fr; gap: 2px; }
  .composer { grid-template-columns: 1fr; }
  .composer button { width: 100%; }
}`;
}

export function renderJs(): string {
  return `const timeline = document.querySelector("#timeline");
const statusEl = document.querySelector("#status");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message");
const refresh = document.querySelector("#refresh");
const rendered = new Set();
const streamRows = new Map();
const toolRows = new Map();
const approvalById = new Map();
const pendingToolApprovals = new Map();

function setStatus(value) {
  statusEl.textContent = value;
}

function appendRow(className, meta, text, id) {
  if (id && rendered.has(id)) return;
  if (id) rendered.add(id);
  const row = document.createElement("div");
  row.className = className;
  if (id) row.dataset.renderedId = id;
  const metaEl = document.createElement("div");
  metaEl.className = "meta";
  metaEl.textContent = meta;
  const textEl = document.createElement("div");
  textEl.className = "text";
  textEl.textContent = text;
  row.append(metaEl, textEl);
  timeline.append(row);
  timeline.scrollTop = timeline.scrollHeight;
  return row;
}

function removeRow(id) {
  rendered.delete(id);
  const row = document.querySelector('[data-rendered-id="' + id + '"]');
  if (row) row.remove();
}

function streamKey(delta) {
  return "stream:" + delta.source + ":" + delta.thread_id;
}

function toolKeyFromParts(source, threadId, toolCallId) {
  return "tool:" + source + ":" + threadId + ":" + toolCallId;
}

function toolKey(delta, tool) {
  return toolKeyFromParts(delta.source, delta.thread_id, tool.tool_call_id);
}

function approvalToolKey(approval) {
  const metadata = approval?.request?.metadata;
  if (!isRecord(metadata) || typeof metadata.thread_id !== "string" || typeof metadata.tool_call_id !== "string") {
    return undefined;
  }
  return toolKeyFromParts(approval.source, metadata.thread_id, metadata.tool_call_id);
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isToolMetadata(value) {
  return isRecord(value)
    && value.type === "tool_call"
    && typeof value.tool_call_id === "string"
    && typeof value.name === "string";
}

function formatValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function truncate(value, maxLength) {
  return value.length > maxLength ? value.slice(0, maxLength - 1) + "..." : value;
}

function parseJsonMaybe(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function toolPreview(tool) {
  const args = isRecord(tool.arguments) ? tool.arguments : {};
  if (typeof args.path === "string") return args.path;
  if (typeof args.command === "string") {
    const argv = Array.isArray(args.args) ? args.args.filter((item) => typeof item === "string") : [];
    return truncate([args.command, ...argv].join(" "), 120);
  }
  return truncate(formatValue(tool.arguments).replace(/\\s+/g, " "), 120);
}

function formatShellResult(result) {
  const lines = [];
  lines.push("exit_code: " + String(result.exit_code ?? ""));
  if (typeof result.cwd === "string") lines.push("cwd: " + result.cwd);
  if (typeof result.stdout === "string" && result.stdout.length > 0) {
    lines.push("", "stdout:", result.stdout.trimEnd());
  }
  if (typeof result.stderr === "string" && result.stderr.length > 0) {
    lines.push("", "stderr:", result.stderr.trimEnd());
  }
  return lines.join("\\n");
}

function formatToolResult(tool) {
  const parsed = parseJsonMaybe(tool.result);
  if (tool.name === "exec" && isRecord(parsed)) {
    return formatShellResult(parsed);
  }
  return formatValue(parsed);
}

function diffPreview(approval) {
  const call = approval?.request?.proposed_call;
  const payload = call?.payload;
  if (!isRecord(call) || call.action !== "edit" || !isRecord(payload)) return "";
  if (typeof payload.old_text !== "string" || typeof payload.new_text !== "string") return "";
  const path = typeof payload.path === "string" ? payload.path : "file";
  const oldLines = payload.old_text.split("\\n").map((line) => "- " + line);
  const newLines = payload.new_text.split("\\n").map((line) => "+ " + line);
  return ["--- " + path, "+++ " + path, ...oldLines, ...newLines].join("\\n");
}

function renderToolDelta(delta) {
  const tool = delta.metadata;
  const id = toolKey(delta, tool);
  let row = toolRows.get(id);
  if (!row) {
    row = createToolRow(delta, tool);
    toolRows.set(id, row);
    timeline.append(row);
  }

  updateToolRow(row, tool);
  const pendingApproval = pendingToolApprovals.get(id);
  if (pendingApproval) {
    attachApprovalToToolRow(row, pendingApproval);
  }
  timeline.scrollTop = timeline.scrollHeight;
}

function createToolRow(delta, tool) {
  const row = document.createElement("div");
  row.className = "tool-call";
  row.dataset.toolCallId = tool.tool_call_id;

  const metaEl = document.createElement("div");
  metaEl.className = "meta";
  metaEl.textContent = delta.source;

  const details = document.createElement("details");
  details.className = "tool-details";

  const summary = document.createElement("summary");
  summary.className = "tool-summary";
  const state = document.createElement("span");
  state.className = "tool-state";
  const name = document.createElement("span");
  name.className = "tool-name";
  const preview = document.createElement("span");
  preview.className = "tool-preview";
  summary.append(state, name, preview);

  const approvalSection = document.createElement("div");
  approvalSection.className = "tool-section tool-approval";
  approvalSection.hidden = true;

  const resultSection = document.createElement("div");
  resultSection.className = "tool-section tool-result-section";
  resultSection.hidden = true;
  const resultLabel = document.createElement("div");
  resultLabel.className = "tool-section-label";
  resultLabel.textContent = "Result";
  const resultPre = document.createElement("pre");
  resultPre.className = "tool-pre tool-result";
  resultSection.append(resultLabel, resultPre);

  details.append(summary, approvalSection, resultSection);
  row.append(metaEl, details);
  updateToolRow(row, tool);
  return row;
}

function updateToolRow(row, tool) {
  const state = tool.state === "completed" || tool.state === "errored" ? tool.state : "running";
  row.dataset.state = state;
  const details = row.querySelector(".tool-details");
  const stateEl = row.querySelector(".tool-state");
  const nameEl = row.querySelector(".tool-name");
  const previewEl = row.querySelector(".tool-preview");
  const resultSection = row.querySelector(".tool-result-section");
  const resultPre = row.querySelector(".tool-result");
  const approvalSection = row.querySelector(".tool-approval");

  details.open = state === "running" && approvalSection.hidden === false;
  stateEl.dataset.state = state;
  stateEl.textContent = state;
  nameEl.textContent = tool.name;
  previewEl.textContent = toolPreview(tool);

  if (state !== "running" && Object.prototype.hasOwnProperty.call(tool, "result")) {
    resultSection.hidden = false;
    resultPre.textContent = formatToolResult(tool);
  }
}

function attachApprovalToToolRow(row, approval) {
  removeApprovalRow(approval.id);
  const section = row.querySelector(".tool-approval");
  section.hidden = false;
  section.dataset.approvalId = approval.id;
  section.replaceChildren();

  const header = document.createElement("div");
  header.className = "approval-header";
  const status = document.createElement("span");
  status.className = "approval-status";
  status.dataset.state = "pending";
  status.textContent = "approval required";
  header.append(status);

  const diff = diffPreview(approval);
  const diffLabel = document.createElement("div");
  diffLabel.className = "tool-section-label";
  diffLabel.textContent = "Diff Preview";
  diffLabel.hidden = diff.length === 0;
  const diffPre = document.createElement("pre");
  diffPre.className = "tool-pre";
  diffPre.textContent = diff;
  diffPre.hidden = diff.length === 0;

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.dataset.decision = "approve";
  approve.textContent = "Approve";
  approve.addEventListener("click", () => decideApproval(approval.id, true));
  const deny = document.createElement("button");
  deny.type = "button";
  deny.dataset.decision = "deny";
  deny.textContent = "Deny";
  deny.addEventListener("click", () => decideApproval(approval.id, false));
  actions.append(approve, deny);

  section.append(header, diffLabel, diffPre, actions);
  const details = row.querySelector(".tool-details");
  details.open = true;
}

function updateToolApproval(row, result) {
  const section = row.querySelector(".tool-approval");
  if (!section) return false;
  const status = section.querySelector(".approval-status");
  const state = result.approved ? "approved" : "denied";
  if (status) {
    status.dataset.state = state;
    status.textContent = result.approved ? "approved" : "denied";
  }
  for (const button of section.querySelectorAll("button")) {
    button.disabled = true;
  }
  return true;
}

function removeApprovalRow(id) {
  rendered.delete("approval:" + id);
  const row = document.querySelector('[data-approval-id="' + id + '"]');
  if (row && row.classList.contains("approval")) row.remove();
}

function appendApproval(approval) {
  const id = "approval:" + approval.id;
  if (rendered.has(id)) return;
  rendered.add(id);
  const row = document.createElement("div");
  row.className = "approval";
  row.dataset.approvalId = approval.id;

  const metaEl = document.createElement("div");
  metaEl.className = "meta";
  metaEl.textContent = approval.request.risk;

  const body = document.createElement("div");
  body.className = "text";
  const summary = document.createElement("div");
  summary.textContent = approval.request.summary;

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.dataset.decision = "approve";
  approve.textContent = "Approve";
  approve.addEventListener("click", () => decideApproval(approval.id, true));
  const deny = document.createElement("button");
  deny.type = "button";
  deny.dataset.decision = "deny";
  deny.textContent = "Deny";
  deny.addEventListener("click", () => decideApproval(approval.id, false));
  actions.append(approve, deny);
  body.append(summary, actions);
  row.append(metaEl, body);
  timeline.append(row);
  timeline.scrollTop = timeline.scrollHeight;
}

function renderApprovalRequested(approval) {
  approvalById.set(approval.id, approval);
  const key = approvalToolKey(approval);
  if (key) {
    pendingToolApprovals.set(key, approval);
    const row = toolRows.get(key);
    if (row) {
      attachApprovalToToolRow(row, approval);
      timeline.scrollTop = timeline.scrollHeight;
      return;
    }
  }

  appendApproval(approval);
}

function renderApprovalResolved(event) {
  const approval = approvalById.get(event.id);
  const key = approval ? approvalToolKey(approval) : undefined;
  if (key) {
    const row = toolRows.get(key);
    pendingToolApprovals.delete(key);
    if (row && updateToolApproval(row, event.result)) {
      removeApprovalRow(event.id);
      approvalById.delete(event.id);
      return;
    }
  }

  removeApprovalRow(event.id);
  approvalById.delete(event.id);
  appendRow("delta", "approval", event.result.approved ? "Approved" : "Denied");
}

function renderMessage(message) {
  if (message.kind === "agent" && message.thread_id) {
    markRunFinished(message.thread_id, "completed");
    const id = "stream:" + message.sender + ":" + message.thread_id;
    streamRows.delete(id);
    removeRow(id);
  }
  const row = appendRow("message", message.sender, message.text, message.id);
  if (row && message.kind === "human" && Array.isArray(message.mentions) && message.mentions.length > 0) {
    attachRunCancel(row, message);
  }
}

function attachRunCancel(row, message) {
  const textEl = row.querySelector(".text");
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.dataset.runCancelFor = message.id;
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => cancelRun(message.id, cancel));
  actions.append(cancel);
  textEl.append(actions);
}

function markRunFinished(messageId, state) {
  const button = document.querySelector('[data-run-cancel-for="' + messageId + '"]');
  if (!button) return;
  button.disabled = true;
  button.textContent = state === "cancelled" ? "Cancelled" : "Completed";
}

function renderDelta(delta) {
  if (delta.kind === "status") {
    if (isToolMetadata(delta.metadata)) {
      renderToolDelta(delta);
      return;
    }

    appendRow("delta", delta.source, delta.text);
    return;
  }

  const id = streamKey(delta);
  let row = streamRows.get(id);
  if (!row) {
    row = appendRow("delta", delta.source, delta.text, id);
    streamRows.set(id, row);
    return;
  }

  const textEl = row.querySelector(".text");
  textEl.textContent += delta.text;
  timeline.scrollTop = timeline.scrollHeight;
}

function renderEvent(event) {
  if (event.type === "message_created" && event.message) {
    renderMessage(event.message);
    return;
  }
  if (event.type === "message_delta" && event.delta) {
    renderDelta(event.delta);
    return;
  }
  if (event.type === "agent_error" && event.error) {
    appendRow("error", event.error.source, event.error.code + ": " + event.error.message);
    return;
  }
  if (event.type === "agent_cancelled" && event.cancelled) {
    markRunFinished(event.cancelled.message_id, "cancelled");
    appendRow("delta", event.cancelled.agent, "Cancelled" + (event.cancelled.reason ? ": " + event.cancelled.reason : ""));
    return;
  }
  if (event.type === "approval_requested" && event.approval) {
    renderApprovalRequested(event.approval);
    return;
  }
  if (event.type === "approval_resolved") {
    renderApprovalResolved(event);
  }
}

async function decideApproval(id, approved) {
  const response = await fetch("/api/approvals/" + encodeURIComponent(id), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved }),
  });
  if (!response.ok) {
    appendRow("error", "approval", await response.text());
  }
}

async function cancelRun(messageId, button) {
  button.disabled = true;
  button.textContent = "Cancelling";
  const response = await fetch("/api/runs/" + encodeURIComponent(messageId) + "/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "user cancelled" }),
  });
  if (!response.ok) {
    button.disabled = false;
    button.textContent = "Cancel";
    appendRow("error", "cancel", await response.text());
  }
}

async function loadHistory() {
  const response = await fetch("/api/history");
  if (!response.ok) throw new Error(await response.text());
  const body = await response.json();
  for (const message of body.messages) renderMessage(message);
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  messageInput.value = "";
  const response = await fetch("/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    appendRow("error", "bridge", await response.text());
  }
});

refresh.addEventListener("click", () => loadHistory().catch((error) => appendRow("error", "bridge", error.message)));

const events = new EventSource("/events");
events.onopen = () => setStatus("connected");
events.onerror = () => setStatus("reconnecting");
events.onmessage = (message) => {
  const event = JSON.parse(message.data);
  renderEvent(event);
};

loadHistory().catch((error) => appendRow("error", "bridge", error.message));`;
}
