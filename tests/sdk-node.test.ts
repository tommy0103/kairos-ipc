import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AllowAllCapabilityGate } from "../packages/kernel/src/capability.ts";
import type { Connection } from "../packages/kernel/src/registry.ts";
import { EndpointRegistry } from "../packages/kernel/src/registry.ts";
import { Router } from "../packages/kernel/src/router.ts";
import { TraceWriter } from "../packages/kernel/src/trace.ts";
import type { ClientFrame, KernelFrame } from "../packages/protocol/src/index.ts";
import { createNode, IpcCallError, type IpcTransport } from "../packages/sdk/src/index.ts";

test("SDK wraps echo action CALL and RESOLVE", async () => {
  const context = createContext();
  const agent = createNode("agent://sdk/agent");
  const echo = createNode("plugin://sdk/echo");

  echo.action("echo", async (payload) => payload);

  await agent.connect(context.createTransport("agent"));
  await echo.connect(context.createTransport("echo"));

  const result = await agent.call("plugin://sdk/echo", "echo", {
    mime_type: "application/json",
    data: { text: "hello sdk" },
  });

  assert.deepEqual(result, {
    mime_type: "application/json",
    data: { text: "hello sdk" },
  });

  await agent.close();
  await echo.close();
});

test("SDK returns default manifest payload", async () => {
  const context = createContext();
  const agent = createNode("agent://sdk/agent");
  const echo = createNode("plugin://sdk/echo");

  echo.action("echo", async (payload) => payload);

  await agent.connect(context.createTransport("agent"));
  await echo.connect(context.createTransport("echo"));

  const manifest = await agent.call("plugin://sdk/echo", "manifest", {
    mime_type: "application/json",
    data: {},
  });

  assert.equal(manifest.mime_type, "text/typescript");
  assert.match(String(manifest.data), /interface Echo/);
  assert.match(String(manifest.data), /echo\(payload: unknown\): unknown/);

  await agent.close();
  await echo.close();
});

