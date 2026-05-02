import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createMockAgent } from "../packages/agent-adapter-mock/src/index.ts";
import { AllowAllCapabilityGate } from "../packages/kernel/src/capability.ts";
import type { Connection } from "../packages/kernel/src/registry.ts";
import { EndpointRegistry } from "../packages/kernel/src/registry.ts";
import { Router } from "../packages/kernel/src/router.ts";
import { TraceWriter } from "../packages/kernel/src/trace.ts";
import { createBrowserPlugin, createCalculatorPlugin, createReMeMemoryPlugin, createShellPlugin, createWorkspacePlugin } from "../packages/plugins-demo/src/index.ts";
import type { ClientFrame, KernelFrame } from "../packages/protocol/src/index.ts";
import { createNode, IpcCallError, type IpcTransport } from "../packages/sdk/src/index.ts";
import { createSlockRegistry } from "../packages/slock-daemon/src/index.ts";
import {
  createSlockChannel,
  createSlockGrantStore,
  SLOCK_APPROVAL_REQUEST_MIME,
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_MIME,
  SLOCK_SHELL_EXEC_MIME,
  type SlockChannelEvent,
} from "../packages/slock-channel/src/index.ts";
import { createSlockHuman } from "../packages/slock-human/src/index.ts";
import { createSlockUiBridge } from "../packages/slock-ui-bridge/src/index.ts";

test("Slock registry lists mounted endpoints and guides manifest inspection", async () => {
  const context = createContext();
  const human = createNode("human://user/local");
  const registry = createSlockRegistry({
    endpoints: [
      { uri: "plugin://local/workspace", kind: "plugin", label: "workspace" },
      { uri: "plugin://memory/reme", kind: "plugin", label: "memory" },
      { uri: "agent://local/pi-assistant", kind: "agent", label: "pi", internal: true },
    ],
  });

  try {
    await human.connect(context.createTransport("human"));
    await registry.node.connect(context.createTransport("registry"));

    const listed = await human.call("slock://registry", "list_endpoints", {
      mime_type: "application/json",
      data: {},
    });
    const listedData = listed.data as { endpoints: Array<{ uri: string; kind: string; manifest_action?: string }> };
    assert.deepEqual(listedData.endpoints.map((endpoint) => endpoint.uri), [
      "slock://registry",
      "plugin://local/workspace",
      "plugin://memory/reme",
    ]);
    assert.deepEqual(listedData.endpoints.map((endpoint) => endpoint.manifest_action), ["manifest", "manifest", "manifest"]);

    const internal = await human.call("slock://registry", "list_endpoints", {
      mime_type: "application/json",
      data: { include_internal: true },
    });
    const internalData = internal.data as { endpoints: Array<{ uri: string }> };
    assert.ok(internalData.endpoints.some((endpoint) => endpoint.uri === "agent://local/pi-assistant"));

    const manifest = await human.call("slock://registry", "manifest", {
      mime_type: "application/json",
      data: {},
    });
    assert.match(String(manifest.data), /list_endpoints\(payload/);
    assert.match(String(manifest.data), /root endpoint's manifest before endpoint-specific actions/);
    assert.match(String(manifest.data), /list_children/);
  } finally {
    await human.close();
    await registry.node.close();
  }
});

test("Slock basic mention flow stays on IPC endpoints", async () => {
  const context = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    mention_aliases: { mock: "agent://local/mock" },
  });
  const agent = createMockAgent({ uri: "agent://local/mock" });
  const calculator = createCalculatorPlugin({ uri: "plugin://demo/calculator" });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  await human.connect(context.createTransport("human"));
  await channel.node.connect(context.createTransport("channel"));
  await agent.node.connect(context.createTransport("agent"));
  await calculator.node.connect(context.createTransport("calculator"));

  await human.call("app://slock/channel/general", "subscribe", {
    mime_type: "application/json",
    data: {},
  });

  const posted = await human.call("app://slock/channel/general", "post_message", {
    mime_type: SLOCK_MESSAGE_MIME,
    data: {
      text: "@mock please calculate something",
      thread_id: null,
    },
  });

  assert.equal(posted.mime_type, SLOCK_MESSAGE_MIME);
  await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));

  assert.ok(events.some((event) => event.type === "message_created" && event.message?.kind === "human"));
  assert.ok(events.some((event) => event.type === "message_delta" && event.delta?.text.includes("Reading")));
  assert.ok(events.some((event) => event.type === "message_delta" && event.delta?.text.includes("Calculator returned 5")));

  const finalEvent = events.find((event) => event.type === "message_created" && event.message?.kind === "agent");
  assert.ok(finalEvent?.message?.text.includes("2 + 3 = 5"));
  assert.equal(channel.messages.length, 2);

  const history = await human.call("app://slock/channel/general", "history", {
    mime_type: "application/json",
    data: { limit: 10 },
  });
  assert.equal((history.data as any).messages.length, 2);

  await human.close();
  await channel.node.close();
  await agent.node.close();
  await calculator.node.close();
});

