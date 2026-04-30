import {
  createCorrelationId,
  createMsgId,
  type ClientFrame,
  type EndpointUri,
  type Envelope,
  type EnvelopePayload,
  type KernelFrame,
  type RejectData,
} from "../../protocol/src/index.ts";
import { connectTransport, type IpcTransport } from "./transport.ts";

export interface ActionContext<TData = unknown> {
  envelope: Envelope<TData>;
  node: IpcNode;
}

export type ActionResult<TData = unknown> = EnvelopePayload<TData> | TData | Promise<EnvelopePayload<TData> | TData>;
export type ActionHandler<TData = unknown, TResult = unknown> = (
  payload: EnvelopePayload<TData>,
  context: ActionContext<TData>,
) => ActionResult<TResult>;

export type MimeSpec = string | string[];

export interface ActionOptions {
  accepts?: MimeSpec;
  returns?: MimeSpec;
  description?: string;
}

interface ActionRegistration {
  handler: ActionHandler;
  options: ActionOptions;
}

export interface DebugEvent {
  node: EndpointUri;
  direction: "in" | "out";
  frame: ClientFrame | KernelFrame;
}

export type DebugSink = boolean | ((event: DebugEvent) => void);

export interface CallOptions {
  ttl_ms?: number;
  correlation_id?: string;
  timeout_ms?: number;
}

export interface PipelineOptions extends CallOptions {
  action?: string;
}

export interface EmitOptions {
  ttl_ms?: number;
  correlation_id?: string;
  reply_to?: EndpointUri | null;
  routing_slip?: EndpointUri[] | null;
}

export interface EndOptions extends EmitOptions {}

export interface CancelOptions {
  ttl_ms?: number;
  correlation_id?: string;
  reason?: string;
}

export interface EmitContext<TData = unknown> {
  envelope: Envelope<TData>;
  node: IpcNode;
}

export type EmitHandler<TData = unknown> = (payload: EnvelopePayload<TData>, context: EmitContext<TData>) => void | Promise<void>;

export interface EndContext<TData = unknown> {
  envelope: Envelope<TData>;
  node: IpcNode;
}

export type EndHandler<TData = unknown> = (payload: EnvelopePayload<TData>, context: EndContext<TData>) => void | Promise<void>;

export interface CancelContext<TData = unknown> {
  envelope: Envelope<TData>;
  node: IpcNode;
}

export type CancelHandler<TData = unknown> = (payload: EnvelopePayload<TData>, context: CancelContext<TData>) => void | Promise<void>;

interface PendingCall {
  resolve(payload: EnvelopePayload): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface RegisterWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class IpcCallError extends Error {
  readonly code: string;
  readonly envelope?: Envelope<RejectData>;

  constructor(message: string, options: { code?: string; envelope?: Envelope<RejectData> } = {}) {
    super(message);
    this.name = "IpcCallError";
    this.code = options.code ?? "IPC_CALL_FAILED";
    this.envelope = options.envelope;
  }
}

export interface CreateNodeOptions {
  default_ttl_ms?: number;
  register_timeout_ms?: number;
  debug?: DebugSink;
}

export function createNode(uri: EndpointUri, options: CreateNodeOptions = {}): IpcNode {
  return new IpcNode(uri, options);
}

export class IpcNode {
  readonly uri: EndpointUri;
  private readonly defaultTtlMs: number;
  private readonly registerTimeoutMs: number;
  private readonly debug?: DebugSink;
  private readonly actions = new Map<string, ActionRegistration>();
  private readonly emitHandlers = new Map<string, Set<EmitHandler>>();
  private readonly endHandlers = new Map<string, Set<EndHandler>>();
  private readonly cancelHandlers = new Map<string, Set<CancelHandler>>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly registerWaiters = new Map<EndpointUri, RegisterWaiter>();
  private transport?: IpcTransport;
  private removeFrameListener?: () => void;

