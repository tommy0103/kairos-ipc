import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Envelope } from "../../protocol/src/index.ts";
const STDOUT_TRACE_PATH = "-";

export interface TraceRoute {
  result: "delivered" | "rejected" | "dropped" | "registered" | "unregistered";
  reason?: string;
}

export class TraceWriter {
  private readonly tracePath: string;

  constructor(tracePath: string) {
    this.tracePath = tracePath;
    if (tracePath !== STDOUT_TRACE_PATH) {
      mkdirSync(dirname(tracePath), { recursive: true });
    }
  }

  recordEnvelope(envelope: Envelope, route: TraceRoute): void {
    const payloadMeta = hashPayload(envelope.payload.data);
    this.write({
      timestamp: new Date().toISOString(),
      msg_id: envelope.header.msg_id,
      correlation_id: envelope.header.correlation_id ?? null,
      source: envelope.header.source,
      target: envelope.header.target,
      op_code: envelope.spec.op_code,
      action: envelope.spec.action ?? null,
      mime_type: envelope.payload.mime_type,
      ttl_ms: envelope.header.ttl_ms,
      route_result: route.result,
      error_reason: route.reason ?? null,
      payload_hash: payloadMeta.hash,
      payload_size: payloadMeta.size,
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
