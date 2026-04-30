import {
  assertEnvelope,
  formatValidationIssues,
  validateEnvelope,
  type Envelope,
} from "../../protocol/src/index.ts";
import type { CapabilityGate } from "./capability.ts";
import { createRejectEnvelope } from "./envelope.ts";
import type { Connection, EndpointRegistry } from "./registry.ts";
import type { TraceWriter } from "./trace.ts";

export interface RouterOptions {
  registry: EndpointRegistry;
  capabilityGate: CapabilityGate;
  trace: TraceWriter;
  kernelUri?: string;
}

export class Router {
  private readonly registry: EndpointRegistry;
  private readonly capabilityGate: CapabilityGate;
  private readonly trace: TraceWriter;
  private readonly kernelUri: string;

  constructor(options: RouterOptions) {
    this.registry = options.registry;
    this.capabilityGate = options.capabilityGate;
    this.trace = options.trace;
    this.kernelUri = options.kernelUri ?? "kernel://local";
  }

  route(value: unknown, inbound?: Connection): void {
    const validation = validateEnvelope(value);
    if (!validation.ok) {
      this.reject(value, "INVALID_ENVELOPE", formatValidationIssues(validation.issues), inbound);
      return;
    }

    assertEnvelope(value);
    const envelope = value;

    if (inbound && !this.registry.isOwnedBy(envelope.header.source, inbound)) {
      this.trace.recordEnvelope(envelope, { result: "rejected", reason: "SOURCE_NOT_REGISTERED" });
      inbound.send({
        type: "error",
        error: {
          code: "SOURCE_NOT_REGISTERED",
          message: `connection is not registered as ${envelope.header.source}`,
        },
      });
      return;
    }

    if (envelope.header.ttl_ms <= 0) {
      this.trace.recordEnvelope(envelope, { result: "rejected", reason: "TTL_EXPIRED" });
      this.reject(envelope, "TTL_EXPIRED", "message ttl_ms has expired", inbound);
      return;
    }

    const capability = this.capabilityGate.evaluate(envelope);
    if (!capability.allowed) {
      this.trace.recordEnvelope(envelope, { result: "rejected", reason: capability.code ?? "CAPABILITY_DENIED" });
      this.reject(
        envelope,
        capability.code ?? "CAPABILITY_DENIED",
        capability.message ?? "source is not allowed to send this envelope",
        inbound,
      );
      return;
    }

    const target = this.registry.get(envelope.header.target);
    if (!target) {
      this.trace.recordEnvelope(envelope, { result: "rejected", reason: "TARGET_NOT_FOUND" });
      this.reject(envelope, "TARGET_NOT_FOUND", `target is not registered: ${envelope.header.target}`, inbound);
      return;
    }

    target.send({ type: "envelope", envelope });
    this.trace.recordEnvelope(envelope, { result: "delivered" });
  }

  private reject(original: unknown, code: string, message: string, inbound?: Connection): void {
    const reject = createRejectEnvelope({ original, code, message, kernelUri: this.kernelUri });
    if (!reject) {
      inbound?.send({ type: "error", error: { code, message } });
      return;
    }

    const target = this.registry.get(reject.header.target);
    if (!target) {
      inbound?.send({ type: "error", error: { code, message } });
      this.trace.recordEnvelope(reject, { result: "dropped", reason: "REJECT_TARGET_NOT_FOUND" });
      return;
    }

    target.send({ type: "envelope", envelope: reject as Envelope });
    this.trace.recordEnvelope(reject as Envelope, { result: "delivered" });
  }
}
