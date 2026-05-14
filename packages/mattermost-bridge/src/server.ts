import { createServer } from "node:net";
import { createNode, type IpcNode } from "../../sdk/src/index.ts";
import { KAIROS_DASHBOARD_EVENT_MIME, type SessionManagerDashboardEvent } from "../../session-manager/src/index.ts";
import { MattermostRestError } from "./client.ts";
import { createMattermostBridgeService, type MattermostBridgeService, type MattermostBridgeServiceOptions } from "./service.ts";
import {
  actionErrorResponse,
  checkOrigin,
  checkTeam,
  checkUser,
  commandErrorResponse,
  dialogErrorResponse,
  jsonResponse,
  MattermostHttpError,
  readActionCallback,
  readDialogSubmission,
  readFormBody,
  readJsonBody,
  requireCallbackToken,
  requireMethod,
  requireSlashToken,
  readSlashCallback,
  routePath,
  toMattermostHttpError,
} from "./http.ts";

export interface MattermostBridgeListenOptions {
  host?: string;
  port: number;
}

export interface MattermostBridge {
  node: IpcNode;
  service: MattermostBridgeService;
  startProjectionSubscription(): Promise<void>;
  listen(options: MattermostBridgeListenOptions): Promise<{ url: string }>;
  close(): Promise<void>;
}

export function createMattermostBridge(options: MattermostBridgeServiceOptions): MattermostBridge {
  const node = createNode(options.uri ?? "app://kairos/mattermost-bridge");
  const service = createMattermostBridgeService(options);
  const handleRequest = createMattermostBridgeFetchHandler(options, service);
  let server: Bun.Server | undefined;
  let closed = false;
  let projectionSubscribed = false;
  let projectionSubscribePromise: Promise<void> | undefined;
  let projectionFlushPromise: Promise<void> | undefined;
  let pendingProjectionSnapshot: SessionManagerDashboardEvent | undefined;
  const pendingProjectionUpdates = new Map<string, SessionManagerDashboardEvent>();
  let projectionErrorCount = 0;
  let lastProjectionError: string | undefined;

  node.action(
    "status",
    {
      description: "Return Mattermost bridge status.",
      accepts: "application/json",
      returns: "application/json",
    },
    async () => ({
      mime_type: "application/json",
      data: {
        ok: true,
        session_manager_uri: options.session_manager_uri,
        projection_error_count: projectionErrorCount,
        last_projection_error: lastProjectionError,
      },
    }),
  );

  node.onEmit("*", (payload) => {
    if (payload.mime_type !== KAIROS_DASHBOARD_EVENT_MIME) return;
    enqueueProjectionEvent(payload.data as SessionManagerDashboardEvent);
  });

  return { node, service, startProjectionSubscription, listen, close };

  async function startProjectionSubscription(): Promise<void> {
    if (closed) {
      throw new Error("Mattermost bridge is closed");
    }
    if (projectionSubscribed) return;
    if (projectionSubscribePromise) return projectionSubscribePromise;

    projectionSubscribePromise = node.call(options.session_manager_uri, "subscribe_dashboard", {
      mime_type: "application/json",
      data: { include_snapshot: true },
    }, { timeout_ms: 5000 }).then(() => {
      projectionSubscribed = true;
    }).finally(() => {
      projectionSubscribePromise = undefined;
    });
    return projectionSubscribePromise;
  }

  async function listen(listenOptions: MattermostBridgeListenOptions): Promise<{ url: string }> {
    if (closed) {
      throw new Error("Mattermost bridge is closed");
    }
    if (server) {
      throw new Error("Mattermost bridge is already listening");
    }
    const hostname = listenOptions.host ?? "127.0.0.1";
    const port = listenOptions.port === 0 ? await findOpenPort(hostname) : listenOptions.port;
    server = Bun.serve({
      hostname,
      port,
      idleTimeout: 0,
      fetch: (request) => handleRequest(request),
    });
    void startProjectionSubscription().catch(() => {
      // A daemon may connect IPC later and call startProjectionSubscription explicitly.
    });
    return { url: `http://${hostname}:${server.port}` };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const closing = server;
    server = undefined;
    if (projectionSubscribePromise) {
      await projectionSubscribePromise.catch(() => undefined);
    }
    pendingProjectionSnapshot = undefined;
    pendingProjectionUpdates.clear();
    if (projectionFlushPromise) {
      await projectionFlushPromise.catch(() => undefined);
    }
    if (projectionSubscribed) {
      await node.call(options.session_manager_uri, "unsubscribe_dashboard", {
        mime_type: "application/json",
        data: { reason: "mattermost bridge closed" },
      }).catch(() => {
        // The session manager may already be gone during shutdown.
      });
      projectionSubscribed = false;
    }
    if (closing) {
      closing.stop(true);
    }
    await node.close();
  }

  function enqueueProjectionEvent(event: SessionManagerDashboardEvent): void {
    if (closed) return;
    if (event.type === "dashboard_snapshot") {
      pendingProjectionSnapshot = event;
      pendingProjectionUpdates.clear();
    } else if (event.type === "session_updated" && event.session_id) {
      pendingProjectionUpdates.set(event.session_id, event);
    } else {
      return;
    }
    void flushProjectionQueue();
  }

  async function flushProjectionQueue(): Promise<void> {
    if (projectionFlushPromise) return projectionFlushPromise;
    projectionFlushPromise = (async () => {
      while (!closed) {
        const events = takePendingProjectionEvents();
        if (events.length === 0) break;
        for (const event of events) {
          if (closed) break;
          await publishProjectionEvent(event);
        }
      }
    })().finally(() => {
      projectionFlushPromise = undefined;
      if (!closed && hasPendingProjectionEvents()) void flushProjectionQueue();
    });
    return projectionFlushPromise;
  }

  function takePendingProjectionEvents(): SessionManagerDashboardEvent[] {
    const events: SessionManagerDashboardEvent[] = [];
    if (pendingProjectionSnapshot) {
      events.push(pendingProjectionSnapshot);
      pendingProjectionSnapshot = undefined;
    }
    events.push(...pendingProjectionUpdates.values());
    pendingProjectionUpdates.clear();
    return events;
  }

  function hasPendingProjectionEvents(): boolean {
    return Boolean(pendingProjectionSnapshot) || pendingProjectionUpdates.size > 0;
  }

  async function publishProjectionEvent(event: SessionManagerDashboardEvent): Promise<void> {
    try {
      await service.publishSessionProjection(event);
    } catch (error) {
      projectionErrorCount += 1;
      lastProjectionError = sanitizeProjectionError(error);
      // Projection delivery is best-effort; Mattermost must not become collaboration truth.
    }
  }

}

