import { createUnixNdjsonKernel } from "./transport/unix-ndjson.ts";

const socketPath = readOption("--socket") ?? process.env.KAIROS_IPC_SOCKET ?? "/tmp/kairos-ipc.sock";
const tracePath = readOption("--trace") ?? process.env.KAIROS_IPC_TRACE ?? "traces/ipc-trace.jsonl";
const captureTracePayload = readFlag("--trace-payload") || process.env.KAIROS_IPC_TRACE_PAYLOAD === "1";

const kernel = await createUnixNdjsonKernel({ socketPath, tracePath, trace: { capture_payload: captureTracePayload } });

console.log(`kairos-ipc kernel listening on ${kernel.socketPath}`);
console.log(`trace writing to ${tracePath}`);

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  await kernel.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readFlag(name: string): boolean {
  return process.argv.includes(name);
}