test("Slock thread replies route to existing agent participants", async () => {
  const context = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    mention_aliases: { mock: "agent://local/mock" },
  });
  const agent = createMockAgent({ uri: "agent://local/mock" });
  const calculator = createCalculatorPlugin({ uri: "plugin://demo/calculator" });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  await human.connect(context.createTransport("human"));
  await channel.node.connect(context.createTransport("channel"));
  await agent.node.connect(context.createTransport("agent"));
  await calculator.node.connect(context.createTransport("calculator"));

  await human.call("app://slock/channel/general", "subscribe", {
    mime_type: "application/json",
    data: {},
  });

  const root = await human.call("app://slock/channel/general", "post_message", {
    mime_type: SLOCK_MESSAGE_MIME,
    data: { text: "@mock start a thread", thread_id: null },
  });
  const rootId = (root.data as { id: string }).id;
  await waitFor(() => events.filter((event) => event.type === "message_created" && event.message?.kind === "agent").length >= 1);

  const followup = await human.call("app://slock/channel/general", "post_message", {
    mime_type: SLOCK_MESSAGE_MIME,
    data: { text: "continue without an explicit mention", thread_id: rootId },
  });
  const followupId = (followup.data as { id: string }).id;

  await waitFor(() => events.filter((event) => event.type === "message_created" && event.message?.kind === "agent").length >= 2);
  const followupMessage = followup.data as { mentions: string[]; thread_id: string | null };
  const agentReplies = events.filter((event) => event.type === "message_created" && event.message?.kind === "agent");
  const finalReply = agentReplies.at(-1)?.message;

  assert.deepEqual(followupMessage.mentions, ["agent://local/mock"]);
  assert.equal(followupMessage.thread_id, rootId);
  assert.equal(finalReply?.thread_id, rootId);
  assert.equal(finalReply?.reply_to_id, followupId);

  const history = await human.call("app://slock/channel/general", "history", {
    mime_type: "application/json",
    data: { limit: 10, thread_id: rootId },
  });
  assert.equal((history.data as any).messages.length, 4);

  await human.close();
  await channel.node.close();
  await agent.node.close();
  await calculator.node.close();
});

test("Slock channel can fan out one alias to multiple online agents", async () => {
  const context = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    mention_aliases: { agent: ["agent://local/mock-a", "agent://local/mock-b"] },
  });
  const agentA = createMockAgent({ uri: "agent://local/mock-a" });
  const agentB = createMockAgent({ uri: "agent://local/mock-b" });
  const calculator = createCalculatorPlugin({ uri: "plugin://demo/calculator" });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  await human.connect(context.createTransport("human"));
  await channel.node.connect(context.createTransport("channel"));
  await agentA.node.connect(context.createTransport("agent-a"));
  await agentB.node.connect(context.createTransport("agent-b"));
  await calculator.node.connect(context.createTransport("calculator"));

  await human.call("app://slock/channel/general", "subscribe", {
    mime_type: "application/json",
    data: {},
  });

  const posted = await human.call("app://slock/channel/general", "post_message", {
    mime_type: SLOCK_MESSAGE_MIME,
    data: { text: "@agent compare answers", thread_id: null },
  });
  assert.deepEqual((posted.data as { mentions: string[] }).mentions, ["agent://local/mock-a", "agent://local/mock-b"]);

  await waitFor(() => events.filter((event) => event.type === "message_created" && event.message?.kind === "agent").length === 2);
  const replies = events
    .filter((event) => event.type === "message_created" && event.message?.kind === "agent")
    .map((event) => event.message?.sender)
    .sort();
  assert.deepEqual(replies, ["agent://local/mock-a", "agent://local/mock-b"]);

  await human.close();
  await channel.node.close();
  await agentA.node.close();
  await agentB.node.close();
  await calculator.node.close();
});

