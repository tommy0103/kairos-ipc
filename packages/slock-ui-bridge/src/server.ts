import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import type { EndpointUri } from "../../protocol/src/index.ts";
import { createNode, type IpcNode } from "../../sdk/src/index.ts";
import type { ApprovalResolution, PendingApproval, SlockHumanEndpoint } from "../../slock-human/src/index.ts";
import {
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_MIME,
  type SlockApprovalEvent,
  type SlockApprovalResult,
  type SlockChannelEvent,
  type SlockMessage,
} from "../../slock-channel/src/index.ts";

const DEFAULT_ASSET_ROOT = fileURLToPath(new URL("../dist/", import.meta.url));

export interface SlockUiBridgeChannel {
  uri: EndpointUri;
  label?: string;
  kind?: "channel" | "dm";
}

export interface SlockUiBridgeOptions {
  channel_uri?: EndpointUri;
  channels?: SlockUiBridgeChannel[];
  human_node: IpcNode;
  human_endpoint?: SlockHumanEndpoint;
  uri?: string;
  history_limit?: number;
  asset_root?: string;
}

export interface ListenOptions {
  host?: string;
  port: number;
}

export interface SlockUiBridge {
  node: IpcNode;
  listen(options: ListenOptions): Promise<{ url: string }>;
  close(): Promise<void>;
}

interface SseClient {
  write(frame: string): void;
  close(): void;
}

