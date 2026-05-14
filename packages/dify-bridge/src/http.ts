import type { DifyApiError } from "./types.ts";

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export async function readJsonBody<T = unknown>(request: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<T> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > maxBytes) {
    throw new ApiError(413, "body_too_large", `request body exceeds ${maxBytes} bytes`);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ApiError(413, "body_too_large", `request body exceeds ${maxBytes} bytes`);
  }
  if (!text.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ApiError(400, "invalid_json", error instanceof Error ? error.message : "invalid JSON body");
  }
}

export function requireAuth(request: Request, token: string | undefined, allowUnauthenticated = false): void {
  if (!token) {
    if (allowUnauthenticated) return;
    throw new ApiError(401, "unauthorized", "bridge token is not configured");
  }

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const headerToken = request.headers.get("x-kairos-bridge-token");
  if (bearer === token || headerToken === token) {
    return;
  }

  throw new ApiError(401, "unauthorized", "missing or invalid bridge token");
}

export function checkOrigin(request: Request, allowedOrigins: string[] | undefined): void {
  if (!allowedOrigins?.length) return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  if (allowedOrigins.includes(origin)) return;
  throw new ApiError(403, "origin_forbidden", `origin is not allowed: ${origin}`);
}

export type DifyBridgeRoute =
  | { kind: "health" }
  | { kind: "openapi" }
  | { kind: "chat" }
  | { kind: "sessions" }
  | { kind: "session"; sessionId: string }
  | { kind: "session_messages"; sessionId: string }
  | { kind: "session_runs"; sessionId: string }
  | { kind: "run_cancel"; runId: string }
  | { kind: "session_artifacts"; sessionId: string }
  | { kind: "artifact"; artifactId: string }
  | { kind: "artifact_review"; artifactId: string }
  | { kind: "session_approvals"; sessionId: string }
  | { kind: "approval_resolve"; approvalId: string }
  | { kind: "session_trace"; sessionId: string }
  | { kind: "run_trace"; runId: string };

export function routePath(pathname: string): DifyBridgeRoute | undefined {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 1 && parts[0] === "health") return { kind: "health" };
  if (parts.length === 1 && parts[0] === "openapi.json") return { kind: "openapi" };
  if (parts.length === 1 && parts[0] === "chat") return { kind: "chat" };
  if (parts.length === 1 && parts[0] === "sessions") return { kind: "sessions" };
  if (parts.length === 2 && parts[0] === "sessions") return { kind: "session", sessionId: parts[1] };
  if (parts.length === 3 && parts[0] === "sessions" && parts[2] === "messages") return { kind: "session_messages", sessionId: parts[1] };
  if (parts.length === 3 && parts[0] === "sessions" && parts[2] === "runs") return { kind: "session_runs", sessionId: parts[1] };
  if (parts.length === 3 && parts[0] === "runs" && parts[2] === "cancel") return { kind: "run_cancel", runId: parts[1] };
  if (parts.length === 3 && parts[0] === "sessions" && parts[2] === "artifacts") return { kind: "session_artifacts", sessionId: parts[1] };
  if (parts.length === 2 && parts[0] === "artifacts") return { kind: "artifact", artifactId: parts[1] };
  if (parts.length === 3 && parts[0] === "artifacts" && parts[2] === "review") return { kind: "artifact_review", artifactId: parts[1] };
  if (parts.length === 3 && parts[0] === "sessions" && parts[2] === "approvals") return { kind: "session_approvals", sessionId: parts[1] };
  if (parts.length === 3 && parts[0] === "approvals" && parts[2] === "resolve") return { kind: "approval_resolve", approvalId: parts[1] };
  if (parts.length === 3 && parts[0] === "sessions" && parts[2] === "trace") return { kind: "session_trace", sessionId: parts[1] };
  if (parts.length === 3 && parts[0] === "runs" && parts[2] === "trace") return { kind: "run_trace", runId: parts[1] };
  return undefined;
}

export function errorBody(error: ApiError): DifyApiError {
  return { error: { code: error.code, message: error.message } };
}