test("SDK manifest includes action MIME metadata", async () => {
  const context = createContext();
  const agent = createNode("agent://sdk/agent");
  const echo = createNode("plugin://sdk/echo");

  echo.action(
    "echo",
    {
      description: "Echo JSON payloads.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => payload,
  );

  await agent.connect(context.createTransport("agent"));
  await echo.connect(context.createTransport("echo"));

  const manifest = await agent.call("plugin://sdk/echo", "manifest", {
    mime_type: "application/json",
    data: {},
  });

  assert.match(String(manifest.data), /Echo JSON payloads/);
  assert.match(String(manifest.data), /@accepts application\/json/);
  assert.match(String(manifest.data), /@returns application\/json/);

  await agent.close();
  await echo.close();
});

test("SDK rejects missing actions as REJECT envelopes", async () => {
  const context = createContext();
  const agent = createNode("agent://sdk/agent");
  const echo = createNode("plugin://sdk/echo");

  await agent.connect(context.createTransport("agent"));
  await echo.connect(context.createTransport("echo"));

  await assert.rejects(
    agent.call("plugin://sdk/echo", "missing", {
      mime_type: "application/json",
      data: {},
    }),
    (error) => {
      assert.ok(error instanceof IpcCallError);
      assert.equal(error.code, "ACTION_NOT_FOUND");
      return true;
    },
  );

  await agent.close();
  await echo.close();
});

test("SDK rejects payload MIME types that an action does not accept", async () => {
  const context = createContext();
  const agent = createNode("agent://sdk/agent");
  const echo = createNode("plugin://sdk/echo");

  echo.action("echo", { accepts: "application/json" }, async (payload) => payload);

  await agent.connect(context.createTransport("agent"));
  await echo.connect(context.createTransport("echo"));

  await assert.rejects(
    agent.call("plugin://sdk/echo", "echo", {
      mime_type: "text/plain",
      data: "hello",
    }),
    (error) => {
      assert.ok(error instanceof IpcCallError);
      assert.equal(error.code, "MIME_NOT_ACCEPTED");
      return true;
    },
  );

  await agent.close();
  await echo.close();
});

test("SDK rejects action results with unexpected return MIME types", async () => {
  const context = createContext();
  const agent = createNode("agent://sdk/agent");
  const echo = createNode("plugin://sdk/echo");

  echo.action(
    "echo",
    { accepts: "application/json", returns: "text/plain" },
    async (payload) => payload,
  );

  await agent.connect(context.createTransport("agent"));
  await echo.connect(context.createTransport("echo"));

  await assert.rejects(
    agent.call("plugin://sdk/echo", "echo", {
      mime_type: "application/json",
      data: { text: "hello" },
    }),
    (error) => {
      assert.ok(error instanceof IpcCallError);
      assert.equal(error.code, "MIME_RETURN_MISMATCH");
      return true;
    },
  );

  await agent.close();
  await echo.close();
});

test("SDK debug callback receives raw incoming and outgoing frames", async () => {
  const context = createContext();
  const debugEvents: any[] = [];
  const agent = createNode("agent://sdk/agent", { debug: (event) => debugEvents.push(event) });
  const echo = createNode("plugin://sdk/echo");

  echo.action("echo", async (payload) => payload);

  await agent.connect(context.createTransport("agent"));
  await echo.connect(context.createTransport("echo"));

  await agent.call("plugin://sdk/echo", "echo", {
    mime_type: "application/json",
    data: { text: "debug" },
  });

  assert.ok(debugEvents.some((event) => event.direction === "out" && event.frame.type === "envelope"));
  assert.ok(debugEvents.some((event) => event.direction === "in" && event.frame.type === "envelope"));
  assert.ok(debugEvents.some((event) => event.direction === "out" && event.frame.type === "register"));
  assert.ok(debugEvents.some((event) => event.direction === "in" && event.frame.type === "registered"));

  await agent.close();
  await echo.close();
});

test("SDK pipeline routes through linear action nodes", async () => {
  const context = createContext();
  const agent = createNode("agent://sdk/agent");
  const fetch = createNode("plugin://sdk/fetch");
  const upper = createNode("plugin://sdk/upper");

  fetch.action(
    "execute",
    { accepts: "application/json", returns: "text/plain" },
    async (payload) => ({ mime_type: "text/plain", data: (payload.data as any).text }),
  );
  upper.action(
    "execute",
    { accepts: "text/plain", returns: "text/plain" },
    async (payload) => ({ mime_type: "text/plain", data: String(payload.data).toUpperCase() }),
  );

  await agent.connect(context.createTransport("agent"));
  await fetch.connect(context.createTransport("fetch"));
  await upper.connect(context.createTransport("upper"));

  const result = await agent.pipeline(
    ["plugin://sdk/fetch", "plugin://sdk/upper", "agent://sdk/agent"],
    { mime_type: "application/json", data: { text: "hello pipeline" } },
  );

  assert.deepEqual(result, { mime_type: "text/plain", data: "HELLO PIPELINE" });

  await agent.close();
  await fetch.close();
  await upper.close();
});

test("SDK pipeline rejects directly back to the final receiver", async () => {
  const context = createContext();
  const agent = createNode("agent://sdk/agent");
  const fetch = createNode("plugin://sdk/fetch");
  const upper = createNode("plugin://sdk/upper");

  fetch.action("execute", { accepts: "text/plain" }, async (payload) => payload);
  upper.action("execute", async (payload) => payload);

  await agent.connect(context.createTransport("agent"));
  await fetch.connect(context.createTransport("fetch"));
  await upper.connect(context.createTransport("upper"));

  await assert.rejects(
    agent.pipeline(
      ["plugin://sdk/fetch", "plugin://sdk/upper", "agent://sdk/agent"],
      { mime_type: "application/json", data: { text: "wrong mime" } },
    ),
    (error) => {
      assert.ok(error instanceof IpcCallError);
      assert.equal(error.code, "MIME_NOT_ACCEPTED");
      return true;
    },
  );

  await agent.close();
  await fetch.close();
  await upper.close();
});

test("SDK aborts local pending CALL waits with AbortSignal", async () => {
  const context = createContext();
  const agent = createNode("agent://sdk/agent");
  const slow = createNode("plugin://sdk/slow");
  const controller = new AbortController();

  slow.action("wait", async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { mime_type: "application/json", data: { done: true } };
  });

  await agent.connect(context.createTransport("agent"));
  await slow.connect(context.createTransport("slow"));

  const pending = agent.call("plugin://sdk/slow", "wait", {
    mime_type: "application/json",
    data: {},
  }, { signal: controller.signal });

  controller.abort("test abort");

  await assert.rejects(
    pending,
    (error) => {
      assert.ok(error instanceof IpcCallError);
      assert.equal(error.code, "CALL_ABORTED");
      assert.match(error.message, /test abort/);
      return true;
    },
  );

  await agent.close();
  await slow.close();
});