test("Slock approval flow gates shell execution through human endpoint", async () => {
  const context = createContext();
  const human = createSlockHuman({
    uri: "human://user/local",
    auto_approval: async () => ({ approved: true, grant_ttl_ms: 60000 }),
  });
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const agent = createMockAgent({ uri: "agent://local/mock" });
  const calculator = createCalculatorPlugin({ uri: "plugin://demo/calculator" });
  const shell = createShellPlugin({ uri: "plugin://local/shell", cwd: process.cwd(), allowed_commands: ["pwd"] });
  const events: SlockChannelEvent[] = [];

  human.node.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  await human.node.connect(context.createTransport("human"));
  await channel.node.connect(context.createTransport("channel"));
  await agent.node.connect(context.createTransport("agent"));
  await calculator.node.connect(context.createTransport("calculator"));
  await shell.node.connect(context.createTransport("shell"));

  await human.node.call("app://slock/channel/general", "subscribe", {
    mime_type: "application/json",
    data: {},
  });

  await human.node.call("app://slock/channel/general", "post_message", {
    mime_type: SLOCK_MESSAGE_MIME,
    data: {
      text: "@mock please run pwd",
      mentions: ["agent://local/mock"],
      thread_id: null,
    },
  });

  await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));
  assert.ok(events.some((event) => event.type === "message_delta" && event.delta?.text.includes("Requesting approval")));
  assert.ok(events.some((event) => event.type === "message_delta" && event.delta?.text.includes("Shell command exited 0")));
  const finalEvent = events.find((event) => event.type === "message_created" && event.message?.kind === "agent");
  assert.ok(finalEvent?.message?.text.includes("Approved shell exec: pwd"));

  const traceText = readFileSync(context.tracePath, "utf8");
  const traces = readTrace(context.tracePath);
  assert.ok(traces.some((event) => event.payload_kind === "slock_message" && event.message_kind === "human" && event.message_id === "channel_msg_1"));
  assert.ok(traces.some((event) => event.payload_kind === "slock_agent_run" && event.message_id === "channel_msg_1" && event.channel === "app://slock/channel/general"));
  assert.ok(traces.some((event) => event.payload_kind === "slock_approval_request" && event.approval_risk === "shell_exec" && event.approval_target === "plugin://local/shell"));
  assert.ok(traces.some((event) => event.payload_kind === "slock_shell_exec" && event.shell_command === "pwd"));
  assert.ok(traces.some((event) => event.payload_kind === "slock_channel_event" && event.channel_event_type === "message_created" && event.message_kind === "agent"));
  assert.doesNotMatch(traceText, /please run pwd/);

  await human.node.close();
  await channel.node.close();
  await agent.node.close();
  await calculator.node.close();
  await shell.node.close();
});

