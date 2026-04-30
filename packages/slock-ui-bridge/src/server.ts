import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { createNode, type IpcNode } from "../../sdk/src/index.ts";
import type { SlockHumanEndpoint } from "../../slock-human/src/index.ts";
import {
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_MIME,
  type SlockApprovalResult,
  type SlockChannelEvent,
  type SlockMessage,
} from "../../slock-channel/src/index.ts";
import { renderCss, renderHtml, renderJs } from "./assets.ts";
import { inferMentions, type MentionAliases } from "./mentions.ts";

export interface SlockUiBridgeOptions {
  channel_uri: string;
  human_node: IpcNode;
  human_endpoint?: SlockHumanEndpoint;
  uri?: string;
  mention_aliases?: MentionAliases;
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
  const channelUri = options.channel_uri;
  const aliases = options.mention_aliases ?? { mock: "agent://local/mock" };
  const historyLimit = options.history_limit ?? 50;
  const clients = new Set<ServerResponse>();
  let server: http.Server | undefined;

  node.action(
    "status",
    {
      description: "Return UI bridge status.",
      accepts: "application/json",
      returns: "application/json",
    },
    async () => ({ mime_type: "application/json", data: { ok: true, channel: channelUri, clients: clients.size } }),
  );

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      broadcast(payload.data as SlockChannelEvent);
    }
  });

  humanEndpoint?.onApprovalRequest((approval) => {
    broadcast({ type: "approval_requested", approval });
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
        sendJson(response, 200, { ok: true, channel: channelUri, clients: clients.size });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/history") {
        const history = await human.call<{ limit: number }, { messages: SlockMessage[] }>(channelUri, "history", {
          mime_type: "application/json",
          data: { limit: historyLimit },
        });
        sendJson(response, 200, history.data);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/approvals") {
        sendJson(response, 200, { approvals: [...(humanEndpoint?.pendingApprovals.values() ?? [])] });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/messages") {
        const body = await readJsonBody(request);
        const text = readText(body);
        const mentions = inferMentions(text, readExplicitMentions(body), aliases);
        const result = await human.call(channelUri, "post_message", {
          mime_type: SLOCK_MESSAGE_MIME,
          data: { text, mentions, thread_id: null },
        });
        sendJson(response, 200, result.data);
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/cancel")) {
        const messageId = decodeURIComponent(url.pathname.slice("/api/runs/".length, -"/cancel".length));
        const body = await readJsonBody(request);
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
        broadcast({ type: "approval_resolved", id, result });
        sendJson(response, 200, { id, ...result });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
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
    response.write(`data: ${JSON.stringify({ type: "bridge_connected", channel: channelUri })}\n\n`);
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
