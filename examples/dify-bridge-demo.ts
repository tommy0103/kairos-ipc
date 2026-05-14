import { createSlockWebDaemon, loadSlockWebDaemonConfig } from "../packages/slock-daemon/src/index.ts";

const config = loadSlockWebDaemonConfig();
if (config.dify_bridge?.enabled !== true) {
  throw new Error("dify-bridge-demo requires dify_bridge.enabled=true in the Slock daemon config");
}

const daemon = await createSlockWebDaemon(config);
const difyBridgeUrl = daemon.dify_bridge_url;
if (!difyBridgeUrl) {
  await daemon.close();
  throw new Error("dify_bridge.enabled is set, but the Slock daemon did not expose dify_bridge_url");
}

console.log(`Kairos Dify bridge: ${difyBridgeUrl}`);
console.log(`Slock web bridge: ${daemon.url ?? "not listening"}`);
console.log(`agents: ${daemon.agent_uris.join(", ")}`);
console.log(`workspace: ${daemon.workspace_root}`);
console.log(`IPC socket: ${daemon.socket_path}`);
console.log(`trace: ${daemon.trace_path}`);

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await new Promise(() => undefined);

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  await daemon.close();
  process.exit(0);
}
