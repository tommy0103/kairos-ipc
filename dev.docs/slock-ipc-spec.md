# Slock IPC Prototype Spec

## 0. 定位

本文档描述一个 Slock-like 的 IPC-native 协作产品原型。

它不是要复刻完整聊天产品，也不是要实现新的 agent framework。它要验证的是：

> Channel UI 可以只是 IPC message bus 的一个投影。Human、agent、app、plugin 都是平权 endpoint；agent 智能由现有 agent framework 通过 adapter 提供。

这个原型应基于 `IPC-roadmap.md` 中的 TypeScript MVP kernel，而不是 Rust kernel，也不依赖现有 VFS/taskTree。

## 1. 核心命题

传统 agent chat app 通常是：

```text
chat app owns conversation
agent is a bot inside chat app
tools are special callbacks owned by agent runtime
human approval is a UI exception
```

Slock IPC 原型希望验证另一种结构：

```text
IPC kernel owns only routing
channel is an app endpoint
human is an endpoint
agent is an endpoint
tools are plugin endpoints
approval is just another message flow
```

也就是说，Slock-like UI 不是系统中心；它只是把某些 IPC event 渲染成 channel、DM、thread 和 notification。

## 2. 非目标

Prototype 阶段不做：

- 不自研 agent loop。
- 不复刻完整 Slock 产品。
- 不实现多租户 SaaS。
- 不做复杂组织权限。
- 不做移动端。
- 不做完整搜索与长期记忆产品。
- 不把 taskTree 或 VFS 放进 IPC kernel。
- 不要求所有 agent framework 支持同一套内部状态模型。

Prototype 阶段只做一个 local-first slice。

## 3. 总体架构

```text
browser ui
  |
  | websocket / local http
  v
app://slock/ui-bridge
  |
  | IPC envelope
  v
app://slock/channel/general
  |
  | mentions / subscriptions / messages
  v
agent://local/pi-assistant
  |
  | tool bridge via IPC
  v
plugin://local/fs
plugin://local/shell
plugin://local/browser
plugin://memory/local

human://user/tomiya
```

### 3.1 IPC Kernel

Kernel 只负责：

- endpoint registry。
- envelope validation。
- routing。
- ttl。
- cancel。
- capability gate。
- trace。

Kernel 不知道：

- channel。
- message。
- mention。
- agent framework。
- tool call。
- approval。
- memory。

### 3.2 Channel App

Channel app 是一个普通 endpoint：

```text
app://slock/channel/general
app://slock/channel/dev
app://slock/dm/tomiya-pi
```

它负责：

- 接收 `post_message`。
- 保存短期 history。
- 向订阅者发送 `EMIT`。
- 根据 mention 规则把消息转发给 agent endpoint。
- 把 agent response 作为普通 message 广播。

Channel app 不负责：

- agent reasoning。
- tool execution。
- local machine permission。
- kernel routing。

### 3.3 Human Endpoint

Human 不是 UI callback，而是 endpoint：

```text
human://user/tomiya
```

Browser UI 是这个 endpoint 的 adapter。

它负责：

- 把用户输入包装成 IPC message。
- 渲染 channel `EMIT`。
- 处理 approval request。
- 处理 notification。

### 3.4 Agent Endpoint

Agent 是 endpoint，不是 kernel 概念：

```text
agent://local/pi-assistant
agent://local/researcher
agent://local/coder
```

Agent endpoint 内部可以使用任何 agent framework，例如 Pi、Pydantic AI、LangGraph、Mastra、AutoGen 或一个 mock agent。

Prototype 第一版不写自己的 agent loop，只写 adapter。

### 3.5 Plugin Endpoint

Tools 是普通 endpoint：

```text
plugin://local/fs
plugin://local/shell
plugin://local/browser
plugin://memory/local
```

Agent framework 的 tool call 通过 adapter 翻译成 IPC `CALL`。

## 4. Endpoint URI 规范

### 4.1 Human

```text
human://user/{user_id}
human://user/{user_id}/device/{device_id}
```

示例：

```text
human://user/tomiya
human://user/tomiya/device/macbook
```

### 4.2 Agent

```text
agent://local/{agent_id}
agent://workspace/{workspace_id}/{agent_id}
```

示例：

```text
agent://local/pi-assistant
agent://local/codex
agent://workspace/default/researcher
```

### 4.3 App

