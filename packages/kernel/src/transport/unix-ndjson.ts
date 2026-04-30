import { existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { isEndpointUri, type ClientFrame } from "../../../protocol/src/index.ts";
import { AllowAllCapabilityGate } from "../capability.ts";
import type { Connection } from "../registry.ts";
import { EndpointRegistry } from "../registry.ts";
import { Router } from "../router.ts";
import { TraceWriter } from "../trace.ts";

export interface UnixNdjsonKernelOptions {
  socketPath: string;
  tracePath: string;
  kernelUri?: string;
}

export interface UnixNdjsonKernel {
  socketPath: string;
  registry: EndpointRegistry;
  router: Router;
  close(): Promise<void>;
}

let nextConnectionId = 1;

export async function createUnixNdjsonKernel(options: UnixNdjsonKernelOptions): Promise<UnixNdjsonKernel> {
  prepareSocketPath(options.socketPath);

  const registry = new EndpointRegistry();
  const trace = new TraceWriter(options.tracePath);
  const router = new Router({
    registry,
    capabilityGate: new AllowAllCapabilityGate(),
    trace,
    kernelUri: options.kernelUri,
  });
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");

    const connection: Connection = {
      id: `conn_${nextConnectionId++}`,
      send(frame) {
        if (!socket.destroyed) {
          socket.write(`${JSON.stringify(frame)}\n`);
        }
      },
    };

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          handleLine(line, connection, registry, router, trace);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      const removed = registry.unregisterConnection(connection);
      for (const uri of removed) {
        trace.recordEvent({ event: "endpoint_unregistered", uri, connection_id: connection.id });
      }
    });

    socket.on("error", (error) => {
      trace.recordEvent({ event: "socket_error", connection_id: connection.id, message: error.message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    socketPath: options.socketPath,
    registry,
    router,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      if (existsSync(options.socketPath)) {
        unlinkSync(options.socketPath);
      }
    },
  };
}

function handleLine(
  line: string,
  connection: Connection,
  registry: EndpointRegistry,
  router: Router,
  trace: TraceWriter,
): void {
  let frame: ClientFrame;
  try {
    frame = JSON.parse(line);
  } catch (error) {
    connection.send({
      type: "error",
      error: {
        code: "BAD_JSON",
        message: error instanceof Error ? error.message : "could not parse JSON frame",
      },
    });
    return;
  }

  if (!isRecord(frame) || typeof frame.type !== "string") {
    connection.send({ type: "error", error: { code: "BAD_FRAME", message: "frame must include a type" } });
    return;
  }

  if (frame.type === "register") {
    if (!isEndpointUri(frame.uri)) {
      connection.send({ type: "error", error: { code: "BAD_URI", message: "register.uri must be an endpoint URI" } });
      return;
    }

    const result = registry.register(frame.uri, connection);
    if (!result.ok) {
      connection.send({ type: "error", error: { code: "REGISTER_FAILED", message: result.error ?? "register failed" } });
      return;
    }

    trace.recordEvent({ event: "endpoint_registered", uri: frame.uri, connection_id: connection.id });
    connection.send({ type: "registered", uri: frame.uri });
    return;
  }

  if (frame.type === "envelope") {
    router.route(frame.envelope, connection);
    return;
  }

  connection.send({ type: "error", error: { code: "BAD_FRAME", message: `unknown frame type: ${frame.type}` } });
}

function prepareSocketPath(socketPath: string): void {
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
