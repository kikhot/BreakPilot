# BreakPilot MCP 工具接口参考

语言：[English](mcp-tools.md) | 中文

BreakPilot 通过名为 `breakpilot-debugger` 的 MCP stdio server 暴露 Agent Runtime Debugger。Agent 可以用它启动或附加本地调试目标、设置断点、检查暂停时的运行时状态、安全求值表达式，并与支持的 IDE 调试会话协作。

启动 MCP：

```bash
breakpilot mcp serve
```

## 协议入口

MCP stdio adapter 接收按行分隔的 JSON-RPC 消息。

| JSON-RPC 方法 | 作用 |
|---|---|
| `initialize` | 返回 MCP 协议元数据、server 名称 `breakpilot-debugger` 和 tools 能力。 |
| `tools/list` | 返回所有可调用 BreakPilot 工具定义及其 JSON Schema 输入。 |
| `tools/call` | 通过 `{ "name": "...", "arguments": { ... } }` 调用工具。 |
| `ping` | 健康检查，返回空对象。 |

`tools/call` 会把 BreakPilot JSON 响应作为 MCP text content 返回。如果工具响应中 `ok: false`，MCP 结果会标记为 `isError: true`。

## 统一响应格式

成功响应：

```json
{
  "ok": true,
  "sessionId": "sess_abc123",
  "data": {},
  "warnings": [],
  "auditId": "audit_abc123"
}
```