```text
app://slock/channel/{channel_id}
app://slock/dm/{dm_id}
app://slock/ui-bridge
```

示例：

```text
app://slock/channel/general
app://slock/dm/tomiya-pi
```

### 4.4 Plugin

```text
plugin://local/{plugin_id}
plugin://memory/{memory_id}
```

示例：

```text
plugin://local/fs
plugin://local/shell
plugin://local/browser
plugin://memory/local
```

## 5. Channel Actions

### 5.1 `post_message`

向 channel 或 DM 写入一条消息。

```json
{
  "header": {
    "msg_id": "msg_01",
    "source": "human://user/tomiya",
    "target": "app://slock/channel/general",
    "reply_to": "human://user/tomiya",
    "ttl_ms": 30000
  },
  "spec": {
    "op_code": "CALL",
    "action": "post_message"
  },
  "payload": {
    "mime_type": "application/vnd.slock.message+json",
    "data": {
      "text": "@pi summarize this repo",
      "mentions": ["agent://local/pi-assistant"],
      "thread_id": null
    }
  }
}
```

### 5.2 `subscribe`

订阅 channel event stream。

```json
{
  "header": {
    "msg_id": "msg_02",
    "source": "human://user/tomiya",
    "target": "app://slock/channel/general",
    "reply_to": "human://user/tomiya/device/macbook",
    "ttl_ms": 86400000
  },
  "spec": {
    "op_code": "CALL",
    "action": "subscribe"
  },
  "payload": {
    "mime_type": "application/json",
    "data": {}
  }
}
```

Channel 后续向订阅者发送：

```text
EMIT message_created
EMIT message_updated
EMIT typing_started
EMIT approval_requested
END subscription_closed
```

### 5.3 `history`

读取 channel 最近消息。

```json
{
  "header": {
    "msg_id": "msg_03",
    "source": "agent://local/pi-assistant",
    "target": "app://slock/channel/general",
    "reply_to": "agent://local/pi-assistant",
    "ttl_ms": 30000
  },
  "spec": {
    "op_code": "CALL",
    "action": "history"
  },
  "payload": {
    "mime_type": "application/json",
    "data": {
      "limit": 50,
      "before": null
    }
  }
}
```

## 6. Mention Flow

当 human 在 channel 中提到 agent：

```text
human://user/tomiya
  -> CALL post_message
  -> app://slock/channel/general
  -> EMIT message_created to subscribers
  -> CALL run to agent://local/pi-assistant
  -> agent emits response deltas
  -> channel broadcasts response
```

Channel app 负责把 mention 编译成 agent call。

```json
{
  "header": {
    "msg_id": "msg_04",
    "correlation_id": "conv_01",
    "source": "app://slock/channel/general",
    "target": "agent://local/pi-assistant",
    "reply_to": "app://slock/channel/general",
    "ttl_ms": 600000
  },
  "spec": {
    "op_code": "CALL",
    "action": "run"
  },
  "payload": {
    "mime_type": "application/vnd.slock.agent-run+json",
    "data": {
      "channel": "app://slock/channel/general",
      "message_id": "channel_msg_123",
      "text": "summarize this repo",
      "sender": "human://user/tomiya"
    }
  }
}
```

Agent 可以把 streaming response 发回 channel：

```json
{
  "header": {
    "msg_id": "msg_05",
    "correlation_id": "conv_01",
    "source": "agent://local/pi-assistant",
    "target": "app://slock/channel/general",
    "ttl_ms": 30000
  },
  "spec": {
    "op_code": "EMIT",
    "action": "message_delta"
  },
  "payload": {
    "mime_type": "application/vnd.slock.message-delta+json",
    "data": {
      "thread_id": "channel_msg_123",
      "text": "I found three main components..."
    }
  }
}
```

Agent 完成时发送 `RESOLVE`：

```json
{
  "header": {
    "msg_id": "msg_06",
    "correlation_id": "conv_01",
    "source": "agent://local/pi-assistant",
    "target": "app://slock/channel/general",
    "ttl_ms": 30000
  },
  "spec": {
    "op_code": "RESOLVE",
    "action": "run"
  },
  "payload": {
    "mime_type": "application/vnd.slock.agent-result+json",
    "data": {
      "summary": "Repository summary posted to channel.",
      "final_message_id": "channel_msg_124"
    }
  }
}
```

## 7. Agent Framework Adapter

