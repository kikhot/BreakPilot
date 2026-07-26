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

每个公开 output schema 都是具体的 success/error union。成功时直接返回当前工具
定义的顶层业务字段，例如：

```json
{"activeSessionId":"bp_...","sessions":[],"ideConnected":true,"ideSessions":[]}
```

失败时返回：

```json
{"error":{"code":"INVALID_ARGUMENT","message":"Invalid arguments for bp_debug_...","details":{"issues":[]}}}
```

`error.code` 和 `error.message` 必定存在；有机器可读上下文时放入
`error.details`。

## 校验、默认值与 detail

BreakPilot validates tool arguments before dispatch. Unknown fields, invalid
ranges, and ambiguous target modes return INVALID_ARGUMENT with issue details.
Successful payloads remain compact top-level objects. Each debug session reports
a provider capability matrix; callers must treat unsupported as authoritative.

公开输入对象采用封闭 schema。BreakPilot 在 session manager 和 provider 调用之前
完成校验，不修改调用方传入的对象；校验问题统一放在
`error.details.issues`，单项结构为 `{ "path", "keyword", "message" }`。
带 `oneOf` 的目标必须且只能命中一个分支。

默认值只在字段缺失时应用。重要默认值包括：`detail: "compact"`、
`frameIndex: 0`、线程/调用栈 `offset: 0`、断点 `enabled: true`、
`temporary: false`、`owner: "agent"`。start 路由会保留字段“未传入”的语义：
源码位置选择 IDE launch，host/port 选择 attach，其他情况选择 headless launch。
attach 内部仍会在 host 缺失时使用 `127.0.0.1`。显式 `mode` 具有最高优先级，
显式传入的值不会被 schema 默认值覆盖。

`detail: "compact"` 是默认的 agent 视图。对 `bp_debug_status` 传入
`detail: "diagnostic"`，会在 BreakPilot session 和 IDE session 摘要中增加
`providerKind` 与 `capabilities`。`bp_debug_start` 总是返回这两个字段，便于 agent
安全选择下一步操作。其他工具即使公开了 `detail`，也不会因此绕过参数校验、
安全策略或 capability gate。

## 通用参数

所有 session 级工具的 `sessionId` 都可以省略。省略时，BreakPilot 会自动选择唯一
live session，或者唯一 paused session。多个候选时返回 `SESSION_AMBIGUOUS`，并附带
候选 session 列表。

新 API 使用简化参数名：

| 参数 | 含义 |
|---|---|
| `projectPath` | 可选 workspace/project selector，用于 hub 的多项目路由。 |
| `filePath` | 源文件路径。 |
| `timeout` | 超时时间，单位毫秒。 |
| `ref` | frame/value 工具返回的不透明变量引用。 |
| `depth` | 对象递归展开深度。 |
| `limit` | 最大变量、栈帧或线程数量。 |
| `maxString` | 字符串预览最大长度。 |
| `expand` | `none`、`preview`、`shallow` 或 `deep`。 |

## Provider 能力矩阵

能力矩阵描述的是当前选中 live provider 的真实能力，而不是“公开工具是否存在”：

| 字段 | 取值 | 含义 |
|---|---|---|
| `pause`、`stepping`、`runToLine` | `native`、`fallback`、`unsupported` | 执行控制能力。 |
| `variableReferences` | `native`、`snapshot`、`unsupported` | 可使用 live reference 展开，或只能读取 IDE snapshot。 |
| `setValue` | `native`、`evaluateAssignment`、`unsupported` | 原生 mutation、赋值表达式模拟或不支持修改。 |
| `breakpointUpdate` | `native`、`fallback`、`unsupported` | 按已有 breakpoint id 更新/迁移。 |
| `conditionalBreakpoints`、`hitConditionalBreakpoints`、`tracepoints` | `native`、`fallback`、`unsupported` | 高级断点保真度。 |
| `eventDrain` | `native`、`fallback`、`unsupported` | 读取缓存的 debugger/tracepoint 事件。 |

当前 DAP session 的 pause、stepping 和 variable reference 固定为 native；变量修改
及高级断点只有在 adapter 明确声明时才是 native。DAP 的 run-to-line 只有在 live
adapter 声明 `gotoTargets`，且 BreakPilot 具备证明 fresh stop 的因果 DAP primitive
时才是 `native`。没有 native goto 时，只有 manager 已接线、可使用共享临时断点事务的
DAP session 才会声明 `fallback`；未接线/direct provider 仍为 `unsupported`。DAP 的
breakpoint update 使用完整 source reconciliation fallback，event drain 仍受能力 gate
控制。IDE 能力来自 live bridge；当前 IDEA 与 VS Code bridge 声明 native
run-to-line，以及 `evaluateAssignment` 形式的 set-value，其他能力必须由 bridge 明确声明。

