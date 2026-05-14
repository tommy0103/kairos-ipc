import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
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
import type { SlockAgentRun } from "../packages/slock-channel/src/index.ts";
import { createDifyBridge, createDifyBridgeService, sourceRefFromDifyMetadata } from "../packages/dify-bridge/src/index.ts";

test("service maps Dify metadata into stable external source refs", () => {
  assert.deepEqual(sourceRefFromDifyMetadata({ app_id: "app_1", conversation_id: "conv_1", message_id: "msg_1" }, "Dify message"), {
    kind: "external",
    uri: "dify://app/app_1/conversation/conv_1/message/msg_1",
    label: "Dify message",
  });
  assert.equal(sourceRefFromDifyMetadata({ conversation_id: "conv_1", message_id: "msg_1" }, "Dify message").uri, "dify://conversation/conv_1/message/msg_1");
  assert.equal(sourceRefFromDifyMetadata({ workflow_run_id: "run_1" }, "Workflow run").uri, "dify://workflow-run/run_1");
});

test("service creates sessions, starts runs, exposes artifacts, approvals, reviews, and trace", async () => {
  const ipc = createContext();
  const human = createNode("human://user/dify-test");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", capturedRuns) });
  const cindy = createAgentAdapter({ uri: "agent://local/cindy", runtime: recordingRuntime("cindy", capturedRuns) });

  try {
    await human.connect(ipc.createTransport("human-dify-service"));
    await sessionManager.node.connect(ipc.createTransport("session-dify-service"));
    await alice.node.connect(ipc.createTransport("alice-dify-service"));
    await cindy.node.connect(ipc.createTransport("cindy-dify-service"));

    const service = createDifyBridgeService({
      human_node: human,
      session_manager_uri: "app://kairos/session-manager",
      trace_path: ipc.tracePath,
    });

    const created = await service.createSession({
      title: "Review repository bridge",
      objective: "Find integration risks.",
      acceptance_criteria: ["Artifacts are available to Dify"],
      source: { app_id: "kairos", conversation_id: "conv_service", message_id: "msg_create", user_id: "user_1" },
    });

    assert.ok(created.session_id);
    assert.equal(created.status, "open");
    assert.equal(created.session_uri, `app://kairos/session/${created.session_id}`);

    await service.postMessage(created.session_id, {
      text: "Please include bridge-specific risks.",
      source: { app_id: "kairos", conversation_id: "conv_service", message_id: "msg_followup" },
    });

    const run = await service.startRun(created.session_id, {
      instruction: "Inspect the bridge boundary and submit concise findings.",
      expected_output: "Markdown findings.",
      agents: ["agent://local/alice", "agent://local/cindy"],
      mode: "parallel",
      synthesis_requested: false,
      source: { app_id: "kairos", conversation_id: "conv_service", message_id: "msg_run", workflow_run_id: "workflow_1" },
    });

    assert.equal(run.session_id, created.session_id);
    assert.equal(run.runs.length, 2);
    assert.ok(run.status_url.endsWith(`/sessions/${created.session_id}`));
    assert.deepEqual(run.runs.map((item) => item.agent).sort(), ["agent://local/alice", "agent://local/cindy"]);

    await waitFor(() => capturedRuns.length === 2);
    await waitFor(() => Object.keys(sessionManager.getSession(created.session_id)?.state.artifacts ?? {}).length === 2);

    const summary = await service.getSession(created.session_id);
    assert.equal(summary.session_id, created.session_id);
    assert.equal(summary.title, "Review repository bridge");
    assert.equal(summary.status, "open");
    assert.ok(summary.latest_artifact?.id);

    const artifacts = await service.listArtifacts(created.session_id);
    assert.equal(artifacts.artifacts.length, 2);
    assert.ok(artifacts.artifacts.every((artifact) => !("content" in artifact)));

    const artifactId = artifacts.artifacts[0]?.id;
    assert.ok(artifactId);
    const artifact = await service.readArtifact(artifactId, created.session_id);
    assert.equal(artifact.id, artifactId);
    assert.deepEqual(artifact.content, {
      summary: artifact.author.endsWith("alice") ? "alice completed" : "cindy completed",
      final_text: JSON.stringify({ text: `human://user/dify-test completed ${created.session_id}` }),
    });

    const review = await service.reviewArtifact(artifactId, { session_id: created.session_id, status: "accepted", note: "Readable by Dify." });
    assert.equal(review.artifact_id, artifactId);
    assert.equal(review.status, "accepted");
    assert.equal(review.session_id, created.session_id);

    const approvalResult = await human.call("app://kairos/session-manager", "request_approval", {
      mime_type: "application/json",
      data: {
        session_id: created.session_id,
        tool_endpoint: "plugin://local/workspace",
        action: "edit",
        risk: "high",
        payload_summary: "change bridge files",
      },
    });
    const approvalId = (approvalResult.data as { approval: { id: string } }).approval.id;

    const approvals = await service.listApprovals(created.session_id);
    assert.deepEqual(approvals.approvals.map((approval) => approval.id), [approvalId]);

    const resolved = await service.resolveApproval(approvalId, { session_id: created.session_id, approved: false, resolution_note: "Dify rejected it." });
    assert.equal(resolved.approval_id, approvalId);
    assert.equal(resolved.status, "rejected");

    const trace = await service.getSessionTrace(created.session_id);
    assert.equal(trace.available, true);
    assert.equal(trace.trace_path, ipc.tracePath);
    assert.ok(trace.view.stats.total_events > 0);

    await assert.rejects(service.getSessionTrace("session_missing"), /session not found/);
    await assert.rejects(service.getRunTrace("delegation_missing"), /delegation not found/);
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
    await cindy.node.close().catch(() => undefined);
  }
});