Prototype 不自研 agent。Agent endpoint 是 adapter host。

### 7.1 Adapter 职责

Agent adapter 负责：

- 接收 IPC `CALL action=run`。
- 把 payload 转成具体 agent framework 的 session input。
- 把 framework event stream 转成 IPC `EMIT`。
- 把 framework final output 转成 IPC `RESOLVE`。
- 把 framework tool call 转成 IPC `CALL plugin://...`。
- 把 IPC tool result 写回 framework。
- 处理中断和 `CANCEL`。

Adapter 不负责：

- 不实现 reasoning algorithm。
- 不实现 planner。
- 不在 kernel 中注册 tool schema。
- 不把 agent framework 的内部状态暴露给 kernel。

### 7.2 Pi Adapter 草案

如果使用 Pi 作为第一个 agent framework，建议 endpoint 为：

```text
agent://local/pi-assistant
```

Adapter 内部结构：

```text
IPC CALL run
  -> Pi session input
  -> Pi event stream
  -> IPC EMIT message_delta / tool_call / tool_result / status
  -> IPC RESOLVE final
```

Pi tool bridge 可以先注入三个通用工具：

```text
ipc_call(target, action, payload)
ipc_request_approval(prompt, risk, proposed_call)
ipc_post_message(channel, text, thread_id)
```

这些工具内部都只是发送 IPC envelope。

### 7.3 Mock Agent Adapter

为了测试 kernel，应保留一个 mock agent：

```text
agent://local/mock
```

它不调用模型，只做 deterministic response：

- 收到 `run` 后 emit 两个 delta。
- 调一次 calculator plugin。
- 最后 resolve。

Mock agent 用于 CI 和协议回归测试。

## 8. Tool Bridge

Agent framework 的工具调用需要桥接到 IPC plugin endpoint。

### 8.1 Tool Call Mapping

Framework tool call：

```text
fs.read_file({ path: "README.md" })
```

映射为：

```json
{
  "header": {
    "source": "agent://local/pi-assistant",
    "target": "plugin://local/fs",
    "reply_to": "agent://local/pi-assistant",
    "ttl_ms": 30000
  },
  "spec": {
    "op_code": "CALL",
    "action": "read_file"
  },
  "payload": {
    "mime_type": "application/json",
    "data": {
      "path": "README.md"
    }
  }
}
```

IPC `RESOLVE` 再映射回 framework tool result。

### 8.2 Manifest

Plugin manifest 仍然是普通 action：

```text
CALL plugin://local/fs action=manifest
```

Agent adapter 可以在启动时读取 manifest，并转换成具体 framework 的 tool schema。

## 9. Human Approval Flow

危险操作必须经过 human endpoint。

### 9.1 示例：shell command approval

Agent 想执行：

```text
plugin://local/shell action=exec
```

如果 capability gate 发现需要 approval，agent 或 plugin 发起：

```json
{
  "header": {
    "msg_id": "msg_07",
    "correlation_id": "approval_01",
    "source": "agent://local/pi-assistant",
    "target": "human://user/tomiya",
    "reply_to": "agent://local/pi-assistant",
    "ttl_ms": 300000
  },
  "spec": {
    "op_code": "CALL",
    "action": "request_approval"
  },
  "payload": {
    "mime_type": "application/vnd.slock.approval-request+json",
    "data": {
      "risk": "shell_exec",
      "summary": "Run a local shell command to inspect the repository.",
      "proposed_call": {
        "target": "plugin://local/shell",
        "action": "exec",
        "payload": {
          "command": "ls -la"
        }
      }
    }
  }
}
```

Human approves：

```json
{
  "header": {
    "msg_id": "msg_08",
    "correlation_id": "approval_01",
    "source": "human://user/tomiya",
    "target": "agent://local/pi-assistant",
    "ttl_ms": 30000
  },
  "spec": {
    "op_code": "RESOLVE",
    "action": "request_approval"
  },
  "payload": {
    "mime_type": "application/vnd.slock.approval-result+json",
    "data": {
      "approved": true,
      "grant_ttl_ms": 60000
    }
  }
}
```

### 9.2 原则

- Approval 是普通 IPC flow，不是 UI 特例。
- Human approval 可以生成临时 capability。
- Approval request 必须包含 human-readable summary。
- 高风险 payload 可以隐藏敏感字段，但 trace 至少记录 risk、target、action。