manager 会在 dispatch 前强制执行该矩阵。pause、stepping、run-to-line、
variable-reference inspection、set-value、breakpoint update 和 event drain 为
`unsupported` 时，会在调用 provider 前返回 `UNSUPPORTED_CAPABILITY`，不会伪造成功。
创建断点时，`condition`、`hitCondition`、`logMessage` 也分别受
`conditionalBreakpoints`、`hitConditionalBreakpoints`、`tracepoints` gate。
尚无对应实现能力的高级语义（`enabled:false`、temporary、suspend policy、
log-message mode、log-stack mode）会在 mutation 前明确拒绝，不会静默忽略。
当 DAP fallback 被声明时，BreakPilot 会使用可见、事务性恢复的 temporary breakpoint，
而不会静默伪造“已到达目标行”。

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
| `bp_debug_run_configurations` | 列出 IDE run configuration 或可运行源码位置。 |
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
  "column": 1,
  "timeout": 30000,
  "includeFrame": true
}
```

只有 session 的 `runToLine` capability 不是 `unsupported` 时才应调用。返回值始终包含
`status`、`targetReached`、`requestedPosition` 与 `cleanedUp`。Agent 应以
`targetReached`，而不是仅以 `status:"paused"`，作为“确实到达请求位置”的依据。若 adapter
选择相邻可执行位置，会在 `resolvedPosition` 中明确返回；另一个 fresh stop 会返回
`paused + targetReached:false`，绝不会自动继续。终止事件返回
`stopped + targetReached:false`；fresh wait 超时返回 `timeout + targetReached:false`。

DAP 只有在 live adapter 可提供因果 target proof 时才使用原生 `gotoTargets`/`goto`。
否则，已由 manager 接线的 DAP session 可以使用 `fallback` 临时断点事务；它返回
`temporaryBreakpointId`，且仅在完整原始 source list 被 adapter 确认恢复后才返回
`cleanedUp:true`。若无法证明恢复，调用会返回 `RUN_TO_LINE_CLEANUP_FAILED` 与
`cleanupRequired:true`；Agent 应先检查/协调断点状态后再重试。

### `bp_debug_status`

默认 status 是紧凑 agent 视图：当前项目 live sessions 和简短 IDE bridge 状态。
它不返回 hub 诊断、语言能力明细、已结束 sessions、capabilities 或完整 IDE client
记录。传入 `detail: "diagnostic"` 后，每个 live BreakPilot/IDE session 摘要会增加
`providerKind` 与 capability matrix。

### `bp_debug_threads` / `bp_debug_call_stack`

`bp_debug_threads` 与 `bp_debug_call_stack` 都支持 `offset` 和 `limit`。
`threadId` 可以是 number，也可以是 opaque string。调用栈返回 frame 的
`index`、`id`、`filePath`、`line` 和 `function`；IDE provider 只能提供栈顶快照时，
结果可能标记为 `partial`。

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

### 断点设置、列表与删除

`bp_debug_set_breakpoint` 有且只有两个互斥 target mode。位置模式用于创建断点，
必须传 `filePath`（或兼容别名 `file`）与 `line`：

```json
{"filePath":"src/App.java","line":42,"condition":"count > 3","enabled":true,"owner":"agent"}
```

位置模式还接受 `hitCondition`、`logMessage`、`temporary`、`suspendPolicy`、
`isLogMessage`、`isLogStack` 和 `requireVerified`。只有 provider 声明相应 capability
时才会 dispatch `condition`、`hitCondition` 与 `logMessage`。其余高级语义虽然保留在
typed contract 中，但请求非默认行为时当前会返回 `UNSUPPORTED_CAPABILITY`，不会被
静默忽略；返回的 verification 仍描述 provider 实际确认的断点。

更新模式传 `breakpointId` 和待更新字段，但不能同时带 `filePath` 或 `line`：

```json
{"breakpointId":"bp_123","enabled":false}
```

该分支已经注册，以保证客户端可针对稳定契约做校验；但当前所有 provider 都声明
`breakpointUpdate: "unsupported"`，因此调用会返回 `UNSUPPORTED_CAPABILITY`，
不会假装更新成功。

返回中包含 `breakpointId`、`filePath`、`line`、`verified`；源文件可读时包含 `lineText`。

`bp_debug_list_breakpoints` 可以通过已连接 IDE 查询原生 breakpoint snapshot，并支持
`filePath`、`owner`、`includeDisabled` filter。没有可用 IDE bridge target 时可能返回
BreakPilot local project store；已经选中的 native query 若执行失败则仍返回明确错误。
所有 provider-specific 字段都不保证具有 IDEA 原生对象的完整保真度。

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
