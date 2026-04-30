# Non-Goals

This prototype is not a VFS, not a task runtime, and not an agent framework.

It is a message substrate for addressable actors.

The prototype deliberately does not implement:

- VFS path semantics.
- taskTree runtime state.
- Agent planning, reflection, memory, or ReAct loops.
- Tool calling as a kernel primitive.
- Workflow scheduling.
- Manifest generation in the kernel.
- Pipeline pop/fan-out/fan-in in the kernel.
- Channel, DM, mention, notification, or approval semantics in the kernel.
- Marketplace/package discovery.
- Remote federation.

Those ideas may exist as endpoint implementations or SDK conventions, but they must not become kernel ontology during the prototype.
