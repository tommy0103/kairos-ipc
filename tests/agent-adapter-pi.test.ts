import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { createPiAgent, createPiSlockTools } from "../packages/agent-adapter-pi/src/index.ts";
import { AllowAllCapabilityGate } from "../packages/kernel/src/capability.ts";
import type { Connection } from "../packages/kernel/src/registry.ts";
import { EndpointRegistry } from "../packages/kernel/src/registry.ts";
import { Router } from "../packages/kernel/src/router.ts";
import { TraceWriter } from "../packages/kernel/src/trace.ts";
import { createShellPlugin, createWorkspacePlugin } from "../packages/plugins-demo/src/index.ts";
import type { ClientFrame, KernelFrame } from "../packages/protocol/src/index.ts";
import { createNode, type IpcTransport } from "../packages/sdk/src/index.ts";
import {
  createSlockChannel,
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_MIME,
  type SlockChannelEvent,
} from "../packages/slock-channel/src/index.ts";
import { createSlockHuman } from "../packages/slock-human/src/index.ts";

test("pi-ai agent adapter projects streamed text onto Slock", async () => {
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  pi.setResponses([fauxAssistantMessage(fauxText("Hello from pi-ai over IPC."))]);

  const context = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const agent = createPiAgent({
    uri: "agent://local/pi-assistant",
    model: pi.getModel(),
    system_prompt: "You are a concise Slock assistant.",
  });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.connect(context.createTransport("human"));
    await channel.node.connect(context.createTransport("channel"));
    await agent.node.connect(context.createTransport("agent"));

    await human.call("app://slock/channel/general", "subscribe", {
      mime_type: "application/json",
      data: {},
    });

    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: {
        text: "@pi hello",
        mentions: ["agent://local/pi-assistant"],
        thread_id: null,
      },
    });

    await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));

    const streamedText = events
      .filter((event) => event.type === "message_delta")
      .map((event) => event.delta?.text ?? "")
      .join("");
    assert.ok(streamedText.includes("Hello from pi-ai over IPC."));
    const finalEvent = events.find((event) => event.type === "message_created" && event.message?.kind === "agent");
    assert.ok(finalEvent?.message?.text.includes("Hello from pi-ai over IPC."));
  } finally {
    await human.close();
    await channel.node.close();
    await agent.node.close();
    pi.unregister();
  }
});

test("pi-ai agent adapter passes API and endpoint configuration to pi-ai", async () => {
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  process.env.KAIROS_IPC_PI_KEY = "env-test-key";
  process.env.KAIROS_IPC_PI_BASE_URL = "https://pi-proxy.example.test/v1";
  pi.setResponses([
    (_context, options, _state, model) => {
      assert.equal(options?.apiKey, "env-test-key");
      assert.equal(options?.headers?.["X-Kairos-Test"], "yes");
      assert.equal(model.baseUrl, "https://pi-proxy.example.test/v1");
      assert.equal(model.headers?.["X-Kairos-Test"], "yes");
      return fauxAssistantMessage(fauxText("Configured pi-ai endpoint reached."));
    },
  ]);

  const context = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const agent = createPiAgent({
    uri: "agent://local/pi-assistant",
    model: pi.getModel(),
    api_key_env: "KAIROS_IPC_PI_KEY",
    base_url_env: "KAIROS_IPC_PI_BASE_URL",
    headers: { "X-Kairos-Test": "yes" },
  });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.connect(context.createTransport("human"));
    await channel.node.connect(context.createTransport("channel"));
    await agent.node.connect(context.createTransport("agent"));

    await human.call("app://slock/channel/general", "subscribe", {
      mime_type: "application/json",
      data: {},
    });

    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: {
        text: "@pi use configured endpoint",
        mentions: ["agent://local/pi-assistant"],
        thread_id: null,
      },
    });

    await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));
    const finalEvent = events.find((event) => event.type === "message_created" && event.message?.kind === "agent");
    assert.ok(finalEvent?.message?.text.includes("Configured pi-ai endpoint reached."));
  } finally {
    await human.close();
    await channel.node.close();
    await agent.node.close();
    delete process.env.KAIROS_IPC_PI_KEY;
    delete process.env.KAIROS_IPC_PI_BASE_URL;
    pi.unregister();
  }
});