  constructor(uri: EndpointUri, options: CreateNodeOptions = {}) {
    this.uri = uri;
    this.defaultTtlMs = options.default_ttl_ms ?? 30000;
    this.registerTimeoutMs = options.register_timeout_ms ?? 3000;
    this.debug = options.debug;
  }

  action<TData = unknown, TResult = unknown>(
    name: string,
    optionsOrHandler: ActionOptions | ActionHandler<TData, TResult>,
    maybeHandler?: ActionHandler<TData, TResult>,
  ): this {
    if (!name.trim()) {
      throw new Error("action name must be non-empty");
    }

    const options = typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
    const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
    if (!handler) {
      throw new Error(`action handler is required: ${name}`);
    }

    this.actions.set(name, { handler: handler as ActionHandler, options });
    return this;
  }

  async connect(addressOrTransport: string | IpcTransport): Promise<this> {
    const transport = typeof addressOrTransport === "string" ? await connectTransport(addressOrTransport) : addressOrTransport;
    this.transport = transport;
    this.removeFrameListener = transport.onFrame((frame) => this.handleFrame(frame));

    await this.register(this.uri);
    return this;
  }

  async call<TData = unknown, TResult = unknown>(
    target: EndpointUri,
    action: string,
    payload: EnvelopePayload<TData>,
    options: CallOptions = {},
  ): Promise<EnvelopePayload<TResult>> {
    this.requireTransport();
    const correlationId = options.correlation_id ?? createCorrelationId();
    const ttlMs = options.ttl_ms ?? this.defaultTtlMs;
    const timeoutMs = options.timeout_ms ?? ttlMs;

    const envelope: Envelope<TData> = {
      header: {
        msg_id: createMsgId(),
        correlation_id: correlationId,
        source: this.uri,
        target,
        reply_to: this.uri,
        ttl_ms: ttlMs,
      },
      spec: { op_code: "CALL", action },
      payload,
    };

    const result = new Promise<EnvelopePayload<TResult>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new IpcCallError(`call timed out: ${target} action=${action}`, { code: "CALL_TIMEOUT" }));
      }, timeoutMs);

      this.pending.set(correlationId, {
        resolve: (next) => resolve(next as EnvelopePayload<TResult>),
        reject,
        timer,
      });
    });

    this.sendFrame({ type: "envelope", envelope });
    return await result;
  }

  async pipeline<TData = unknown, TResult = unknown>(
    route: EndpointUri[],
    payload: EnvelopePayload<TData>,
    options: PipelineOptions = {},
  ): Promise<EnvelopePayload<TResult>> {
    if (route.length === 0) {
      throw new Error("pipeline route must include at least one endpoint");
    }

    const fullRoute = route.at(-1) === this.uri ? route : [...route, this.uri];
    if (fullRoute.length < 2) {
      throw new Error("pipeline route must include at least one worker endpoint before the final receiver");
    }

    const correlationId = options.correlation_id ?? createCorrelationId("pipe");
    const ttlMs = options.ttl_ms ?? this.defaultTtlMs;
    const timeoutMs = options.timeout_ms ?? ttlMs;
    const target = fullRoute[0];
    const replyTo = fullRoute[1];
    const routingSlip = fullRoute.slice(2).reverse();

    const result = new Promise<EnvelopePayload<TResult>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new IpcCallError(`pipeline timed out: ${fullRoute.join(" -> ")}`, { code: "PIPELINE_TIMEOUT" }));
      }, timeoutMs);

      this.pending.set(correlationId, {
        resolve: (next) => resolve(next as EnvelopePayload<TResult>),
        reject,
        timer,
      });
    });

    this.sendFrame({
      type: "envelope",
      envelope: {
        header: {
          msg_id: createMsgId(),
          correlation_id: correlationId,
          source: this.uri,
          target,
          reply_to: replyTo,
          routing_slip: routingSlip,
          ttl_ms: ttlMs,
        },
        spec: { op_code: "CALL", action: options.action ?? "execute" },
        payload,
      },
    });

    return await result;
  }

  emit<TData = unknown>(
    target: EndpointUri,
    action: string,
    payload: EnvelopePayload<TData>,
    options: EmitOptions = {},
  ): void {
    this.sendFrame({
      type: "envelope",
      envelope: {
        header: {
          msg_id: createMsgId(),
          correlation_id: options.correlation_id,
          source: this.uri,
          target,
          reply_to: options.reply_to,
          routing_slip: options.routing_slip,
          ttl_ms: options.ttl_ms ?? this.defaultTtlMs,
        },
        spec: { op_code: "EMIT", action },
        payload,
      },
    });
  }

  end<TData = unknown>(
    target: EndpointUri,
    action: string,
    payload: EnvelopePayload<TData>,
    options: EndOptions = {},
  ): void {
    this.sendFrame({
      type: "envelope",
      envelope: {
        header: {
          msg_id: createMsgId(),
          correlation_id: options.correlation_id,
          source: this.uri,
          target,
          reply_to: options.reply_to,
          routing_slip: options.routing_slip,
          ttl_ms: options.ttl_ms ?? this.defaultTtlMs,
        },
        spec: { op_code: "END", action },
        payload,
      },
    });
  }

  cancel<TData = { reason?: string }>(
    target: EndpointUri,
    payload: EnvelopePayload<TData> = {
      mime_type: "application/json",
      data: {} as TData,
    },
    options: CancelOptions = {},
  ): void {
    const data = options.reason && isRecord(payload.data)
      ? { ...payload.data, reason: options.reason } as TData
      : payload.data;

    this.sendFrame({
      type: "envelope",
      envelope: {
        header: {
          msg_id: createMsgId(),
          correlation_id: options.correlation_id,
          source: this.uri,
          target,
          ttl_ms: options.ttl_ms ?? this.defaultTtlMs,
        },
        spec: { op_code: "CANCEL" },
        payload: { ...payload, data },
      },
    });
  }

  onEmit<TData = unknown>(action: string, handler: EmitHandler<TData>): () => void {
    if (!action.trim()) {
      throw new Error("emit action must be non-empty");
    }

    let handlers = this.emitHandlers.get(action);
    if (!handlers) {
      handlers = new Set<EmitHandler>();
      this.emitHandlers.set(action, handlers);
    }
    handlers.add(handler as EmitHandler);

    return () => {
      handlers.delete(handler as EmitHandler);
      if (handlers.size === 0) {
        this.emitHandlers.delete(action);
      }
    };
  }

  onEnd<TData = unknown>(action: string, handler: EndHandler<TData>): () => void {
    if (!action.trim()) {
      throw new Error("end action must be non-empty");
    }

    let handlers = this.endHandlers.get(action);
    if (!handlers) {
      handlers = new Set<EndHandler>();
      this.endHandlers.set(action, handlers);
    }
    handlers.add(handler as EndHandler);

    return () => {
      handlers.delete(handler as EndHandler);
      if (handlers.size === 0) {
        this.endHandlers.delete(action);
      }
    };
  }

  onCancel<TData = unknown>(action: string, handler: CancelHandler<TData>): () => void {
    if (!action.trim()) {
      throw new Error("cancel action must be non-empty");
    }

    let handlers = this.cancelHandlers.get(action);
    if (!handlers) {
      handlers = new Set<CancelHandler>();
      this.cancelHandlers.set(action, handlers);
    }
    handlers.add(handler as CancelHandler);

    return () => {
      handlers.delete(handler as CancelHandler);
      if (handlers.size === 0) {
        this.cancelHandlers.delete(action);
      }
    };
  }

  async close(): Promise<void> {
    this.removeFrameListener?.();
    this.removeFrameListener = undefined;
    const transport = this.transport;
    this.transport = undefined;

    for (const [correlationId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new IpcCallError(`node closed before call resolved: ${correlationId}`, { code: "NODE_CLOSED" }));
    }
    this.pending.clear();

    if (transport) {
      await transport.close();
    }
  }

  private async register(uri: EndpointUri): Promise<void> {
    const transport = this.requireTransport();
    const registered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.registerWaiters.delete(uri);
        reject(new Error(`timed out registering endpoint: ${uri}`));
      }, this.registerTimeoutMs);

      this.registerWaiters.set(uri, { resolve, reject, timer });
    });

    this.sendFrame({ type: "register", uri });
    await registered;
  }

  private handleFrame(frame: KernelFrame): void {
    this.debugFrame("in", frame);

    if (frame.type === "registered") {
      const waiter = this.registerWaiters.get(frame.uri);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.registerWaiters.delete(frame.uri);
        waiter.resolve();
      }
      return;
    }

    if (frame.type === "error") {
      this.rejectRegisterWaiters(frame.error.code, frame.error.message);
      return;
    }

    void this.handleEnvelope(frame.envelope);
  }

  private async handleEnvelope(envelope: Envelope): Promise<void> {
    if (envelope.spec.op_code === "CALL") {
      await this.handleCall(envelope);
      return;
    }

    if (envelope.spec.op_code === "RESOLVE") {
      if (this.resolvePending(envelope)) {
        return;
      }
      if (envelope.spec.action && this.actions.has(envelope.spec.action)) {
        await this.handleCall(envelope);
      }
      return;
    }

    if (envelope.spec.op_code === "REJECT") {
      this.rejectPending(envelope as Envelope<RejectData>);
      return;
    }

    if (envelope.spec.op_code === "EMIT") {
      await this.handleEmit(envelope);
      return;
    }

    if (envelope.spec.op_code === "END") {
      await this.handleEnd(envelope);
      return;
    }

    if (envelope.spec.op_code === "CANCEL") {
      await this.dispatchCancel(envelope);
    }
  }

  private async handleEmit(envelope: Envelope): Promise<void> {
    await this.dispatchEmit(envelope);

    if (envelope.spec.action && this.actions.has(envelope.spec.action)) {
      await this.handleActionEnvelope(envelope, "EMIT");
    }
  }

  private async handleEnd(envelope: Envelope): Promise<void> {
    await this.dispatchEnd(envelope);
    if (envelope.header.reply_to) {
      this.forwardTerminalStreamEnvelope(envelope, "END");
    }
  }

  private async dispatchEmit(envelope: Envelope): Promise<void> {
    const action = envelope.spec.action;
    const handlers = [
      ...(action ? this.emitHandlers.get(action) ?? [] : []),
      ...(this.emitHandlers.get("*") ?? []),
    ];

    await Promise.all(handlers.map((handler) => handler(envelope.payload, { envelope, node: this })));
  }

  private async dispatchEnd(envelope: Envelope): Promise<void> {
    const action = envelope.spec.action;
    const handlers = [
      ...(action ? this.endHandlers.get(action) ?? [] : []),
      ...(this.endHandlers.get("*") ?? []),
    ];

    await Promise.all(handlers.map((handler) => handler(envelope.payload, { envelope, node: this })));
  }

  private async dispatchCancel(envelope: Envelope): Promise<void> {
    const action = envelope.spec.action;
    const handlers = [
      ...(action ? this.cancelHandlers.get(action) ?? [] : []),
      ...(this.cancelHandlers.get("*") ?? []),
    ];

    await Promise.all(handlers.map((handler) => handler(envelope.payload, { envelope, node: this })));
  }

  private async handleCall(envelope: Envelope): Promise<void> {
    await this.handleActionEnvelope(envelope, "RESOLVE");
  }

  private async handleActionEnvelope(envelope: Envelope, responseOpCode: "RESOLVE" | "EMIT"): Promise<void> {
    const action = envelope.spec.action;
    if (!action) {
      this.sendReject(envelope, "ACTION_REQUIRED", `${envelope.spec.op_code} envelope must include spec.action`);
      return;
    }

    try {
      if (envelope.spec.op_code === "CALL" && action === "manifest" && !this.actions.has("manifest")) {
        this.sendResolve(envelope, this.createManifestPayload());
        return;
      }

      const registration = this.actions.get(action);
      if (!registration) {
        this.sendReject(envelope, "ACTION_NOT_FOUND", `action is not registered: ${action}`);
        return;
      }

      if (!mimeMatches(envelope.payload.mime_type, registration.options.accepts)) {
        this.sendReject(envelope, "MIME_NOT_ACCEPTED", `action does not accept ${envelope.payload.mime_type}`, {
          accepts: registration.options.accepts ?? null,
          actual: envelope.payload.mime_type,
        });
        return;
      }

      const result = await registration.handler(envelope.payload, { envelope, node: this });
      const responsePayload = toPayload(result, envelope.payload.mime_type);
      if (!mimeMatches(responsePayload.mime_type, registration.options.returns)) {
        this.sendReject(envelope, "MIME_RETURN_MISMATCH", `action returned ${responsePayload.mime_type}`, {
          returns: registration.options.returns ?? null,
          actual: responsePayload.mime_type,
        });
        return;
      }

      if (responseOpCode === "RESOLVE") {
        this.sendResolve(envelope, responsePayload);
        return;
      }

      this.sendEmitResult(envelope, responsePayload);
    } catch (error) {
      this.sendReject(envelope, "ACTION_FAILED", error instanceof Error ? error.message : "action failed");
    }
  }

  private sendResolve(request: Envelope, payload: EnvelopePayload): void {
    this.sendFrame({
      type: "envelope",
      envelope: {
        header: this.createResponseHeader(request),
        spec: { op_code: "RESOLVE", action: request.spec.action },
        payload,
      },
    });
  }

  private sendEmitResult(request: Envelope, payload: EnvelopePayload): void {
    const target = request.header.reply_to ?? request.header.source;
    this.sendFrame({
      type: "envelope",
      envelope: {
        header: {
          msg_id: createMsgId(),
          correlation_id: request.header.correlation_id ?? request.header.msg_id,
          source: this.uri,
          target,
          reply_to: null,
          routing_slip: request.header.routing_slip,
          ttl_ms: this.defaultTtlMs,
        },
        spec: { op_code: "EMIT", action: request.spec.action },
        payload,
      },
    });
  }

  private forwardTerminalStreamEnvelope(request: Envelope, opCode: "END"): void {
    this.sendFrame({
      type: "envelope",
      envelope: {
        header: {
          msg_id: createMsgId(),
          correlation_id: request.header.correlation_id ?? request.header.msg_id,
          source: this.uri,
          target: request.header.reply_to ?? request.header.source,
          reply_to: null,
          routing_slip: request.header.routing_slip,
          ttl_ms: this.defaultTtlMs,
        },
        spec: { op_code: opCode, action: request.spec.action },
        payload: request.payload,
      },
    });
  }

  private sendReject(request: Envelope, code: string, message: string, detail?: unknown): void {
    this.sendFrame({
      type: "envelope",
      envelope: {
        header: this.createRejectHeader(request),
        spec: { op_code: "REJECT", action: request.spec.action },
        payload: {
          mime_type: "application/json",
          data: { error: { code, message, detail } },
        },
      },
    });
  }

  private createResponseHeader(request: Envelope): Envelope["header"] {
    const routingSlip = [...(request.header.routing_slip ?? [])];
    const nextReplyTo = routingSlip.pop();

    return {
      msg_id: createMsgId(),
      correlation_id: request.header.correlation_id ?? request.header.msg_id,
      source: this.uri,
      target: request.header.reply_to ?? request.header.source,
      reply_to: nextReplyTo,
      routing_slip: routingSlip.length > 0 ? routingSlip : undefined,
      ttl_ms: this.defaultTtlMs,
    };
  }

  private createRejectHeader(request: Envelope): Envelope["header"] {
    const routingSlip = request.header.routing_slip ?? [];

    return {
      msg_id: createMsgId(),
      correlation_id: request.header.correlation_id ?? request.header.msg_id,
      source: this.uri,
      target: routingSlip[0] ?? request.header.reply_to ?? request.header.source,
      ttl_ms: this.defaultTtlMs,
    };
  }

  private resolvePending(envelope: Envelope): boolean {
    const correlationId = envelope.header.correlation_id;
    if (!correlationId) {
      return false;
    }

    const pending = this.pending.get(correlationId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(correlationId);
    pending.resolve(envelope.payload);
    return true;
  }

  private rejectPending(envelope: Envelope<RejectData>): boolean {
    const correlationId = envelope.header.correlation_id;
    if (!correlationId) {
      return false;
    }

    const pending = this.pending.get(correlationId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(correlationId);

    const error = envelope.payload.data.error;
    pending.reject(new IpcCallError(error.message, { code: error.code, envelope }));
    return true;
  }

  private rejectRegisterWaiters(code: string, message: string): void {
    for (const [uri, waiter] of this.registerWaiters) {
      clearTimeout(waiter.timer);
      this.registerWaiters.delete(uri);
      waiter.reject(new IpcCallError(message, { code }));
    }
  }

  private createManifestPayload(): EnvelopePayload<string> {
    const interfaceName = manifestInterfaceName(this.uri);
    const actions = [...this.actions.entries()].sort(([left], [right]) => left.localeCompare(right));
    const body = actions.length > 0
      ? actions.map(([action, registration]) => manifestActionLine(action, registration.options)).join("\n")
      : "  // no actions registered";

    return {
      mime_type: "text/typescript",
      data: `interface ${interfaceName} {\n${body}\n}`,
    };
  }

  private requireTransport(): IpcTransport {
    if (!this.transport) {
      throw new Error(`node is not connected: ${this.uri}`);
    }
    return this.transport;
  }

  private sendFrame(frame: ClientFrame): void {
    this.debugFrame("out", frame);
    this.requireTransport().send(frame);
  }

  private debugFrame(direction: "in" | "out", frame: ClientFrame | KernelFrame): void {
    if (!this.debug) {
      return;
    }

    const event = { node: this.uri, direction, frame };
    if (typeof this.debug === "function") {
      this.debug(event);
      return;
    }

    console.error(JSON.stringify(event));
  }
}

function toPayload(value: unknown, fallbackMimeType: string): EnvelopePayload {
  if (isPayload(value)) {
    return value;
  }

  return {
    mime_type: fallbackMimeType,
    data: value === undefined ? null : value,
  };
}

function isPayload(value: unknown): value is EnvelopePayload {
  return isRecord(value) && typeof value.mime_type === "string" && Object.hasOwn(value, "data");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mimeMatches(actual: string, expected?: MimeSpec): boolean {
  if (!expected) {
    return true;
  }

  const candidates = Array.isArray(expected) ? expected : [expected];
  return candidates.some((candidate) => mimePatternMatches(actual, candidate));
}

function mimePatternMatches(actual: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "*/*") {
    return true;
  }

  if (pattern.endsWith("/*")) {
    return actual.startsWith(`${pattern.slice(0, -1)}`);
  }

  return actual === pattern;
}

function manifestActionLine(action: string, options: ActionOptions): string {
  const docs = [
    options.description,
    options.accepts ? `@accepts ${formatMimeSpec(options.accepts)}` : undefined,
    options.returns ? `@returns ${formatMimeSpec(options.returns)}` : undefined,
  ].filter((line): line is string => Boolean(line));

  if (docs.length === 0) {
    return `  ${action}(payload: unknown): unknown;`;
  }

  const comment = ["  /**", ...docs.map((line) => `   * ${line}`), "   */"].join("\n");
  return `${comment}\n  ${action}(payload: unknown): unknown;`;
}

function formatMimeSpec(spec: MimeSpec): string {
  return Array.isArray(spec) ? spec.join(" | ") : spec;
}

function manifestInterfaceName(uri: string): string {
  const last = uri.split(/[/:]+/).filter(Boolean).at(-1) ?? "Node";
  const safe = last.replace(/[^a-zA-Z0-9_$]/g, "_");
  const name = safe.length > 0 ? safe : "Node";
  return /^[a-zA-Z_$]/.test(name) ? capitalize(name) : `Node_${name}`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
