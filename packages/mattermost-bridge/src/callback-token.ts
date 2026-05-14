import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const DEFAULT_CALLBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface MattermostCallbackTokenScope {
  path: string;
  ttl_ms?: number;
  now_ms?: number;
}

interface CallbackTokenPayload {
  v: 1;
  path: string;
  exp: number;
  nonce: string;
}

export function createMattermostCallbackToken(secret: string, scope: MattermostCallbackTokenScope): string {
  const now = scope.now_ms ?? Date.now();
  const payload: CallbackTokenPayload = {
    v: 1,
    path: normalizePath(scope.path),
    exp: now + (scope.ttl_ms ?? DEFAULT_CALLBACK_TOKEN_TTL_MS),
    nonce: randomUUID(),
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `kcb1.${encoded}.${sign(encoded, secret)}`;
}

export function verifyMattermostCallbackToken(token: string, secret: string, expectedPath: string, nowMs = Date.now()): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "kcb1") return false;
  const [, encoded, signature] = parts;
  if (!encoded || !signature || !constantTimeEqual(signature, sign(encoded, secret))) return false;
  const payload = parsePayload(encoded);
  if (!payload || payload.v !== 1) return false;
  if (payload.path !== normalizePath(expectedPath)) return false;
  return Number.isFinite(payload.exp) && payload.exp >= nowMs;
}

function parsePayload(encoded: string): CallbackTokenPayload | undefined {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.v !== 1 || typeof record.path !== "string" || typeof record.exp !== "number" || typeof record.nonce !== "string") return undefined;
    return record as unknown as CallbackTokenPayload;
  } catch {
    return undefined;
  }
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
