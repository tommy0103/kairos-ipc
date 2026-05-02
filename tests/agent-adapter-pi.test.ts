import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { createPiAgent, createPiRuntime, createPiSlockTools } from "../packages/agent-adapter-pi/src/index.ts";
import { AllowAllCapabilityGate } from "../packages/kernel/src/capability.ts";
import type { Connection } from "../packages/kernel/src/registry.ts";
import { EndpointRegistry } from "../packages/kernel/src/registry.ts";
import { Router } from "../packages/kernel/src/router.ts";
import { TraceWriter } from "../packages/kernel/src/trace.ts";
import { createCalculatorPlugin, createShellPlugin, createWorkspacePlugin } from "../packages/plugins-demo/src/index.ts";
import type { ClientFrame, KernelFrame } from "../packages/protocol/src/index.ts";
import { createNode, type IpcTransport } from "../packages/sdk/src/index.ts";
import { createSlockRegistry } from "../packages/slock-daemon/src/index.ts";
import {
  createSlockChannel,
  createSlockGrantStore,
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

test("pi-ai runtime does not cap tool turns by default", async () => {
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  const toolTurnCount = 10;
  pi.setResponses([
    ...Array.from({ length: toolTurnCount }, (_, index) => (context) => {
      const priorResults = context.messages.filter((message) => message.role === "toolResult");
      assert.equal(priorResults.length, index);
      return fauxAssistantMessage(fauxToolCall("loop_tool", { index }, { id: `tool-${index}` }), { stopReason: "toolUse" });
    }),
    (context) => {
      const results = context.messages.filter((message) => message.role === "toolResult");
      assert.equal(results.length, toolTurnCount);
      return fauxAssistantMessage(fauxText("Finished after ten tool turns."));
    },
  ]);

  const runtime = createPiRuntime({
    model: pi.getModel(),
    execute_tool: (toolCall) => ({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [fauxText(`ok ${toolCall.arguments.index}`)],
      isError: false,
      timestamp: Date.now(),
    }),
  });

  try {
    const events = [];
    for await (const event of runtime.run({
      channel: "app://slock/channel/general",
      message_id: "message-1",
      text: "@pi keep going",
      sender: "human://user/local",
    }, {
      agent_uri: "agent://local/pi-assistant",
      node: {
        uri: "agent://local/pi-assistant",
        call: async () => {
          throw new Error("history unavailable");
        },
      },
    })) {
      events.push(event);
    }

    assert.equal(pi.state.callCount, toolTurnCount + 1);
    assert.equal(events.filter((event) => event.type === "status" && event.metadata?.state === "completed").length, toolTurnCount);
    const finalEvent = events.find((event) => event.type === "final");
    assert.equal(finalEvent?.result.final_text, "Finished after ten tool turns.");
  } finally {
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

test("pi-ai agent adapter can scope context to a Slock thread", async () => {
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  pi.setResponses([
    (context) => {
      assert.equal(context.messages.length, 1);
      assert.equal(context.messages[0]?.role, "user");
      assert.equal(context.messages[0]?.content, "remember the thread code is red");
      return fauxAssistantMessage(fauxText("I will remember red for this thread."));
    },
    (context) => {
      assert.equal(context.messages.length, 3);
      assert.equal(context.messages[0]?.role, "user");
      assert.equal(context.messages[0]?.content, "remember the thread code is red");
      assert.equal(context.messages[1]?.role, "assistant");
      assert.ok(context.messages[1]?.content.some((block) => block.type === "text" && block.text.includes("red")));
      assert.equal(context.messages[2]?.role, "user");
      assert.equal(context.messages[2]?.content, "what was the thread code?");
      assert.equal(JSON.stringify(context.messages).includes("unrelated channel note"), false);
      return fauxAssistantMessage(fauxText("The thread code is red."));
    },
  ]);

  const ipc = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    mention_aliases: { pi: "agent://local/pi-assistant" },
  });
  const agent = createPiAgent({
    uri: "agent://local/pi-assistant",
    model: pi.getModel(),
    context_history_limit: 10,
    context_history_scope: "thread",
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
    const root = await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@pi remember the thread code is red", thread_id: null },
    });
    const rootId = (root.data as { id: string }).id;

    await waitFor(() => events.filter((event) => event.type === "message_created" && event.message?.kind === "agent").length >= 1);

    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "unrelated channel note", thread_id: null },
    });

    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "what was the thread code?", thread_id: rootId },
    });

    await waitFor(() => events.filter((event) => event.type === "message_created" && event.message?.kind === "agent").length >= 2);
    const finalMessages = events.filter((event) => event.type === "message_created" && event.message?.kind === "agent");
    assert.ok(finalMessages.at(-1)?.message?.text.includes("red"));
    assert.equal(finalMessages.at(-1)?.message?.thread_id, rootId);
  } finally {
    await human.close();
    await channel.node.close();
    await agent.node.close();
    pi.unregister();
  }
});

