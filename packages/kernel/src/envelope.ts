import {
  createMsgId,
  isEndpointUri,
  type Envelope,
  type RejectData,
} from "../../protocol/src/index.ts";

export interface RejectOptions {
  original?: unknown;
  target?: string;
  code: string;
  message: string;
  detail?: unknown;
  kernelUri?: string;
}

export function createRejectEnvelope(options: RejectOptions): Envelope<RejectData> | null {
  const target = options.target ?? inferReturnTarget(options.original);
  if (!target) {
    return null;
  }

  const original = asLooseEnvelope(options.original);
  const spec = asLooseSpec(original?.spec);
  const header = asLooseHeader(original?.header);

  return {
    header: {
      msg_id: createMsgId("rej"),
      correlation_id: typeof header?.correlation_id === "string" ? header.correlation_id : undefined,
      source: options.kernelUri ?? "kernel://local",
      target,
      ttl_ms: 30000,
    },
    spec: {
      op_code: "REJECT",
      action: typeof spec?.action === "string" ? spec.action : undefined,
    },
    payload: {
      mime_type: "application/json",
      data: {
        error: {
          code: options.code,
          message: options.message,
          detail: options.detail,
        },
      },
    },
  };
}

export function inferReturnTarget(original: unknown): string | null {
  const header = asLooseHeader(asLooseEnvelope(original)?.header);
  if (!header) {
    return null;
  }

  if (isEndpointUri(header.reply_to)) {
    return header.reply_to;
  }

  if (isEndpointUri(header.source)) {
    return header.source;
  }

  return null;
}

function asLooseEnvelope(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asLooseHeader(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asLooseSpec(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
