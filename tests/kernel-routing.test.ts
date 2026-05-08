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
import { SLOCK_APPROVAL_REQUEST_MIME, SLOCK_CHANNEL_EVENT_MIME, SLOCK_MESSAGE_DELTA_MIME, SLOCK_MESSAGE_MIME } from "../packages/slock-channel/src/index.ts";

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
  const traces = readTrace(context.tracePath);
  const rejectTrace = traces.find((entry) => entry.op_code === "REJECT");
  assert.equal(rejectTrace?.payload_kind, "ipc_reject");
  assert.equal(rejectTrace?.reject_error_code, "TARGET_NOT_FOUND");
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

test("trace records content-safe Slock metadata without payload contents", () => {
  const context = createContext();
  const human = new MemoryConnection("human");
  const channel = new MemoryConnection("channel");

  context.registry.register("human://user/local", human);
  context.registry.register("app://slock/channel/general", channel);

  context.router.route({
    header: {
      msg_id: createMsgId(),
      source: "human://user/local",
      target: "app://slock/channel/general",
      reply_to: "human://user/local",
      ttl_ms: 30000,
    },
    spec: { op_code: "CALL", action: "post_message" },
    payload: {
      mime_type: SLOCK_MESSAGE_MIME,
      data: {
        text: "secret project detail",
        mentions: ["agent://local/pi-assistant"],
        thread_id: null,
      },
    },
  }, human);

  const traces = readTrace(context.tracePath);
  assert.equal(traces[0]?.event, "envelope");
  assert.equal(traces[0]?.payload_kind, "slock_message_input");
  assert.equal(traces[0]?.channel, "app://slock/channel/general");
  assert.equal(traces[0]?.mention_count, 1);
  assert.equal(typeof traces[0]?.payload_hash, "string");
  assert.equal(typeof traces[0]?.payload_size, "number");
  assert.doesNotMatch(readFileSync(context.tracePath, "utf8"), /secret project detail/);
});

test("trace can capture full payloads when explicitly enabled", () => {
  const dir = mkdtempSync(join("/tmp", "kairos-ipc-router-test-"));
  const tracePath = join(dir, "trace.jsonl");
  const registry = new EndpointRegistry();
  const trace = new TraceWriter(tracePath, { capture_payload: true });
  const router = new Router({ registry, capabilityGate: new AllowAllCapabilityGate(), trace });
  const human = new MemoryConnection("human");
  const channel = new MemoryConnection("channel");

  registry.register("human://user/local", human);
  registry.register("app://slock/channel/general", channel);

  router.route({
    header: {
      msg_id: createMsgId(),
      source: "human://user/local",
      target: "app://slock/channel/general",
      reply_to: "human://user/local",
      ttl_ms: 30000,
    },
    spec: { op_code: "CALL", action: "post_message" },
    payload: {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "debug payload text", thread_id: null },
    },
  }, human);

  const traces = readTrace(tracePath);
  assert.deepEqual((traces[0]?.payload as any).text, "debug payload text");
});

test("trace extracts approval risk and proposed call metadata", () => {
  const context = createContext();
  const agent = new MemoryConnection("agent");
  const human = new MemoryConnection("human");

  context.registry.register("agent://local/pi-assistant", agent);
  context.registry.register("human://user/local", human);

  context.router.route({
    header: {
      msg_id: createMsgId(),
      source: "agent://local/pi-assistant",
      target: "human://user/local",
      reply_to: "agent://local/pi-assistant",
      ttl_ms: 30000,
    },
    spec: { op_code: "CALL", action: "request_approval" },
    payload: {
      mime_type: SLOCK_APPROVAL_REQUEST_MIME,
      data: {
        id: "approval_1",
        risk: "shell_exec",
        summary: "Run pwd",
        metadata: { channel: "app://slock/channel/general", thread_id: "channel_msg_1" },
        proposed_call: { target: "plugin://local/shell", action: "exec", payload: { command: "pwd", args: [] } },
      },
    },
  }, agent);

  const traces = readTrace(context.tracePath);
  assert.equal(traces[0]?.payload_kind, "slock_approval_request");
  assert.equal(traces[0]?.approval_id, "approval_1");
  assert.equal(traces[0]?.approval_risk, "shell_exec");
  assert.equal(traces[0]?.approval_target, "plugin://local/shell");
  assert.equal(traces[0]?.approval_action, "exec");
  assert.equal(traces[0]?.channel, "app://slock/channel/general");
  assert.equal(traces[0]?.thread_id, "channel_msg_1");
});

test("trace extracts status delta and channel error diagnostics", () => {
  const context = createContext();
  const agent = new MemoryConnection("agent");
  const channel = new MemoryConnection("channel");
  const human = new MemoryConnection("human");

  context.registry.register("agent://local/pi-assistant", agent);
  context.registry.register("app://slock/channel/general", channel);
  context.registry.register("human://user/local", human);

  context.router.route({
    header: {
      msg_id: createMsgId(),
      source: "agent://local/pi-assistant",
      target: "app://slock/channel/general",
      ttl_ms: 30000,
    },
    spec: { op_code: "EMIT", action: "message_delta" },
    payload: {
      mime_type: SLOCK_MESSAGE_DELTA_MIME,
      data: {
        thread_id: "channel_msg_1",
        kind: "status",
        text: "Model gateway timed out.",
        metadata: { type: "agent_phase", phase: "model", phase_state: "errored" },
      },
    },
  }, agent);

  context.router.route({
    header: {
      msg_id: createMsgId(),
      source: "app://slock/channel/general",
      target: "human://user/local",
      ttl_ms: 30000,
    },
    spec: { op_code: "EMIT", action: "agent_error" },
    payload: {
      mime_type: SLOCK_CHANNEL_EVENT_MIME,
      data: {
        type: "agent_error",
        channel: "app://slock/channel/general",
        error: { code: "ACTION_FAILED", message: "Model gateway timed out.", source: "agent://local/pi-assistant" },
      },
    },
  }, channel);

  const traces = readTrace(context.tracePath);
  assert.equal(traces[0]?.status_text, "Model gateway timed out.");
  assert.equal(traces[0]?.status_type, "agent_phase");
  assert.equal(traces[0]?.status_phase, "model");
  assert.equal(traces[0]?.status_phase_state, "errored");
  assert.equal(traces[1]?.error_code, "ACTION_FAILED");
  assert.equal(traces[1]?.error_message, "Model gateway timed out.");
});

function createContext() {
  const dir = mkdtempSync(join("/tmp", "kairos-ipc-router-test-"));
  const tracePath = join(dir, "trace.jsonl");
  const registry = new EndpointRegistry();
  const trace = new TraceWriter(tracePath);
  const router = new Router({ registry, capabilityGate: new AllowAllCapabilityGate(), trace });
  return { dir, tracePath, registry, router };
}

function readTrace(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
