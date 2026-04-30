import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createMockAgent } from "../packages/agent-adapter-mock/src/index.ts";
import { createUnixNdjsonKernel } from "../packages/kernel/src/transport/unix-ndjson.ts";
import { createCalculatorPlugin } from "../packages/plugins-demo/src/index.ts";
import { createNode } from "../packages/sdk/src/index.ts";
import {
  createSlockChannel,
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_MIME,
  type SlockChannelEvent,
} from "../packages/slock-channel/src/index.ts";

const dir = mkdtempSync(join("/tmp", "kairos-ipc-slock-basic-"));
const socketPath = join(dir, "kernel.sock");
const tracePath = join(dir, "trace.jsonl");
const address = `unix://${socketPath}`;

const kernel = await createUnixNdjsonKernel({ socketPath, tracePath });
const human = createNode("human://user/local");
const channel = createSlockChannel({ uri: "app://slock/channel/general" });
const agent = createMockAgent({ uri: "agent://local/mock" });
const calculator = createCalculatorPlugin({ uri: "plugin://demo/calculator" });
const events: SlockChannelEvent[] = [];

human.onEmit("*", (payload) => {
  if (payload.mime_type !== SLOCK_CHANNEL_EVENT_MIME) {
    return;
  }

  const event = payload.data as SlockChannelEvent;
  events.push(event);
  printEvent(event);
});

try {
  await human.connect(address);
  await channel.node.connect(address);
  await agent.node.connect(address);
  await calculator.node.connect(address);

  await human.call("app://slock/channel/general", "subscribe", {
    mime_type: "application/json",
    data: {},
  });

  await human.call("app://slock/channel/general", "post_message", {
    mime_type: SLOCK_MESSAGE_MIME,
    data: {
      text: "@mock please calculate something",
      mentions: ["agent://local/mock"],
      thread_id: null,
    },
  });

  await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));
  console.log(`trace: ${tracePath}`);
} finally {
  await human.close();
  await channel.node.close();
  await agent.node.close();
  await calculator.node.close();
  await kernel.close();
}

function printEvent(event: SlockChannelEvent): void {
  if (event.type === "message_created" && event.message) {
    console.log(`[${event.message.kind}] ${event.message.sender}: ${event.message.text}`);
    return;
  }

  if (event.type === "message_delta" && event.delta) {
    console.log(`[delta] ${event.delta.source}: ${event.delta.text}`);
    return;
  }

  if (event.type === "agent_error" && event.error) {
    console.log(`[error] ${event.error.source}: ${event.error.code} ${event.error.message}`);
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for slock final message");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