test("pi-ai agent adapter injects retrieved long-term memory context", async () => {
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  const memoryRequests: Array<Record<string, unknown>> = [];
  pi.setResponses([
    (context) => {
      assert.match(context.systemPrompt ?? "", /Long-term memory is available/);
      assert.match(context.systemPrompt ?? "", /Relevant long-term memory/);
      assert.match(context.systemPrompt ?? "", /concise Chinese answers/);
      return fauxAssistantMessage(fauxText("Memory context was available."));
    },
  ]);

  const ipc = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const memory = createNode("plugin://memory/reme");
  memory.action("retrieve", { accepts: "application/json", returns: "application/json" }, async (payload) => {
    memoryRequests.push(payload.data as Record<string, unknown>);
    return {
      mime_type: "application/json",
      data: { memories: ["User prefers concise Chinese answers."] },
    };
  });
  const agent = createPiAgent({
    uri: "agent://local/pi-assistant",
    model: pi.getModel(),
    system_prompt: "You are a concise Slock assistant.",
    memory: {
      enabled: true,
      uri: "plugin://memory/reme",
      workspace_id: "kairos-ipc",
      scopes: ["personal"],
      top_k: 2,
    },
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
    await memory.connect(ipc.createTransport("memory"));
    await agent.node.connect(ipc.createTransport("agent"));

    await human.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@pi how should you answer?", mentions: ["agent://local/pi-assistant"], thread_id: null },
    });

    await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));
    assert.equal(memoryRequests.length, 1);
    assert.equal(memoryRequests[0]?.scope, "personal");
    assert.equal(memoryRequests[0]?.workspace_id, "kairos-ipc");
    assert.equal(memoryRequests[0]?.query, "how should you answer?");
  } finally {
    await human.close();
    await channel.node.close();
    await memory.close();
    await agent.node.close();
    pi.unregister();
  }
});

test("pi-ai ipc_call tool describes registry and endpoint manifest discovery", () => {
  const tools = createPiSlockTools({ ipc_call_targets: ["plugin://demo/calculator"] });
  const tool = tools.tools[0];
  assert.equal(tool?.name, "ipc_call");
  assert.match(tool?.description ?? "", /slock:\/\/registry list_endpoints/);
  assert.match(tool?.description ?? "", /call its manifest action before endpoint-specific actions/);
  assert.match(tool?.description ?? "", /manifest exposes list_children/);
  assert.match(tool?.description ?? "", /call the child manifest before child-specific actions/);
  assert.match(tool?.description ?? "", /Leave timeout_ms and ttl_ms unset by default/);
  assert.match(tool?.description ?? "", /Known useful target URIs: slock:\/\/registry, plugin:\/\/demo\/calculator/);
  const parameters = JSON.stringify(tool?.parameters);
  assert.ok(parameters.includes("list_endpoints"));
  assert.ok(parameters.includes("Do not set casually"));
});

test("pi-ai ipc_call uses a longer internal wait for memory writes", async () => {
  const calls: Array<{ target: string; action: string; ttl_ms?: number; timeout_ms?: number }> = [];
  const tools = createPiSlockTools({
    memory_uri: "plugin://memory/reme",
    tool_ttl_ms: 1000,
    memory_tool_ttl_ms: 123000,
  });

  const result = await tools.execute_tool(fauxToolCall("ipc_call", {
    target: "plugin://memory/reme",
    action: "summarize",
    payload: { scope: "personal", trajectories: [{ messages: [{ role: "user", content: "User likes apples." }] }] },
  }, { id: "memory-timeout" }), {
    input: {
      channel: "app://slock/channel/general",
      message_id: "message-1",
      text: "remember this",
      sender: "human://user/local",
    },
    runtime: {
      agent_uri: "agent://local/pi-assistant",
      node: {
        uri: "agent://local/pi-assistant",
        call: async (target, action, _payload, options = {}) => {
          calls.push({ target, action, ttl_ms: options.ttl_ms, timeout_ms: options.timeout_ms });
          if (action === "request_approval") {
            return {
              mime_type: "application/json",
              data: {
                approved: true,
                grant: {
                  id: "grant-1",
                  token: "token-1",
                  source: "agent://local/pi-assistant",
                  target: "plugin://memory/reme",
                  actions: ["summarize"],
                  issued_at: "2026-05-01T00:00:00.000Z",
                  expires_at: "2026-05-01T00:05:00.000Z",
                },
              },
            };
          }
          return { mime_type: "application/json", data: { ok: true } };
        },
      },
    },
  });

  assert.equal(result.isError, false);
  const memoryCall = calls.find((call) => call.target === "plugin://memory/reme" && call.action === "summarize");
  assert.equal(memoryCall?.ttl_ms, 123000);
  assert.equal(memoryCall?.timeout_ms, 123000);
});