test("Workspace plugin exposes bounded list and search without approval", async () => {
  const root = mkdtempSync(join("/tmp", "kairos-ipc-workspace-introspection-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "README.md"), "Kairos IPC workspace\n", "utf8");
  writeFileSync(join(root, "src", "alpha.ts"), "export const marker = 'needle value';\n", "utf8");
  writeFileSync(join(root, ".hidden"), "needle hidden\n", "utf8");

  const context = createContext();
  const human = createNode("human://user/local");
  const workspace = createWorkspacePlugin({
    uri: "plugin://local/workspace",
    root,
    grant_store: createSlockGrantStore(),
  });

  await human.connect(context.createTransport("human"));
  await workspace.node.connect(context.createTransport("workspace"));

  const manifest = await human.call("plugin://local/workspace", "manifest", {
    mime_type: "application/json",
    data: {},
  });
  assert.match(String(manifest.data), /edit\(payload: WorkspaceEditRequest\): WorkspaceEditResult/);
  assert.match(String(manifest.data), /old_text: string/);
  assert.doesNotMatch(String(manifest.data), /edit\(payload: unknown\): unknown/);

  const listed = await human.call("plugin://local/workspace", "list", {
    mime_type: "application/json",
    data: { recursive: true, max_entries: 10 },
  });
  const listData = listed.data as { entries: Array<{ path: string; type: string }>; truncated: boolean };
  assert.equal(listData.truncated, false);
  assert.ok(listData.entries.some((entry) => entry.path === "README.md" && entry.type === "file"));
  assert.ok(listData.entries.some((entry) => entry.path === "src" && entry.type === "directory"));
  assert.ok(listData.entries.some((entry) => entry.path === "src/alpha.ts" && entry.type === "file"));
  assert.equal(listData.entries.some((entry) => entry.path === ".hidden"), false);

  const searched = await human.call("plugin://local/workspace", "search", {
    mime_type: "application/json",
    data: { query: "needle", path: "src", max_matches: 5 },
  });
  const searchData = searched.data as { matches: Array<{ path: string; line_number: number; column: number; line: string }> };
  assert.deepEqual(searchData.matches, [{
    path: "src/alpha.ts",
    line_number: 1,
    column: 24,
    line: "export const marker = 'needle value';",
  }]);

  await assert.rejects(
    human.call("plugin://local/workspace", "list", {
      mime_type: "application/json",
      data: { path: "../outside" },
    }),
    (error) => error instanceof IpcCallError && error.code === "ACTION_FAILED",
  );

  await human.close();
  await workspace.node.close();
});

test("Browser plugin reads HTTP pages without approval", async () => {
  const previousFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.href);
    return new Response("<!doctype html><title>Kairos Test Page</title><main><h1>Browser plugin says hi</h1><script>secret()</script></main>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as typeof fetch;

  const context = createContext();
  const human = createNode("human://user/local");
  const browser = createBrowserPlugin({ uri: "plugin://local/browser" });

  try {
    await human.connect(context.createTransport("human"));
    await browser.node.connect(context.createTransport("browser"));

    const manifest = await human.call("plugin://local/browser", "manifest", {
      mime_type: "application/json",
      data: {},
    });
    assert.match(String(manifest.data), /read_page\(payload: BrowserReadPageRequest\): BrowserReadPageResult/);
    assert.match(String(manifest.data), /max_redirects/);

    const page = await human.call("plugin://local/browser", "read_page", {
      mime_type: "application/json",
      data: { url: "https://example.com/test", include_headers: true },
    });
    const data = page.data as {
      status: number;
      ok: boolean;
      title?: string;
      text: string;
      content_type?: string;
      headers?: Record<string, string>;
    };
    assert.equal(data.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.title, "Kairos Test Page");
    assert.match(data.text, /Browser plugin says hi/);
    assert.doesNotMatch(data.text, /secret/);
    assert.equal(data.content_type, "text/html; charset=utf-8");
    assert.equal(data.headers?.["content-type"], "text/html; charset=utf-8");
    assert.deepEqual(requests, ["https://example.com/test"]);
  } finally {
    await human.close();
    await browser.node.close();
    globalThis.fetch = previousFetch;
  }
});

test("Browser plugin can restrict origins when configured", async () => {
  const previousFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.href);
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;

  const context = createContext();
  const human = createNode("human://user/local");
  const browser = createBrowserPlugin({ uri: "plugin://local/browser", allowed_origins: ["https://allowed.example"] });

  try {
    await human.connect(context.createTransport("human"));
    await browser.node.connect(context.createTransport("browser"));

    const page = await human.call("plugin://local/browser", "read_page", {
      mime_type: "application/json",
      data: { url: "https://allowed.example/page" },
    });
    assert.equal((page.data as { text: string }).text, "ok");

    await assert.rejects(
      human.call("plugin://local/browser", "read_page", {
        mime_type: "application/json",
        data: { url: "https://example.com/" },
      }),
      (error) => error instanceof IpcCallError && error.code === "ACTION_FAILED",
    );
    assert.deepEqual(requests, ["https://allowed.example/page"]);
  } finally {
    await human.close();
    await browser.node.close();
    globalThis.fetch = previousFetch;
  }
});

test("Slock channel publishes product events on the subscription stream", async () => {
  const context = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const subscriptionId = "subscription_test_1";
  const emitted: Array<{ event: SlockChannelEvent; correlation_id?: string }> = [];
  const ended: Array<{ event: SlockChannelEvent; correlation_id?: string }> = [];

  human.onEmit("*", (payload, eventContext) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      emitted.push({
        event: payload.data as SlockChannelEvent,
        correlation_id: eventContext.envelope.header.correlation_id,
      });
    }
  });

  human.onEnd("*", (payload, eventContext) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      ended.push({
        event: payload.data as SlockChannelEvent,
        correlation_id: eventContext.envelope.header.correlation_id,
      });
    }
  });

  await human.connect(context.createTransport("human"));
  await channel.node.connect(context.createTransport("channel"));

  await human.call("app://slock/channel/general", "subscribe", {
    mime_type: "application/json",
    data: {},
  }, { correlation_id: subscriptionId });

  const posted = await human.call("app://slock/channel/general", "post_message", {
    mime_type: SLOCK_MESSAGE_MIME,
    data: { text: "hello channel", mentions: [], thread_id: null },
  });
  const messageId = (posted.data as { id: string }).id;

  await human.call("app://slock/channel/general", "update_message", {
    mime_type: "application/json",
    data: { message_id: messageId, text: "hello edited channel" },
  });

  await human.call("app://slock/channel/general", "typing_started", {
    mime_type: "application/json",
    data: { thread_id: messageId },
  });

  await human.call("app://slock/channel/general", "publish_approval_requested", {
    mime_type: "application/json",
    data: {
      id: "approval_test_1",
      source: "agent://local/pi-assistant",
      created_at: "2026-04-30T00:00:00.000Z",
      request: {
        id: "approval_test_1",
        risk: "write",
        summary: "Write approved.txt",
        proposed_call: {
          target: "plugin://local/workspace",
          action: "write",
          payload: { path: "approved.txt" },
        },
      },
    },
  });

  await human.call("app://slock/channel/general", "publish_approval_resolved", {
    mime_type: "application/json",
    data: { id: "approval_test_1", result: { approved: false, reason: "not now" } },
  });

  await human.call("app://slock/channel/general", "unsubscribe", {
    mime_type: "application/json",
    data: { reason: "test complete" },
  });

  await waitFor(() => emitted.some(({ event }) => event.type === "approval_resolved") && ended.length === 1);

  assert.deepEqual(emitted.map(({ event }) => event.type), [
    "message_created",
    "message_updated",
    "typing_started",
    "approval_requested",
    "approval_resolved",
  ]);
  assert.ok(emitted.every(({ correlation_id }) => correlation_id === subscriptionId));
  assert.equal(ended[0].event.type, "subscription_closed");
  assert.equal(ended[0].event.subscription?.subscriber, "human://user/local");
  assert.equal(ended[0].event.subscription?.reason, "test complete");
  assert.equal(ended[0].correlation_id, subscriptionId);
  assert.equal(channel.subscribers.has("human://user/local"), false);

  await human.close();
  await channel.node.close();
});

