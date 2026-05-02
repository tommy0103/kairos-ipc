import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Envelope } from "../../protocol/src/index.ts";
const STDOUT_TRACE_PATH = "-";

export interface TraceRoute {
  result: "delivered" | "rejected" | "dropped" | "registered" | "unregistered";
  reason?: string;
}

export interface TraceWriterOptions {
  capture_payload?: boolean;
}

export class TraceWriter {
  private readonly tracePath: string;
  private readonly capturePayload: boolean;

  constructor(tracePath: string, options: TraceWriterOptions = {}) {
    this.tracePath = tracePath;
    this.capturePayload = options.capture_payload ?? false;
    if (tracePath !== STDOUT_TRACE_PATH) {
      mkdirSync(dirname(tracePath), { recursive: true });
    }
  }

  recordEnvelope(envelope: Envelope, route: TraceRoute): void {
    const payloadMeta = hashPayload(envelope.payload.data);
    this.write({
      timestamp: new Date().toISOString(),
      event: "envelope",
      msg_id: envelope.header.msg_id,
      correlation_id: envelope.header.correlation_id ?? null,
      source: envelope.header.source,
      target: envelope.header.target,
      reply_to: envelope.header.reply_to ?? null,
      op_code: envelope.spec.op_code,
      action: envelope.spec.action ?? null,
      mime_type: envelope.payload.mime_type,
      ttl_ms: envelope.header.ttl_ms,
      route_result: route.result,
      error_reason: route.reason ?? null,
      payload_hash: payloadMeta.hash,
      payload_size: payloadMeta.size,
      ...deriveEnvelopeMetadata(envelope),
      ...(this.capturePayload ? { payload: envelope.payload.data } : {}),
    });
  }

  recordEvent(event: Record<string, unknown>): void {
    this.write({ timestamp: new Date().toISOString(), ...event });
  }

  private write(event: Record<string, unknown>): void {
    const line = `${JSON.stringify(event)}\n`;
    if (this.tracePath === STDOUT_TRACE_PATH) {
      console.log(line.trimEnd());
      return;
    }
    appendFileSync(this.tracePath, line, "utf8");
  }
}

function hashPayload(payload: unknown): { hash: string; size: number } {
  const serialized = JSON.stringify(payload) ?? "null";
  return {
    hash: createHash("sha256").update(serialized).digest("hex"),
    size: Buffer.byteLength(serialized, "utf8"),
  };
}

function deriveEnvelopeMetadata(envelope: Envelope): Record<string, unknown> {
  const data = envelope.payload.data;
  const metadata: Record<string, unknown> = {};

  if (envelope.payload.mime_type === "application/vnd.slock.message+json") {
    Object.assign(metadata, deriveMessageMetadata(data, envelope));
  }
  if (envelope.payload.mime_type === "application/vnd.slock.channel-event+json") {
    Object.assign(metadata, deriveChannelEventMetadata(data));
  }
  if (envelope.payload.mime_type === "application/vnd.slock.agent-run+json") {
    Object.assign(metadata, deriveAgentRunMetadata(data));
  }
  if (envelope.payload.mime_type === "application/vnd.slock.agent-result+json") {
    Object.assign(metadata, deriveAgentResultMetadata(data));
  }
  if (envelope.payload.mime_type === "application/vnd.slock.message-delta+json") {
    Object.assign(metadata, deriveMessageDeltaMetadata(data));
  }
  if (envelope.payload.mime_type === "application/vnd.slock.approval-request+json") {
    Object.assign(metadata, deriveApprovalRequestMetadata(data));
  }
  if (envelope.payload.mime_type === "application/vnd.slock.approval-result+json") {
    Object.assign(metadata, deriveApprovalResultMetadata(data));
  }
  if (envelope.payload.mime_type === "application/vnd.slock.shell-exec+json") {
    Object.assign(metadata, deriveShellExecMetadata(data));
  }
  if (envelope.payload.mime_type === "application/vnd.slock.shell-result+json") {
    Object.assign(metadata, deriveShellResultMetadata(data));
  }

  return metadata;
}

function deriveMessageMetadata(data: unknown, envelope: Envelope): Record<string, unknown> {
  if (!isRecord(data)) {
    return { payload_kind: "slock_message" };
  }

  const metadata: Record<string, unknown> = {
    payload_kind: typeof data.id === "string" ? "slock_message" : "slock_message_input",
    channel: typeof data.channel === "string" ? data.channel : channelUriFromEnvelope(envelope),
    message_id: stringValue(data.id),
    thread_id: nullableStringValue(data.thread_id),
    reply_to_id: nullableStringValue(data.reply_to_id),
    message_sender: stringValue(data.sender),
    message_kind: stringValue(data.kind),
  };
  const mentions = stringArrayValue(data.mentions);
  if (mentions) {
    metadata.mentions = mentions;
    metadata.mention_count = mentions.length;
  }
  return compact(metadata);
}