export function createSlockUiBridge(options: SlockUiBridgeOptions): SlockUiBridge {
  const node = createNode(options.uri ?? "app://slock/ui-bridge");
  const human = options.human_node;
  const humanEndpoint = options.human_endpoint;
  const channels = normalizeChannels(options);
  const defaultChannelUri = channels[0].uri;
  const channelUris = new Set(channels.map((channel) => channel.uri));
  const historyLimit = options.history_limit ?? 50;
  const assetRoot = resolve(options.asset_root ?? DEFAULT_ASSET_ROOT);
  const clients = new Set<SseClient>();
  const approvalChannels = new Map<string, EndpointUri>();
  let server: Bun.Server | undefined;

  node.action(
    "status",
    {
      description: "Return UI bridge status.",
      accepts: "application/json",
      returns: "application/json",
    },
    async () => ({
      mime_type: "application/json",
      data: { ok: true, channel: defaultChannelUri, default_channel: defaultChannelUri, channels, clients: clients.size },
    }),
  );

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      broadcast(payload.data as SlockChannelEvent);
    }
  });

  human.onEnd("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      broadcast(payload.data as SlockChannelEvent);
    }
  });

  humanEndpoint?.onApprovalRequest((approval) => {
    const channelUri = channelForApproval(approval);
    approvalChannels.set(approval.id, channelUri);
    publishApprovalRequested(channelUri, approval);
  });

  humanEndpoint?.onApprovalResolved((resolution) => {
    const channelUri = approvalChannels.get(resolution.id) ?? defaultChannelUri;
    approvalChannels.delete(resolution.id);
    publishApprovalResolved(channelUri, resolution);
  });

  return { node, listen, close };

  async function listen(options: ListenOptions): Promise<{ url: string }> {
    if (server) {
      throw new Error("Slock UI bridge is already listening");
    }

    const hostname = options.host ?? "127.0.0.1";
    server = Bun.serve({
      hostname,
      port: options.port,
      idleTimeout: 0,
      fetch: (request) => handleRequest(request),
    });

    return { url: `http://${hostname}:${server.port}` };
  }

  async function close(): Promise<void> {
    for (const client of clients) {
      client.close();
    }
    clients.clear();

    const closing = server;
    server = undefined;
    if (closing) {
      closing.stop(true);
    }

    await node.close();
  }

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/events") {
        return openEventStream();
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        return jsonResponse(200, { ok: true, channel: defaultChannelUri, default_channel: defaultChannelUri, channels, clients: clients.size });
      }

      if (request.method === "GET" && url.pathname === "/api/channels") {
        return jsonResponse(200, { channels, default_channel: defaultChannelUri });
      }

      if (request.method === "GET" && url.pathname === "/api/history") {
        const channelUri = readChannelUri(url);
        const history = await human.call<{ limit: number }, { messages: SlockMessage[] }>(channelUri, "history", {
          mime_type: "application/json",
          data: { limit: historyLimit },
        });
        return jsonResponse(200, history.data);
      }

      if (request.method === "GET" && url.pathname === "/api/approvals") {
        return jsonResponse(200, {
          approvals: [...(humanEndpoint?.pendingApprovals.values() ?? [])].map((approval) => ({
            ...approval,
            channel: channelForApproval(approval),
          })),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/messages") {
        const body = await readJsonBody(request);
        const channelUri = readChannelUri(url, body);
        const text = readText(body);
        const result = await human.call(channelUri, "post_message", {
          mime_type: SLOCK_MESSAGE_MIME,
          data: {
            text,
            mentions: readExplicitMentions(body),
            thread_id: readThreadId(body),
            reply_to_id: readReplyToId(body),
          },
        });
        return jsonResponse(200, result.data);
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/cancel")) {
        const messageId = decodeURIComponent(url.pathname.slice("/api/runs/".length, -"/cancel".length));
        const body = await readJsonBody(request);
        const channelUri = readChannelUri(url, body);
        const result = await human.call(channelUri, "cancel_agent_run", {
          mime_type: "application/json",
          data: { message_id: messageId, reason: readReason(body) ?? "user cancelled" },
        });
        return jsonResponse(200, result.data);
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/approvals/")) {
        if (!humanEndpoint) {
          return jsonResponse(404, { error: "approval endpoint is not configured" });
        }

        const id = decodeURIComponent(url.pathname.slice("/api/approvals/".length));
        const body = await readJsonBody(request);
        const result = readApprovalResult(body);
        humanEndpoint.decide(id, result);
        return jsonResponse(200, { id, ...result });
      }

      if (url.pathname.startsWith("/api/")) {
        return jsonResponse(404, { error: "not_found" });
      }

      if (request.method === "GET" || request.method === "HEAD") {
        return await serveStaticAsset(url.pathname, request.method === "HEAD");
      }

      return jsonResponse(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(error.status, { error: error.message });
      }
      const message = error instanceof Error ? error.message : "request failed";
      return jsonResponse(500, { error: message });
    }
  }

  function openEventStream(): Response {
    let client: SseClient | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        client = {
          write(frame) {
            try {
              controller.enqueue(new TextEncoder().encode(frame));
            } catch (_error) {
              if (client) clients.delete(client);
            }
          },
          close() {
            try {
              controller.close();
            } catch (_error) {
              // The browser may already have closed the stream.
            }
            if (client) clients.delete(client);
          },
        };
        clients.add(client);
        client.write(`data: ${JSON.stringify({ type: "bridge_connected", channel: defaultChannelUri, channels })}\n\n`);
      },
      cancel() {
        if (client) clients.delete(client);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  function broadcast(event: SlockChannelEvent | Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      client.write(frame);
    }
  }

  function publishApprovalRequested(channelUri: EndpointUri, approval: PendingApproval): void {
    const event: SlockApprovalEvent = approval;
    void human.call(channelUri, "publish_approval_requested", {
      mime_type: "application/json",
      data: event,
    }).catch((error) => {
      broadcastPublishError(channelUri, "APPROVAL_REQUEST_PUBLISH_FAILED", error);
    });
  }

  function publishApprovalResolved(channelUri: EndpointUri, resolution: ApprovalResolution): void {
    void human.call(channelUri, "publish_approval_resolved", {
      mime_type: "application/json",
      data: { id: resolution.id, result: resolution.result },
    }).catch((error) => {
      broadcastPublishError(channelUri, "APPROVAL_RESOLUTION_PUBLISH_FAILED", error);
    });
  }

  function broadcastPublishError(channelUri: EndpointUri, code: string, error: unknown): void {
    broadcast({
      type: "agent_error",
      channel: channelUri,
      error: {
        code,
        message: error instanceof Error ? error.message : "failed to publish channel event",
        source: node.uri,
      },
    });
  }

  function readChannelUri(url: URL, body?: unknown): EndpointUri {
    const requested = url.searchParams.get("channel") ?? (isRecord(body) && typeof body.channel === "string" ? body.channel : undefined);
    const channelUri = requested && requested.trim().length > 0 ? requested.trim() : defaultChannelUri;
    if (!channelUris.has(channelUri)) {
      throw new HttpError(400, `unknown channel: ${channelUri}`);
    }
    return channelUri;
  }

  function channelForApproval(approval: PendingApproval): EndpointUri {
    const metadata = approval.request.metadata;
    const channel = isRecord(metadata) && typeof metadata.channel === "string" ? metadata.channel : undefined;
    return channel && channelUris.has(channel) ? channel : defaultChannelUri;
  }

  async function serveStaticAsset(pathname: string, head = false): Promise<Response> {
    const candidates = assetCandidates(pathname);
    let sawMissingIndex = false;

    for (const candidate of candidates) {
      try {
        const filePath = resolveAssetPath(assetRoot, candidate);
        const body = await readFile(filePath);
        return binaryResponse(200, contentTypeFor(filePath), body, head);
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        if (!isMissingFileError(error)) {
          throw error;
        }
        sawMissingIndex ||= candidate === "index.html";
      }
    }

    if (sawMissingIndex) {
      return textResponse(500, "text/html; charset=utf-8", missingUiBuildHtml());
    }

    return jsonResponse(404, { error: "asset_not_found" });
  }
}

