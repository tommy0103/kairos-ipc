import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createUnixNdjsonKernel } from "../packages/kernel/src/transport/unix-ndjson.ts";
import { createNode } from "../packages/sdk/src/index.ts";

const dir = mkdtempSync(join("/tmp", "kairos-ipc-pipeline-demo-"));
const socketPath = join(dir, "kernel.sock");
const tracePath = join(dir, "trace.jsonl");
const address = `unix://${socketPath}`;

const kernel = await createUnixNdjsonKernel({ socketPath, tracePath });
const agent = createNode("agent://demo/pipeline-agent");
const fetch = createNode("plugin://demo/fetch");
const upper = createNode("plugin://demo/upper");

fetch.action(
  "execute",
  {
    description: "Extract text from a JSON payload.",
    accepts: "application/json",
    returns: "text/plain",
  },
  async (payload) => ({ mime_type: "text/plain", data: (payload.data as any).text }),
);

upper.action(
  "execute",
  {
    description: "Uppercase plain text.",
    accepts: "text/plain",
    returns: "text/plain",
  },
  async (payload) => ({ mime_type: "text/plain", data: String(payload.data).toUpperCase() }),
);

try {
  await agent.connect(address);
  await fetch.connect(address);
  await upper.connect(address);

  const result = await agent.pipeline(
    ["plugin://demo/fetch", "plugin://demo/upper", "agent://demo/pipeline-agent"],
    {
      mime_type: "application/json",
      data: { text: "hello routing slip" },
    },
  );

  console.log(JSON.stringify(result, null, 2));
  console.log(`trace: ${tracePath}`);
} finally {
  await agent.close();
  await fetch.close();
  await upper.close();
  await kernel.close();
}
