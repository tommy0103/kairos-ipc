import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createMsgId, type Envelope, type KernelFrame } from "../packages/protocol/src/index.ts";
import { AllowAllCapabilityGate } from "../packages/kernel/src/capability.ts";
import type { Connection } from "../packages/kernel/src/registry.ts";
import { EndpointRegistry } from "../packages/kernel/src/registry.ts";
import { Router } from "../packages/kernel/src/router.ts";
import { TraceWriter } from "../packages/kernel/src/trace.ts";

test("routes CALL and RESOLVE between registered endpoints", () => {
  const context = createContext();
  const agent = new MemoryConnection("agent");
  const plugin = new MemoryConnection("plugin");

  context.registry.register("agent://test/main", agent);
  context.registry.register("plugin://test/echo", plugin);

  context.router.route(createCallEnvelope(), agent);

  const call = plugin.nextEnvelope();
  assert.equal(call.spec.op_code, "CALL");
  assert.deepEqual(call.payload.data, { text: "hello" });

  context.router.route(
    {
      header: {
        msg_id: createMsgId(),
        source: "plugin://test/echo",
        target: "agent://test/main",
        ttl_ms: 30000,
      },
      spec: { op_code: "RESOLVE", action: "echo" },
      payload: { mime_type: "application/json", data: { text: "hello" } },
    },
    plugin,
  );

  const resolve = agent.nextEnvelope();
  assert.equal(resolve.spec.op_code, "RESOLVE");
  assert.deepEqual(resolve.payload.data, { text: "hello" });
});

test("returns REJECT when target is not registered", () => {
  const context = createContext();
  const agent = new MemoryConnection("agent");

  context.registry.register("agent://test/main", agent);
  context.router.route(
    {
      ...createCallEnvelope(),
      header: {
        ...createCallEnvelope().header,
        target: "plugin://test/missing",
      },
    },
    agent,
  );

  const reject = agent.nextEnvelope();
  assert.equal(reject.spec.op_code, "REJECT");
  assert.equal((reject.payload.data as any).error.code, "TARGET_NOT_FOUND");

  const trace = readFileSync(context.tracePath, "utf8");
  assert.match(trace, /TARGET_NOT_FOUND/);
});

test("returns REJECT when ttl_ms has expired", () => {
  const context = createContext();
  const agent = new MemoryConnection("agent");
  const plugin = new MemoryConnection("plugin");

  context.registry.register("agent://test/main", agent);
  context.registry.register("plugin://test/echo", plugin);

  context.router.route(
    {
      ...createCallEnvelope(),
      header: {
        ...createCallEnvelope().header,
        ttl_ms: 0,
      },
    },
    agent,
  );

  const reject = agent.nextEnvelope();
  assert.equal(reject.spec.op_code, "REJECT");
  assert.equal((reject.payload.data as any).error.code, "TTL_EXPIRED");
  assert.equal(plugin.frames.length, 0);
});

test("rejects envelopes whose source is not owned by the sending connection", () => {
  const context = createContext();
  const agent = new MemoryConnection("agent");
  const plugin = new MemoryConnection("plugin");

  context.registry.register("agent://test/main", agent);
  context.registry.register("plugin://test/echo", plugin);

  context.router.route(createCallEnvelope(), plugin);

  const error = plugin.nextFrame();
  assert.equal(error.type, "error");
  assert.equal(error.error.code, "SOURCE_NOT_REGISTERED");
  assert.equal(plugin.frames.length, 0);
});

function createContext() {
  const dir = mkdtempSync(join("/tmp", "kairos-ipc-router-test-"));
  const tracePath = join(dir, "trace.jsonl");
  const registry = new EndpointRegistry();
  const trace = new TraceWriter(tracePath);
  const router = new Router({ registry, capabilityGate: new AllowAllCapabilityGate(), trace });
  return { dir, tracePath, registry, router };
}

function createCallEnvelope(): Envelope {
  return {
    header: {
      msg_id: createMsgId(),
      source: "agent://test/main",
      target: "plugin://test/echo",
      reply_to: "agent://test/main",
      ttl_ms: 30000,
    },
    spec: { op_code: "CALL", action: "echo" },
    payload: { mime_type: "application/json", data: { text: "hello" } },
  };
}

class MemoryConnection implements Connection {
  id: string;
  frames: KernelFrame[] = [];

  constructor(id: string) {
    this.id = id;
  }

  send(frame: KernelFrame): void {
    this.frames.push(frame);
  }

  nextFrame(): any {
    const frame = this.frames.shift();
    assert.ok(frame, `expected frame for ${this.id}`);
    return frame;
  }

  nextEnvelope(): Envelope {
    const frame = this.nextFrame();
    assert.equal(frame.type, "envelope");
    return frame.envelope;
  }
}