test("service metadata responses do not expose raw string artifact bodies", async () => {
  const ipc = createContext();
  const human = createNode("human://user/dify-metadata-test");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });

  try {
    await human.connect(ipc.createTransport("human-dify-metadata"));
    await sessionManager.node.connect(ipc.createTransport("session-dify-metadata"));
    const service = createDifyBridgeService({
      human_node: human,
      session_manager_uri: "app://kairos/session-manager",
      trace_path: ipc.tracePath,
    });

    const created = await service.createSession({ title: "String artifact metadata boundary" });
    const secretBody = "SECRET_MARKDOWN_BODY ".repeat(40);
    await human.call("app://kairos/session-manager", "submit_artifact", {
      mime_type: "application/json",
      data: {
        session_id: created.session_id,
        artifact: {
          author: "agent://local/alice",
          kind: "research_note",
          title: "Raw artifact body",
          content: secretBody,
        },
      },
    });

    const list = await service.listArtifacts(created.session_id);
    assert.equal(list.artifacts.length, 1);
    assert.equal(list.artifacts[0]?.summary, undefined);
    assert.equal(JSON.stringify(list).includes("SECRET_MARKDOWN_BODY"), false);

    const summary = await service.getSession(created.session_id);
    assert.equal(JSON.stringify(summary).includes("SECRET_MARKDOWN_BODY"), false);

    const detail = await service.readArtifact(list.artifacts[0]!.id, created.session_id);
    assert.equal(detail.content, secretBody);
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
  }
});

