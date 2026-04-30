# Kairos Prototype IPC Roadmap

## 0. 定位

Prototype IPC 是一个全新的 protocol/runtime 实验，不是现有 VFS kernel 的续作，也不是 taskTree 的重构。

它要验证的核心命题是：

> 一个极薄的 IPC kernel，只依赖 URI、Envelope、op_code、ttl、capability 和 trace，就可以支撑 human、agent、app、plugin 作为平权 endpoint 协作，而不需要理解 task、tool、memory、ReAct loop 或 VFS。

## 1. 设计原则

### 1.1 Kernel 原则

IPC kernel 应该保持冷、薄、无业务语义。

Kernel 只负责：

- endpoint registry：维护 URI 到连接的映射。
- envelope validation：校验 header/spec/payload 的最小结构。
- routing：根据 `header.target` 投递消息。
- ttl：处理消息过期。
- cancel：投递取消指令。
- capability gate：做最小权限检查。
- trace：记录可审计消息轨迹。

Kernel 不负责：

- 不理解 taskTree。
- 不理解 VFS。
- 不理解 tool calling。
- 不理解 ReAct / planner / reflection。
- 不反序列化或解释 `payload.data`。
- 不生成 manifest。
- 不执行 pipeline pop。
- 不维护 agent loop 状态。

### 1.2 Endpoint 原则

所有主体都通过同一种 envelope 通信：

- `agent://...`
- `human://...`
- `app://...`
- `plugin://...`
- `kernel://...`，仅用于 kernel 管理接口时使用。

它们在消息层平权，但在权限、信任、确认和副作用治理上不平权。

### 1.3 Prototype 原则

Prototype 阶段不要把 VFS、taskTree、memory、agent framework 与 IPC kernel 耦合。

现有 VFS/taskTree 可以继续作为某个 agent node 的内部实现策略，但不能进入 IPC kernel 的本体论。

## 2. 推荐仓库结构

建议新建独立目录，不放在当前 kairos-bench 项目内，例如：

```text
kairos-ipc-prototype/
  packages/
    protocol/          # Shared TypeScript envelope/types/helpers
    kernel/            # TypeScript MVP message bus
    sdk/               # TypeScript endpoint SDK
  examples/
    echo-plugin/
    calculator-plugin/
    cli-human/
    todo-app/
    simple-agent/
    pipeline-demo/
    stream-demo/
  specs/
    IPC-v0.md
    non-goals.md
    transport.md
  traces/
  scripts/
```

## 3. Phase 0: Spec 定界

目标：先把实验边界写死，避免 prototype 滑回 VFS 或 task runtime。

产物：

- `specs/IPC-v0.md`
- `specs/non-goals.md`
- `specs/transport.md`

### 3.1 IPC v0 最小协议

v0 envelope 保留三层结构：

```text
header
spec
payload
```

v0 `op_code` 保留：

- `CALL`
- `RESOLVE`
- `REJECT`
- `EMIT`
- `END`
- `CANCEL`

暂缓：

- `PIPELINE_SPAWN`
- fan-out / fan-in
- durable task runtime
- advanced scheduling
- remote federation

### 3.2 明确非目标

Prototype IPC 不是：

- VFS。
- taskTree runtime。
- memory system。
- agent framework。
- workflow engine。
- tool calling wrapper。
- app plugin marketplace。

它只是可寻址主体之间传递 intent message 的底座。

### 3.3 Transport 选择

建议 v0 使用：

```text
Unix socket + NDJSON
```

原因：

- 易调试。
- 易用 `tail` / `jq` / `nc` 观察。
- 不需要提前冻结 protobuf schema。
- 足够验证 protocol 语义。

后续可以增加 transport adapter：

- WebSocket
- stdio
- HTTP
- gRPC
- message queue

验收标准：

- 能用文档解释 IPC prototype 与 VFS prototype 的边界。
- 能用文档解释 kernel 与 SDK 的职责边界。
- 能用文档解释 human、agent、app、plugin 如何平权通信。

## 4. Phase 1: TypeScript Kernel MVP

目标：实现一个真正无业务语义的消息总线。

