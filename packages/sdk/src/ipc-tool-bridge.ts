import type { EndpointUri, EnvelopePayload } from "../../protocol/src/index.ts";
import type { CallOptions } from "./node.ts";

export interface IpcToolCaller {
  call(
    target: EndpointUri,
    action: string,
    payload: EnvelopePayload,
    options?: CallOptions,
  ): Promise<EnvelopePayload>;
}

export interface IpcToolCallArgs {
  target: EndpointUri;
  action: string;
  mime_type: string;
  payload: unknown;
  ttl_ms?: number;
  timeout_ms?: number;
}

export interface IpcToolCallMimeContext {
  target: EndpointUri;
  action: string;
  payload: unknown;
}

export interface NormalizeIpcToolCallOptions {
  default_mime_type?: string | ((context: IpcToolCallMimeContext) => string | undefined);
}

export interface IpcToolCallPrepareContext<TContext = unknown> {
  context: TContext;
  signal?: AbortSignal;
}

export interface IpcToolCallPreparation {
  target?: EndpointUri;
  action?: string;
  mime_type?: string;
  payload?: unknown;
  ttl_ms?: number;
  timeout_ms?: number;
}

export type IpcToolCallNumberDefault<TContext = unknown> =
  | number
  | ((call: IpcToolCallArgs, context: IpcToolCallPrepareContext<TContext>) => number | undefined);

export interface ExecuteIpcToolCallOptions<TContext = unknown> extends NormalizeIpcToolCallOptions {
  context?: TContext;
  signal?: AbortSignal;
  default_ttl_ms?: IpcToolCallNumberDefault<TContext>;
  default_timeout_ms?: IpcToolCallNumberDefault<TContext>;
  prepare_call?: (
    call: IpcToolCallArgs,
    context: IpcToolCallPrepareContext<TContext>,
  ) => IpcToolCallPreparation | void | Promise<IpcToolCallPreparation | void>;
}

export interface IpcToolCallExecution<TResult = unknown> {
  call: IpcToolCallArgs;
  payload: EnvelopePayload;
  options: CallOptions;
  result: EnvelopePayload<TResult>;
}

export function normalizeIpcToolCallArgs(
  value: Record<string, unknown>,
  options: NormalizeIpcToolCallOptions = {},
): IpcToolCallArgs {
  const target = readString(value, "target") as EndpointUri;
  const action = readString(value, "action");
  const rawPayload = Object.hasOwn(value, "payload")
    ? value.payload
    : Object.hasOwn(value, "data")
      ? value.data
      : {};
  const nestedPayload = readEnvelopePayload(rawPayload);
  const payload = nestedPayload ? nestedPayload.data : rawPayload;
  const mimeType = readOptionalString(value, "mime_type")
    ?? nestedPayload?.mime_type
    ?? defaultMimeType({ target, action, payload }, options);

  return {
    target,
    action,
    mime_type: mimeType,
    payload,
    ttl_ms: readOptionalPositiveNumber(value, "ttl_ms"),
    timeout_ms: readOptionalPositiveNumber(value, "timeout_ms"),
  };
}

export async function executeIpcToolCall<TResult = unknown, TContext = unknown>(
  caller: IpcToolCaller,
  rawCall: IpcToolCallArgs | Record<string, unknown>,
  options: ExecuteIpcToolCallOptions<TContext> = {},
): Promise<IpcToolCallExecution<TResult>> {
  const context: IpcToolCallPrepareContext<TContext> = {
    context: options.context as TContext,
    signal: options.signal,
  };
  const initialCall = isNormalizedIpcToolCall(rawCall)
    ? rawCall
    : normalizeIpcToolCallArgs(rawCall, options);
  const preparation = await options.prepare_call?.(initialCall, context);
  const call = preparation ? applyPreparation(initialCall, preparation) : initialCall;
  const ttlMs = call.ttl_ms ?? resolveNumberDefault(options.default_ttl_ms, call, context);
  const timeoutMs = call.timeout_ms
    ?? call.ttl_ms
    ?? resolveNumberDefault(options.default_timeout_ms, call, context)
    ?? ttlMs;
  const payload: EnvelopePayload = {
    mime_type: call.mime_type,
    data: call.payload,
  };
  const callOptions: CallOptions = {
    ...(ttlMs !== undefined ? { ttl_ms: ttlMs } : {}),
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const result = await caller.call(call.target, call.action, payload, callOptions) as EnvelopePayload<TResult>;

  return { call, payload, options: callOptions, result };
}

function defaultMimeType(context: IpcToolCallMimeContext, options: NormalizeIpcToolCallOptions): string {
  if (typeof options.default_mime_type === "function") {
    return options.default_mime_type(context) ?? "application/json";
  }
  return options.default_mime_type ?? "application/json";
}

function readEnvelopePayload(value: unknown): EnvelopePayload | undefined {
  if (!isRecord(value) || typeof value.mime_type !== "string" || !Object.hasOwn(value, "data")) {
    return undefined;
  }

  return { mime_type: value.mime_type, data: value.data };
}

function isNormalizedIpcToolCall(value: IpcToolCallArgs | Record<string, unknown>): value is IpcToolCallArgs {
  return typeof value.target === "string"
    && typeof value.action === "string"
    && typeof value.mime_type === "string"
    && Object.hasOwn(value, "payload");
}

function applyPreparation(call: IpcToolCallArgs, preparation: IpcToolCallPreparation): IpcToolCallArgs {
  const next: IpcToolCallArgs = {
    ...call,
    ...(preparation.target ? { target: preparation.target } : {}),
    ...(preparation.action ? { action: preparation.action } : {}),
    ...(preparation.mime_type ? { mime_type: preparation.mime_type } : {}),
    ...(isPositiveNumber(preparation.ttl_ms) ? { ttl_ms: preparation.ttl_ms } : {}),
    ...(isPositiveNumber(preparation.timeout_ms) ? { timeout_ms: preparation.timeout_ms } : {}),
  };

  if (Object.hasOwn(preparation, "payload")) {
    next.payload = preparation.payload;
  }

  return next;
}

function resolveNumberDefault<TContext>(
  value: IpcToolCallNumberDefault<TContext> | undefined,
  call: IpcToolCallArgs,
  context: IpcToolCallPrepareContext<TContext>,
): number | undefined {
  const next = typeof value === "function" ? value(call, context) : value;
  return isPositiveNumber(next) ? next : undefined;
}

function readString(value: Record<string, unknown>, key: string): string {
  const next = value[key];
  if (typeof next !== "string" || next.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return next;
}

function readOptionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const next = value[key];
  return typeof next === "number" && Number.isFinite(next) ? next : undefined;
}

function readOptionalPositiveNumber(value: Record<string, unknown>, key: string): number | undefined {
  const next = readOptionalNumber(value, key);
  return isPositiveNumber(next) ? next : undefined;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const next = value[key];
  return typeof next === "string" && next.trim().length > 0 ? next : undefined;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
