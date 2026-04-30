# Transport v0

The v0 transport is Unix socket + NDJSON.

Reasons:

- Easy to inspect with local tools.
- No schema compiler is needed while the protocol is still moving.
- It is enough to validate endpoint ergonomics, trace shape, and routing semantics.

## Frame Types

### Register

```json
{ "type": "register", "uri": "agent://demo/simple" }
```

The kernel responds:

```json
{ "type": "registered", "uri": "agent://demo/simple" }
```

### Envelope

```json
{ "type": "envelope", "envelope": { "header": {}, "spec": {}, "payload": {} } }
```

### Error

Transport or parse errors are reported as frame errors:

```json
{ "type": "error", "error": { "code": "BAD_JSON", "message": "..." } }
```

Envelope-level failures should be returned as `REJECT` envelopes whenever the kernel can identify a return endpoint.

## Defaults

- Socket path: `/tmp/kairos-ipc.sock`
- Trace path: `traces/ipc-trace.jsonl`

Both can be overridden by CLI flags or environment variables.
