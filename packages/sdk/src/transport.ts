import net from "node:net";
import type { ClientFrame, KernelFrame } from "../../protocol/src/index.ts";

export type FrameListener = (frame: KernelFrame) => void;

export interface IpcTransport {
  send(frame: ClientFrame): void;
  onFrame(listener: FrameListener): () => void;
  close(): void | Promise<void>;
}

export async function connectTransport(address: string): Promise<IpcTransport> {
  const socketPath = parseUnixAddress(address);
  return await UnixNdjsonClientTransport.connect(socketPath);
}

export function parseUnixAddress(address: string): string {
  if (address.startsWith("unix://")) {
    const url = new URL(address);
    if (!url.pathname) {
      throw new Error(`unix address must include a socket path: ${address}`);
    }
    return url.pathname;
  }

  if (address.startsWith("/")) {
    return address;
  }

  throw new Error(`unsupported IPC transport address: ${address}`);
}

export class UnixNdjsonClientTransport implements IpcTransport {
  private readonly socket: net.Socket;
  private buffer = "";
  private readonly listeners = new Set<FrameListener>();

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.accept(chunk));
  }

  static async connect(socketPath: string): Promise<UnixNdjsonClientTransport> {
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new UnixNdjsonClientTransport(socket);
  }

  send(frame: ClientFrame): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket.destroy();
  }

  private accept(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.emit(JSON.parse(line));
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private emit(frame: KernelFrame): void {
    for (const listener of this.listeners) {
      listener(frame);
    }
  }
}
