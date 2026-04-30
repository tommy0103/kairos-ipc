import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@mariozechner/pi-ai";
import { createPiAgent } from "../packages/agent-adapter-pi/src/index.ts";
import { AllowAllCapabilityGate } from "../packages/kernel/src/capability.ts";
import type { Connection } from "../packages/kernel/src/registry.ts";
import { EndpointRegistry } from "../packages/kernel/src/registry.ts";
import { Router } from "../packages/kernel/src/router.ts";
import { TraceWriter } from "../packages/kernel/src/trace.ts";
import type { ClientFrame, KernelFrame } from "../packages/protocol/src/index.ts";
import { createNode, type IpcTransport } from "../packages/sdk/src/index.ts";
import {
  createSlockChannel,
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_MIME,
  type SlockChannelEvent,
} from "../packages/slock-channel/src/index.ts";

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
