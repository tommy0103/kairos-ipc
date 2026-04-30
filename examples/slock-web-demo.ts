import { createSlockWebDaemon, loadSlockWebDaemonConfig } from "../packages/slock-daemon/src/index.ts";

const daemon = await createSlockWebDaemon(loadSlockWebDaemonConfig());

console.log(`Slock web bridge: ${daemon.url ?? "not listening"}`);
console.log(`agent: ${daemon.agent_uri}`);
console.log(`workspace: ${daemon.workspace_root}`);
console.log(`IPC socket: ${daemon.socket_path}`);
console.log(`trace: ${daemon.trace_path}`);

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await new Promise(() => undefined);

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  await daemon.close();
  process.exit(0);
}