test("Slock channel subscriptions are scoped to one channel endpoint", async () => {
  const context = createContext();
  const human = createNode("human://user/local");
  const general = createSlockChannel({ uri: "app://slock/channel/general" });
  const dm = createSlockChannel({ uri: "app://slock/dm/local-pi" });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  await human.connect(context.createTransport("human"));
  await general.node.connect(context.createTransport("general"));
  await dm.node.connect(context.createTransport("dm"));

  await human.call("app://slock/channel/general", "subscribe", {
    mime_type: "application/json",
    data: {},
  });

  await human.call("app://slock/channel/general", "post_message", {
    mime_type: SLOCK_MESSAGE_MIME,
    data: { text: "hello general", mentions: [], thread_id: null },
  });

  await human.call("app://slock/dm/local-pi", "post_message", {
    mime_type: SLOCK_MESSAGE_MIME,
    data: { text: "hello dm", mentions: [], thread_id: null },
  });

  await waitFor(() => events.length === 1);
  assert.equal(events[0].type, "message_created");
  assert.equal(events[0].channel, "app://slock/channel/general");
  assert.equal(general.messages.length, 1);
  assert.equal(dm.messages.length, 1);

  await human.close();
  await general.node.close();
  await dm.node.close();
});

test("Slock UI bridge publishes human approval callbacks through channel events", async () => {
  const context = createContext();
  const human = createSlockHuman({ uri: "human://user/local" });
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const agent = createNode("agent://local/tester");
  const bridge = createSlockUiBridge({
    channel_uri: "app://slock/channel/general",
    human_node: human.node,
    human_endpoint: human,
  });
  const events: SlockChannelEvent[] = [];

  human.node.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  await human.node.connect(context.createTransport("human"));
  await channel.node.connect(context.createTransport("channel"));
  await agent.connect(context.createTransport("agent"));

  await human.node.call("app://slock/channel/general", "subscribe", {
    mime_type: "application/json",
    data: {},
  });

  const approval = agent.call("human://user/local", "request_approval", {
    mime_type: SLOCK_APPROVAL_REQUEST_MIME,
    data: {
      id: "approval_bridge_1",
      risk: "write",
      summary: "Write through bridge",
      proposed_call: {
        target: "plugin://local/workspace",
        action: "write",
        payload: { path: "bridge.txt" },
      },
    },
  });

  await waitFor(() => events.some((event) => event.type === "approval_requested"));
  human.decide("approval_bridge_1", { approved: false, reason: "test denied" });
  const result = await approval;
  await waitFor(() => events.some((event) => event.type === "approval_resolved"));

  const requested = events.find((event) => event.type === "approval_requested");
  const resolved = events.find((event) => event.type === "approval_resolved");
  assert.equal(requested?.approval?.id, "approval_bridge_1");
  assert.equal(requested?.approval?.source, "agent://local/tester");
  assert.equal(resolved?.id, "approval_bridge_1");
  assert.equal(resolved?.result?.approved, false);
  assert.equal(result.data.approved, false);

  await bridge.close();
  await human.node.close();
  await channel.node.close();
  await agent.close();
});