function deriveChannelEventMetadata(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    return { payload_kind: "slock_channel_event" };
  }

  const metadata: Record<string, unknown> = {
    payload_kind: "slock_channel_event",
    channel_event_type: stringValue(data.type),
    channel: stringValue(data.channel),
  };

  if (isRecord(data.message)) {
    Object.assign(metadata, prefixMetadata("event_message", deriveMessageMetadata(data.message, emptyEnvelope())));
    metadata.message_id = stringValue(data.message.id);
    metadata.thread_id = nullableStringValue(data.message.thread_id);
    metadata.reply_to_id = nullableStringValue(data.message.reply_to_id);
    metadata.message_sender = stringValue(data.message.sender);
    metadata.message_kind = stringValue(data.message.kind);
  }
  if (isRecord(data.delta)) {
    metadata.thread_id = stringValue(data.delta.thread_id);
    metadata.delta_source = stringValue(data.delta.source);
    metadata.delta_kind = stringValue(data.delta.kind);
  }
  if (isRecord(data.approval)) {
    Object.assign(metadata, withoutPayloadKind(deriveApprovalEventMetadata(data.approval)));
  }
  if (isRecord(data.result)) {
    metadata.approval_id = stringValue(data.id);
    Object.assign(metadata, withoutPayloadKind(deriveApprovalResultMetadata(data.result)));
  }
  if (isRecord(data.cancelled)) {
    metadata.message_id = stringValue(data.cancelled.message_id);
    metadata.agent = stringValue(data.cancelled.agent);
    metadata.cancel_reason = stringValue(data.cancelled.reason);
  }
  if (isRecord(data.error)) {
    metadata.error_code = stringValue(data.error.code);
    metadata.error_source = stringValue(data.error.source);
  }
  if (isRecord(data.typing)) {
    metadata.typing_source = stringValue(data.typing.source);
    metadata.thread_id = nullableStringValue(data.typing.thread_id);
  }
  if (isRecord(data.subscription)) {
    metadata.subscriber = stringValue(data.subscription.subscriber);
  }

  return compact(metadata);
}

function deriveAgentRunMetadata(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    return { payload_kind: "slock_agent_run" };
  }
  return compact({
    payload_kind: "slock_agent_run",
    channel: stringValue(data.channel),
    message_id: stringValue(data.message_id),
    thread_id: nullableStringValue(data.thread_id),
    message_sender: stringValue(data.sender),
  });
}

function deriveAgentResultMetadata(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    return { payload_kind: "slock_agent_result" };
  }
  return compact({
    payload_kind: "slock_agent_result",
    final_message_id: stringValue(data.final_message_id),
    cancelled: booleanValue(data.cancelled),
    cancel_reason: stringValue(data.reason),
  });
}

function deriveMessageDeltaMetadata(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    return { payload_kind: "slock_message_delta" };
  }
  return compact({
    payload_kind: "slock_message_delta",
    thread_id: stringValue(data.thread_id),
    delta_kind: stringValue(data.kind),
  });
}

function deriveApprovalEventMetadata(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    return { payload_kind: "slock_approval_event" };
  }
  const requestMetadata = withoutPayloadKind(deriveApprovalRequestMetadata(data.request));
  return compact({
    ...requestMetadata,
    approval_id: stringValue(data.id),
    approval_source: stringValue(data.source),
    payload_kind: "slock_approval_event",
  });
}

function deriveApprovalRequestMetadata(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    return { payload_kind: "slock_approval_request" };
  }
  const proposedCall = isRecord(data.proposed_call) ? data.proposed_call : {};
  const requestMetadata = isRecord(data.metadata) ? data.metadata : {};
  return compact({
    payload_kind: "slock_approval_request",
    approval_id: stringValue(data.id),
    approval_risk: stringValue(data.risk),
    approval_target: stringValue(proposedCall.target),
    approval_action: stringValue(proposedCall.action),
    channel: stringValue(requestMetadata.channel),
    thread_id: nullableStringValue(requestMetadata.thread_id),
    tool_call_id: stringValue(requestMetadata.tool_call_id),
    tool_name: stringValue(requestMetadata.tool_name),
  });
}

function deriveApprovalResultMetadata(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    return { payload_kind: "slock_approval_result" };
  }
  const grant = isRecord(data.grant) ? data.grant : {};
  return compact({
    payload_kind: "slock_approval_result",
    approval_decision: booleanValue(data.approved),
    grant_id: stringValue(grant.id),
    grant_target: stringValue(grant.target),
    grant_actions: stringArrayValue(grant.actions),
    grant_expires_at: stringValue(grant.expires_at),
    approval_id: stringValue(grant.approval_id),
    approval_risk: stringValue(grant.risk),
  });
}

function deriveShellExecMetadata(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    return { payload_kind: "slock_shell_exec" };
  }
  return compact({
    payload_kind: "slock_shell_exec",
    shell_command: stringValue(data.command),
    shell_args: stringArrayValue(data.args),
    grant_id: isRecord(data.approval_grant) ? stringValue(data.approval_grant.id) : undefined,
  });
}

function deriveShellResultMetadata(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    return { payload_kind: "slock_shell_result" };
  }
  return compact({
    payload_kind: "slock_shell_result",
    shell_command: stringValue(data.command),
    shell_exit_code: numberValue(data.exit_code),
  });
}

function channelUriFromEnvelope(envelope: Envelope): string | undefined {
  if (envelope.header.target.startsWith("app://slock/channel/") || envelope.header.target.startsWith("app://slock/dm/")) {
    return envelope.header.target;
  }
  if (envelope.header.source.startsWith("app://slock/channel/") || envelope.header.source.startsWith("app://slock/dm/")) {
    return envelope.header.source;
  }
  return undefined;
}

function prefixMetadata(prefix: string, metadata: Record<string, unknown>): Record<string, unknown> {
  const prefixed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    prefixed[`${prefix}_${key}`] = value;
  }
  return prefixed;
}

function withoutPayloadKind(metadata: Record<string, unknown>): Record<string, unknown> {
  const { payload_kind: _payloadKind, ...rest } = metadata;
  return rest;
}

function compact(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableStringValue(value: unknown): string | null | undefined {
  return typeof value === "string" ? value : value === null ? null : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyEnvelope(): Envelope {
  return {
    header: {
      msg_id: "",
      source: "",
      target: "",
      ttl_ms: 0,
    },
    spec: { op_code: "CALL" },
    payload: { mime_type: "application/json", data: null },
  };
}