test("pi-ai generic ipc_call tool can discover endpoints, inspect a manifest, and call a plugin action", async () => {
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  pi.setResponses([
    fauxAssistantMessage(fauxToolCall("ipc_call", {
      target: "slock://registry",
      action: "list_endpoints",
      payload: {},
    }, { id: "registry-1" }), { stopReason: "toolUse" }),
    (context) => {
      const registryResult = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "registry-1");
      assert.ok(registryResult?.content.some((block) => block.type === "text" && block.text.includes("plugin://demo/calculator")));
      return fauxAssistantMessage(fauxToolCall("ipc_call", {
        target: "plugin://demo/calculator",
        action: "manifest",
        payload: {},
      }, { id: "manifest-1" }), { stopReason: "toolUse" });
    },
    (context) => {
      const manifestResult = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "manifest-1");
      assert.ok(manifestResult?.content.some((block) => block.type === "text" && block.text.includes("interface Calculator")));
      assert.ok(manifestResult?.content.some((block) => block.type === "text" && block.text.includes("add(payload")));
      return fauxAssistantMessage(fauxToolCall("ipc_call", {
        target: "plugin://demo/calculator",
        action: "add",
        payload: { a: 2, b: 3 },
      }, { id: "add-1" }), { stopReason: "toolUse" });
    },
    (context) => {
      const addResult = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "add-1");
      assert.ok(addResult?.content.some((block) => block.type === "text" && block.text.includes('"result": 5')));
      return fauxAssistantMessage(fauxText("Calculator returned 5 through ipc_call."));
    },
  ]);

  const ipc = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const tools = createPiSlockTools({ ipc_call_targets: ["plugin://demo/calculator"] });
  const agent = createPiAgent({
    uri: "agent://local/pi-assistant",
    model: pi.getModel(),
    tools: tools.tools,
    execute_tool: tools.execute_tool,
  });
  const registry = createSlockRegistry({
    endpoints: [{ uri: "plugin://demo/calculator", kind: "plugin", label: "calculator" }],
  });
  const calculator = createCalculatorPlugin({ uri: "plugin://demo/calculator" });
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
    await registry.node.connect(ipc.createTransport("registry"));
    await calculator.node.connect(ipc.createTransport("calculator"));

    await human.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@pi inspect calculator and add numbers", mentions: ["agent://local/pi-assistant"], thread_id: null },
    });

    await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));
    const finalEvent = events.find((event) => event.type === "message_created" && event.message?.kind === "agent");
    assert.ok(finalEvent?.message?.text.includes("Calculator returned 5 through ipc_call."));
  } finally {
    await human.close();
    await channel.node.close();
    await agent.node.close();
    await registry.node.close();
    await calculator.node.close();
    pi.unregister();
  }
});

