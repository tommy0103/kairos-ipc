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
          <textarea id="message" name="message" rows="2" autocomplete="off">@mock please run pwd</textarea>
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

.message, .delta, .error, .approval {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  gap: 12px;
  padding: 9px 20px;
  border-bottom: 1px solid #eef1f3;
}

.message:hover, .delta:hover { background: #fafbfc; }
.delta { background: var(--delta); color: #304554; }
.error { color: var(--warn); background: #fff8ea; }
.approval { background: #f9f6ef; }

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
  .message, .delta, .error, .approval { grid-template-columns: 1fr; gap: 2px; }
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

function setStatus(value) {
  statusEl.textContent = value;
}

function appendRow(className, meta, text, id) {
  if (id && rendered.has(id)) return;
  if (id) rendered.add(id);
  const row = document.createElement("div");
  row.className = className;
  const metaEl = document.createElement("div");
  metaEl.className = "meta";
  metaEl.textContent = meta;
  const textEl = document.createElement("div");
  textEl.className = "text";
  textEl.textContent = text;
  row.append(metaEl, textEl);
  timeline.append(row);
  timeline.scrollTop = timeline.scrollHeight;
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

function renderMessage(message) {
  appendRow("message", message.sender, message.text, message.id);
}

function renderEvent(event) {
  if (event.type === "message_created" && event.message) {
    renderMessage(event.message);
    return;
  }
  if (event.type === "message_delta" && event.delta) {
    appendRow("delta", event.delta.source, event.delta.text);
    return;
  }
  if (event.type === "agent_error" && event.error) {
    appendRow("error", event.error.source, event.error.code + ": " + event.error.message);
    return;
  }
  if (event.type === "approval_requested" && event.approval) {
    appendApproval(event.approval);
    return;
  }
  if (event.type === "approval_resolved") {
    const row = document.querySelector('[data-approval-id="' + event.id + '"]');
    if (row) row.remove();
    appendRow("delta", "approval", event.result.approved ? "Approved" : "Denied");
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