test("Slock UI bridge exposes multiple channels and channel histories stay isolated", async () => {
  const context = createContext();
  const human = createNode("human://user/local");
  const generalUri = "app://slock/channel/general";
  const dmUri = "app://slock/dm/local-pi";
  const general = createSlockChannel({ uri: generalUri });
  const dm = createSlockChannel({ uri: dmUri });
  const bridge = createSlockUiBridge({
    channel_uri: generalUri,
    channels: [
      { uri: generalUri, label: "general", kind: "channel" },
      { uri: dmUri, label: "pi", kind: "dm" },
    ],
    human_node: human,
  });

  await human.connect(context.createTransport("human"));
  await bridge.node.connect(context.createTransport("bridge"));
  await general.node.connect(context.createTransport("general"));
  await dm.node.connect(context.createTransport("dm"));

  try {
    const status = await human.call("app://slock/ui-bridge", "status", {
      mime_type: "application/json",
      data: {},
    });
    const statusData = status.data as { channels: Array<{ uri: string; kind: string }>; default_channel: string };
    assert.equal(statusData.default_channel, generalUri);
    assert.deepEqual(statusData.channels.map((channel) => channel.uri), [generalUri, dmUri]);

    await human.call(generalUri, "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "hello general", mentions: [], thread_id: null },
    });

    await human.call(dmUri, "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "hello dm", mentions: [], thread_id: null },
    });

    const generalHistory = await human.call(generalUri, "history", {
      mime_type: "application/json",
      data: { limit: 10 },
    });
    const dmHistory = await human.call(dmUri, "history", {
      mime_type: "application/json",
      data: { limit: 10 },
    });
    const generalBody = generalHistory.data as { messages: Array<{ text: string; channel: string }> };
    const dmBody = dmHistory.data as { messages: Array<{ text: string; channel: string }> };

    assert.deepEqual(generalBody.messages.map((message) => message.text), ["hello general"]);
    assert.deepEqual(generalBody.messages.map((message) => message.channel), [generalUri]);
    assert.deepEqual(dmBody.messages.map((message) => message.text), ["hello dm"]);
    assert.deepEqual(dmBody.messages.map((message) => message.channel), [dmUri]);
  } finally {
    await bridge.close();
    await human.close();
    await general.node.close();
    await dm.node.close();
  }
});