失败响应：

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "sessionId is required.",
    "details": {}
  },
  "auditId": "audit_abc123"
}
```

常见错误码包括 `SESSION_NOT_FOUND`、`ADAPTER_START_FAILED`、`ATTACH_FAILED`、`LAUNCH_FAILED`、`BREAKPOINT_NOT_VERIFIED`、`BREAKPOINT_TIMEOUT`、`EVALUATE_BLOCKED_BY_POLICY`、`DEBUG_PORT_NOT_ALLOWED`、`WORKSPACE_VIOLATION`、`IDE_NOT_CONNECTED`、`IDE_SESSION_NOT_FOUND`、`SESSION_OWNER_CONFLICT`、`POLICY_VIOLATION`、`UNSUPPORTED_LANGUAGE`、`INVALID_LANGUAGE_IDENTIFIER`、`INVALID_ARGUMENT` 和 `TOOL_FAILED`。

## 通用概念

`sessionId` 由 `debug_launch`、`debug_attach` 或 `adopt_ide_session` 返回，后续所有 session 级工具都需要它。

`lang` 是推荐的语言选择字段。内置 registry 默认包括 `python`、`node`、`typescript` 和 `java`，实际支持列表由 `list_supported_languages` 动态返回。`debug_launch` 在省略 `lang` 时可以从 `program` 扩展名推断语言；MCP 暴露的 `debug_attach` schema 不包含源文件路径，所以建议显式传入 `lang`。

`mode` 表示运行时协调模式：

| 值 | 含义 |
|---|---|
| `headless` | BreakPilot 直接控制 DAP session。launch/attach 默认值。 |
| `ide` | BreakPilot 采纳并查询 IDE 拥有的 debug session。 |
| `hybrid` | 协调 MCP 调用与 IDE bridge 状态。 |

`owner` 表示谁可以驱动执行：

| 值 | 含义 |
|---|---|
| `mcp` | MCP 拥有执行控制权。launch/attach 默认值。 |
| `ide` | IDE 拥有执行控制权。 |
| `hybrid` | 共享所有权，通常用于已采纳的 IDE session。 |

`objectFields` 控制变量展开：

| 值 | 含义 |
|---|---|
| `none` | 不展开对象子字段。 |
| `preview` | 保留对象 preview 和 `variablesReference`，但不抓取子字段。 |
| `shallow` | 展开一层对象字段。 |
| `deep` | 按 `maxDepth` 递归展开。 |

## 推荐调用流程

Headless DAP 调试：

```json
{"tool":"debug_launch","arguments":{"lang":"python","program":"examples/python/app.py"}}
{"tool":"set_breakpoint","arguments":{"sessionId":"<sessionId>","file":"examples/python/app.py","line":12}}
{"tool":"wait_for_breakpoint","arguments":{"sessionId":"<sessionId>","timeoutMs":30000}}
{"tool":"get_runtime_snapshot","arguments":{"sessionId":"<sessionId>","profile":"focused","objectFields":"preview"}}
{"tool":"inspect_variable","arguments":{"sessionId":"<sessionId>","variablesReference":7}}
{"tool":"evaluate","arguments":{"sessionId":"<sessionId>","expression":"order.customer.name","mode":"readonly"}}
{"tool":"continue_execution","arguments":{"sessionId":"<sessionId>"}}
{"tool":"disconnect","arguments":{"sessionId":"<sessionId>"}}
```

已暂停的 IDE 调试：

```json
{"tool":"ide_status","arguments":{}}
{"tool":"list_ide_sessions","arguments":{"workspace":"/absolute/workspace/path"}}
{"tool":"adopt_ide_session","arguments":{"ideSessionId":"<ideSessionId>","workspace":"/absolute/workspace/path"}}
{"tool":"get_active_breakpoint_context","arguments":{"sessionId":"<sessionId>","profile":"focused"}}
```

## 工具索引

| 工具 | 作用 |
|---|---|
| `debug_launch` | 通过 DAP adapter 启动目标程序。 |
| `debug_attach` | 通过 DAP adapter 附加到已有 debug target。 |
| `set_breakpoint` | 设置 agent-owned 源码断点。 |
| `wait_for_breakpoint` | 等待 stopped event。 |
| `get_runtime_snapshot` | 从暂停的 runtime 读取 stack frames 和 scoped variables。 |
| `inspect_variable` | 展开单个 `variablesReference`。 |
| `evaluate` | 按策略控制的风险模式求值表达式。 |
| `continue_execution` | 恢复暂停线程。 |
| `step_over` | 单步越过当前语句。 |
| `step_into` | 单步进入调用。 |
| `step_out` | 单步跳出当前帧。 |
| `remove_breakpoint` | 删除 agent-owned 断点。 |
| `list_breakpoints` | 列出某个 session 的断点。 |
| `list_sessions` | 列出活跃 BreakPilot sessions。 |
| `list_supported_languages` | 返回已注册 adapter 能力和可用性。 |
| `disconnect` | 断开 debug session 并清理 agent 断点。 |
| `ide_status` | 返回 IDE bridge 状态和已连接 clients。 |
| `list_ide_sessions` | 列出 IDE 上报的 debug sessions。 |
| `adopt_ide_session` | 将 IDE session 转为 BreakPilot session。 |
| `get_active_breakpoint_context` | 采纳或使用当前暂停 IDE session 并返回上下文。 |

## `debug_launch`

通过已注册 Debug Adapter Protocol adapter 启动目标程序。

schema 必填：无。实际使用中，应提供 `lang`，或提供能推断语言的 `program`；多数 adapter 还需要 `program`、`module`、`mainClass` 或 raw `dap` launch object。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `lang` | string | 否 | 推断 | 已注册语言标识，如 `python`、`node`、`typescript`、`java`。 |
| `program` | string | 否 | 无 | 程序路径；Java 下也可以是 main class 或用于推导 `mainClass` 的 `.java` 文件。传入时必须位于 workspace 内。 |
| `module` | string | 否 | 无 | Python module launch 的模块名。 |
| `args` | string[] | 否 | `[]` | 程序参数。 |
| `cwd` | string | 否 | workspace root | 传给 adapter 的运行工作目录。 |
| `env` | object | 否 | process env | adapter/target 的额外环境。类似生产环境的 env marker 可能被策略拦截。 |
| `mode` | string | 否 | `headless` | `headless`、`ide` 或 `hybrid`。 |
| `owner` | string | 否 | `mcp` | `mcp`、`ide` 或 `hybrid`。 |
| `adapterCommand` | string | 否 | adapter 默认/env | 覆盖 debug adapter 可执行命令。 |
| `adapterArgs` | string[] | 否 | adapter 默认 | 覆盖 adapter 进程参数。 |
| `dap` | object | 否 | 自动生成 | 原始 adapter-specific DAP launch 参数。仅在需要直接传入 adapter 原生设置时使用。 |

Adapter 说明：

| 语言 | launch 配置重点 |
|---|---|
| `python` | `{ program, module, args, cwd, env, justMyCode: true, stopOnEntry: false }` |
| `node` / `typescript` | `{ type: "pwa-node", request: "launch", program, args, cwd, env, sourceMaps: true }` |
| `java` | `{ request: "launch", mainClass, classpath: ".", cwd, args, stopOnEntry: true }`；支持 `vmArgs`、`javaPath`、`classpath` 和显式 `mainClass`。 |

示例：

```json
{
  "lang": "python",
  "program": "examples/python/app.py",
  "args": ["--port", "5000"],
  "cwd": ".",
  "mode": "headless",
  "owner": "mcp"
}
```

成功时 `data` 是 `SessionSummary`，包含 `sessionId`、`language`、`mode`、`owner`、`state`、`workspaceRoot`、`providerKind`、可选 IDE IDs 和 provider `capabilities`。

## `debug_attach`

附加到已运行的 target。target 可能是 DAP endpoint，也可能由 adapter 管理附加传输。

schema 必填：无。实际使用中应显式传 `lang`，因为 MCP 暴露的 attach schema 不包含用于语言推断的源路径。`host` 和 `port` 有语言相关默认值，但建议显式传入。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `lang` | string | 否 | 推断 | 已注册语言标识。MCP attach schema 未暴露源路径，建议显式传入。 |
| `host` | string | 否 | `127.0.0.1` | target host，必须被策略允许。Java attach 在未提供 host 时使用 `localhost`。 |
| `port` | number | 否 | Python `5678`，Node `9229` | target debug port，必须被策略允许。 |
| `mode` | string | 否 | `headless` | `headless`、`ide` 或 `hybrid`。 |
| `owner` | string | 否 | `mcp` | `mcp`、`ide` 或 `hybrid`。 |
| `adapterCommand` | string | 否 | adapter 默认/env | 覆盖 adapter 可执行命令。 |
| `adapterArgs` | string[] | 否 | adapter 默认 | 覆盖 adapter 进程参数。 |
| `dapHost` | string | 否 | 无 | 连接到已有 DAP server，而不是启动/使用 adapter transport。 |
| `dapPort` | number | 否 | 无 | 与 `dapHost` 一起使用的已有 DAP server port。 |
| `dap` | object | 否 | 自动生成 | 原始 adapter-specific attach 参数。 |

Adapter 说明：

| 语言 | attach 行为 |
|---|---|
| `python` | 可直接连接 debugpy DAP socket；也可通过 `debugpy.adapter` 附加。常用配置为 `{ connect: { host, port }, justMyCode: true }`。 |
| `node` / `typescript` | 使用 JS debug adapter：`{ type: "pwa-node", request: "attach", address, port, cwd, sourceMaps: true }`。 |
| `java` | 把 `host:port` 视为 JDWP endpoint，并委托给 Java bridge。port 必须是 `1..65535` 的整数。 |

示例：

```json
{
  "lang": "node",
  "host": "127.0.0.1",
  "port": 9229,
  "cwd": "."
}
```

成功时 `data` 与 `debug_launch` 一样，是 `SessionSummary`。

## `set_breakpoint`

设置 agent-owned 行断点，并同步到 runtime provider。对于 DAP session，BreakPilot 还会把断点变更广播给同一 workspace 的 IDE clients。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `sessionId` | string | 是 | 无 | launch、attach 或 adopt 返回的 debug session id。 |
| `file` | string | 是 | 无 | 源文件路径。会相对 workspace 解析，并必须通过 workspace 策略。 |
| `line` | number | 是 | 无 | 1-based 源码行号。 |
| `column` | number | 否 | 无 | 可选源码列。 |
| `condition` | string | 否 | 无 | 条件断点表达式。 |
| `hitCondition` | string | 否 | 无 | adapter-specific 命中次数条件。 |
| `logMessage` | string | 否 | 无 | adapter-specific logpoint 文本。 |
| `requireVerified` | boolean | 否 | `false` | 为 true 时，如果 adapter 未验证该断点，返回 `BREAKPOINT_NOT_VERIFIED`。 |

示例：

```json
{
  "sessionId": "sess_abc123",
  "file": "app/service/order.py",
  "line": 42,
  "condition": "order is not None",
  "requireVerified": true
}
```

成功数据：

```json
{
  "breakpoint": {
    "id": "bp_abc123",
    "sessionId": "sess_abc123",
    "file": "/absolute/path/app/service/order.py",
    "line": 42,
    "verified": true,
    "createdAt": "2026-06-16T00:00:00.000Z"
  },
  "breakpoints": []
}
```

## `wait_for_breakpoint`

等待目标 runtime 在断点或 step event 处暂停。Agent 工作流中应始终使用有限 timeout。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `sessionId` | string | 是 | 无 | Debug session id。 |
| `timeoutMs` | number | 否 | `30000` | 最大等待毫秒数。 |

示例：

```json
{
  "sessionId": "sess_abc123",
  "timeoutMs": 30000
}
```

成功数据包含 `stopped`，它是 DAP-style stopped event，通常带有 `reason`、`threadId`、`description`、`allThreadsStopped`；当 BreakPilot 从 stack trace 恢复错过的 stopped event 时，可能还包含 `topFrame`。

## `get_runtime_snapshot`

从暂停 session 读取渐进式 runtime snapshot。推荐先使用 `profile: "focused"` 与 `objectFields: "preview"`；在请求宽泛 `full` snapshot 前，优先用 `inspect_variable` 做定向展开。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `sessionId` | string | 是 | 无 | Debug session id。 |
| `threadId` | number | 否 | provider thread | 要检查的线程。 |
| `frameId` | number | 否 | 由 `frameIndex` 选择 | 直接检查的 DAP frame id。 |
| `frameIndex` | number | 否 | `0` | 未提供 `frameId` 时的 stack frame index。 |
| `profile` | string | 否 | `focused` | `focused`、`locals`、`full` 或 `custom`。 |
| `includeCategories` | string[] | 否 | 由 profile 决定 | `custom` snapshot 要包含的分类。 |
| `includeScopes` | string[] | 否 | 无 | 要包含的原始 adapter scope 名，例如 `Locals` 或 `Globals`。 |
| `objectFields` | string | 否 | 由 profile 决定 | `none`、`preview`、`shallow` 或 `deep`。 |
| `maxDepth` | number | 否 | policy/schema 默认 | 对象递归最大深度。schema 默认 `1`，policy 可能有更宽默认值。 |
| `maxItems` | number | 否 | policy/schema 默认 | 每个 scope/object 的最大变量数量。schema 默认 `10`，policy 可能有更宽默认值。 |
| `maxStringLength` | number | 否 | `2000` | 最大字符串预览长度。 |

Profiles：

| Profile | 行为 |
|---|---|
| `focused` | 包含 arguments、locals 和 receiver-like 值。Agent 默认推荐。 |
| `locals` | 类似 focused 分类，除非显式覆盖，否则 `objectFields: "none"`。 |
| `custom` | 只包含 `includeCategories` 或 `includeScopes` 指定内容。 |
| `full` | 包含所有 scope 分类，但仍受 limits 限制。 |

Scope categories：

| Category | 含义 |
|---|---|
| `arguments` | 函数或方法参数。 |
| `locals` | 所选 frame 的局部变量。 |
| `receiver` | `this`、`self` 或等价当前对象。 |
| `closures` | 闭包捕获变量。 |
| `globals` | 全局变量。 |
| `statics` | 静态字段。 |
| `module` | module/script scope。 |
| `runtime` | 内置、class/function、framework 或 runtime scopes。 |
| `other` | 无法分类的 scope。 |

示例：

```json
{
  "sessionId": "sess_abc123",
  "frameIndex": 0,
  "profile": "focused",
  "objectFields": "preview",
  "maxDepth": 1,
  "maxItems": 10
}
```

成功数据是 `RuntimeSnapshot`：

```json
{
  "sessionId": "sess_abc123",
  "source": "headless",
  "language": "python",
  "profile": "focused",
  "threadId": 1,
  "frameId": 7,
  "stackFrames": [],
  "variables": {
    "locals": {
      "name": "locals",
      "category": "locals",
      "rawScopes": ["Locals"],
      "expensive": false,
      "variables": {}
    }
  },
  "availableCategories": [],
  "omittedCategories": [],
  "availableScopes": [],
  "omittedScopes": [],
  "scopeMetadata": [],
  "limits": {
    "maxDepth": 1,
    "maxItems": 10,
    "maxStringLength": 2000
  }
}
```

序列化变量包含 `name`、`type`、`kind`、`valuePreview`、`value`、`variablesReference`、`truncated`，以及可选 `redacted`、`cycle`、`presentationError`。

## `inspect_variable`

展开 snapshot 或前一次变量检查返回的单个 DAP `variablesReference`。这是查看一个对象、数组、map 或 scope 的首选方式，可以避免为了一个对象请求完整 runtime snapshot。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `sessionId` | string | 是 | 无 | Debug session id。 |
| `variablesReference` | number | 是 | 无 | 要展开的 DAP variables reference。 |
| `start` | number | 否 | `0` | indexed variables 的起始偏移。 |
| `count` | number | 否 | 无 | 请求的子变量数量，也会影响 `maxItems`。 |
| `objectFields` | string | 否 | `deep` | `none`、`preview`、`shallow` 或 `deep`。 |
| `maxDepth` | number | 否 | `1` | 递归子字段深度。 |
| `maxItems` | number | 否 | `20` | 最大序列化子变量数。 |
| `maxStringLength` | number | 否 | `2000` | 最大字符串预览长度。 |

示例：

```json
{
  "sessionId": "sess_abc123",
  "variablesReference": 7,
  "start": 0,
  "count": 20,
  "objectFields": "deep",
  "maxDepth": 1
}
```

成功数据通常包含 `variablesReference`、`start`、`count` 和序列化 `variables` map。IDE provider 可能返回 provider-specific context。

## `evaluate`

在当前 debug frame 中求值表达式，并受策略风险模式控制。默认使用 `readonly`。在 `readonly` 模式下，BreakPilot 会拒绝函数调用、赋值、import/require、构造、delete、`await`、分号串联，以及超过策略长度限制的表达式。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `sessionId` | string | 是 | 无 | Debug session id。 |
| `expression` | string | 是 | 无 | 要求值的表达式。 |
| `mode` | string | 否 | policy 默认或 `readonly` | `readonly`、`guarded` 或 `unsafe`。 |
| `threadId` | number | 否 | provider thread | 线程上下文。 |
| `frameId` | number | 否 | current frame | frame 上下文。 |
| `timeoutMs` | number | 否 | policy timeout / `1000` schema | 求值超时毫秒数。 |

模式：

| Mode | 行为 |
|---|---|
| `readonly` | 仅用于属性、字段和索引检查。 |
| `guarded` | 预留给策略控制的更宽检查。 |
| `unsafe` | policy 要求时需要 IDE 显式确认；这种情况下 headless provider 会被拦截。 |

示例：

```json
{
  "sessionId": "sess_abc123",
  "expression": "order.customer.name",
  "mode": "readonly",
  "timeoutMs": 1000
}
```

成功数据包含 `{ "result": <adapter result>, "mode": "readonly" }`。

## `continue_execution`

继续执行暂停的 runtime thread。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `sessionId` | string | 是 | 无 | Debug session id。 |
| `threadId` | number | 否 | provider thread | 要继续的线程。 |

示例：

```json
{
  "sessionId": "sess_abc123",
  "threadId": 1
}
```

成功数据包含 provider `result`。对于 DAP session，session state 会切换为 `running`。

## `step_over`

在所选线程或 provider 默认线程中 step over 当前语句。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `sessionId` | string | 是 | 无 | Debug session id。 |
| `threadId` | number | 否 | provider thread | 要 step 的线程。 |

示例：

```json
{
  "sessionId": "sess_abc123",
  "threadId": 1
}
```

成功数据包含 provider step `result`；session 会进入 `running`，直到下一次暂停。

## `step_into`

在所选线程或 provider 默认线程中 step into 下一个调用。

参数和响应与 `step_over` 相同。

示例：

```json
{
  "sessionId": "sess_abc123"
}
```

## `step_out`

在所选线程或 provider 默认线程中 step out 当前 frame。

参数和响应与 `step_over` 相同。

示例：

```json
{
  "sessionId": "sess_abc123"
}
```

## `remove_breakpoint`

删除一个 agent-owned 断点。BreakPilot 会更新 runtime provider；对于 DAP session，还会把删除事件广播给已连接的 IDE clients。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `sessionId` | string | 是 | 无 | Debug session id。 |
| `breakpointId` | string | 是 | 无 | `set_breakpoint` 或 `list_breakpoints` 返回的 breakpoint id。 |

示例：

```json
{
  "sessionId": "sess_abc123",
  "breakpointId": "bp_abc123"
}
```

成功数据包含 `{ "removed": true }`；如果没有匹配的 BreakPilot-owned breakpoint，则是 `{ "removed": false }`。

## `list_breakpoints`

列出某个 session 的 BreakPilot-managed breakpoints。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `sessionId` | string | 是 | 无 | Debug session id。 |

示例：

```json
{
  "sessionId": "sess_abc123"
}
```

成功数据包含 `{ "breakpoints": [...] }`。

## `list_sessions`

列出活跃 BreakPilot sessions。

必填参数：无。

示例：

```json
{}
```

成功数据包含 `{ "sessions": [...] }`，每一项是 `SessionSummary`。

## `list_supported_languages`

报告已注册语言 adapter 和当前环境可用性。每个 adapter 会验证本地 toolchain，并把 availability warnings/errors 返回；普通依赖缺失不会被当作工具调用失败。

必填参数：无。

示例：

```json
{}
```

成功数据：

```json
{
  "languages": [
    {
      "language": "python",
      "displayName": "Python",
      "supportsAttach": true,
      "availability": {
        "available": true,
        "errors": [],
        "warnings": []
      }
    }
  ]
}
```

## `disconnect`

断开 debug session，清理 BreakPilot-owned breakpoints，从 session store 移除 session，并通知 IDE clients 清理 agent breakpoints。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `sessionId` | string | 是 | 无 | Debug session id。 |
| `terminateDebuggee` | boolean | 否 | `false` | provider 支持时，请求终止 target。 |
| `restart` | boolean | 否 | `false` | provider 支持时，请求 adapter restart 行为。 |

示例：

```json
{
  "sessionId": "sess_abc123",
  "terminateDebuggee": false
}
```

成功数据包含 `{ "disconnected": true, "result": ... }`。如果 adapter 未确认 disconnect，`warnings` 会包含提示，BreakPilot 仍会在本地清理 session。

## `ide_status`

返回 IDE bridge 状态和已连接的 IDE clients。

必填参数：无。

示例：

```json
{}
```

成功数据在 bridge 不可用时是 `{ "enabled": false, "clients": [] }`；否则返回 bridge status object 和已连接 clients。

## `list_ide_sessions`

列出已连接 IDE 插件上报的 debug sessions。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `clientId` | string | 否 | 所有 clients | 按 IDE client id 过滤 sessions。 |
| `workspace` | string | 否 | 所有 workspaces | 按 workspace 过滤。会相对 BreakPilot workspace root 解析。 |

示例：

```json
{
  "workspace": "/absolute/workspace/path"
}
```

成功数据包含 `{ "sessions": [...] }`。IDE session entries 由 VS Code / IntelliJ bridge 上报，通常包含 `clientId`、`ideSessionId`、`workspaceRoot`、`language`、`state` 和当前暂停元数据。

## `adopt_ide_session`

将已有 IDE debug session 采纳为 BreakPilot session。当用户已经在 VS Code 或 IntelliJ 中停在断点处，并希望 Agent 不启动单独 debuggee 而直接检查 runtime state 时使用。

schema 必填：无。实际使用中，应传入足够过滤条件以选中一个 IDE session。如果多个 session 活跃，传 `clientId` 和/或 `ideSessionId`。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `clientId` | string | 否 | 推断 | IDE bridge client id。 |
| `ideSessionId` | string | 否 | 推断 | IDE debug session id。 |
| `workspace` | string | 否 | selected session workspace | workspace filter。 |
| `lang` | string | 否 | IDE session language 或 `idea` | runtime language override。 |
| `mode` | string | 否 | `ide` | `ide` 或 `hybrid`。 |
| `owner` | string | 否 | `hybrid` | `ide` 或 `hybrid`。 |

示例：

```json
{
  "ideSessionId": "idea_ab12",
  "workspace": "/absolute/workspace/path",
  "mode": "ide",
  "owner": "hybrid"
}
```

成功数据是 `SessionSummary`。如果同一个 IDE session 已经被采纳，BreakPilot 会返回已有 `sessionId` 并带 warning。

## `get_active_breakpoint_context`

采纳或使用当前暂停的 IDE session，并返回当前 breakpoint context。这是“检查 IDE 里当前暂停位置”的最快单次调用。

schema 必填：无。实际使用中，传 `sessionId` 表示使用已采纳 IDE session；否则传入足够 IDE 过滤条件来识别当前活跃暂停 session。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---:|---:|---|---|
| `sessionId` | string | 否 | 自动采纳 | 已有 BreakPilot session id。 |
| `clientId` | string | 否 | 推断 | 自动采纳时的 IDE client filter。 |
| `ideSessionId` | string | 否 | 推断 | 自动采纳时的 IDE session filter。 |
| `workspace` | string | 否 | 推断 | workspace filter。 |
| `timeoutMs` | number | 否 | `1000` | snapshot 前短暂等待 IDE stopped/breakpoint event。 |
| `frameIndex` | number | 否 | `0` | 用于 `topFrame` 的 stack frame index。 |
| `profile` | string | 否 | `focused` | Snapshot profile。 |
| `objectFields` | string | 否 | `preview` | Snapshot object expansion。 |
| `maxDepth` | number | 否 | `1` | Snapshot object depth。 |
| `maxItems` | number | 否 | `10` | Snapshot item limit。 |
| `maxStringLength` | number | 否 | `2000` | Snapshot string limit。 |

示例：

```json
{
  "workspace": "/absolute/workspace/path",
  "profile": "focused",
  "objectFields": "preview",
  "timeoutMs": 1000
}
```

成功数据：

```json
{
  "stopped": null,
  "topFrame": {},
  "snapshot": {},
  "ideSessionId": "idea_ab12",
  "providerKind": "ide"
}
```

## 安全建议

保持本地、授权的调试范围。BreakPilot policy 会检查 workspace path、允许的 attach host/port、类似生产环境的标记、变量 limits、脱敏规则和 evaluate mode。推荐：

- 先用 `profile: "focused"`，再考虑 `profile: "full"`；
- 先用 `inspect_variable`，再考虑宽泛对象展开；
- `evaluate` 默认使用 `mode: "readonly"`；
- 使用较短、明确的 `timeoutMs`；
- 收集证据后调用 `disconnect` 或 `remove_breakpoint` 清理。