Prototype 阶段优先使用 TypeScript 写 kernel。原因不是 TypeScript 比 Rust 更适合最终形态，而是它能最快验证协议语义、endpoint ergonomics、trace 形状和 SDK 边界。Rust kernel 应该等协议边界稳定后再考虑重写或固化。

### 4.1 Kernel 模块

建议模块划分：

```text
packages/kernel/src/
  main.ts
  envelope.ts
  registry.ts
  router.ts
  capability.ts
  trace.ts
  transport/
    unix-ndjson.ts
packages/protocol/src/
  types.ts
  validate.ts
  ids.ts
```

### 4.2 Kernel 职责

Kernel MVP 需要实现：

- endpoint 连接。
- endpoint 注册一个或多个 URI。
- envelope 结构校验。
- `target` 不存在时返回 `REJECT`。
- `ttl_ms` 过期时返回 `REJECT`。
- 按 `target` 投递。
- 为每条消息写 trace JSONL。
- 连接断开时注销 endpoint。

### 4.3 Kernel 不做的事

MVP 阶段明确不要做：

- 不解析 `payload.data`。
- 不执行 action。
- 不知道 manifest。
- 不知道 pipeline。
- 不知道 stream 的业务含义。
- 不知道 task。
- 不知道 VFS。

### 4.4 验收标准

- 两个 mock endpoint 可以互发 `CALL` / `RESOLVE`。
- target 不存在时，source 收到 `REJECT`。
- ttl 过期时，source 或 `reply_to` 收到 `REJECT`。
- trace 文件能复盘完整消息路径。
- kernel 代码里没有 agent/tool/task/VFS 专用分支。

## 5. Phase 2: TypeScript SDK MVP

目标：把裸 envelope 变成 endpoint 作者愿意使用的 API。

### 5.1 最小 API 草案

```ts
const node = createNode("plugin://demo/echo");

node.action("echo", async (payload) => payload);

await node.connect("unix:///tmp/kairos-ipc.sock");

const result = await node.call("plugin://demo/echo", "echo", {
  mime_type: "application/json",
  data: { text: "hello" }
});
```

### 5.2 SDK 职责

SDK 负责：

- 自动生成 `msg_id`。
- 自动生成或延续 `correlation_id`。
- 维护 pending promise map。
- 包装 `CALL` / `RESOLVE` / `REJECT`。
- 默认实现 `manifest` action。
- 做 MIME accepts/returns 检查。
- 实现 routing slip 的 pop/forward。
- 实现 stream helper：`emit()`、`end()`、`cancel()`。
- 提供 debug mode 输出原始 envelope。

### 5.3 SDK 不做的事

- 不把 taskTree 做成 SDK 必需概念。
- 不把 ReAct loop 做成 SDK 必需概念。
- 不强制所有 endpoint 都是 plugin/tool。

### 5.4 验收标准

- 写 echo plugin 不需要手写 envelope。
- SDK debug 模式能看到原始 envelope。
- SDK 错误不会要求 kernel 修改语义。
- manifest 是 SDK convention，不是 kernel feature。

## 6. Phase 3: 平权 Endpoint Demo

目标：验证 human、agent、app、plugin 都能作为同一种 endpoint 协作。

### 6.1 Demo endpoints

实现四类 endpoint：

```text
plugin://demo/calculator
human://cli/operator
app://demo/todo
agent://demo/simple
```

### 6.2 Demo 场景

场景 A：agent 调 calculator。

```text
agent://demo/simple -> plugin://demo/calculator -> agent://demo/simple
```

场景 B：agent 请求 human approval。

```text
agent://demo/simple -> human://cli/operator -> agent://demo/simple
```

场景 C：agent 调 app 创建 todo。

```text
agent://demo/simple -> app://demo/todo -> agent://demo/simple
```

场景 D：human 直接调 app。

```text
human://cli/operator -> app://demo/todo
```

### 6.3 验收标准

- human 不是 UI callback，而是真 endpoint。
- app 不是 tool，而是真 endpoint。
- agent 不是特殊 orchestrator，而是真 endpoint。
- plugin 不是唯一被调用对象，而是真 endpoint。
- kernel 对四类 endpoint 完全无感。

