import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createAgentAdapter, createSimpleRuntime } from "../packages/agent-adapter/src/index.ts";
import type { AgentRuntime } from "../packages/agent-adapter/src/index.ts";
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

test("tool-agnostic agent adapter projects runtime events to Slock", async () => {
  const context = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const agent = createAgentAdapter({
    uri: "agent://local/simple-runtime",
    runtime: createSimpleRuntime({ name: "adapter-test" }),
  });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

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
      text: "@simple describe the adapter boundary",
      mentions: ["agent://local/simple-runtime"],
      thread_id: null,
    },
  });

  await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));

  assert.ok(events.some((event) => event.type === "message_delta" && event.delta?.text.includes("adapter-test received")));
  assert.ok(events.some((event) => event.type === "message_delta" && event.delta?.text.includes("Working on")));
  const finalEvent = events.find((event) => event.type === "message_created" && event.message?.kind === "agent");
  assert.ok(finalEvent?.message?.text.includes("adapter-test says"));

  await human.close();
  await channel.node.close();
  await agent.node.close();
});

test("Slock channel can cancel an active agent delta stream", async () => {
  const context = createContext();
  const human = createNode("human://user/local");
  const channel = createSlockChannel({ uri: "app://slock/channel/general" });
  const agent = createAgentAdapter({
    uri: "agent://local/slow-runtime",
    runtime: createSlowRuntime(),
  });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  await human.connect(context.createTransport("human"));
  await channel.node.connect(context.createTransport("channel"));
  await agent.node.connect(context.createTransport("agent"));

  await human.call("app://slock/channel/general", "subscribe", {
    mime_type: "application/json",
    data: {},
  });

  const posted = await human.call("app://slock/channel/general", "post_message", {
    mime_type: SLOCK_MESSAGE_MIME,
    data: {
      text: "@slow keep streaming",
      mentions: ["agent://local/slow-runtime"],
      thread_id: null,
    },
  });

  const messageId = (posted.data as { id: string }).id;
  await waitFor(() => events.some((event) => event.type === "message_delta" && event.delta?.text === "started"));

  const cancelled = await human.call("app://slock/channel/general", "cancel_agent_run", {
    mime_type: "application/json",
    data: { message_id: messageId, reason: "test cancel" },
  });

  assert.deepEqual(cancelled.data, {
    cancelled: true,
    message_id: messageId,
    agent: "agent://local/slow-runtime",
    reason: "test cancel",
  });
  await waitFor(() => events.some((event) => event.type === "agent_cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.ok(events.some((event) => event.type === "agent_cancelled" && event.cancelled?.message_id === messageId));
  assert.equal(events.some((event) => event.type === "message_delta" && event.delta?.text === "after cancel"), false);
  assert.equal(events.some((event) => event.type === "message_created" && event.message?.kind === "agent"), false);

  await human.close();
  await channel.node.close();
  await agent.node.close();
});

function createSlowRuntime(): AgentRuntime {
  return {
    async *run(_input, context) {
      yield { type: "message_delta", text: "started" };
      await new Promise<void>((resolve) => {
        if (context.signal?.aborted) {
          resolve();
          return;
        }
        context.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "message_delta", text: "after cancel" };
      yield { type: "final", result: { summary: "finished", final_text: "finished" } };
    },
  };
}

function createContext() {
  const dir = mkdtempSync(join("/tmp", "kairos-ipc-agent-adapter-test-"));
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
