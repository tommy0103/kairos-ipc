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
- The Slock slice currently includes a channel endpoint, browser UI bridge, mock agent adapter, calculator plugin, shell plugin, and human approval endpoint.

## Commands

```bash
bun install
bun run test
bun run kernel -- --socket /tmp/kairos-ipc.sock --trace traces/ipc-trace.jsonl
bun run demo:echo
bun run demo:pipeline
bun run demo:slock-basic
bun run demo:slock-agent-adapter
bun run demo:slock-pi-faux
bun run build:slock-ui
bun run demo:slock-web -- --port 5173
```

The tests use in-memory connections because this Codex sandbox can reject local listener calls with `EPERM`. The Unix socket NDJSON transport and Bun web bridge are implemented and intended to run in a normal local environment.

`bun run demo:echo` starts a local Unix socket kernel, registers `agent://demo/simple` and `plugin://demo/echo`, then performs this SDK-level call:

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

`bun run demo:pipeline` starts the same local kernel and sends one payload through a linear SDK-managed route:

```text
agent://demo/pipeline-agent
  -> plugin://demo/fetch
  -> plugin://demo/upper
  -> agent://demo/pipeline-agent
```

The kernel only sees ordinary envelopes; the SDK handles `reply_to` and `routing_slip` advancement.

`bun run demo:slock-basic` runs the first Slock-flavored vertical slice:

```text
human://user/local
  -> app://slock/channel/general post_message
  -> agent://local/mock run
  -> plugin://demo/calculator add
  -> app://slock/channel/general final message
  -> human://user/local channel events
```

This is still pure IPC: channel, human, agent, and calculator are all endpoints, and the kernel remains unaware of Slock concepts.

`bun run demo:slock-web -- --port 5173` builds the Vue UI and starts the browser UI bridge. The page uses local HTTP for user actions and SSE for channel events, while the bridge uses `human://user/local` over IPC to talk to the channel. The web demo defaults to `agent://local/pi-assistant`, backed by `@mariozechner/pi-ai`.

`bun run demo:slock-agent-adapter` runs a separate tool-agnostic adapter demo:

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

For `slock-web`, configure the default pi assistant with environment variables or CLI flags:

```bash
OPENAI_API_KEY=... bun run demo:slock-web -- --port 5173
bun run demo:slock-web -- --provider openai --model gpt-4o-mini --base-url http://localhost:4000/v1
```

Use `--api openai-completions` when an OpenAI-compatible gateway exposes Chat Completions but not the Responses API selected by the model registry.

The pi assistant is exposed through `@pi`, `@pi-assistant`, and `@agent`. DM channels whose label or URI segment matches an agent alias, such as `pi` or `local-pi`, implicitly route plain messages to that agent, so users do not need to mention the agent inside a PM. Its Slock tools are `read`, `write`, `edit`, and `exec`: `read` calls the workspace plugin directly; `write`, `edit`, and `exec` first request human approval, then call the workspace or shell plugin through IPC.

By default, the pi assistant builds each run from recent Slock channel history, capped by `context_history_limit` and truncated at the current message id. Human messages are replayed as pi-ai user messages with mentions stripped, and prior Slock agent messages are replayed as pi-ai assistant messages. Set `context_history_limit: 0` to fall back to single-message runs.

The approval path looks like this:

```text
agent://local/pi-assistant
  -> human://user/local request_approval
  -> plugin://local/shell exec
  -> app://slock/channel/general final message
```

The shell plugin uses `execFile`, not arbitrary shell string execution. It defaults to an allowlist for no-approval demos; `slock-web` disables that allowlist because `exec` is already gated by human approval.
