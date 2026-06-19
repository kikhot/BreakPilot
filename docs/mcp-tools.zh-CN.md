# BreakPilot MCP 工具参考

语言：[English](mcp-tools.md) | 中文

BreakPilot 通过 `breakpilot-debugger` MCP server 暴露 Agent Runtime Debugger。
公开 agent-facing 工具统一使用 `bp_debug_` 前缀。旧的 DAP 风格工具名已从
MCP 路由中删除。

启动 MCP：

```bash
breakpilot mcp serve
```

HTTP 客户端可以先启动 hub：`breakpilot serve`，然后连接
`http://127.0.0.1:57987/stream`（Streamable HTTP）或
`http://127.0.0.1:57987/sse`（legacy SSE）。

## 协议入口

stdio adapter 接收按行分隔的 JSON-RPC：

| 方法 | 用途 |
|---|---|
| `initialize` | 返回 MCP 元数据和工具能力。 |
| `tools/list` | 返回公开的 `bp_debug_*` 工具。 |
| `tools/call` | 通过 `{ "name": "...", "arguments": {} }` 调用工具。 |
| `ping` | 健康检查。 |

工具结果的结构化数据只通过 `structuredContent` 暴露。`content` 文本只是简短
人类可读状态，不作为数据通道。成功响应直接返回工具的业务字段，不再包
`ok`、`data`、`auditId` 或空 `warnings`。失败响应返回
`{ "error": { "code": "...", "message": "...", "details": {} } }`。
`warnings` 仅在存在非致命告警时出现。

## 通用参数

所有 session 级工具的 `sessionId` 都可以省略。省略时，BreakPilot 会自动选择唯一
live session，或者唯一 paused session。多个候选时返回 `SESSION_AMBIGUOUS`，并附带
候选 session 列表。

新 API 使用简化参数名：

| 参数 | 含义 |
|---|---|
| `projectPath` | 可选项目路径；本轮预留给未来多项目路由。 |
| `filePath` | 源文件路径。 |
| `timeout` | 超时时间，单位毫秒。 |
| `ref` | frame/value 工具返回的不透明变量引用。 |
| `depth` | 对象递归展开深度。 |
| `limit` | 最大变量、栈帧或线程数量。 |
| `maxString` | 字符串预览最大长度。 |
| `expand` | `none`、`preview`、`shallow` 或 `deep`。 |

## 推荐流程

```json
{"tool":"bp_debug_start","arguments":{"mode":"attach","language":"python","host":"127.0.0.1","port":5678}}
{"tool":"bp_debug_set_breakpoint","arguments":{"filePath":"examples/python/app.py","line":12}}
{"tool":"bp_debug_control","arguments":{"action":"wait","timeout":30000}}
{"tool":"bp_debug_threads","arguments":{}}
{"tool":"bp_debug_call_stack","arguments":{"limit":20}}
{"tool":"bp_debug_frame","arguments":{"frameIndex":0,"expand":"preview","limit":20}}
{"tool":"bp_debug_value","arguments":{"path":["order","total"],"depth":1}}
{"tool":"bp_debug_eval","arguments":{"expression":"order.total","mode":"readonly"}}
{"tool":"bp_debug_control","arguments":{"action":"resume"}}
```

IDE 已暂停会话：

```json
{"tool":"bp_debug_start","arguments":{"mode":"ide","ideSessionId":"<ideSessionId>"}}
{"tool":"bp_debug_context","arguments":{"expand":"preview","limit":20}}
```

IDE run configuration 启动由 `bp_debug_start` 表达，但要求 IDE bridge 支持：

```json
{"tool":"bp_debug_start","arguments":{"projectPath":"/path/to/project","runConfigName":"DemoApplication"}}
```

当前 bridge 未实现该能力时，BreakPilot 返回明确 capability error，不静默 fallback。

## 工具列表

