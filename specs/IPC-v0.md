# Kairos IPC v0

Kairos IPC v0 is a minimal message substrate for addressable actors.

The protocol is intentionally small:

- Every participant is an endpoint with a URI.
- Every message is an immutable envelope.
- The kernel only validates, routes, applies TTL/capability gates, and records trace events.
- Business meaning stays in endpoint code and SDK conventions.

## Envelope

Every message has three top-level objects:

```text
header
spec
payload
```

### `header`

Kernel-visible routing metadata.

| Field | Required | Meaning |
| --- | --- | --- |
| `msg_id` | yes | Globally unique message id. |
| `correlation_id` | no | Logical conversation, promise, pipeline, or stream id. |
| `source` | yes | Sender endpoint URI. |
| `target` | yes | Receiver endpoint URI. |
| `reply_to` | no | Endpoint that should receive the next response. |
| `routing_slip` | no | SDK-managed future route stack. |
| `ttl_ms` | yes | Time-to-live in milliseconds. |

### `spec`

Endpoint-visible operation metadata.

v0 op codes:

- `CALL`
- `RESOLVE`
- `REJECT`
- `EMIT`
- `END`
- `CANCEL`

`spec.action` is required for `CALL`. Other op codes may carry the originating action for diagnostics.

### `payload`

Endpoint-owned data.

| Field | Required | Meaning |
| --- | --- | --- |
| `mime_type` | yes | Payload media type. |
| `data` | yes | Opaque endpoint data. |

The kernel must not deserialize or interpret `payload.data` beyond computing optional trace metadata such as size and hash.

## Kernel Responsibilities

The v0 kernel does exactly this:

- Maintain endpoint URI registrations.
- Validate envelope structure.
- Route by `header.target`.
- Return `REJECT` for missing targets, invalid envelopes, TTL expiry, and capability denial.
- Record trace JSONL.
- Unregister endpoint URIs when connections close.

The kernel does not know about agents, tools, tasks, channels, manifests, VFS, ReAct loops, or pipelines.

## Management Frame

The initial prototype transport uses NDJSON frames over a Unix socket. Registration is transport-level, not a business envelope:

```json
{ "type": "register", "uri": "plugin://demo/echo" }
```

Messages are sent as:

```json
{ "type": "envelope", "envelope": { "header": {}, "spec": {}, "payload": {} } }
```

The kernel delivers envelopes back to endpoints using the same frame shape.