test("pi-ai generic ipc_call tool can list and search the workspace plugin", async () => {
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  const root = mkdtempSync(join("/tmp", "kairos-ipc-pi-workspace-ipc-call-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "README.md"), "Kairos IPC workspace\n", "utf8");
  writeFileSync(join(root, "src", "notes.ts"), "export const topic = 'workspace-search-marker';\n", "utf8");

  pi.setResponses([
    fauxAssistantMessage(fauxToolCall("ipc_call", {
      target: "plugin://local/workspace",
      action: "manifest",
      payload: {},
    }, { id: "workspace-manifest" }), { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "workspace-manifest");
      assert.ok(result?.content.some((block) => block.type === "text" && block.text.includes("list(payload")));
      assert.ok(result?.content.some((block) => block.type === "text" && block.text.includes("search(payload")));
      return fauxAssistantMessage(fauxToolCall("ipc_call", {
        target: "plugin://local/workspace",
        action: "list",
        payload: { recursive: true, max_entries: 10 },
      }, { id: "workspace-list" }), { stopReason: "toolUse" });
    },
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "workspace-list");
      assert.ok(result?.content.some((block) => block.type === "text" && block.text.includes("src/notes.ts")));
      return fauxAssistantMessage(fauxToolCall("ipc_call", {
        target: "plugin://local/workspace",
        action: "search",
        payload: { query: "workspace-search-marker", path: "src" },
      }, { id: "workspace-search" }), { stopReason: "toolUse" });
    },
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "workspace-search");
      assert.ok(result?.content.some((block) => block.type === "text" && block.text.includes("workspace-search-marker")));
      return fauxAssistantMessage(fauxText("Workspace list and search completed through ipc_call."));
    },
  ]);

  const ipc = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const tools = createPiSlockTools({ workspace_uri: "plugin://local/workspace", ipc_call_targets: ["plugin://local/workspace"] });
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["ipc_call"]);
  const agent = createPiAgent({
    uri: "agent://local/pi-assistant",
    model: pi.getModel(),
    tools: tools.tools,
    execute_tool: tools.execute_tool,
  });
  const workspace = createWorkspacePlugin({ uri: "plugin://local/workspace", root, grant_store: createSlockGrantStore() });
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
      data: { text: "@pi inspect workspace", mentions: ["agent://local/pi-assistant"], thread_id: null },
    });

    await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));
    const finalEvent = events.find((event) => event.type === "message_created" && event.message?.kind === "agent");
    assert.ok(finalEvent?.message?.text.includes("Workspace list and search completed through ipc_call."));
  } finally {
    await human.close();
    await channel.node.close();
    await agent.node.close();
    await workspace.node.close();
    pi.unregister();
  }
});