| 工具 | 用途 |
|---|---|
| `bp_debug_start` | 启动、附加或采纳调试会话。 |
| `bp_debug_status` | 查看 active session、live sessions 和简短 IDE 状态。 |
| `bp_debug_control` | pause、resume、wait、step、disconnect、stop、drainEvents。 |
| `bp_debug_run_to_line` | 运行到指定源码行。 |
| `bp_debug_threads` | 查看线程列表。 |
| `bp_debug_call_stack` | 查看指定线程调用链。 |
| `bp_debug_frame` | 查看指定栈帧变量。 |
| `bp_debug_value` | 按路径读取变量或展开 `ref`。 |
| `bp_debug_set_value` | provider 支持时修改变量值。 |
| `bp_debug_eval` | 表达式求值。 |
| `bp_debug_context` | 获取当前位置、调用栈和栈顶变量。 |
| `bp_debug_set_breakpoint` | 设置断点。 |
| `bp_debug_list_breakpoints` | 列出断点。 |
| `bp_debug_remove_breakpoint` | 按 id 或 file/line 删除断点。 |

## 关键工具

### `bp_debug_start`

支持 headless DAP launch/attach，以及 IDE session adopt。

常用参数：

| 参数 | 类型 | 说明 |
|---|---:|---|
| `mode` | string | `launch`、`attach` 或 `ide`。 |
| `language` | string | adapter id，例如 `python`、`node`、`typescript`、`java`。 |
| `program` / `filePath` | string | launch 目标；headless 下 `filePath` 可作为 `program`。 |
| `host`, `port` | string/number | attach endpoint。 |
| `runConfigName` | string | IDE run configuration 名称；需要 IDE bridge 支持。 |
| `ideSessionId`, `clientId` | string | IDE adopt mode 的会话选择参数。 |

### `bp_debug_control`

```json
{
  "sessionId": "optional",
  "action": "pause | resume | wait | stepOver | stepInto | stepOut | stop | disconnect | drainEvents",
  "threadId": 1,
  "timeout": 30000,
  "includeFrame": false
}
```

`wait` 和 step 类动作默认只返回 `status`、`reason` 和 `position`。需要变量时传
`includeFrame: true`，变量体积由 `expand`、`depth`、`limit` 和 `maxString` 控制。

### `bp_debug_run_to_line`

将当前调试会话运行到指定源码行。

```json
{
  "filePath": "src/App.java",
  "line": 42,
  "timeout": 30000,
  "includeFrame": true
}
```

Phase 1 只公开契约。真正运行能力会在后续阶段通过 IDE bridge 原生命令或临时断点 fallback 实现。

### `bp_debug_status`

默认 status 是紧凑 agent 视图：当前项目 live sessions 和简短 IDE bridge 状态。
它不返回 hub 诊断、语言能力明细、已结束 sessions、capabilities 或完整 IDE client 记录。

### `bp_debug_threads` / `bp_debug_call_stack`

`bp_debug_threads` 返回 provider 线程列表。`bp_debug_call_stack` 接收可选
`threadId` 和 `limit`，返回 frame 的 `index`、`id`、`filePath`、`line` 和 `function`。

### `bp_debug_frame`

返回 frame 元数据和分组变量。

```json
{
  "frameIndex": 0,
  "expand": "preview",
  "depth": 1,
  "limit": 20,
  "maxString": 2000
}
```

变量节点是有序数组，不是 map，因此重复变量名不会互相覆盖：

```json
{
  "name": "analysis",
  "value": "NameAnalysis(...)",
  "type": "HelloController$NameAnalysis",
  "path": ["analysis"],
  "ref": 7072
}
```

### `bp_debug_value`

支持两种读取方式：

```json
{"path":["analysis","score"]}
```

```json
{"ref":7072,"depth":1,"limit":20}
```

数组和 List 下标使用字符串路径，例如 `"0"`。`ref` 是不透明 token，不能解析，
只能原样传回。

### 断点工具

设置断点：

```json
{"filePath":"src/App.java","line":42,"condition":"count > 3"}
```

返回中包含 `breakpointId`、`filePath`、`line`、`verified`；源文件可读时包含 `lineText`。

删除断点可以按 id：

```json
{"breakpointId":"bp_123"}
```

也可以按位置：

```json
{"filePath":"src/App.java","line":42}
```

## 安全

BreakPilot 仍执行 workspace 边界、attach host/port、生产环境阻断、变量读取限制、
脱敏规则和 evaluate mode 限制。默认使用 `bp_debug_eval` 的 `mode: "readonly"`。