test("SDK treats EMIT, END, and CANCEL as stream subscription flow", async () => {
  const context = createContext();
  const ticker = createNode("plugin://sdk/ticker");
  const upper = createNode("plugin://sdk/upper");
  const agent = createNode("agent://sdk/agent");
  const streamId = "stream_sdk_1";
  const emitted: Array<{ data: unknown; correlation_id?: string; source: string }> = [];
  const ended: Array<{ data: unknown; correlation_id?: string; source: string }> = [];
  const cancelled: Array<{ data: unknown; correlation_id?: string; source: string }> = [];

  upper.action(
    "execute",
    { accepts: "text/plain", returns: "text/plain" },
    async (payload) => ({ mime_type: "text/plain", data: String(payload.data).toUpperCase() }),
  );

  agent.onEmit("execute", (payload, context) => {
    emitted.push({
      data: payload.data,
      correlation_id: context.envelope.header.correlation_id,
      source: context.envelope.header.source,
    });
  });

  agent.onEnd("execute", (payload, context) => {
    ended.push({
      data: payload.data,
      correlation_id: context.envelope.header.correlation_id,
      source: context.envelope.header.source,
    });
  });

  ticker.onCancel("*", (payload, context) => {
    cancelled.push({
      data: payload.data,
      correlation_id: context.envelope.header.correlation_id,
      source: context.envelope.header.source,
    });
  });

  await ticker.connect(context.createTransport("ticker"));
  await upper.connect(context.createTransport("upper"));
  await agent.connect(context.createTransport("agent"));

  ticker.emit("plugin://sdk/upper", "execute", {
    mime_type: "text/plain",
    data: "hello stream",
  }, { correlation_id: streamId, reply_to: "agent://sdk/agent" });

  await waitFor(() => emitted.length === 1);
  assert.deepEqual(emitted[0], {
    data: "HELLO STREAM",
    correlation_id: streamId,
    source: "plugin://sdk/upper",
  });

  ticker.end("plugin://sdk/upper", "execute", {
    mime_type: "application/json",
    data: { done: true },
  }, { correlation_id: streamId, reply_to: "agent://sdk/agent" });

  await waitFor(() => ended.length === 1);
  assert.deepEqual(ended[0], {
    data: { done: true },
    correlation_id: streamId,
    source: "plugin://sdk/upper",
  });

  agent.cancel("plugin://sdk/ticker", {
    mime_type: "application/json",
    data: {},
  }, { correlation_id: streamId, reason: "subscriber stopped" });

  await waitFor(() => cancelled.length === 1);
  assert.deepEqual(cancelled[0], {
    data: { reason: "subscriber stopped" },
    correlation_id: streamId,
    source: "agent://sdk/agent",
  });

  await ticker.close();
  await upper.close();
  await agent.close();
});

function createContext() {
  const dir = mkdtempSync(join("/tmp", "kairos-ipc-sdk-test-"));
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