test("pi-ai ipc_call reads workspace plugin without approval", async () => {
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  const root = mkdtempSync(join("/tmp", "kairos-ipc-pi-read-tool-"));
  writeFileSync(join(root, "notes.txt"), "alpha notes", "utf8");
  pi.setResponses([
    fauxAssistantMessage(fauxToolCall("ipc_call", {
      target: "plugin://local/workspace",
      action: "read",
      payload: { path: "notes.txt" },
    }, { id: "read-1" }), { stopReason: "toolUse" }),
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

test("pi-ai ipc_call requires approval before workspace write", async () => {
  let approvals = 0;
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  const root = mkdtempSync(join("/tmp", "kairos-ipc-pi-write-tool-"));
  const grantStore = createSlockGrantStore();
  pi.setResponses([
    fauxAssistantMessage(fauxToolCall("ipc_call", {
      target: "plugin://local/workspace",
      action: "write",
      payload: { path: "approved.txt", content: "approved write" },
    }, { id: "write-1" }), {
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
    grant_store: grantStore,
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
  const workspace = createWorkspacePlugin({ uri: "plugin://local/workspace", root, grant_store: grantStore });
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

test("pi-ai ipc_call edit and exec require approval", async () => {
  const approvals: Array<{ id: string; request: { metadata?: Record<string, unknown> } }> = [];
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  const root = mkdtempSync(join("/tmp", "kairos-ipc-pi-edit-exec-tools-"));
  const grantStore = createSlockGrantStore();
  writeFileSync(join(root, "draft.txt"), "before", "utf8");
  pi.setResponses([
    fauxAssistantMessage([
      fauxToolCall("ipc_call", {
        target: "plugin://local/workspace",
        action: "edit",
        payload: { path: "draft.txt", old_text: "before", new_text: "after" },
      }, { id: "edit-1" }),
      fauxToolCall("ipc_call", {
        target: "plugin://local/shell",
        action: "exec",
        payload: { command: "node", args: ["--version"] },
      }, { id: "exec-1" }),
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
  const human = createSlockHuman({ uri: "human://user/local", grant_store: grantStore });
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
  const workspace = createWorkspacePlugin({ uri: "plugin://local/workspace", root, grant_store: grantStore });
  const shell = createShellPlugin({ uri: "plugin://local/shell", cwd: root, allowed_commands: null, grant_store: grantStore });
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
      const args = metadata?.arguments as Record<string, unknown> | undefined;
      return event.type === "message_delta"
        && metadata?.type === "tool_call"
        && metadata.name === "ipc_call"
        && args?.action === "exec";
    });
    const execRunning = execToolEvents.find((event) => event.delta?.metadata?.state === "running");
    const execCompleted = execToolEvents.find((event) => event.delta?.metadata?.state === "completed");
    assert.ok(execRunning?.delta?.metadata);
    const execCallArgs = execRunning.delta.metadata.arguments as Record<string, unknown>;
    const execArgs = execCallArgs.payload as Record<string, unknown>;
    assert.equal(execArgs.command, "node");
    assert.deepEqual(execArgs.args, ["--version"]);
    assert.equal(execCompleted?.delta?.metadata?.type, "tool_call");
    const execApprovalMetadata = approvals.find((approval) => approval.request.metadata?.ipc_action === "exec")
      ?.request.metadata;
    assert.equal(execApprovalMetadata?.tool_call_id, "exec-1");
    assert.equal(execApprovalMetadata?.tool_name, "ipc_call");
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

test("pi-ai ipc_call memory writes require approval", async () => {
  let approvals = 0;
  let memoryPayload: Record<string, unknown> | undefined;
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  const grantStore = createSlockGrantStore();
  pi.setResponses([
    fauxAssistantMessage(fauxToolCall("ipc_call", {
      target: "plugin://memory/reme",
      action: "summarize",
      payload: { scope: "task", trajectories: [] },
    }, { id: "memory-1" }), { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "memory-1");
      assert.ok(result?.content.some((block) => block.type === "text" && block.text.includes('"ok": true')));
      return fauxAssistantMessage(fauxText("Memory summarize completed after approval."));
    },
  ]);

  const ipc = createContext();
  const human = createSlockHuman({
    uri: "human://user/local",
    grant_store: grantStore,
    auto_approval: async () => {
      approvals++;
      return { approved: true, grant_ttl_ms: 60000 };
    },
  });
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const tools = createPiSlockTools({ memory_uri: "plugin://memory/reme", ipc_call_targets: ["plugin://memory/reme"] });
  const agent = createPiAgent({
    uri: "agent://local/pi-assistant",
    model: pi.getModel(),
    tools: tools.tools,
    execute_tool: tools.execute_tool,
  });
  const memory = createNode("plugin://memory/reme");
  memory.action("summarize", { accepts: "application/json", returns: "application/json" }, async (payload) => {
    memoryPayload = payload.data as Record<string, unknown>;
    return { mime_type: "application/json", data: { ok: true } };
  });
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
    await memory.connect(ipc.createTransport("memory"));

    await human.node.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    await human.node.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@pi remember this task decision", mentions: ["agent://local/pi-assistant"], thread_id: null },
    });

    await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));
    assert.equal(approvals, 1);
    assert.ok(memoryPayload?.approval_grant);
  } finally {
    await human.node.close();
    await channel.node.close();
    await agent.node.close();
    await memory.close();
    pi.unregister();
  }
});

test("pi-ai pending approval is withdrawn when the agent stream is cancelled", async () => {
  const pi = registerFauxProvider({ tokensPerSecond: 1000 });
  const grantStore = createSlockGrantStore();
  pi.setResponses([
    fauxAssistantMessage(fauxToolCall("ipc_call", {
      target: "plugin://local/workspace",
      action: "write",
      payload: { path: "cancelled.txt", content: "nope" },
    }, { id: "write-1" }), {
      stopReason: "toolUse",
    }),
  ]);

  const ipc = createContext();
  const human = createSlockHuman({ uri: "human://user/local", grant_store: grantStore });
  const approvals: string[] = [];
  const resolutions: Array<{ id: string; approved: boolean; reason?: string }> = [];
  human.onApprovalRequest((approval) => {
    approvals.push(approval.id);
  });
  human.onApprovalResolved((resolution) => {
    resolutions.push({
      id: resolution.id,
      approved: resolution.result.approved,
      reason: resolution.result.reason,
    });
  });
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const tools = createPiSlockTools({ workspace_uri: "plugin://local/workspace" });
  const agent = createPiAgent({
    uri: "agent://local/pi-assistant",
    model: pi.getModel(),
    tools: tools.tools,
    execute_tool: tools.execute_tool,
  });
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

    await human.node.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    const posted = await human.node.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@pi write then wait", mentions: ["agent://local/pi-assistant"], thread_id: null },
    });
    const messageId = (posted.data as { id: string }).id;

    await waitFor(() => approvals.length === 1);
    await human.node.call("app://slock/channel/general", "cancel_agent_run", {
      mime_type: "application/json",
      data: { message_id: messageId, reason: "test cancel" },
    });

    await waitFor(() => resolutions.length === 1);
    assert.deepEqual(resolutions[0], {
      id: approvals[0],
      approved: false,
      reason: "test cancel",
    });
    assert.equal(human.pendingApprovals.size, 0);
    assert.ok(events.some((event) => event.type === "agent_cancelled" && event.cancelled?.message_id === messageId));
    assert.equal(events.some((event) => event.type === "message_created" && event.message?.kind === "agent"), false);
  } finally {
    await human.node.close();
    await channel.node.close();
    await agent.node.close();
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
