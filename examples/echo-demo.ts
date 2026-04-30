import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createUnixNdjsonKernel } from "../packages/kernel/src/transport/unix-ndjson.ts";
import { createNode } from "../packages/sdk/src/index.ts";

const dir = mkdtempSync(join("/tmp", "kairos-ipc-demo-"));
const socketPath = join(dir, "kernel.sock");
const tracePath = join(dir, "trace.jsonl");
const address = `unix://${socketPath}`;

const kernel = await createUnixNdjsonKernel({ socketPath, tracePath });
const agent = createNode("agent://demo/simple");
const plugin = createNode("plugin://demo/echo");

plugin.action("echo", async (payload) => payload);

try {
  await agent.connect(address);
  await plugin.connect(address);

  const result = await agent.call("plugin://demo/echo", "echo", {
    mime_type: "application/json",
    data: { text: "hello ipc" },
  });

  console.log(JSON.stringify(result, null, 2));
  console.log(`trace: ${tracePath}`);
} finally {
  await agent.close();
  await plugin.close();
  await kernel.close();
}
