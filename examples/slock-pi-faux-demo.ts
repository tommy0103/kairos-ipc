import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@mariozechner/pi-ai";
import { createPiAgent } from "../packages/agent-adapter-pi/src/index.ts";
import { createUnixNdjsonKernel } from "../packages/kernel/src/transport/unix-ndjson.ts";
import { createNode } from "../packages/sdk/src/index.ts";
import {
  createSlockChannel,
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_MIME,
  type SlockChannelEvent,
} from "../packages/slock-channel/src/index.ts";

const dir = mkdtempSync(join("/tmp", "kairos-ipc-slock-pi-faux-"));
const socketPath = join(dir, "kernel.sock");
const tracePath = join(dir, "trace.jsonl");
const address = `unix://${socketPath}`;

const pi = registerFauxProvider({ tokensPerSecond: 1000 });
pi.setResponses([fauxAssistantMessage(fauxText("pi-ai faux runtime received the Slock message over IPC."))]);

const kernel = await createUnixNdjsonKernel({ socketPath, tracePath });
const human = createNode("human://user/local");
const channel = createSlockChannel({ uri: "app://slock/channel/general" });
const agent = createPiAgent({
  uri: "agent://local/pi-assistant",
  model: pi.getModel(),
  system_prompt: "You are a concise assistant running behind a Slock IPC adapter.",
});
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

  await human.call("app://slock/channel/general", "subscribe", {
    mime_type: "application/json",
    data: {},
  });

  await human.call("app://slock/channel/general", "post_message", {
    mime_type: SLOCK_MESSAGE_MIME,
    data: {
      text: "@pi say hello from pi-ai",
      mentions: ["agent://local/pi-assistant"],
      thread_id: null,
    },
  });

  await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.kind === "agent"));
  console.log(`trace: ${tracePath}`);
} finally {
  await human.close();
  await channel.node.close();
  await agent.node.close();
  await kernel.close();
  pi.unregister();
}

function printEvent(event: SlockChannelEvent): void {
  if (event.type === "message_created" && event.message) {
    console.log(`[${event.message.kind}] ${event.message.sender}: ${event.message.text}`);
    return;
  }

  if (event.type === "message_delta" && event.delta) {
    console.log(`[delta] ${event.delta.source}: ${event.delta.text}`);
  }

  if (event.type === "agent_error" && event.error) {
    console.log(`[agent_error] ${event.error.source}: ${event.error.message}`);
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for pi-ai final message");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
