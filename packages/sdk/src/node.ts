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
import { z, ZodError, type ZodType } from "zod";

export interface ActionContext<TData = unknown> {
  envelope: Envelope<TData>;
  node: IpcNode;
}

export type ActionResult<TData = unknown> = EnvelopePayload<TData> | TData | Promise<EnvelopePayload<TData> | TData>;
export type StreamActionResult<TData = unknown> = AsyncIterable<EnvelopePayload<TData> | TData>;
export type ActionHandler<TData = unknown, TResult = unknown> = (
  payload: EnvelopePayload<TData>,
  context: ActionContext<TData>,
) => ActionResult<TResult> | StreamActionResult<TResult> | Promise<StreamActionResult<TResult>>;

export type MimeSpec = string | string[];

export interface SchemaActionArgs<TData = unknown> {
  input: TData;
  payload: EnvelopePayload<TData>;
  context: ActionContext<TData>;
}

export type SchemaActionHandler<TData = unknown, TResult = unknown> = (
  args: SchemaActionArgs<TData>,
) => ActionResult<TResult> | StreamActionResult<TResult> | Promise<StreamActionResult<TResult>>;

export interface ActionOptions<TData = unknown, TResult = unknown> {
  accepts?: MimeSpec;
  returns?: MimeSpec;
  description?: string;
  doc?: string;
  input?: ZodType<TData>;
  output?: ZodType<TResult>;
  input_name?: string;
  output_name?: string;
  examples?: unknown[];
}

interface ActionRegistration {
  handler: ActionHandler | SchemaActionHandler;
  options: ActionOptions;
  mode: "payload" | "schema";
}

interface DecoratedActionMetadata {
  name?: string;
  options: ActionOptions;
}

const PLUGIN_URI_BY_CLASS = new WeakMap<Function, EndpointUri>();
const ACTION_METADATA_BY_METHOD = new WeakMap<Function, DecoratedActionMetadata>();

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
  signal?: AbortSignal;
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
  cleanup?: () => void;
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

export { z };

export function Plugin(uri: EndpointUri): ClassDecorator {
  return (value: Function) => {
    PLUGIN_URI_BY_CLASS.set(value, uri);
  };
}

export function Action<TData = unknown, TResult = unknown>(
  nameOrOptions?: string | ActionOptions<TData, TResult>,
  maybeOptions: ActionOptions<TData, TResult> = {},
): MethodDecorator {
  const name = typeof nameOrOptions === "string" ? nameOrOptions : undefined;
  const options = typeof nameOrOptions === "string" ? maybeOptions : nameOrOptions ?? {};
  return actionMetadataDecorator({ name, options: options as ActionOptions });
}

export function Accepts(accepts: MimeSpec): MethodDecorator {
  return actionMetadataDecorator({ options: { accepts } });
}

export function Returns(returns: MimeSpec): MethodDecorator {
  return actionMetadataDecorator({ options: { returns } });
}

