import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createMockAgent } from "../packages/agent-adapter-mock/src/index.ts";
import { AllowAllCapabilityGate } from "../packages/kernel/src/capability.ts";
import type { Connection } from "../packages/kernel/src/registry.ts";
import { EndpointRegistry } from "../packages/kernel/src/registry.ts";
import { Router } from "../packages/kernel/src/router.ts";
import { TraceWriter } from "../packages/kernel/src/trace.ts";
import { createCalculatorPlugin, createShellPlugin, createWorkspacePlugin } from "../packages/plugins-demo/src/index.ts";
import type { ClientFrame, KernelFrame } from "../packages/protocol/src/index.ts";
import { createNode, IpcCallError, type IpcTransport } from "../packages/sdk/src/index.ts";
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

function createContext() {
  const dir = mkdtempSync(join("/tmp", "kairos-ipc-slock-test-"));
  const registry = new EndpointRegistry();
  const trace = new TraceWriter(join(dir, "trace.jsonl"));
  const router = new Router({ registry, capabilityGate: new AllowAllCapabilityGate(), trace });

  return {
    registry,
    router,
    createTransport(id: string): IpcTransport {
      return new MemoryKernelTransport(id, registry, router, trace);
    },
  };
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

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
