# Kairos IPC Prototype

This prototype is not a VFS, not a task runtime, and not an agent framework.
It is a message substrate for addressable actors.

中文表述：这不是文件系统，不是任务系统，也不是 agent 框架。这是一个让可寻址主体互相传递意图的消息底座。

## Current Slice

- Phase 0 specs live in `specs/`.
- Shared envelope types and validation live in `packages/protocol`.
- The TypeScript kernel MVP lives in `packages/kernel`.
- The TypeScript endpoint SDK MVP lives in `packages/sdk`.
- The kernel currently supports endpoint registration, envelope validation, routing, TTL rejection, source ownership checks, and trace JSONL.
- The SDK currently supports connect/register, action handlers, `call()`, pending promise resolution, `RESOLVE`/`REJECT` wrapping, MIME accepts/returns checks, raw frame debug hooks, and a default `manifest` action.
- The Slock slice currently includes a channel endpoint, browser UI bridge, mock agent adapter, calculator plugin, allowlisted shell plugin, and human approval endpoint.

## Commands

```bash
npm test
npm run kernel -- --socket /tmp/kairos-ipc.sock --trace traces/ipc-trace.jsonl
npm run demo:echo
npm run demo:pipeline
npm run demo:slock-basic
npm run demo:slock-agent-adapter
npm run demo:slock-web -- --port 5173
```

The tests use in-memory connections because this Codex sandbox rejects local `net.Server.listen()` calls with `EPERM`. The Unix socket NDJSON transport is implemented and intended to run in a normal local environment.

`npm run demo:echo` starts a local Unix socket kernel, registers `agent://demo/simple` and `plugin://demo/echo`, then performs this SDK-level call:

```ts
const result = await agent.call("plugin://demo/echo", "echo", {
  mime_type: "application/json",
  data: { text: "hello ipc" },
});
```

Actions can optionally declare MIME metadata for runtime checks and manifest output:

```ts
plugin.action(
  "echo",
  { accepts: "application/json", returns: "application/json" },
  async (payload) => payload,
);
```

`npm run demo:pipeline` starts the same local kernel and sends one payload through a linear SDK-managed route:

```text
agent://demo/pipeline-agent
  -> plugin://demo/fetch
  -> plugin://demo/upper
  -> agent://demo/pipeline-agent
```

The kernel only sees ordinary envelopes; the SDK handles `reply_to` and `routing_slip` advancement.

`npm run demo:slock-basic` runs the first Slock-flavored vertical slice:

```text
human://user/local
  -> app://slock/channel/general post_message
  -> agent://local/mock run
  -> plugin://demo/calculator add
  -> app://slock/channel/general final message
  -> human://user/local channel events
```

This is still pure IPC: channel, human, agent, and calculator are all endpoints, and the kernel remains unaware of Slock concepts.

`npm run demo:slock-web -- --port 5173` starts the browser UI bridge. The page uses local HTTP for user actions and SSE for channel events, while the bridge uses `human://user/local` over IPC to talk to the channel.

`npm run demo:slock-agent-adapter` runs a separate tool-agnostic adapter demo:

```text
IPC CALL action=run
  -> AgentRuntime.run(input)
  -> runtime status/delta/final events
  -> IPC EMIT message_delta / RESOLVE final
```

This adapter intentionally does not define a generic tool-call protocol. Real agent frameworks can keep their own tool handling inside the runtime or framework adapter.

`packages/agent-adapter-pi` hosts `@mariozechner/pi-ai` as an IPC agent endpoint. Tests use pi-ai's faux provider, but real provider configuration can be passed explicitly:

```ts
import { getModel } from "@mariozechner/pi-ai";
import { createPiAgent } from "./packages/agent-adapter-pi/src/index.ts";

const agent = createPiAgent({
  uri: "agent://local/pi-assistant",
  model: getModel("openai", "gpt-4o-mini"),
  api_key_env: "OPENAI_API_KEY",
  base_url: process.env.OPENAI_BASE_URL,
});
```

Use `api_key` / `base_url` for direct values, or `api_key_env` / `base_url_env` when the values should be read from environment variables at runtime. Extra HTTP headers can be passed with `headers`.

The default browser message is `@mock please run pwd`, which exercises the approval path:

```text
agent://local/mock
  -> human://user/local request_approval
  -> plugin://local/shell exec
  -> app://slock/channel/general final message
```

The shell plugin uses `execFile` with an allowlist, not arbitrary shell string execution.