export function createPluginNode(instance: object, options: CreateNodeOptions = {}): IpcNode {
  const uri = PLUGIN_URI_BY_CLASS.get(instance.constructor);
  if (!uri) {
    throw new Error(`plugin class is missing @Plugin metadata: ${instance.constructor.name}`);
  }
  return createNode(uri, options).plugin(instance);
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
    optionsOrHandler: ActionOptions<TData, TResult> | ActionHandler<TData, TResult> | SchemaActionHandler<TData, TResult>,
    maybeHandler?: ActionHandler<TData, TResult> | SchemaActionHandler<TData, TResult>,
  ): this {
    if (!name.trim()) {
      throw new Error("action name must be non-empty");
    }

    const options = typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
    const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
    if (!handler) {
      throw new Error(`action handler is required: ${name}`);
    }

    this.actions.set(name, {
      handler: handler as ActionHandler | SchemaActionHandler,
      options: options as ActionOptions,
      mode: options.input ? "schema" : "payload",
    });
    return this;
  }

  plugin(instance: object): this {
    registerPluginActions(this, instance);
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

    if (options.signal?.aborted) {
      throw abortedCallError(target, action, options.signal);
    }

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
        cleanup?.();
        reject(new IpcCallError(`call timed out: ${target} action=${action}`, { code: "CALL_TIMEOUT" }));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(correlationId);
        cleanup?.();
        reject(abortedCallError(target, action, options.signal));
      };
      const cleanup = options.signal
        ? () => options.signal?.removeEventListener("abort", onAbort)
        : undefined;

      options.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(correlationId, {
        resolve: (next) => resolve(next as EnvelopePayload<TResult>),
        reject,
        timer,
        cleanup,
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

    if (options.signal?.aborted) {
      throw abortedPipelineError(fullRoute, options.signal);
    }

    const target = fullRoute[0];
    const replyTo = fullRoute[1];
    const routingSlip = fullRoute.slice(2).reverse();

    const result = new Promise<EnvelopePayload<TResult>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        cleanup?.();
        reject(new IpcCallError(`pipeline timed out: ${fullRoute.join(" -> ")}`, { code: "PIPELINE_TIMEOUT" }));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(correlationId);
        cleanup?.();
        reject(abortedPipelineError(fullRoute, options.signal));
      };
      const cleanup = options.signal
        ? () => options.signal?.removeEventListener("abort", onAbort)
        : undefined;

      options.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(correlationId, {
        resolve: (next) => resolve(next as EnvelopePayload<TResult>),
        reject,
        timer,
        cleanup,
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
      pending.cleanup?.();
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
    if (this.resolvePending(envelope)) {
      return;
    }
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

      const context = { envelope, node: this };
      let result;
      if (registration.mode === "schema") {
        const input = parseActionInput(registration.options, envelope.payload.data);
        result = await (registration.handler as SchemaActionHandler)({
          input,
          payload: { ...envelope.payload, data: input },
          context,
        });
      } else {
        result = await (registration.handler as ActionHandler)(envelope.payload, context);
      }

      if (isAsyncIterable(result)) {
        await this.sendStreamResult(envelope, registration, result, responseOpCode);
        return;
      }

      const responsePayload = parseActionOutput(registration.options, toPayload(result, envelope.payload.mime_type));
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
      if (error instanceof ZodError) {
        this.sendReject(envelope, "PAYLOAD_INVALID", formatZodError(error), { issues: error.issues });
        return;
      }
      this.sendReject(envelope, "ACTION_FAILED", error instanceof Error ? error.message : "action failed");
    }
  }

  private async sendStreamResult(
    request: Envelope,
    registration: ActionRegistration,
    result: AsyncIterable<unknown>,
    responseOpCode: "RESOLVE" | "EMIT",
  ): Promise<void> {
    for await (const item of result) {
      const responsePayload = parseActionOutput(registration.options, toPayload(item, request.payload.mime_type));
      if (!mimeMatches(responsePayload.mime_type, registration.options.returns)) {
        this.sendReject(request, "MIME_RETURN_MISMATCH", `action returned ${responsePayload.mime_type}`, {
          returns: registration.options.returns ?? null,
          actual: responsePayload.mime_type,
        });
        return;
      }
      this.sendEmitResult(request, responsePayload);
    }

    if (responseOpCode === "RESOLVE") {
      this.sendEndResult(request, { mime_type: request.payload.mime_type, data: null });
    }
  }

  private sendResolve(request: Envelope, payload: EnvelopePayload): void {
    this.trySendFrame({
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
    this.trySendFrame({
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

  private sendEndResult(request: Envelope, payload: EnvelopePayload): void {
    const target = request.header.reply_to ?? request.header.source;
    this.trySendFrame({
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
        spec: { op_code: "END", action: request.spec.action },
        payload,
      },
    });
  }

  private forwardTerminalStreamEnvelope(request: Envelope, opCode: "END"): void {
    this.trySendFrame({
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
    this.trySendFrame({
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
    pending.cleanup?.();
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
    pending.cleanup?.();
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
    const declarations = schemaTypeDeclarations(actions);
    const body = actions.length > 0
      ? actions.map(([action, registration]) => manifestActionLine(action, registration.options)).join("\n")
      : "  // no actions registered";

    return {
      mime_type: "text/typescript",
      data: `${declarations ? `${declarations}\n\n` : ""}interface ${interfaceName} {\n${body}\n}`,
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

  private trySendFrame(frame: ClientFrame): boolean {
    if (!this.transport) {
      return false;
    }

    try {
      this.sendFrame(frame);
      return true;
    } catch {
      return false;
    }
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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isRecord(value) && typeof value[Symbol.asyncIterator] === "function";
}

function parseActionInput(options: ActionOptions, data: unknown): unknown {
  return options.input ? options.input.parse(data) : data;
}

function parseActionOutput(options: ActionOptions, payload: EnvelopePayload): EnvelopePayload {
  return options.output ? { ...payload, data: options.output.parse(payload.data) } : payload;
}

function actionMetadataDecorator(metadata: Partial<DecoratedActionMetadata>): MethodDecorator {
  return ((...args: unknown[]) => {
    const target = decoratedMethodTarget(args);
    const current = ACTION_METADATA_BY_METHOD.get(target.method) ?? { name: target.name, options: {} };
    ACTION_METADATA_BY_METHOD.set(target.method, {
      name: metadata.name ?? current.name ?? target.name,
      options: { ...current.options, ...(metadata.options ?? {}) },
    });
  }) as MethodDecorator;
}

function decoratedMethodTarget(args: unknown[]): { method: Function; name: string } {
  if (typeof args[0] === "function" && isRecord(args[1]) && typeof args[1].name === "string") {
    return { method: args[0], name: args[1].name };
  }

  const name = typeof args[1] === "string" || typeof args[1] === "symbol" ? String(args[1]) : "action";
  const descriptor = args[2];
  if (isRecord(descriptor) && typeof descriptor.value === "function") {
    return { method: descriptor.value, name };
  }

  throw new Error("@Action can only decorate methods");
}

function registerPluginActions(node: IpcNode, instance: object): void {
  const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(prototype)) {
    if (key === "constructor") {
      continue;
    }

    const method = prototype[key];
    if (typeof method !== "function") {
      continue;
    }

    const metadata = ACTION_METADATA_BY_METHOD.get(method);
    if (!metadata) {
      continue;
    }

    const options = metadata.options.input ? metadata.options : { ...metadata.options, input: z.unknown() };
    node.action(metadata.name ?? key, options, async ({ input, context }) => {
      return await method.call(instance, input, context);
    });
  }
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "payload"}: ${issue.message}`)
    .join("; ") || "payload failed schema validation";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortedCallError(target: EndpointUri, action: string, signal: AbortSignal | undefined): IpcCallError {
  return new IpcCallError(`call aborted: ${target} action=${action}${abortReasonSuffix(signal)}`, { code: "CALL_ABORTED" });
}

function abortedPipelineError(route: EndpointUri[], signal: AbortSignal | undefined): IpcCallError {
  return new IpcCallError(`pipeline aborted: ${route.join(" -> ")}${abortReasonSuffix(signal)}`, { code: "PIPELINE_ABORTED" });
}

function abortReasonSuffix(signal: AbortSignal | undefined): string {
  if (!signal) {
    return "";
  }

  if (typeof signal.reason === "string" && signal.reason.length > 0) {
    return `: ${signal.reason}`;
  }

  if (signal.reason instanceof Error && signal.reason.message.length > 0) {
    return `: ${signal.reason.message}`;
  }

  return "";
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
  const inputType = options.input ? schemaTypeName(action, "input", options) : "unknown";
  const outputType = options.output ? schemaTypeName(action, "output", options) : "unknown";
  const docs = [
    options.doc ?? options.description,
    options.accepts ? `@accepts ${formatMimeSpec(options.accepts)}` : undefined,
    options.returns ? `@returns ${formatMimeSpec(options.returns)}` : undefined,
    ...(options.examples ?? []).map((example) => `@example ${stringifyCompact(example)}`),
  ].filter((line): line is string => Boolean(line));

  if (docs.length === 0) {
    return `  ${action}(payload: ${inputType}): ${outputType};`;
  }

  const comment = ["  /**", ...docs.flatMap((line) => line.split("\n")).map((line) => `   * ${line}`), "   */"].join("\n");
  return `${comment}\n  ${action}(payload: ${inputType}): ${outputType};`;
}

function schemaTypeDeclarations(actions: Array<[string, ActionRegistration]>): string {
  const declarations: string[] = [];
  const seen = new Set<string>();
  for (const [action, registration] of actions) {
    if (registration.options.input) {
      const name = schemaTypeName(action, "input", registration.options);
      if (!seen.has(name)) {
        seen.add(name);
        declarations.push(schemaToTsDeclaration(name, registration.options.input));
      }
    }
    if (registration.options.output) {
      const name = schemaTypeName(action, "output", registration.options);
      if (!seen.has(name)) {
        seen.add(name);
        declarations.push(schemaToTsDeclaration(name, registration.options.output));
      }
    }
  }
  return declarations.filter(Boolean).join("\n\n");
}

function schemaTypeName(action: string, kind: "input" | "output", options: ActionOptions): string {
  if (kind === "input" && options.input_name) {
    return options.input_name;
  }
  if (kind === "output" && options.output_name) {
    return options.output_name;
  }
  return `${capitalizeIdentifier(action)}${kind === "input" ? "Input" : "Output"}`;
}

function schemaToTsDeclaration(name: string, schema: ZodType): string {
  const jsonSchema = z.toJSONSchema(schema) as JsonSchema;
  const description = typeof jsonSchema.description === "string" ? tsDoc([jsonSchema.description]) : "";
  if (jsonSchema.type === "object" || isRecord(jsonSchema.properties)) {
    return `${description}${description ? "\n" : ""}export interface ${name} ${renderObjectType(jsonSchema, 0)}`;
  }
  return `${description}${description ? "\n" : ""}export type ${name} = ${renderJsonSchemaType(jsonSchema, 0)};`;
}

type JsonSchema = Record<string, unknown>;

function renderJsonSchemaType(schema: unknown, indent: number): string {
  if (!isRecord(schema)) {
    return "unknown";
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ") || "never";
  }
  if (Object.hasOwn(schema, "const")) {
    return JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((entry) => renderJsonSchemaType(entry, indent)).join(" | ");
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((entry) => renderJsonSchemaType(entry, indent)).join(" | ");
  }

  const type = Array.isArray(schema.type) ? schema.type.filter((item) => item !== "null")[0] : schema.type;
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${renderJsonSchemaType(schema.items, indent)}>`;
    case "object":
      if (!isRecord(schema.properties) && schema.additionalProperties === true) {
        return "Record<string, unknown>";
      }
      return renderObjectType(schema, indent);
    default:
      return "unknown";
  }
}

function renderObjectType(schema: JsonSchema, indent: number): string {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  const currentIndent = "  ".repeat(indent);
  const childIndent = "  ".repeat(indent + 1);
  const lines: string[] = ["{"];

  for (const [key, value] of Object.entries(properties)) {
    if (isRecord(value) && typeof value.description === "string") {
      lines.push(tsDoc([value.description], childIndent));
    }
    const optional = required.has(key) ? "" : "?";
    lines.push(`${childIndent}${propertyKey(key)}${optional}: ${renderJsonSchemaType(value, indent + 1)};`);
  }

  if (isRecord(schema.additionalProperties)) {
    lines.push(`${childIndent}[key: string]: ${renderJsonSchemaType(schema.additionalProperties, indent + 1)};`);
  } else if (schema.additionalProperties === true) {
    lines.push(`${childIndent}[key: string]: unknown;`);
  }

  lines.push(`${currentIndent}}`);
  return lines.join("\n");
}

function propertyKey(key: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function tsDoc(lines: string[], indent = ""): string {
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`), `${indent} */`].join("\n");
}

function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
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

function capitalizeIdentifier(value: string): string {
  const parts = value.split(/[^a-zA-Z0-9_$]+/).filter(Boolean);
  const joined = parts.length > 0 ? parts.map(capitalize).join("") : "Action";
  const safe = joined.replace(/[^a-zA-Z0-9_$]/g, "_");
  return /^[a-zA-Z_$]/.test(safe) ? safe : `Action_${safe}`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