function sanitizeProjectionError(error: unknown): string {
  if (error instanceof MattermostRestError) {
    return error.message;
  }
  if (error instanceof Error && error.name) {
    return `Projection delivery failed: ${error.name}`;
  }
  return "Projection delivery failed";
}

export function createMattermostBridgeFetchHandler(options: MattermostBridgeServiceOptions, service: MattermostBridgeService): (request: Request) => Promise<Response> {
  return async function handleRequest(request: Request): Promise<Response> {
    let route: ReturnType<typeof routePath> | undefined;
    try {
      const url = new URL(request.url);
      route = routePath(url.pathname);

      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }), request);
      }

      if (!route) {
        throw new MattermostHttpError(404, "not_found", "Mattermost bridge route not found.");
      }

      if (route.kind === "health") {
        requireMethod(request, "GET");
        return withCors(jsonResponse(200, { ok: true }), request);
      }

      if (route.kind === "trace") {
        requireMethod(request, "GET");
        return withCors(htmlResponse(200, bridgeLinkPage("Trace", "Session", route.session_id)), request);
      }

      if (route.kind === "artifact") {
        requireMethod(request, "GET");
        return withCors(htmlResponse(200, bridgeLinkPage("Artifact", "Artifact", route.artifact_id)), request);
      }

      checkOrigin(request, options.allowed_origins, options.require_origin === true);

      if (route.kind === "slash") {
        requireMethod(request, "POST");
        const form = await readFormBody(request, options.max_form_body_bytes ?? options.max_body_bytes);
        const payload = readSlashCallback(form);
        requireSlashToken(request, payload.token, options.slash_command_token);
        checkTeam(payload.team_id, options.allowed_team_ids);
        checkUser(payload.user_id, options.allowed_user_ids);
        return withCors(jsonResponse(200, await service.handleSlash(payload)), request);
      }

      if (route.kind === "action") {
        requireMethod(request, "POST");
        const body = await readJsonBody(request, options.max_json_body_bytes ?? options.max_body_bytes);
        requireCallbackToken(request, options.slash_command_token, body);
        const payload = readActionCallback(body);
        checkTeam(payload.team_id, options.allowed_team_ids);
        checkUser(payload.user_id, options.allowed_user_ids);
        return withCors(jsonResponse(200, await service.handleAction(payload)), request);
      }

      requireMethod(request, "POST");
      const body = await readJsonBody(request, options.max_json_body_bytes ?? options.max_body_bytes);
      requireCallbackToken(request, options.slash_command_token, body);
      const payload = readDialogSubmission(body);
      checkTeam(payload.team_id, options.allowed_team_ids);
      checkUser(payload.user_id, options.allowed_user_ids);
      return withCors(jsonResponse(200, await service.handleDialog(payload)), request);
    } catch (error) {
      const httpError = toMattermostHttpError(error);
      const body = route?.kind === "dialog" ? dialogErrorResponse(httpError) : route?.kind === "action" ? actionErrorResponse(httpError) : commandErrorResponse(httpError);
      return withCors(jsonResponse(httpError.status, body), request);
    }
  };

  function withCors(response: Response, request: Request): Response {
    const origin = request.headers.get("origin");
    if (origin && options.allowed_origins?.includes(origin)) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set("vary", "origin");
    }
    response.headers.set("access-control-allow-headers", "authorization, content-type");
    response.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    return response;
  }
}

function htmlResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function bridgeLinkPage(title: string, label: string, id: string): string {
  const safeTitle = escapeHtml(title);
  const safeLabel = escapeHtml(label);
  const safeId = escapeHtml(id);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Kairos ${safeTitle}</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f4ef; color: #221f1c; }
      main { width: min(560px, calc(100vw - 40px)); border: 1px solid #d8d1c7; border-radius: 14px; background: #fffdf8; padding: 28px; box-shadow: 0 18px 40px rgb(29 24 18 / 10%); }
      h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.25; }
      p { margin: 0; color: #635c53; line-height: 1.55; }
      code { display: inline-block; margin-top: 18px; padding: 8px 10px; border-radius: 8px; background: #ece6dc; color: #2f2a24; font-size: 13px; word-break: break-all; }
    </style>
  </head>
  <body>
    <main>
      <h1>Kairos ${safeTitle}</h1>
      <p>This bridge link is valid. The full ${safeTitle.toLowerCase()} reader is provided by the Kairos workspace UI.</p>
      <code>${safeLabel}: ${safeId}</code>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char] ?? char);
}

async function findOpenPort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, hostname, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      probe.close(() => {
        if (port) resolve(port);
        else reject(new Error("failed to allocate Mattermost bridge port"));
      });
    });
  });
}
