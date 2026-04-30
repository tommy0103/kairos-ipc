import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createMockAgent } from "../packages/agent-adapter-mock/src/index.ts";
import { AllowAllCapabilityGate } from "../packages/kernel/src/capability.ts";
import type { Connection } from "../packages/kernel/src/registry.ts";
import { EndpointRegistry } from "../packages/kernel/src/registry.ts";
import { Router } from "../packages/kernel/src/router.ts";
import { TraceWriter } from "../packages/kernel/src/trace.ts";
import { createCalculatorPlugin, createShellPlugin } from "../packages/plugins-demo/src/index.ts";
import type { ClientFrame, KernelFrame } from "../packages/protocol/src/index.ts";
import { createNode, type IpcTransport } from "../packages/sdk/src/index.ts";
import {
  createSlockChannel,
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_MIME,
  type SlockChannelEvent,
} from "../packages/slock-channel/src/index.ts";
import { createSlockHuman } from "../packages/slock-human/src/index.ts";

test("Slock basic mention flow stays on IPC endpoints", async () => {
  const context = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
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
      mentions: ["agent://local/mock"],
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
