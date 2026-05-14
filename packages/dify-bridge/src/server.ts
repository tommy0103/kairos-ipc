import { createServer } from "node:net";
import { createNode, type IpcNode } from "../../sdk/src/index.ts";
import type {
  DifyBridgeOptions,
  DifyCancelRunRequest,
  DifyChatRequest,
  DifyCreateSessionRequest,
  DifyPostMessageRequest,
  DifyResolveApprovalRequest,
  DifyReviewArtifactRequest,
  DifyStartRunRequest,
} from "./types.ts";
import { createDifyBridgeOpenApi } from "./openapi.ts";
import { createDifyBridgeService, type DifyBridgeService } from "./service.ts";
import { ApiError, checkOrigin, errorBody, jsonResponse, readJsonBody, requireAuth, routePath } from "./http.ts";

export interface DifyBridgeListenOptions {
  host?: string;
  port: number;
}

export interface DifyBridge {
  node: IpcNode;
  service: DifyBridgeService;
  listen(options: DifyBridgeListenOptions): Promise<{ url: string }>;
  close(): Promise<void>;
}

export function createDifyBridge(options: DifyBridgeOptions): DifyBridge {
  const node = createNode(options.uri ?? "app://kairos/dify-bridge");
  const service = createDifyBridgeService(options);
  let server: Bun.Server | undefined;
  let closed = false;

  node.action(
    "status",
    {
      description: "Return Dify bridge status.",
      accepts: "application/json",
      returns: "application/json",
    },
    async () => ({
      mime_type: "application/json",
      data: { ok: true, session_manager_uri: options.session_manager_uri },
    }),
  );

  return { node, service, listen, close };

  async function listen(listenOptions: DifyBridgeListenOptions): Promise<{ url: string }> {
    if (closed) {
      throw new Error("Dify bridge is closed");
    }
    if (server) {
      throw new Error("Dify bridge is already listening");
    }
    const hostname = listenOptions.host ?? "127.0.0.1";
    const port = listenOptions.port === 0 ? await findOpenPort(hostname) : listenOptions.port;
    server = Bun.serve({
      hostname,
      port,
      idleTimeout: 0,
      fetch: (request) => handleRequest(request),
    });
    return { url: `http://${hostname}:${server.port}` };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const closing = server;
    server = undefined;
    if (closing) {
      closing.stop(true);
    }
    await node.close();
  }

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }), request);
      }

      const route = routePath(url.pathname);
      if (!route) {
        throw new ApiError(404, "not_found", `route not found: ${url.pathname}`);
      }

      if (route.kind === "health") {
        requireMethod(request, "GET");
        return withCors(jsonResponse(200, { ok: true }), request);
      }

      if (route.kind === "openapi") {
        requireMethod(request, "GET");
        return withCors(jsonResponse(200, createDifyBridgeOpenApi()), request);
      }

      checkOrigin(request, options.allowed_origins);
      requireAuth(request, options.auth_token, options.allow_unauthenticated === true);

      switch (route.kind) {
        case "chat": {
          requireMethod(request, "POST");
          const body = readChatRequest(await readJsonBody(request, options.max_body_bytes));
          const result = await service.chat(body);
          const response = new Response(result.text, {
            status: 200,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "x-kairos-session-id": result.session_id,
            },
          });
          return withCors(response, request);
        }
        case "sessions": {
          requireMethod(request, "POST");
          const body = readCreateSessionRequest(await readJsonBody(request, options.max_body_bytes));
          return withCors(jsonResponse(200, await service.createSession(body)), request);
        }
        case "session": {
          requireMethod(request, "GET");
          return withCors(jsonResponse(200, await service.getSession(route.sessionId)), request);
        }
        case "session_messages": {
          requireMethod(request, "POST");
          const body = readPostMessageRequest(await readJsonBody(request, options.max_body_bytes));
          return withCors(jsonResponse(200, await service.postMessage(route.sessionId, body)), request);
        }
        case "session_runs": {
          requireMethod(request, "POST");
          const body = readStartRunRequest(await readJsonBody(request, options.max_body_bytes));
          return withCors(jsonResponse(200, await service.startRun(route.sessionId, body)), request);
        }
        case "run_cancel": {
          requireMethod(request, "POST");
          const body = readCancelRunRequest(await readJsonBody(request, options.max_body_bytes));
          return withCors(jsonResponse(200, await service.cancelRun(route.runId, body)), request);
        }
        case "session_artifacts": {
          requireMethod(request, "GET");
          return withCors(jsonResponse(200, await service.listArtifacts(route.sessionId)), request);
        }
        case "artifact": {
          requireMethod(request, "GET");
          return withCors(jsonResponse(200, await service.readArtifact(route.artifactId, url.searchParams.get("session_id") ?? undefined)), request);
        }
        case "artifact_review": {
          requireMethod(request, "POST");
          const body = readReviewArtifactRequest(await readJsonBody(request, options.max_body_bytes));
          return withCors(jsonResponse(200, await service.reviewArtifact(route.artifactId, body)), request);
        }
        case "session_approvals": {
          requireMethod(request, "GET");
          return withCors(jsonResponse(200, await service.listApprovals(route.sessionId)), request);
        }
        case "approval_resolve": {
          requireMethod(request, "POST");
          const body = readResolveApprovalRequest(await readJsonBody(request, options.max_body_bytes));
          return withCors(jsonResponse(200, await service.resolveApproval(route.approvalId, body)), request);
        }
        case "session_trace": {
          requireMethod(request, "GET");
          return withCors(jsonResponse(200, await service.getSessionTrace(route.sessionId)), request);
        }
        case "run_trace": {
          requireMethod(request, "GET");
          return withCors(jsonResponse(200, await service.getRunTrace(route.runId)), request);
        }
      }
    } catch (error) {
      const apiError = toApiError(error);
      return withCors(jsonResponse(apiError.status, errorBody(apiError)), request);
    }
  }

  function withCors(response: Response, request: Request): Response {
    const origin = request.headers.get("origin");
    if (origin && options.allowed_origins?.includes(origin)) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set("vary", "origin");
    }
    response.headers.set("access-control-allow-headers", "authorization, content-type, x-kairos-bridge-token");
    response.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    return response;
  }
}

