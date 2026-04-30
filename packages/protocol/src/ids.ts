import { randomBytes } from "node:crypto";

export function createMsgId(prefix = "msg"): string {
  const timestamp = Date.now().toString(36);
  const entropy = randomBytes(8).toString("hex");
  return `${prefix}_${timestamp}_${entropy}`;
}

export function createCorrelationId(prefix = "corr"): string {
  return createMsgId(prefix);
}
