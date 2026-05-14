import type {
  MattermostActionErrorResponse,
  MattermostCommandResponse,
  MattermostDialogResponse,
  MattermostDialogSubmission,
  MattermostInteractiveActionCallback,
  MattermostSlashCallback,
} from "./types.ts";
import { verifyMattermostCallbackToken } from "./callback-token.ts";

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class MattermostHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(status: number, code: string, publicMessage: string) {
    super(publicMessage);
    this.name = "MattermostHttpError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export type MattermostBridgeRoute =
  | { kind: "health" }
  | { kind: "slash" }
  | { kind: "action" }
  | { kind: "dialog" }
  | { kind: "trace"; session_id: string }
  | { kind: "artifact"; artifact_id: string };

export function routePath(pathname: string): MattermostBridgeRoute | undefined {
  let parts: string[];
  try {
    parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new MattermostHttpError(400, "invalid_path", "Invalid request path.");
  }
  if (parts.length === 1 && parts[0] === "health") return { kind: "health" };
  if (parts.length === 2 && parts[0] === "trace" && parts[1]) return { kind: "trace", session_id: parts[1] };
  if (parts.length === 2 && parts[0] === "artifacts" && parts[1]) return { kind: "artifact", artifact_id: parts[1] };
  if (parts.length === 2 && parts[0] === "mattermost" && parts[1] === "slash") return { kind: "slash" };
  if (parts.length === 2 && parts[0] === "mattermost" && parts[1] === "action") return { kind: "action" };
  if (parts.length === 2 && parts[0] === "mattermost" && parts[1] === "dialog") return { kind: "dialog" };
  return undefined;
}

export function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function commandErrorResponse(error: MattermostHttpError): MattermostCommandResponse {
  return { response_type: "ephemeral", text: `Kairos error: ${error.publicMessage}` };
}

export function dialogErrorResponse(error: MattermostHttpError): MattermostDialogResponse {
  return { error: error.publicMessage };
}

export function actionErrorResponse(error: MattermostHttpError): MattermostActionErrorResponse {
  return { error: { message: error.publicMessage } };
}

export function checkOrigin(request: Request, allowedOrigins: string[] | undefined, requireOrigin = false): void {
  if (!allowedOrigins?.length) return;
  const origin = request.headers.get("origin");
  if (!origin && !requireOrigin) return;
  if (!origin) throw new MattermostHttpError(403, "origin_forbidden", "Origin is not allowed.");
  if (allowedOrigins.includes(origin)) return;
  throw new MattermostHttpError(403, "origin_forbidden", "Origin is not allowed.");
}

export function checkTeam(teamId: string | undefined, allowedTeamIds: string[] | undefined): void {
  if (!allowedTeamIds?.length) return;
  if (teamId && allowedTeamIds.includes(teamId)) return;
  throw new MattermostHttpError(403, "team_forbidden", "Mattermost team is not allowed.");
}

export function checkUser(userId: string | undefined, allowedUserIds: string[] | undefined): void {
  if (allowedUserIds === undefined) return;
  if (userId && allowedUserIds.includes(userId)) return;
  throw new MattermostHttpError(403, "user_forbidden", "Mattermost user is not allowed.");
}

export function requireSlashToken(request: Request, formToken: string | undefined, expectedToken: string | undefined): void {
  if (!expectedToken) {
    throw new MattermostHttpError(401, "unauthorized", "Unauthorized Mattermost callback.");
  }
  const headerToken = readAuthorizationToken(request);
  if (headerToken === expectedToken || formToken === expectedToken) return;
  throw new MattermostHttpError(401, "unauthorized", "Unauthorized Mattermost callback.");
}

export function requireCallbackToken(request: Request, expectedToken: string | undefined, callback?: unknown): void {
  if (!expectedToken) {
    throw new MattermostHttpError(401, "unauthorized", "Unauthorized Mattermost callback.");
  }
  if (readAuthorizationToken(request) === expectedToken) return;
  const path = new URL(request.url).pathname;
  const callbackToken = readQueryToken(request) ?? readCallbackToken(callback);
  if (callbackToken && verifyMattermostCallbackToken(callbackToken, expectedToken, path)) return;
  throw new MattermostHttpError(401, "unauthorized", "Unauthorized Mattermost callback.");
}

export async function readFormBody(request: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<URLSearchParams> {
  requireContentType(request, "application/x-www-form-urlencoded");
  const text = await readTextBody(request, maxBytes);
  return new URLSearchParams(text);
}

export async function readJsonBody<T = unknown>(request: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<T> {
  requireContentType(request, "application/json");
  const text = await readTextBody(request, maxBytes);
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MattermostHttpError(400, "invalid_json", "Invalid JSON callback body.");
  }
}

export function readSlashCallback(form: URLSearchParams): MattermostSlashCallback {
  const payload = Object.fromEntries(form.entries());
  return {
    token: cleanString(payload.token),
    team_id: requiredString(payload.team_id, "team_id"),
    team_domain: cleanString(payload.team_domain),
    channel_id: requiredString(payload.channel_id, "channel_id"),
    channel_name: cleanString(payload.channel_name),
    post_id: cleanString(payload.post_id),
    user_id: requiredString(payload.user_id, "user_id"),
    user_name: cleanString(payload.user_name),
    command: requiredString(payload.command, "command"),
    text: cleanString(payload.text) ?? "",
    response_url: cleanString(payload.response_url),
    trigger_id: cleanString(payload.trigger_id),
  };
}

export function readActionCallback(value: unknown): MattermostInteractiveActionCallback {
  const record = readObject(value);
  return {
    user_id: requiredString(record.user_id, "user_id"),
    user_name: cleanString(record.user_name),
    team_id: requiredString(record.team_id, "team_id"),
    team_domain: cleanString(record.team_domain),
    channel_id: requiredString(record.channel_id, "channel_id"),
    channel_name: cleanString(record.channel_name),
    post_id: cleanString(record.post_id),
    trigger_id: cleanString(record.trigger_id),
    type: cleanString(record.type),
    context: readOptionalObject(record.context),
    selected_option: cleanString(record.selected_option),
    selected_options: Array.isArray(record.selected_options) ? record.selected_options.filter((item): item is string => typeof item === "string") : undefined,
  };
}

export function readDialogSubmission(value: unknown): MattermostDialogSubmission {
  const record = readObject(value);
  return {
    type: cleanString(record.type),
    callback_id: cleanString(record.callback_id),
    state: cleanString(record.state),
    user_id: requiredString(record.user_id, "user_id"),
    user_name: cleanString(record.user_name),
    team_id: requiredString(record.team_id, "team_id"),
    team_domain: cleanString(record.team_domain),
    channel_id: requiredString(record.channel_id, "channel_id"),
    channel_name: cleanString(record.channel_name),
    submission: readSubmission(record.submission),
    cancelled: record.cancelled === true,
  };
}

export function requireMethod(request: Request, method: "GET" | "POST"): void {
  if (request.method !== method) {
    throw new MattermostHttpError(405, "method_not_allowed", "HTTP method is not allowed.");
  }
}

export function toMattermostHttpError(error: unknown): MattermostHttpError {
  if (error instanceof MattermostHttpError) return error;
  return new MattermostHttpError(500, "internal_error", "The request could not be completed.");
}

async function readTextBody(request: Request, maxBytes: number): Promise<string> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > maxBytes) {
    throw new MattermostHttpError(413, "body_too_large", "Callback body is too large.");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new MattermostHttpError(413, "body_too_large", "Callback body is too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function readAuthorizationToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.match(/^Token\s+(.+)$/i)?.[1];
}

function readQueryToken(request: Request): string | undefined {
  const params = new URL(request.url).searchParams;
  return cleanString(params.get("kairos_callback_token")) ?? cleanString(params.get("callback_token"));
}

function readCallbackToken(value: unknown): string | undefined {
  if (value instanceof URLSearchParams) {
    return cleanString(value.get("kairos_callback_token")) ?? cleanString(value.get("callback_token"));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const direct = cleanString(record.kairos_callback_token) ?? cleanString(record.callback_token);
  if (direct) return direct;
  const context = readTokenFromRecord(record.context);
  if (context) return context;
  const state = cleanString(record.state);
  if (!state) return undefined;
  try {
    return readTokenFromRecord(JSON.parse(state));
  } catch {
    return undefined;
  }
}

function readTokenFromRecord(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return cleanString(record.kairos_callback_token) ?? cleanString(record.callback_token);
}

function requireContentType(request: Request, expected: string): void {
  const actual = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (actual === expected) return;
  throw new MattermostHttpError(415, "unsupported_media_type", "Callback content type is not supported.");
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MattermostHttpError(400, "invalid_request", "Callback body must be an object.");
  }
  return value as Record<string, unknown>;
}

function readOptionalObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return readObject(value);
}

function readSubmission(value: unknown): Record<string, string | boolean | string[] | undefined> {
  const record = readObject(value ?? {});
  const submission: Record<string, string | boolean | string[] | undefined> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string" || typeof item === "boolean" || item === undefined) {
      submission[key] = item;
    } else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) {
      submission[key] = item;
    }
  }
  return submission;
}

function requiredString(value: unknown, name: string): string {
  const text = cleanString(value);
  if (!text) throw new MattermostHttpError(400, "invalid_request", `Mattermost callback requires ${name}.`);
  return text;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