## 7. Phase 4: Pipeline 与 Routing Slip

目标：验证线性 workflow 是否能由 envelope header 表达。

### 7.1 SDK API 草案

```ts
await agent.pipeline([
  "plugin://demo/fetch",
  "plugin://demo/translate",
  "agent://demo/main"
], {
  mime_type: "application/json",
  data: { url: "https://example.com" }
});
```

### 7.2 编译后的 envelope 语义

```text
target = plugin://demo/fetch
reply_to = plugin://demo/translate
routing_slip = ["agent://demo/main"]
```

### 7.3 规则

- 常规 `RESOLVE` 时，由 SDK pop routing slip。
- `REJECT` 时，由 SDK 清空 routing slip 并退回 origin 或 final receiver。
- Kernel 不参与 pop。
- Kernel 不知道 pipeline。

### 7.4 验收标准

- `fetch -> translate -> agent` 成功。
- `translate` 失败时直接回到 agent。
- trace 能看出 routing slip 如何变化。
- kernel 没有 pipeline-specific branch。

## 8. Phase 5: Stream / EMIT / END / CANCEL

目标：验证 cron、subscription、long-running app、human typing 等事件流。

### 8.1 Demo 场景

场景 A：ticker 直接推给 agent。

```text
plugin://demo/ticker -> agent://demo/stream-listener
```

场景 B：ticker 经过 transform。

```text
plugin://demo/ticker -> plugin://demo/transform -> agent://demo/stream-listener
```

### 8.2 规则

- `EMIT` 经过普通节点时保持流态。
- `EMIT` 不 pop routing slip。
- `END` 表示流彻底结束。
- `CANCEL` 从订阅方发回 stream owner。
- SDK 维护 stream subscription state。

### 8.3 验收标准

- agent 每秒收到 ticker。
- transform 可以处理每个 event。
- agent 发 `CANCEL` 后 ticker 停止。
- `END` 能释放 SDK 侧 stream state。
- kernel 不知道 ticker、transform 或 subscription 业务语义。

## 9. Phase 6: Capability 与 Identity

目标：给平权 endpoint 加上最小治理边界。

### 9.1 Capability 草案

```json
{
  "source": "agent://demo/main",
  "target": "app://demo/todo",
  "actions": ["create", "list"],
  "expires_at": "2026-04-28T12:00:00Z",
  "token": "..."
}
```

### 9.2 Kernel 检查

Kernel 只检查：

- source 是否允许发送给 target。
- `spec.action` 是否在允许 scope 内。
- capability 是否过期。
- token 是否有效。

### 9.3 暂缓内容

- 暂缓复杂 OAuth。
- 暂缓 multi-tenant federation。
- 暂缓细粒度 payload policy。
- 暂缓完整 cryptographic identity。

### 9.4 验收标准

- 没权限的 `CALL` 被 kernel 拒绝。
- 有权限但 action 不在 scope 时被拒绝。
- human endpoint 可以授予临时 capability。
- trace 中能看到拒绝原因。

## 10. Phase 7: Trace、Replay、Inspector

目标：让 protocol 可观察、可调试、可审计。

### 10.1 CLI 草案

```bash
ipc endpoints list
ipc trace tail
ipc trace show <msg_id>
ipc trace replay <correlation_id>
ipc caps list
```

### 10.2 Trace 字段

默认 trace 记录：

- timestamp
- msg_id
- correlation_id
- source
- target
- op_code
- action
- mime_type
- ttl_ms
- route result
- error reason
- payload hash
- payload size

默认不记录完整 payload。debug 模式可以开启 payload capture。

### 10.3 验收标准

- 一次 pipeline 可以完整复盘。
- 一次 stream 可以看到 `EMIT` / `END` / `CANCEL`。
- 一次权限拒绝可以定位原因。
- replay 可以重放无副作用 demo。

## 11. Phase 8: Agent Pattern Adapter

目标：证明 ReAct / planner / tool-use 是 agent node 内部策略，而不是 kernel 协议要求。

