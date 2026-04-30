import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
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
import { renderCss, renderHtml, renderJs } from "./assets.ts";

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

export function createSlockUiBridge(options: SlockUiBridgeOptions): SlockUiBridge {
  const node = createNode(options.uri ?? "app://slock/ui-bridge");
  const human = options.human_node;
  const humanEndpoint = options.human_endpoint;
  const channels = normalizeChannels(options);
  const defaultChannelUri = channels[0].uri;
  const channelUris = new Set(channels.map((channel) => channel.uri));
  const historyLimit = options.history_limit ?? 50;
  const clients = new Set<ServerResponse>();
  const approvalChannels = new Map<string, EndpointUri>();
  let server: http.Server | undefined;

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

    server = http.createServer((request, response) => {
      void handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(options.port, options.host ?? "127.0.0.1", () => {
        server?.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : options.port;
    return { url: `http://${options.host ?? "127.0.0.1"}:${actualPort}` };
  }

  async function close(): Promise<void> {
    for (const client of clients) {
      client.end();
    }
    clients.clear();

    const closing = server;
    server = undefined;
    if (closing) {
      await new Promise<void>((resolve, reject) => {
        closing.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    await node.close();
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");

    try {
      if (request.method === "GET" && url.pathname === "/") {
        sendText(response, 200, "text/html; charset=utf-8", renderHtml());
        return;
      }

      if (request.method === "GET" && url.pathname === "/styles.css") {
        sendText(response, 200, "text/css; charset=utf-8", renderCss());
        return;
      }

      if (request.method === "GET" && url.pathname === "/app.js") {
        sendText(response, 200, "text/javascript; charset=utf-8", renderJs());
        return;
      }

      if (request.method === "GET" && url.pathname === "/events") {
        openEventStream(request, response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        sendJson(response, 200, { ok: true, channel: defaultChannelUri, default_channel: defaultChannelUri, channels, clients: clients.size });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/channels") {
        sendJson(response, 200, { channels, default_channel: defaultChannelUri });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/history") {
        const channelUri = readChannelUri(url);
        const history = await human.call<{ limit: number }, { messages: SlockMessage[] }>(channelUri, "history", {
          mime_type: "application/json",
          data: { limit: historyLimit },
        });
        sendJson(response, 200, history.data);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/approvals") {
        sendJson(response, 200, {
          approvals: [...(humanEndpoint?.pendingApprovals.values() ?? [])].map((approval) => ({
            ...approval,
            channel: channelForApproval(approval),
          })),
        });
        return;
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
        sendJson(response, 200, result.data);
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/cancel")) {
        const messageId = decodeURIComponent(url.pathname.slice("/api/runs/".length, -"/cancel".length));
        const body = await readJsonBody(request);
        const channelUri = readChannelUri(url, body);
        const result = await human.call(channelUri, "cancel_agent_run", {
          mime_type: "application/json",
          data: { message_id: messageId, reason: readReason(body) ?? "user cancelled" },
        });
        sendJson(response, 200, result.data);
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/approvals/")) {
        if (!humanEndpoint) {
          sendJson(response, 404, { error: "approval endpoint is not configured" });
          return;
        }

        const id = decodeURIComponent(url.pathname.slice("/api/approvals/".length));
        const body = await readJsonBody(request);
        const result = readApprovalResult(body);
        humanEndpoint.decide(id, result);
        sendJson(response, 200, { id, ...result });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "request failed";
      sendJson(response, 500, { error: message });
    }
  }

  function openEventStream(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify({ type: "bridge_connected", channel: defaultChannelUri, channels })}\n\n`);
    clients.add(response);

    request.on("close", () => {
      clients.delete(response);
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

function sendText(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
