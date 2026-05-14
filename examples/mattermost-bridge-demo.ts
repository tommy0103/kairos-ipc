import { createSlockWebDaemon, loadSlockWebDaemonConfig } from "../packages/slock-daemon/src/index.ts";

const config = loadSlockWebDaemonConfig();
if (config.mattermost_bridge?.enabled !== true) {
  throw new Error("mattermost-bridge-demo requires mattermost_bridge.enabled=true in the Slock daemon config");
}

const daemon = await createSlockWebDaemon(config);
const mattermostBridgeUrl = daemon.mattermost_bridge_url;
if (!mattermostBridgeUrl) {
  await daemon.close();
  throw new Error("mattermost_bridge.enabled is set, but the Slock daemon did not expose mattermost_bridge_url");
}

const publicUrl = config.mattermost_bridge.public_url ?? mattermostBridgeUrl;

console.log(`Kairos Mattermost bridge: ${mattermostBridgeUrl}`);
console.log(`Mattermost callback URL: ${publicUrl}/mattermost/slash`);
console.log(`Mattermost interactive action URL: ${publicUrl}/mattermost/action`);
console.log(`Mattermost dialog URL: ${publicUrl}/mattermost/dialog`);
console.log(`Slock web bridge: ${daemon.url ?? "not listening"}`);
console.log(`Mattermost base URL: ${config.mattermost_bridge.mattermost_base_url ?? "not configured"}`);
console.log(`allowed teams: ${config.mattermost_bridge.allowed_team_ids?.join(", ") ?? "all"}`);
console.log(`agents: ${daemon.agent_uris.join(", ")}`);
console.log(`workspace: ${daemon.workspace_root}`);
console.log(`IPC socket: ${daemon.socket_path}`);
console.log(`trace: ${daemon.trace_path}`);
console.log("");
console.log("Mattermost setup:");
console.log("1. Create a bot account or personal access token and set mattermost_bridge.bot_token or KAIROS_MATTERMOST_BOT_TOKEN.");
console.log("2. Create a slash command named /kairos with request URL shown above.");
console.log("3. Set the slash command token in mattermost_bridge.slash_command_token or KAIROS_MATTERMOST_SLASH_TOKEN.");
console.log("4. If Mattermost cannot reach 127.0.0.1, set mattermost_bridge.public_url to the reachable callback base URL.");

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await new Promise(() => undefined);

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  await daemon.close();
  process.exit(0);
}