### 11.1 Demo endpoint

实现：

```text
agent://demo/react
```

它内部可以使用一个极简 loop：

```text
receive task
CALL manifest
CALL tool
observe RESOLVE / REJECT
repeat if needed
return RESOLVE
```

### 11.2 验收标准

- ReAct agent 可以动态读取 calculator manifest。
- ReAct agent 可以调用 calculator。
- ReAct agent 可以请求 human approval。
- ReAct agent 可以调用 app。
- ReAct agent 最终返回 caller。
- kernel 不需要为 ReAct 修改任何代码。

## 12. Optional Checkpoint: Rust Kernel 评估点

目标：在 TypeScript MVP 证明协议语义后，再决定是否需要 Rust kernel。

这不是默认实现步骤，而是一个 go/no-go checkpoint。

### 12.1 适合切到 Rust 的信号

- TypeScript kernel 的协议边界已经稳定。
- endpoint registry、routing、ttl、cancel、capability、trace 语义都经过 demo 验证。
- 性能、隔离、长期守护进程稳定性或嵌入式分发成为主要问题。
- 需要更强的资源控制、并发模型或系统级 socket/process 管理。

### 12.2 不应该切到 Rust 的信号

- envelope 字段仍频繁变化。
- pipeline / stream / capability 语义仍在摇摆。
- SDK ergonomics 还没稳定。
- 主要风险仍是产品抽象，而不是系统性能。

### 12.3 Rust 重写原则

如果重写 Rust kernel，它必须保持与 TypeScript MVP 完全相同的协议边界：

- 不理解 taskTree。
- 不理解 VFS。
- 不理解 agent loop。
- 不反序列化 `payload.data`。
- 不接管 SDK 的 manifest、pipeline pop 或 stream helper。

Rust 版本应该是 TypeScript MVP kernel 的实现替换，而不是语义扩张。

## 13. 建议实现顺序

推荐按以下顺序推进：

1. 写 `IPC-v0.md`。
2. 写 `non-goals.md`。
3. 写 `transport.md`。
4. 实现 TypeScript Unix socket NDJSON server。
5. 实现 endpoint register/connect。
6. 实现 raw envelope routing。
7. 实现 trace JSONL。
8. 实现 TS SDK connect/call/respond。
9. 实现 echo plugin demo。
10. 实现 manifest demo。
11. 实现 calculator plugin。
12. 实现 CLI human endpoint。
13. 实现 todo app endpoint。
14. 实现 simple agent endpoint。
15. 实现 SDK pipeline helper。
16. 实现 stream helper。
17. 实现 capability MVP。
18. 实现 trace inspector。
19. 实现 simple ReAct adapter。
20. 评估是否需要 Rust kernel rewrite。

## 14. Prototype 成功标准

Prototype IPC 成功的标志不是功能多，而是能演示以下场景，并且 kernel 不出现主体专用逻辑：

```text
human -> agent -> plugin -> agent -> human

agent -> app

agent -> human approval -> app

cron stream -> plugin transform -> agent

agent A -> agent B -> plugin -> agent A
```

这些场景全部共用同一种 envelope。

## 15. 最重要的架构边界

建议在 prototype README 第一屏写明：

```text
This prototype is not a VFS, not a task runtime, and not an agent framework.
It is a message substrate for addressable actors.
```

中文表述：

```text
这不是文件系统，不是任务系统，也不是 agent 框架。
这是一个让可寻址主体互相传递意图的消息底座。
```

这条边界是 prototype 最重要的保护线。

## 16. 与现有 VFS/taskTree 的关系

现有 VFS/taskTree 可以继续存在，但它属于某个 agent node 或 runtime node 的内部实现策略。

IPC kernel 不应该知道：

- taskTree。
- workspace。
- plan/explore。
- resume/sleep。
- task log。
- VFS path semantics。

未来如果 taskTree 被证明足够通用，可以把它提升为：

```text
agent://system/task-supervisor
```

或：

```text
plugin://system/tasks
```

但这是 endpoint 产品化选择，不是 IPC kernel 的协议要求。
