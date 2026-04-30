# Kairos IPC Intent Specification (v2.0)
## 1. 核心架构与设计原则
 * **微内核哲学 (Microkernel Architecture)**：
   * **内核层 (Rust)**：作为无状态、无情的纯粹消息总线（Message Bus）。只解析 Header 进行路由调度，绝对不反序列化或干涉 Payload，不知晓“业务逻辑”或“工具调用”的存在。
   * **用户态层 (TypeScript SDK)**：作为智能代理。负责承载业务代码、处理类型反射、生成说明书，以及进行 MIME 阻抗匹配。
 * **信封模式 (Envelope Pattern)**：组件间通信基于不可变的封套结构传递。
 * **无状态路由 (Stateless Routing)**：Kernel 不维护 Pipeline 的执行状态，所有接力上下文均由 header.routing_slip 隐式携带。
 * **URI 寻址 (URI Addressing)**：所有组件（Agent, Plugin, Kernel）均拥有统一的标识（如 agent://session_01/main, plugin://system/fs）。存在即安装。
 * **代码即契约 (Code as Schema)**：抛弃死板的 JSON Schema，节点能力通过原生 TypeScript Interface 签名向 Agent 暴露，实现大模型原生的 Vibe Coding。
## 2. 数据结构定义 (Envelope Structure)
一个标准的 Intent Message 必须包含三个顶层对象：header, spec, payload。
### 2.1 Header Object (内核路由层)
由 Kernel 强校验并负责处理。

| Key | Type | Required | 描述与边界情况 (Edge Cases) |
| :--- | :--- | :--- | :--- |
| msg_id | String | Yes | 全局唯一消息 ID (推荐 ULID)。仅用于系统级日志追踪，业务不依赖。 |
| correlation_id | String | No | 关联上下文 ID。用于挂起和唤醒 Promise，或标识一条持续的流水线。 |
| source | String | Yes | 发送方的 URI。 |
| target | String | Yes | 目标接收方的 URI。Kernel 根据此字段投递。 |
| reply_to | String | No | **核心路由字段**。当前节点执行完毕后，结果应发送到的下一跳 URI。 |
| routing_slip | Array | No | **隐式管道栈**。存储未来需要经历的节点 URI。**注**：常规完成时必须 pop()；若遇到 EMIT（流），则**不** pop() 而是直接复制给下一跳。 |
| ttl_ms | Integer | Yes | 消息存活时间（毫秒）。超时则 Kernel 自动销毁并回退超时错误。 | <br> ### 2.2 Spec Object (动作规约层) <br> 面向目标组件，定义通信原语。
| Key | Type | Required | 描述 |
| :--- | :--- | :--- | :--- |
| op_code | String | Yes | **核心操作码**。严格枚举值： <br> CALL: 发起常规单次调用 <br> RESOLVE: 单次调用成功返回 <br> REJECT: 执行失败，立刻退回终点 <br> PIPELINE_SPAWN: 向 Kernel 申请建立拓扑 <br> EMIT: **持续原子流推送**（不弹栈） <br> END: 流式推送彻底结束（触发弹栈释放） <br> CANCEL: 订阅方主动阻断流发出的指令 |
| action | String | No | 具体的函数名（如 read_file）。仅在 CALL 时必须。 | <br> ### 2.3 Payload Object (数据载荷层) <br> 完全由 SDK 与业务端点解析，Kernel 视其为黑盒。
| Key | Type | Required | 描述 |
| :--- | :--- | :--- | :--- |
| mime_type | String | Yes | 数据格式声明（如 application/json, text/typescript）。Node SDK 会自动拦截不匹配的 MIME 并抛出 REJECT。 |
| data | Any | Yes | 实际数据。报错时内存放 Error JSON。 |

