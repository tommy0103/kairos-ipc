import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createMockAgent } from "../packages/agent-adapter-mock/src/index.ts";
import { createUnixNdjsonKernel } from "../packages/kernel/src/transport/unix-ndjson.ts";
import { createCalculatorPlugin, createShellPlugin } from "../packages/plugins-demo/src/index.ts";
import { createSlockChannel } from "../packages/slock-channel/src/index.ts";
import { createSlockHuman } from "../packages/slock-human/src/index.ts";
import { createSlockUiBridge } from "../packages/slock-ui-bridge/src/index.ts";

const port = readNumberOption("--port", 5173);
const host = readOption("--host") ?? "127.0.0.1";
const dir = mkdtempSync(join("/tmp", "kairos-ipc-slock-web-"));
const socketPath = join(dir, "kernel.sock");
const tracePath = join(dir, "trace.jsonl");
const ipcAddress = `unix://${socketPath}`;

const kernel = await createUnixNdjsonKernel({ socketPath, tracePath });
const human = createSlockHuman({ uri: "human://user/local" });
const channel = createSlockChannel({ uri: "app://slock/channel/general" });
const agent = createMockAgent({ uri: "agent://local/mock" });
const calculator = createCalculatorPlugin({ uri: "plugin://demo/calculator" });
const shell = createShellPlugin({ uri: "plugin://local/shell", cwd: process.cwd(), allowed_commands: ["pwd", "echo", "ls"] });
const bridge = createSlockUiBridge({
  channel_uri: "app://slock/channel/general",
  human_node: human.node,
  human_endpoint: human,
  mention_aliases: { mock: "agent://local/mock" },
});

await human.node.connect(ipcAddress);
await bridge.node.connect(ipcAddress);
await channel.node.connect(ipcAddress);
await agent.node.connect(ipcAddress);
await calculator.node.connect(ipcAddress);
await shell.node.connect(ipcAddress);

await human.node.call("app://slock/channel/general", "subscribe", {
  mime_type: "application/json",
  data: {},
});

const { url } = await bridge.listen({ host, port });
console.log(`Slock web bridge: ${url}`);
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
  await calculator.node.close();
  await shell.node.close();
  await kernel.close();
  process.exit(0);
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
