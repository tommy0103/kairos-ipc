import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import { createPiAgent, createPiSlockTools } from "../packages/agent-adapter-pi/src/index.ts";
import { createUnixNdjsonKernel } from "../packages/kernel/src/transport/unix-ndjson.ts";
import { createShellPlugin, createWorkspacePlugin } from "../packages/plugins-demo/src/index.ts";
import { createSlockChannel } from "../packages/slock-channel/src/index.ts";
import { createSlockHuman } from "../packages/slock-human/src/index.ts";
import { createSlockUiBridge } from "../packages/slock-ui-bridge/src/index.ts";

const port = readNumberOption("--port", 5173);
const host = readOption("--host") ?? "127.0.0.1";
const dir = mkdtempSync(join("/tmp", "kairos-ipc-slock-web-"));
const socketPath = join(dir, "kernel.sock");
const tracePath = join(dir, "trace.jsonl");
const ipcAddress = `unix://${socketPath}`;
const piUri = "agent://local/pi-assistant";
const workspaceUri = "plugin://local/workspace";
const shellUri = "plugin://local/shell";
const workspaceRoot = readOption("--workspace") ?? process.cwd();
const piTools = createPiSlockTools({ workspace_uri: workspaceUri, shell_uri: shellUri });

const kernel = await createUnixNdjsonKernel({ socketPath, tracePath });
const human = createSlockHuman({ uri: "human://user/local" });
const channel = createSlockChannel({ uri: "app://slock/channel/general" });
const agent = createPiAgent({
  uri: piUri,
  model: resolvePiModel(),
  api_key: readOption("--api-key") ?? process.env.KAIROS_IPC_PI_API_KEY,
  base_url: readOption("--base-url") ?? process.env.KAIROS_IPC_PI_BASE_URL ?? process.env.OPENAI_BASE_URL,
  system_prompt: [
    "You are pi-assistant running behind Slock IPC.",
    "Use read for workspace inspection. Read does not require approval.",
    "Use write, edit, or exec only when the user asks for a concrete filesystem or command action; those tools require human approval before execution.",
    "Keep final answers concise and mention which files or commands were used.",
  ].join("\n"),
  tools: piTools.tools,
  execute_tool: piTools.execute_tool,
});
const workspace = createWorkspacePlugin({ uri: workspaceUri, root: workspaceRoot });
const shell = createShellPlugin({ uri: shellUri, cwd: workspaceRoot, allowed_commands: null });
const bridge = createSlockUiBridge({
  channel_uri: "app://slock/channel/general",
  human_node: human.node,
  human_endpoint: human,
  mention_aliases: { pi: piUri, "pi-assistant": piUri, agent: piUri },
});

await human.node.connect(ipcAddress);
await bridge.node.connect(ipcAddress);
await channel.node.connect(ipcAddress);
await agent.node.connect(ipcAddress);
await workspace.node.connect(ipcAddress);
await shell.node.connect(ipcAddress);

await human.node.call("app://slock/channel/general", "subscribe", {
  mime_type: "application/json",
  data: {},
});

const { url } = await bridge.listen({ host, port });
console.log(`Slock web bridge: ${url}`);
console.log(`pi assistant: ${piUri}`);
console.log(`workspace: ${workspaceRoot}`);
console.log(`IPC socket: ${socketPath}`);
console.log(`trace: ${tracePath}`);

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await new Promise(() => undefined);

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  await bridge.close();
  await human.node.close();
  await channel.node.close();
  await agent.node.close();
  await workspace.node.close();
  await shell.node.close();
  await kernel.close();
  process.exit(0);
}

function resolvePiModel(): Model<Api> {
  const provider = readOption("--provider") ?? process.env.KAIROS_IPC_PI_PROVIDER ?? "openai";
  const model = readOption("--model") ?? process.env.KAIROS_IPC_PI_MODEL ?? "gpt-4o-mini";
  return getModel(provider as never, model as never) as Model<Api>;
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readNumberOption(name: string, fallback: number): number {
  const raw = readOption(name);
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