## 3. 标准自省协议 (Introspection)
系统不存在外置文档。所有节点必须隐式支持 action: "manifest"，大模型通过此系统调用获取使用手册。
**Agent 的查询报文:**
```json
{
  "header": { "source": "agent://01", "target": "plugin://system/fs", "reply_to": "agent://01" },
  "spec": { "op_code": "CALL", "action": "manifest" },
  "payload": { "mime_type": "application/json", "data": {} }
}
```
**Node SDK 拦截并反射生成的响应:**
```json
{
  "header": { "target": "agent://01" },
  "spec": { "op_code": "RESOLVE" },
  "payload": {
    "mime_type": "text/typescript",
    "data": "interface FS {\n  /** \n   * 读取文件 \n   * @accepts application/json\n   * @returns text/plain \n   */\n  read_file(payload: { path: string });\n}"
  }
}
```
## 4. 核心流转机制与标准用例 (Examples)
### 场景 A：隐式管道接力 (Pipeline Routing Slip)
Agent 声明一个 抓取 -> 翻译 -> 自己 的管道。
**Kernel 拦截 PIPELINE_SPAWN 编译后，发给第一棒 (Scraper) 的报文：**
```json
{
  "header": {
    "correlation_id": "pipe_01",
    "target": "plugin://scraper",
    "reply_to": "plugin://translator",      // 自动设为第二棒
    "routing_slip": ["agent://session_1"]   // 剩余的终点站
  },
  "spec": { "op_code": "CALL", "action": "execute" },
  "payload": {
    "mime_type": "application/json",
    "data": { "url": "https://example.com" }
  }
}
```
*执行成功后，Scraper SDK 执行弹栈 (pop)，将结果组装为 RESOLVE 扔给 Translator。*
### 场景 B：传染性原子事件流 (Infectious EMIT via Cron)
Agent 建立一个无限循环的任务：Cron节点 -> Scraper节点 -> Agent本身。
**1. Cron 节点发出的第一次滴答 (Tick)：**
*Cron 节点产出的是流，所以它发出 EMIT，SDK 特殊处理：**保留**当前的 routing_slip。*
```json
{
  "header": {
    "correlation_id": "daily_news",
    "source": "plugin://system/cron",
    "target": "plugin://scraper",
    "reply_to": "agent://session_1", // 依然保留
    "routing_slip": []               // 不进行 pop
  },
  "spec": { "op_code": "EMIT" },     // 注意：是 EMIT
  "payload": {
    "mime_type": "application/json",
    "data": { "timestamp": 1714260000, "url": "https://news.com" }
  }
}
```
**2. 中间件的“流态传染”：**
Scraper 本身是一个**普通的单次调用节点**，但当它的 SDK 发现收到的报文是 EMIT 时，魔法生效：
Scraper 抓取完毕后，SDK **不**打包成 RESOLVE，而是继续打包成 EMIT 投递给 reply_to。
```json
{
  "header": {
    "correlation_id": "daily_news",
    "target": "agent://session_1",
    "reply_to": null,
    "routing_slip": []
  },
  "spec": { "op_code": "EMIT" },      // 被上游传染为 EMIT
  "payload": {
    "mime_type": "text/html",
    "data": "<html>...新闻内容...</html>"
  }
}
```
*结果：Agent 每天都会收到一篇新的 HTML，直到 Agent 发送 CANCEL 掐断 Cron 节点。*
### 场景 C：管道中途崩溃 (Cascade Cancellation)
如果 Scraper API 挂了，系统强行打断所有接力。
*Plugin SDK 会立即清空 routing_slip，并强行将 target 设置为栈底的终点。*
```json
{
  "header": {
    "correlation_id": "pipe_01",
    "target": "agent://session_1", // 直接跃迁回 Agent
    "reply_to": null,
    "routing_slip": []             // 栈被强行清空
  },
  "spec": { "op_code": "REJECT" },
  "payload": {
    "mime_type": "application/json",
    "data": { "error": "Scraper Timeout", "node": "plugin://scraper" }
  }
}
```