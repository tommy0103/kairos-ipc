import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createAgentAdapter, type AgentRuntime } from "../packages/agent-adapter/src/index.ts";
import { AllowAllCapabilityGate } from "../packages/kernel/src/capability.ts";
import type { Connection } from "../packages/kernel/src/registry.ts";
import { EndpointRegistry } from "../packages/kernel/src/registry.ts";
import { Router } from "../packages/kernel/src/router.ts";
import { TraceWriter } from "../packages/kernel/src/trace.ts";
import type { ClientFrame, KernelFrame } from "../packages/protocol/src/index.ts";
import { createNode, type IpcTransport } from "../packages/sdk/src/index.ts";
import { createSessionManager } from "../packages/session-manager/src/index.ts";
import {
  createSlockChannel,
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_MIME,
  type SlockAgentRun,
  type SlockChannelEvent,
} from "../packages/slock-channel/src/index.ts";

test("session manager owns multi-agent Slock routing and projects artifacts back to the channel", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    session_manager_uri: "app://kairos/session-manager",
    mention_aliases: { agent: ["agent://local/alice", "agent://local/cindy"] },
  });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", capturedRuns) });
  const cindy = createAgentAdapter({ uri: "agent://local/cindy", runtime: recordingRuntime("cindy", capturedRuns) });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.connect(ipc.createTransport("human"));
    await sessionManager.node.connect(ipc.createTransport("session-manager"));
    await channel.node.connect(ipc.createTransport("channel"));
    await alice.node.connect(ipc.createTransport("alice"));
    await cindy.node.connect(ipc.createTransport("cindy"));

    await human.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    const posted = await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@agent compare architecture options", thread_id: null },
    });
    const rootId = (posted.data as { id: string }).id;

    await waitFor(() => events.filter((event) => event.type === "message_created" && event.message?.kind === "agent").length === 2);

    assert.equal(sessionManager.sessions.size, 1);
    const record = [...sessionManager.sessions.values()][0];
    assert.ok(record);
    assert.equal(Object.keys(record.state.delegations).length, 2);
    assert.equal(Object.keys(record.state.artifacts).length, 2);
    assert.equal(Object.values(record.state.barriers)[0]?.status, "satisfied");
    assert.deepEqual(Object.keys(record.state.active_runs), []);

    assert.equal(channel.messages.length, 3);
    assert.equal(events.filter((event) => event.type === "agent_run_started").length, 2);
    assert.equal(events.filter((event) => event.type === "agent_run_finished" && event.run?.state === "completed").length, 2);
    assert.ok(capturedRuns.every((run) => run.session_id === record.id));
    assert.ok(capturedRuns.every((run) => run.context_text?.includes("Kairos collaboration session")));
    assert.ok(capturedRuns.every((run) => run.context_text?.includes("compare architecture options")));

    const projected = events.filter((event) => event.type === "message_created" && event.message?.kind === "agent");
    assert.deepEqual(projected.map((event) => event.message?.sender).sort(), ["agent://local/alice", "agent://local/cindy"]);
    assert.ok(projected.every((event) => event.message?.thread_id === rootId));
    assert.ok(projected.some((event) => event.message?.text.includes("alice completed")));
    assert.ok(projected.some((event) => event.message?.text.includes("cindy completed")));
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await channel.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
    await cindy.node.close().catch(() => undefined);
  }
});

function recordingRuntime(name: string, capturedRuns: SlockAgentRun[]): AgentRuntime {
  return {
    async *run(input) {
      capturedRuns.push(input);
      yield { type: "status", text: `${name} reading session context` };
      yield {
        type: "final",
        result: {
          summary: `${name} completed`,
          final_text: `${name} completed ${input.session_id} ${input.delegation_id}`,
        },
      };
    },
  };
}

function createContext() {
  const dir = mkdtempSync(join("/tmp", "kairos-ipc-session-manager-test-"));
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