async function findOpenPort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, hostname, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      probe.close(() => {
        if (port) resolve(port);
        else reject(new Error("failed to allocate Dify bridge port"));
      });
    });
  });
}

function requireMethod(request: Request, method: "GET" | "POST"): void {
  if (request.method !== method) {
    throw new ApiError(405, "method_not_allowed", `${request.method} is not allowed`);
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    const message = error.message || "request failed";
    const status = /not found/i.test(message) ? 404 : 500;
    if (/requires|invalid|duplicate|must|expected/i.test(message)) {
      return new ApiError(400, "invalid_request", message);
    }
    return new ApiError(status, status === 404 ? "not_found" : "internal_error", status === 404 ? message : "internal server error");
  }
  return new ApiError(500, "internal_error", "request failed");
}

function readCreateSessionRequest(value: unknown): DifyCreateSessionRequest {
  const record = readObject(value);
  return {
    title: readOptionalString(record.title),
    objective: readOptionalString(record.objective),
    acceptance_criteria: readOptionalStringArray(record.acceptance_criteria),
    source: readSource(record.source),
  };
}

function readPostMessageRequest(value: unknown): DifyPostMessageRequest {
  const record = readObject(value);
  return { text: readOptionalString(record.text), source: readSource(record.source) };
}

function readChatRequest(value: unknown): DifyChatRequest {
  const record = readObject(value);
  return {
    message: readRequiredString(record.message ?? record.query ?? record.text, "message"),
    title: readOptionalString(record.title),
    agents: Array.isArray(record.agents) ? readEndpointArray(record.agents, "agents") : undefined,
    acceptance_criteria: readOptionalStringArray(record.acceptance_criteria),
    expected_output: readOptionalString(record.expected_output),
    source: readSource(record.source),
  };
}