test("pi-ai agent adapter builds context from Slock channel history", async () => {
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  pi.setResponses([
    (context) => {
      assert.equal(context.messages.length, 1);
      assert.equal(context.messages[0]?.role, "user");
      assert.equal(context.messages[0]?.content, "remember the project name is Kairos");
      return fauxAssistantMessage(fauxText("I will remember Kairos."));
    },
    (context) => {
      assert.equal(context.messages.length, 3);
      assert.equal(context.messages[0]?.role, "user");
      assert.equal(context.messages[0]?.content, "remember the project name is Kairos");
      assert.equal(context.messages[1]?.role, "assistant");
      assert.ok(context.messages[1]?.content.some((block) => block.type === "text" && block.text.includes("Kairos")));
      assert.equal(context.messages[2]?.role, "user");
      assert.equal(context.messages[2]?.content, "what project name did I give you?");
      return fauxAssistantMessage(fauxText("You told me the project is Kairos."));
    },
  ]);

  const ipc = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const agent = createPiAgent({
    uri: "agent://local/pi-assistant",
    model: pi.getModel(),
    context_history_limit: 10,
  });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.connect(ipc.createTransport("human"));
    await channel.node.connect(ipc.createTransport("channel"));
    await agent.node.connect(ipc.createTransport("agent"));

    await human.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@pi remember the project name is Kairos", mentions: ["agent://local/pi-assistant"], thread_id: null },
    });

    await waitFor(() => events.filter((event) => event.type === "message_created" && event.message?.kind === "agent").length >= 1);

    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@pi what project name did I give you?", mentions: ["agent://local/pi-assistant"], thread_id: null },
    });

    await waitFor(() => events.filter((event) => event.type === "message_created" && event.message?.kind === "agent").length >= 2);
    const finalMessages = events.filter((event) => event.type === "message_created" && event.message?.kind === "agent");
    assert.ok(finalMessages.at(-1)?.message?.text.includes("Kairos"));
  } finally {
    await human.close();
    await channel.node.close();
    await agent.node.close();
    pi.unregister();
  }
});

test("pi-ai Slock read tool calls workspace plugin without approval", async () => {
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  const root = mkdtempSync(join("/tmp", "kairos-ipc-pi-read-tool-"));
  writeFileSync(join(root, "notes.txt"), "alpha notes", "utf8");
  pi.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }, { id: "read-1" }), { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult");
      assert.ok(result?.content.some((block) => block.type === "text" && block.text.includes("alpha notes")));
      return fauxAssistantMessage(fauxText("Read notes.txt successfully."));
    },
  ]);

  const ipc = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const tools = createPiSlockTools({ workspace_uri: "plugin://local/workspace" });
  const agent = createPiAgent({
    uri: "agent://local/pi-assistant",
    model: pi.getModel(),
    tools: tools.tools,
    execute_tool: tools.execute_tool,
  });
  const workspace = createWorkspacePlugin({ uri: "plugin://local/workspace", root });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.connect(ipc.createTransport("human"));
    await channel.node.connect(ipc.createTransport("channel"));
    await agent.node.connect(ipc.createTransport("agent"));
    await workspace.node.connect(ipc.createTransport("workspace"));

    await human.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@pi read notes", mentions: ["agent://local/pi-assistant"], thread_id: null },
    });

    await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));
    const finalEvent = events.find((event) => event.type === "message_created" && event.message?.kind === "agent");
    assert.ok(finalEvent?.message?.text.includes("Read notes.txt successfully."));
  } finally {
    await human.close();
    await channel.node.close();
    await agent.node.close();
    await workspace.node.close();
    pi.unregister();
  }
});

test("pi-ai Slock write tool requires approval before workspace write", async () => {
  let approvals = 0;
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  const root = mkdtempSync(join("/tmp", "kairos-ipc-pi-write-tool-"));
  pi.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "approved.txt", content: "approved write" }, { id: "write-1" }), {
      stopReason: "toolUse",
    }),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult");
      assert.ok(result?.content.some((block) => block.type === "text" && block.text.includes("approved.txt")));
      return fauxAssistantMessage(fauxText("Write completed after approval."));
    },
  ]);

  const ipc = createContext();
  const human = createSlockHuman({
    uri: "human://user/local",
    auto_approval: async () => {
      approvals++;
      return { approved: true, grant_ttl_ms: 60000 };
    },
  });
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const tools = createPiSlockTools({ workspace_uri: "plugin://local/workspace" });
  const agent = createPiAgent({
    uri: "agent://local/pi-assistant",
    model: pi.getModel(),
    tools: tools.tools,
    execute_tool: tools.execute_tool,
  });
  const workspace = createWorkspacePlugin({ uri: "plugin://local/workspace", root });
  const events: SlockChannelEvent[] = [];

  human.node.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.node.connect(ipc.createTransport("human"));
    await channel.node.connect(ipc.createTransport("channel"));
    await agent.node.connect(ipc.createTransport("agent"));
    await workspace.node.connect(ipc.createTransport("workspace"));

    await human.node.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    await human.node.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@pi write a file", mentions: ["agent://local/pi-assistant"], thread_id: null },
    });

    await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));
    assert.equal(approvals, 1);
    assert.equal(readFileSync(join(root, "approved.txt"), "utf8"), "approved write");
  } finally {
    await human.node.close();
    await channel.node.close();
    await agent.node.close();
    await workspace.node.close();
    pi.unregister();
  }
});