test("HTTP chat route starts a Kairos session and returns Dify-friendly plain text", async () => {
  const port = await getFreePortIfAvailable();
  if (port === undefined) return;

  const ipc = createContext();
  const human = createNode("human://user/dify-chat-test");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", capturedRuns) });
  const cindy = createAgentAdapter({ uri: "agent://local/cindy", runtime: recordingRuntime("cindy", capturedRuns) });
  const bridge = createDifyBridge({
    human_node: human,
    session_manager_uri: "app://kairos/session-manager",
    auth_token: "secret-token",
    trace_path: ipc.tracePath,
  });

  try {
    await human.connect(ipc.createTransport("human-dify-chat"));
    await sessionManager.node.connect(ipc.createTransport("session-dify-chat"));
    await alice.node.connect(ipc.createTransport("alice-dify-chat"));
    await cindy.node.connect(ipc.createTransport("cindy-dify-chat"));
    await bridge.node.connect(ipc.createTransport("bridge-dify-chat"));
    const { url } = await bridge.listen({ host: "127.0.0.1", port });

    const response = await fetch(`${url}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        message: "Review the repository and tell me the highest risk before shipping.",
        source: { app_id: "kairos", conversation_id: "conv_chat", message_id: "msg_chat", user_id: "user_chat" },
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
    const answer = await response.text();
    assert.match(answer, /Kairos session started/);
    assert.match(answer, /agent:\/\/local\/alice/);
    assert.match(answer, /agent:\/\/local\/cindy/);
    const sessionId = response.headers.get("x-kairos-session-id");
    assert.ok(sessionId);
    assert.match(answer, new RegExp(sessionId));

    await waitFor(() => capturedRuns.length === 2);
    const session = sessionManager.getSession(sessionId);
    assert.equal(session?.state.session?.objective, "Review the repository and tell me the highest risk before shipping.");
    assert.deepEqual(Object.values(session?.state.delegations ?? {}).map((delegation) => delegation.assignee).sort(), ["agent://local/alice", "agent://local/cindy"]);
  } finally {
    await bridge.close().catch(() => undefined);
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
    await cindy.node.close().catch(() => undefined);
  }
});

test("HTTP exposes Dify workflow routes with auth, OpenAPI, artifacts, and JSON 404s", async () => {
  const port = await getFreePortIfAvailable();
  if (port === undefined) return;

  const ipc = createContext();
  const human = createNode("human://user/dify-http-test");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", capturedRuns) });
  const cindy = createAgentAdapter({ uri: "agent://local/cindy", runtime: recordingRuntime("cindy", capturedRuns) });
  const bridge = createDifyBridge({
    human_node: human,
    session_manager_uri: "app://kairos/session-manager",
    auth_token: "secret-token",
    trace_path: ipc.tracePath,
  });

  try {
    await human.connect(ipc.createTransport("human-dify-http"));
    await sessionManager.node.connect(ipc.createTransport("session-dify-http"));
    await alice.node.connect(ipc.createTransport("alice-dify-http"));
    await cindy.node.connect(ipc.createTransport("cindy-dify-http"));
    await bridge.node.connect(ipc.createTransport("bridge-dify-http"));
    const { url } = await bridge.listen({ host: "127.0.0.1", port });

    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const browserHealth = await fetch(`${url}/health`, { headers: { origin: "https://evil.example" } });
    assert.equal(browserHealth.status, 200);
    assert.equal(browserHealth.headers.get("access-control-allow-origin"), null);

    const openapi = await fetch(`${url}/openapi.json`);
    assert.equal(openapi.status, 200);
    const document = await openapi.json() as {
      paths: Record<string, Record<string, {
        operationId?: string;
        requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
        responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
      }>>;
      components?: { schemas?: Record<string, unknown> };
    };
    const operationIds = Object.values(document.paths).flatMap((methods) => Object.values(methods).map((operation) => operation.operationId));
    assert.ok(operationIds.includes("startKairosChat"));
    assert.ok(operationIds.includes("createKairosSession"));
    assert.ok(operationIds.includes("startKairosRun"));
    assert.ok(operationIds.includes("getKairosRunTrace"));
    assert.ok(document.components?.schemas?.DifyCreateSessionRequest);
    assert.ok(document.components?.schemas?.DifyStartRunRequest);
    assert.ok(document.components?.schemas?.DifyArtifactDetail);
    assert.equal(
      document.paths["/sessions/{session_id}/runs"]?.post?.requestBody?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/DifyStartRunRequest",
    );
    assert.equal(
      document.paths["/sessions/{session_id}/runs"]?.post?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/DifyStartRunResponse",
    );

    const unauthorized = await fetch(`${url}/sessions`, { method: "POST", body: JSON.stringify({ title: "No token" }) });
    assert.equal(unauthorized.status, 401);
    assert.equal(((await unauthorized.json()) as { error: { code: string } }).error.code, "unauthorized");

    const sessionResponse = await fetch(`${url}/sessions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        title: "HTTP bridge session",
        source: { app_id: "kairos", conversation_id: "conv_http", message_id: "msg_create" },
      }),
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json() as { session_id: string };
    assert.ok(session.session_id);

    const runResponse = await fetch(`${url}/sessions/${encodeURIComponent(session.session_id)}/runs`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        instruction: "Review HTTP bridge behavior.",
        agents: ["agent://local/alice", "agent://local/cindy"],
        source: { app_id: "kairos", conversation_id: "conv_http", message_id: "msg_run" },
      }),
    });
    assert.equal(runResponse.status, 200);
    const run = await runResponse.json() as { runs: Array<{ delegation_id: string }> };
    assert.equal(run.runs.length, 2);
    assert.ok(run.runs.every((item) => item.delegation_id));

    const invalidRunResponse = await fetch(`${url}/sessions/${encodeURIComponent(session.session_id)}/runs`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ agents: ["agent://local/alice"] }),
    });
    assert.equal(invalidRunResponse.status, 400);
    assert.equal(((await invalidRunResponse.json()) as { error: { code: string } }).error.code, "invalid_request");

    await waitFor(() => capturedRuns.length === 2);
    await waitFor(() => Object.keys(sessionManager.getSession(session.session_id)?.state.artifacts ?? {}).length === 2);

    const artifactsResponse = await fetch(`${url}/sessions/${encodeURIComponent(session.session_id)}/artifacts`, { headers: authHeaders() });
    assert.equal(artifactsResponse.status, 200);
    const artifacts = await artifactsResponse.json() as { artifacts: Array<{ id: string; content?: unknown }> };
    assert.equal(artifacts.artifacts.length, 2);
    assert.ok(artifacts.artifacts.every((artifact) => !("content" in artifact)));

    const artifactId = artifacts.artifacts[0]?.id;
    assert.ok(artifactId);
    const artifactResponse = await fetch(`${url}/artifacts/${encodeURIComponent(artifactId)}?session_id=${encodeURIComponent(session.session_id)}`, { headers: authHeaders() });
    assert.equal(artifactResponse.status, 200);
    const artifact = await artifactResponse.json() as { id: string; content?: unknown };
    assert.equal(artifact.id, artifactId);
    assert.ok(artifact.content);

    const unknown = await fetch(`${url}/api/does-not-exist`, { headers: authHeaders() });
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, "not_found");
  } finally {
    await bridge.close().catch(() => undefined);
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
    await cindy.node.close().catch(() => undefined);
  }
});