test("Shell plugin rejects non-allowlisted exec without capability grant", async () => {
  const context = createContext();
  const agent = createNode("agent://local/tester");
  const grantStore = createSlockGrantStore();
  const shell = createShellPlugin({
    uri: "plugin://local/shell",
    cwd: process.cwd(),
    allowed_commands: null,
    grant_store: grantStore,
  });

  await agent.connect(context.createTransport("agent"));
  await shell.node.connect(context.createTransport("shell"));

  await assert.rejects(
    agent.call("plugin://local/shell", "exec", {
      mime_type: SLOCK_SHELL_EXEC_MIME,
      data: { command: "pwd", args: [] },
    }),
    /capability grant is required/,
  );

  await agent.close();
  await shell.node.close();
});

test("ReMe memory plugin maps stable actions to HTTP and gates writes", async () => {
  const reme = mockFetch((path) => {
    if (path === "/retrieve_personal_memory") {
      return { memories: [{ text: "User prefers concise Chinese answers." }] };
    }
    return { ok: true };
  });
  const context = createContext();
  const human = createNode("human://user/local");
  const grantStore = createSlockGrantStore();
  const memory = createReMeMemoryPlugin({
    uri: "plugin://memory/reme",
    base_url: "http://reme.test",
    workspace_id: "kairos-ipc",
    grant_store: grantStore,
  });

  try {
    await human.connect(context.createTransport("human"));
    await memory.node.connect(context.createTransport("memory"));

    const manifest = await human.call("plugin://memory/reme", "manifest", {
      mime_type: "application/json",
      data: {},
    });
    assert.equal(manifest.mime_type, "text/typescript");
    assert.match(String(manifest.data), /summarize\(payload: ReMeSummarizeRequest\): ReMeMemoryResponse/);
    assert.match(String(manifest.data), /Do not send a summary field directly/);
    assert.match(String(manifest.data), /list_children\(payload: ListChildrenRequest\): ListChildrenResponse/);

    const children = await human.call("plugin://memory/reme", "list_children", {
      mime_type: "application/json",
      data: {},
    });
    const childrenData = children.data as { endpoint: string; children: Array<{ uri: string; kind: string; manifest_action?: string }> };
    assert.equal(childrenData.endpoint, "plugin://memory/reme");
    assert.deepEqual(childrenData.children.map((child) => child.uri), [
      "plugin://memory/reme/personal",
      "plugin://memory/reme/task",
      "plugin://memory/reme/tool",
    ]);
    assert.deepEqual([...new Set(childrenData.children.map((child) => child.kind))], ["namespace"]);
    assert.ok(childrenData.children.every((child) => child.manifest_action === undefined));

    const retrieved = await human.call("plugin://memory/reme", "retrieve", {
      mime_type: "application/json",
      data: { scope: "personal", query: "style" },
    });
    const retrieveData = retrieved.data as { endpoint: string; memories: string[] };
    assert.equal(retrieveData.endpoint, "/retrieve_personal_memory");
    assert.deepEqual(retrieveData.memories, ["User prefers concise Chinese answers."]);
    assert.equal(reme.requests[0]?.path, "/retrieve_personal_memory");
    assert.equal(reme.requests[0]?.body.workspace_id, "kairos-ipc");

    await assert.rejects(
      human.call("plugin://memory/reme", "summarize", {
        mime_type: "application/json",
        data: { scope: "task", trajectories: [] },
      }),
      (error) => {
        assert.ok(error instanceof IpcCallError);
        assert.equal(error.code, "PAYLOAD_INVALID");
        assert.match(error.message, /trajectories/);
        return true;
      },
    );

    await assert.rejects(
      human.call("plugin://memory/reme", "summarize", {
        mime_type: "application/json",
        data: { scope: "task", trajectories: [{ messages: [{ role: "user", content: "Remember this task decision." }] }] },
      }),
      (error) => {
        assert.ok(error instanceof IpcCallError);
        assert.equal(error.code, "ACTION_FAILED");
        assert.match(error.message, /capability grant is required/);
        return true;
      },
    );

    const grant = grantStore.issue({
      source: "human://user/local",
      target: "plugin://memory/reme",
      action: "summarize",
      ttl_ms: 60000,
      risk: "memory_write",
    });
    await assert.rejects(
      human.call("plugin://memory/reme", "summarize", {
        mime_type: "application/json",
        data: { scope: "personal", summary: "User likes apples.", approval_grant: grant },
      }),
      (error) => {
        assert.ok(error instanceof IpcCallError);
        assert.equal(error.code, "PAYLOAD_INVALID");
        assert.match(error.message, /trajectories/);
        return true;
      },
    );
    const summarized = await human.call("plugin://memory/reme", "summarize", {
      mime_type: "application/json",
      data: {
        scope: "task",
        trajectories: [{ messages: [{ role: "user", content: "Remember this task decision." }], score: 1.0 }],
        approval_grant: grant,
      },
    });
    const summarizeData = summarized.data as { endpoint: string };
    assert.equal(summarizeData.endpoint, "/summary_task_memory");
    assert.equal(reme.requests.at(-1)?.path, "/summary_task_memory");
    assert.equal(Object.hasOwn(reme.requests.at(-1)?.body ?? {}, "approval_grant"), false);

    const vectorGrant = grantStore.issue({
      source: "human://user/local",
      target: "plugin://memory/reme",
      action: "vector_store",
      ttl_ms: 60000,
      risk: "memory_admin",
    });
    await human.call("plugin://memory/reme", "vector_store", {
      mime_type: "application/json",
      data: { operation: "list", approval_grant: vectorGrant },
    });
    assert.equal(reme.requests.at(-1)?.path, "/vector_store");
    assert.equal(reme.requests.at(-1)?.body.action, "list");
    assert.equal(Object.hasOwn(reme.requests.at(-1)?.body ?? {}, "operation"), false);
  } finally {
    await human.close();
    await memory.node.close();
    reme.restore();
  }
});

