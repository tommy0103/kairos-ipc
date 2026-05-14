# Kairos IPC Dify Plugin

This Dify tool plugin wraps the local Kairos Dify Bridge. It gives Dify apps first-class Kairos tools without making Dify the owner of Kairos sessions, artifacts, approvals, or trace.

## Required runtime

Start the local bridge first:

```bash
OPENAI_API_KEY=$COPILOT_GATEWAY_API_KEY KAIROS_DIFY_BRIDGE_TOKEN=dev-token bun run demo:dify-bridge -- --config .configs/dify-local-real-agents-config.json
```

Configure the provider credentials in Dify:

- `bridge_url`: `http://127.0.0.1:5180` when Dify can reach the host directly.
- `bridge_token`: the value of `KAIROS_DIFY_BRIDGE_TOKEN`.

For Docker-hosted Dify on macOS, use a bridge URL that the worker container can reach, such as `http://host.docker.internal:5180`.

## Product boundary

Dify is a launcher and review wrapper. Kairos remains the runtime and source of truth for collaboration state.

Use these tools to start work, poll status, read artifacts, review artifacts, resolve approvals, and open trace evidence. Do not build Dify workflows that rewrite agent outputs as if they were the durable Kairos artifacts.