test("HTTP requires an auth token by default and only reflects configured origins", async () => {
  const port = await getFreePortIfAvailable();
  if (port === undefined) return;

  const ipc = createContext();
  const human = createNode("human://user/dify-auth-test");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const bridge = createDifyBridge({
    human_node: human,
    session_manager_uri: "app://kairos/session-manager",
    trace_path: ipc.tracePath,
    allowed_origins: ["https://dify.local"],
  });

  try {
    await human.connect(ipc.createTransport("human-dify-auth"));
    await sessionManager.node.connect(ipc.createTransport("session-dify-auth"));
    await bridge.node.connect(ipc.createTransport("bridge-dify-auth"));
    const { url } = await bridge.listen({ host: "127.0.0.1", port });

    const missingToken = await fetch(`${url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "No bridge token configured" }),
    });
    assert.equal(missingToken.status, 401);
    assert.equal(((await missingToken.json()) as { error: { code: string } }).error.code, "unauthorized");

    const preflight = await fetch(`${url}/sessions`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);

    const allowedPreflight = await fetch(`${url}/sessions`, {
      method: "OPTIONS",
      headers: { origin: "https://dify.local" },
    });
    assert.equal(allowedPreflight.headers.get("access-control-allow-origin"), "https://dify.local");
  } finally {
    await bridge.close().catch(() => undefined);
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
  }
});

test("Dify bridge close is idempotent and prevents listen after close", async () => {
  const human = createNode("human://user/dify-close-test");
  const bridge = createDifyBridge({
    human_node: human,
    session_manager_uri: "app://kairos/session-manager",
  });

  await bridge.close();
  await bridge.close();
  await assert.rejects(bridge.listen({ host: "127.0.0.1", port: 0 }), /closed/);
});

function authHeaders(): HeadersInit {
  return {
    authorization: "Bearer secret-token",
    "content-type": "application/json",
  };
}

function recordingRuntime(name: string, capturedRuns: SlockAgentRun[]): AgentRuntime {
  return {
    async *run(input) {
      capturedRuns.push(input);
      yield {
        type: "final",
        result: {
          summary: `${name} completed`,
          final_text: JSON.stringify({ text: `${input.sender} completed ${input.session_id}` }),
        },
      };
    },
  };
}

function createContext() {
  const dir = mkdtempSync(join("/tmp", "kairos-ipc-dify-bridge-test-"));
  const tracePath = join(dir, "trace.jsonl");
  const registry = new EndpointRegistry();
  const trace = new TraceWriter(tracePath);
  const router = new Router({ registry, capabilityGate: new AllowAllCapabilityGate(), trace });

  return {
    tracePath,
    createTransport(id: string): IpcTransport {
      return new MemoryKernelTransport(id, registry, router, trace);
    },
  };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("failed to allocate a local test port"));
        }
      });
    });
  });
}

async function getFreePortIfAvailable(): Promise<number | undefined> {
  try {
    return await getFreePort();
  } catch (error) {
    if (isLocalBindUnavailable(error)) {
      return undefined;
    }
    throw error;
  }
}

function isLocalBindUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; syscall?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const syscall = typeof candidate.syscall === "string" ? candidate.syscall : undefined;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return (code === "EPERM" || code === "EACCES") && (syscall === "listen" || /listen|bind/i.test(message));
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
