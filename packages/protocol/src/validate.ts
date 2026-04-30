import { OP_CODES, type Envelope, type OpCode } from "./types.ts";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

const URI_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const OP_CODE_SET = new Set<string>(OP_CODES);

export function isEndpointUri(value: unknown): value is string {
  return typeof value === "string" && URI_PATTERN.test(value);
}

export function isOpCode(value: unknown): value is OpCode {
  return typeof value === "string" && OP_CODE_SET.has(value);
}

export function validateEnvelope(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isRecord(value)) {
    return fail("$", "envelope must be an object");
  }

  const header = value.header;
  const spec = value.spec;
  const payload = value.payload;

  if (!isRecord(header)) {
    issues.push({ path: "$.header", message: "header must be an object" });
  } else {
    validateHeader(header, issues);
  }

  if (!isRecord(spec)) {
    issues.push({ path: "$.spec", message: "spec must be an object" });
  } else {
    validateSpec(spec, issues);
  }

  if (!isRecord(payload)) {
    issues.push({ path: "$.payload", message: "payload must be an object" });
  } else {
    validatePayload(payload, issues);
  }

  return { ok: issues.length === 0, issues };
}

export function assertEnvelope(value: unknown): asserts value is Envelope {
  const result = validateEnvelope(value);
  if (!result.ok) {
    throw new Error(formatValidationIssues(result.issues));
  }
}

export function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

function validateHeader(header: Record<string, unknown>, issues: ValidationIssue[]): void {
  if (!isNonEmptyString(header.msg_id)) {
    issues.push({ path: "$.header.msg_id", message: "msg_id must be a non-empty string" });
  }

  if (header.correlation_id !== undefined && !isNonEmptyString(header.correlation_id)) {
    issues.push({ path: "$.header.correlation_id", message: "correlation_id must be a non-empty string" });
  }

  if (!isEndpointUri(header.source)) {
    issues.push({ path: "$.header.source", message: "source must be an endpoint URI" });
  }

  if (!isEndpointUri(header.target)) {
    issues.push({ path: "$.header.target", message: "target must be an endpoint URI" });
  }

  if (header.reply_to !== undefined && header.reply_to !== null && !isEndpointUri(header.reply_to)) {
    issues.push({ path: "$.header.reply_to", message: "reply_to must be an endpoint URI or null" });
  }

  if (header.routing_slip !== undefined && header.routing_slip !== null) {
    if (!Array.isArray(header.routing_slip)) {
      issues.push({ path: "$.header.routing_slip", message: "routing_slip must be an array or null" });
    } else {
      header.routing_slip.forEach((uri, index) => {
        if (!isEndpointUri(uri)) {
          issues.push({ path: `$.header.routing_slip[${index}]`, message: "entry must be an endpoint URI" });
        }
      });
    }
  }

  if (!Number.isInteger(header.ttl_ms) || typeof header.ttl_ms !== "number") {
    issues.push({ path: "$.header.ttl_ms", message: "ttl_ms must be an integer" });
  } else if (header.ttl_ms < 0) {
    issues.push({ path: "$.header.ttl_ms", message: "ttl_ms must be zero or greater" });
  }
}

function validateSpec(spec: Record<string, unknown>, issues: ValidationIssue[]): void {
  if (!isOpCode(spec.op_code)) {
    issues.push({ path: "$.spec.op_code", message: `op_code must be one of ${OP_CODES.join(", ")}` });
  }

  if (spec.action !== undefined && !isNonEmptyString(spec.action)) {
    issues.push({ path: "$.spec.action", message: "action must be a non-empty string when present" });
  }

  if (spec.op_code === "CALL" && !isNonEmptyString(spec.action)) {
    issues.push({ path: "$.spec.action", message: "action is required for CALL" });
  }
}

function validatePayload(payload: Record<string, unknown>, issues: ValidationIssue[]): void {
  if (!isNonEmptyString(payload.mime_type)) {
    issues.push({ path: "$.payload.mime_type", message: "mime_type must be a non-empty string" });
  }

  if (!Object.hasOwn(payload, "data")) {
    issues.push({ path: "$.payload.data", message: "data is required" });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(path: string, message: string): ValidationResult {
  return { ok: false, issues: [{ path, message }] };
}
