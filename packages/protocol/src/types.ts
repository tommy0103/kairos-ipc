export const OP_CODES = [
  "CALL",
  "RESOLVE",
  "REJECT",
  "EMIT",
  "END",
  "CANCEL",
] as const;

export type OpCode = (typeof OP_CODES)[number];

export type EndpointUri = string;

export type JsonObject = Record<string, unknown>;

export interface EnvelopeHeader {
  msg_id: string;
  correlation_id?: string;
  source: EndpointUri;
  target: EndpointUri;
  reply_to?: EndpointUri | null;
  routing_slip?: EndpointUri[] | null;
  ttl_ms: number;
}

export interface EnvelopeSpec {
  op_code: OpCode;
  action?: string;
}

export interface EnvelopePayload<TData = unknown> {
  mime_type: string;
  data: TData;
}

export interface Envelope<TData = unknown> {
  header: EnvelopeHeader;
  spec: EnvelopeSpec;
  payload: EnvelopePayload<TData>;
}

export interface RegisterFrame {
  type: "register";
  uri: EndpointUri;
}

export interface EnvelopeFrame {
  type: "envelope";
  envelope: Envelope;
}

export interface RegisteredFrame {
  type: "registered";
  uri: EndpointUri;
}

export interface ErrorFrame {
  type: "error";
  error: {
    code: string;
    message: string;
    detail?: unknown;
  };
}

export type ClientFrame = RegisterFrame | EnvelopeFrame;
export type KernelFrame = RegisteredFrame | EnvelopeFrame | ErrorFrame;

export interface RejectData {
  error: {
    code: string;
    message: string;
    detail?: unknown;
  };
}
