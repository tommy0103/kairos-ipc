import type { Envelope } from "../../protocol/src/index.ts";

export interface CapabilityDecision {
  allowed: boolean;
  code?: string;
  message?: string;
}

export interface CapabilityGate {
  evaluate(envelope: Envelope): CapabilityDecision;
}

export class AllowAllCapabilityGate implements CapabilityGate {
  evaluate(_envelope: Envelope): CapabilityDecision {
    return { allowed: true };
  }
}