function createContext() {
  const dir = mkdtempSync(join("/tmp", "kairos-ipc-slock-test-"));
  const tracePath = join(dir, "trace.jsonl");
  const registry = new EndpointRegistry();
  const trace = new TraceWriter(tracePath);
  const router = new Router({ registry, capabilityGate: new AllowAllCapabilityGate(), trace });

  return {
    tracePath,
    registry,
    router,
    createTransport(id: string): IpcTransport {
      return new MemoryKernelTransport(id, registry, router, trace);
    },
  };
}

function readTrace(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

class MemoryKernelTransport implements IpcTransport {
  private readonly connection: Connection;
  private readonly registry: EndpointRegistry;
  private readonly router: Router;
  private readonly trace: TraceWriter;
  private readonly listeners = new Set<(frame: KernelFrame) => void>();
  private closed = false;

  constructor(id: string, registry: EndpointRegistry, router: Router, trace: TraceWriter) {
    this.registry = registry;
    this.router = router;
    this.trace = trace;
    this.connection = {
      id,
      send: (frame) => this.emit(frame),
    };
  }

  send(frame: ClientFrame): void {
    if (this.closed) {
      throw new Error(`transport is closed: ${this.connection.id}`);
    }

    if (frame.type === "register") {
      const result = this.registry.register(frame.uri, this.connection);
      if (!result.ok) {
        this.emit({ type: "error", error: { code: "REGISTER_FAILED", message: result.error ?? "register failed" } });
        return;
      }
      this.trace.recordEvent({ event: "endpoint_registered", uri: frame.uri, connection_id: this.connection.id });
      this.emit({ type: "registered", uri: frame.uri });
      return;
    }

    this.router.route(frame.envelope, this.connection);
  }

  onFrame(listener: (frame: KernelFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    const removed = this.registry.unregisterConnection(this.connection);
    for (const uri of removed) {
      this.trace.recordEvent({ event: "endpoint_unregistered", uri, connection_id: this.connection.id });
    }
  }

  private emit(frame: KernelFrame): void {
    for (const listener of this.listeners) {
      listener(frame);
    }
  }
}

function mockFetch(handler: (path: string, body: Record<string, unknown>) => unknown): {
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  restore(): void;
} {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = parseJsonBody(typeof init?.body === "string" ? init.body : "");
    requests.push({ path: url.pathname, body });
    return new Response(JSON.stringify(handler(url.pathname, body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    requests,
    restore() {
      globalThis.fetch = previousFetch;
    },
  };
}

function parseJsonBody(value: string): Record<string, unknown> {
  if (value.length === 0) {
    return {};
  }
  const parsed = JSON.parse(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