function assetCandidates(pathname: string): string[] {
  const decoded = safeDecodePath(pathname);
  if (decoded === "/") {
    return ["index.html"];
  }

  const candidate = decoded.replace(/^\/+/, "");
  return extname(decoded) ? [candidate] : [candidate, "index.html"];
}

function resolveAssetPath(root: string, candidate: string): string {
  const filePath = resolve(root, candidate);
  const pathFromRoot = relative(root, filePath);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new HttpError(400, "invalid asset path");
  }
  return filePath;
}

function safeDecodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch (_error) {
    throw new HttpError(400, "invalid asset path");
  }
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".map":
      return "application/json; charset=utf-8";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR");
}

function missingUiBuildHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Slock IPC</title></head>
  <body style="font: 14px/1.45 system-ui, sans-serif; padding: 24px;">
    <h1>Slock UI build is missing</h1>
    <p>Run <code>bun run build:slock-ui</code> before starting the web bridge.</p>
  </body>
</html>`;
}

function normalizeChannels(options: SlockUiBridgeOptions): SlockUiBridgeChannel[] {
  const configured = options.channels && options.channels.length > 0
    ? options.channels
    : [{ uri: options.channel_uri ?? "app://slock/channel/general" }];
  const seen = new Set<EndpointUri>();

  return configured.map((channel) => {
    if (!channel.uri) {
      throw new Error("Slock UI bridge channel is missing uri");
    }
    if (seen.has(channel.uri)) {
      throw new Error(`duplicate Slock UI bridge channel URI: ${channel.uri}`);
    }
    seen.add(channel.uri);
    return {
      uri: channel.uri,
      label: channel.label ?? labelFromUri(channel.uri),
      kind: channel.kind ?? kindFromUri(channel.uri),
    };
  });
}

function labelFromUri(uri: EndpointUri): string {
  const parts = uri.split("/").filter(Boolean);
  return decodeURIComponent(parts.at(-1) ?? uri);
}

function kindFromUri(uri: EndpointUri): "channel" | "dm" {
  return uri.startsWith("app://slock/dm/") ? "dm" : "channel";
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function textResponse(status: number, contentType: string, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

function binaryResponse(status: number, contentType: string, body: Uint8Array, head = false): Response {
  return new Response(head ? null : body, {
    status,
    headers: { "content-type": contentType },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) {
    return {};
  }

  return JSON.parse(text);
}

function readText(value: unknown): string {
  if (!isRecord(value) || typeof value.text !== "string" || value.text.trim().length === 0) {
    throw new Error("message text is required");
  }
  return value.text.trim();
}

function readExplicitMentions(value: unknown): string[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.mentions)) {
    return undefined;
  }
  return value.mentions.filter((mention): mention is string => typeof mention === "string");
}

function readThreadId(value: unknown): string | null {
  if (!isRecord(value) || typeof value.thread_id !== "string" || value.thread_id.trim().length === 0) {
    return null;
  }
  return value.thread_id;
}

function readReplyToId(value: unknown): string | null {
  if (!isRecord(value) || typeof value.reply_to_id !== "string" || value.reply_to_id.trim().length === 0) {
    return null;
  }
  return value.reply_to_id;
}

function readReason(value: unknown): string | undefined {
  return isRecord(value) && typeof value.reason === "string" ? value.reason : undefined;
}

function readApprovalResult(value: unknown): SlockApprovalResult {
  if (!isRecord(value) || typeof value.approved !== "boolean") {
    throw new Error("approval result requires boolean approved");
  }

  return {
    approved: value.approved,
    grant_ttl_ms: typeof value.grant_ttl_ms === "number" ? value.grant_ttl_ms : 60000,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