test("pi-ai Slock edit and exec tools require approval", async () => {
  const approvals: Array<{ id: string; request: { metadata?: Record<string, unknown> } }> = [];
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  const root = mkdtempSync(join("/tmp", "kairos-ipc-pi-edit-exec-tools-"));
  writeFileSync(join(root, "draft.txt"), "before", "utf8");
  pi.setResponses([
    fauxAssistantMessage([
      fauxToolCall("edit", { path: "draft.txt", old_text: "before", new_text: "after" }, { id: "edit-1" }),
      fauxToolCall("exec", { command: "node", args: ["--version"] }, { id: "exec-1" }),
    ], { stopReason: "toolUse" }),
    (context) => {
      const results = context.messages.filter((message) => message.role === "toolResult");
      assert.equal(results.length, 2);
      assert.ok(results.some((result) => result.content.some(
        (block) => block.type === "text" && block.text.includes('"command": "node"'),
      )));
      assert.ok(results.some((result) => result.content.some(
        (block) => block.type === "text" && block.text.includes('"exit_code": 0'),
      )));
      return fauxAssistantMessage(fauxText("Edit and exec completed after approval."));
    },
  ]);

  const ipc = createContext();
  const human = createSlockHuman({ uri: "human://user/local" });
  human.onApprovalRequest((approval) => {
    approvals.push(approval);
    queueMicrotask(() => human.decide(approval.id, { approved: true, grant_ttl_ms: 60000 }));
  });
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const tools = createPiSlockTools({ workspace_uri: "plugin://local/workspace", shell_uri: "plugin://local/shell" });
  const agent = createPiAgent({
    uri: "agent://local/pi-assistant",
    model: pi.getModel(),
    tools: tools.tools,
    execute_tool: tools.execute_tool,
  });
  const workspace = createWorkspacePlugin({ uri: "plugin://local/workspace", root });
  const shell = createShellPlugin({ uri: "plugin://local/shell", cwd: root, allowed_commands: null });
  const events: SlockChannelEvent[] = [];

  human.node.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.node.connect(ipc.createTransport("human"));
    await channel.node.connect(ipc.createTransport("channel"));
    await agent.node.connect(ipc.createTransport("agent"));
    await workspace.node.connect(ipc.createTransport("workspace"));
    await shell.node.connect(ipc.createTransport("shell"));

    await human.node.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    await human.node.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@pi edit and run node --version", mentions: ["agent://local/pi-assistant"], thread_id: null },
    });

    await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));
    const execToolEvents = events.filter((event) => {
      const metadata = event.delta?.metadata;
      return event.type === "message_delta"
        && metadata?.type === "tool_call"
        && metadata.name === "exec";
    });
    const execRunning = execToolEvents.find((event) => event.delta?.metadata?.state === "running");
    const execCompleted = execToolEvents.find((event) => event.delta?.metadata?.state === "completed");
    assert.ok(execRunning?.delta?.metadata);
    const execArgs = execRunning.delta.metadata.arguments as Record<string, unknown>;
    assert.equal(execArgs.command, "node");
    assert.deepEqual(execArgs.args, ["--version"]);
    assert.equal(execCompleted?.delta?.metadata?.type, "tool_call");
    const execApprovalMetadata = approvals.find((approval) => approval.request.metadata?.tool_name === "exec")
      ?.request.metadata;
    assert.equal(execApprovalMetadata?.tool_call_id, "exec-1");
    assert.equal(typeof execApprovalMetadata?.thread_id, "string");
    assert.equal(approvals.length, 2);
    assert.equal(readFileSync(join(root, "draft.txt"), "utf8"), "after");
  } finally {
    await human.node.close();
    await channel.node.close();
    await agent.node.close();
    await workspace.node.close();
    await shell.node.close();
    pi.unregister();
  }
});

function createContext() {
  const dir = mkdtempSync(join("/tmp", "kairos-ipc-agent-adapter-pi-test-"));
  const registry = new EndpointRegistry();
  const trace = new TraceWriter(join(dir, "trace.jsonl"));
  const router = new Router({ registry, capabilityGate: new AllowAllCapabilityGate(), trace });

  return {
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