## 10. Local Daemon

Local daemon 是 endpoint host，不是 kernel 本体。

它负责：

- 启动 agent adapters。
- 启动 local plugins。
- 管理 local config。
- 暴露 browser UI bridge。
- 连接 IPC kernel。

第一版可以把 kernel 和 daemon 放在同一个 Node.js 进程里，但逻辑边界必须清楚：

```text
kernel package: routing only
daemon package: starts endpoints
```

## 11. Minimal MVP

第一版只需要支持一个 workspace、一个 channel、一个 human、一个 agent、两个 plugin。

### 11.1 必需 Endpoint

```text
app://slock/channel/general
human://user/local
agent://local/mock
plugin://demo/calculator
plugin://local/shell
```

如果 Pi adapter 能快速接入，再增加：

```text
agent://local/pi-assistant
```

### 11.2 必需 Flow

MVP 必须跑通：

```text
human posts @agent in channel
channel emits message_created
channel calls agent run
agent emits response deltas
agent calls calculator plugin
agent posts final answer to channel
channel emits final message
```

带 approval 的增强 flow：

```text
agent wants shell exec
agent asks human approval
human approves
agent calls shell plugin
agent posts result
```

### 11.3 MVP Success Criteria

- Browser 能看到实时 channel stream。
- Human 发消息后，channel 通过 IPC 记录并广播。
- Mention 能触发 agent endpoint。
- Agent response 是 stream，而不是一次性文本。
- Agent tool call 通过 IPC plugin 执行。
- Shell exec 需要 human approval。
- Kernel 不包含 channel、agent、tool、approval 专用逻辑。
- Trace 可以复盘从 human message 到 agent tool call 再到 final answer 的完整链路。

## 12. Suggested Repository Slice

在独立 prototype 仓库中建议结构：

```text
kairos-ipc-prototype/
  packages/
    protocol/
    kernel/
    sdk/
    slock-channel/
    slock-ui-bridge/
    agent-adapter-mock/
    agent-adapter-pi/
    plugins-local/
  apps/
    slock-web/
    local-daemon/
  examples/
    slock-basic/
    slock-approval/
  specs/
    IPC-v0.md
    slock-ipc-spec.md
```

## 13. Implementation Order

推荐顺序：

1. TypeScript IPC kernel。
2. TypeScript SDK。
3. Mock endpoint test。
4. Channel endpoint。
5. Browser UI bridge。
6. Mock agent adapter。
7. Calculator plugin。
8. End-to-end channel mention demo。
9. Shell plugin。
10. Human approval flow。
11. Pi adapter。
12. Trace viewer。

不要先做 Pi adapter。先用 mock agent 确认 IPC + channel + stream + approval 的形状，再接真实 agent framework。

## 14. Trace Requirements

Slock IPC demo 的 trace 至少能回答：

- 谁发了原始 human message？
- 哪个 channel 收到了消息？
- 哪个 agent 被 mention 触发？
- agent 调用了哪些 plugins？
- 哪些操作请求过 human approval？
- human 是否 approve？
- final answer 是哪条 channel message？

默认 trace 不记录完整 message content，可记录：

- payload hash。
- payload size。
- source。
- target。
- action。
- correlation_id。
- risk class。

Debug 模式可以记录完整 payload。

## 15. Open Questions

- Channel 是否应该是 `app://...` endpoint，还是 `room://...` scheme？
- DM 是 channel 的一种，还是单独 endpoint type？
- Mention routing 应该由 channel app 负责，还是由独立 router endpoint 负责？
- Approval capability 应该由 human endpoint 直接签发，还是由 kernel capability manager 签发？
- Agent adapter 应该主动 post message，还是只返回 stream 给 channel，由 channel 负责落库？
- Long-term memory 是 agent 内部状态，还是 `plugin://memory/...`？
- Browser UI bridge 是否应该拥有 `human://...` URI，还是 human endpoint 与 device endpoint 分离？

## 16. 最小结论

Slock IPC prototype 的价值不在于做一个聊天 app，而在于证明：

```text
channel = message projection
human = endpoint
agent = endpoint adapter around existing framework
tool = plugin endpoint
approval = message flow
kernel = routing substrate only
```

如果这个 slice 跑通，Prototype IPC 的价值会比 echo/pipeline demo 更直观，因为它展示的是一个真实协作空间，而不是孤立协议能力。

