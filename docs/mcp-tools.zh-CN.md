# BreakPilot MCP 工具参考

语言：[English](mcp-tools.md) | 中文

BreakPilot 通过 `breakpilot-debugger` MCP server 暴露 Agent Runtime Debugger。
新的公开 agent-facing 工具统一使用 `bp_debug_` 前缀。旧的 DAP 风格工具名
在迁移期可作为内部兼容 handler 保留，但不再通过 `tools/list` 暴露。

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

成功响应仍使用统一 control-plane envelope：
`{ "ok": true, "sessionId": "...", "data": {}, "warnings": [] }`。
失败响应使用 `{ "ok": false, "error": { "code": "...", "message": "...", "details": {} } }`。

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
| `bp_debug_status` | 查看 sessions、active session、IDE 状态和语言能力。 |
| `bp_debug_control` | pause、resume、wait、step、disconnect、stop、drainEvents。 |
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
  "timeout": 30000
}
```

`wait` 和 step 类动作会尽量返回当前 `status`、`position` 和轻量 `frame` 摘要。

### `bp_debug_threads` / `bp_debug_call_stack`

`bp_debug_threads` 返回 provider 线程列表。`bp_debug_call_stack` 接收可选
`threadId` 和 `limit`，返回 frame 的 `index`、`id`、`filePath`、`line`、
`function`、`presentation`。

### `bp_debug_frame`

返回 frame 元数据、分组变量和可读 `presentation`。

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
  "label": "analysis = NameAnalysis(...)",
  "type": "HelloController$NameAnalysis",
  "kind": "object",
  "value": { "summary": "NameAnalysis[...]", "raw": null },
  "ref": 7072,
  "expandable": true,
  "truncated": false,
  "children": []
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

返回中包含 resolved breakpoint record；源文件可读时包含 `lineText`。

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