function readStartRunRequest(value: unknown): DifyStartRunRequest {
  const record = readObject(value);
  const instruction = readRequiredString(record.instruction, "instruction");
  const delegationPlan = readDelegationPlan(record.delegation_plan);
  const agents = readEndpointArray(record.agents ?? delegationPlan?.map((item) => item.assignee), "agents");
  if (agents.length === 0 && !delegationPlan?.length) {
    throw new ApiError(400, "invalid_request", "start run requires at least one agent");
  }
  return {
    instruction,
    agents,
    mode: record.mode === "sequential" ? "sequential" : record.mode === "parallel" ? "parallel" : undefined,
    expected_output: readOptionalString(record.expected_output),
    synthesis_requested: typeof record.synthesis_requested === "boolean" ? record.synthesis_requested : undefined,
    delegation_plan: delegationPlan,
    source: readSource(record.source),
  };
}

function readCancelRunRequest(value: unknown): DifyCancelRunRequest {
  const record = readObject(value);
  return { session_id: readOptionalString(record.session_id), reason: readOptionalString(record.reason) };
}

function readReviewArtifactRequest(value: unknown): DifyReviewArtifactRequest {
  const record = readObject(value);
  const status = record.status;
  if (status !== "accepted" && status !== "rejected" && status !== "revision_requested") {
    throw new ApiError(400, "invalid_request", "artifact review requires status accepted, rejected, or revision_requested");
  }
  return {
    session_id: readOptionalString(record.session_id),
    status,
    note: readOptionalString(record.note),
    reviewer: readOptionalString(record.reviewer),
    revision_instruction: readOptionalString(record.revision_instruction),
    rerun: record.rerun === true ? true : undefined,
    source: readSource(record.source),
  };
}

function readResolveApprovalRequest(value: unknown): DifyResolveApprovalRequest {
  const record = readObject(value);
  const status = record.status;
  if (status !== undefined && status !== "approved" && status !== "rejected" && status !== "cancelled" && status !== "expired") {
    throw new ApiError(400, "invalid_request", "approval resolve status must be approved, rejected, cancelled, or expired");
  }
  return {
    session_id: readOptionalString(record.session_id),
    status,
    approved: typeof record.approved === "boolean" ? record.approved : undefined,
    resolved_by: readOptionalString(record.resolved_by),
    resolution_note: readOptionalString(record.resolution_note),
  };
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new ApiError(400, "invalid_request", "request body must be a JSON object");
}

function readRequiredString(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ApiError(400, "invalid_request", `${field} is required`);
  return text;
}

function readOptionalString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(readOptionalString).filter((item): item is string => Boolean(item));
}

function readEndpointArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new ApiError(400, "invalid_request", `${field} must be an array`);
  return value.map((item) => readRequiredString(item, field));
}

function readDelegationPlan(value: unknown): DifyStartRunRequest["delegation_plan"] {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const record = readObject(item);
    return {
      assignee: readRequiredString(record.assignee, "delegation_plan.assignee"),
      role: readOptionalString(record.role),
      role_label: readOptionalString(record.role_label),
      instruction: readOptionalString(record.instruction),
      expected_output: readOptionalString(record.expected_output),
    };
  });
}

function readSource(value: unknown): DifyCreateSessionRequest["source"] {
  if (value === undefined) return undefined;
  const record = readObject(value);
  return {
    app_id: readOptionalString(record.app_id),
    conversation_id: readOptionalString(record.conversation_id),
    message_id: readOptionalString(record.message_id),
    user_id: readOptionalString(record.user_id),
    workflow_run_id: readOptionalString(record.workflow_run_id),
  };
}
