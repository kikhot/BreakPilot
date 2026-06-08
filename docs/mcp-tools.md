# MCP 工具接口

统一成功格式：

```json
{
  "ok": true,
  "sessionId": "sess_001",
  "data": {},
  "warnings": [],
  "auditId": "audit_001"
}
```

统一失败格式：

```json
{
  "ok": false,
  "error": {
    "code": "BREAKPOINT_NOT_VERIFIED",
    "message": "Breakpoint was not verified by debug adapter",
    "details": {}
  },
  "auditId": "audit_002"
}
```

## 1. `debug_launch`

用途：通过 Debug Adapter launch 目标程序。

输入：

```json
{
  "lang": "python",
  "program": "examples/flask/app.py",
  "args": [],
  "cwd": ".",
  "mode": "headless",
  "owner": "mcp",
  "adapterCommand": "python",
  "adapterArgs": ["-m", "debugpy.adapter"]
}
```

DAP 映射：`initialize` -> `launch` -> `initialized` -> 后续 `configurationDone`。

安全点：workspace path、production marker、launch env。

失败：`ADAPTER_START_FAILED`、`LAUNCH_FAILED`、`WORKSPACE_VIOLATION`。

## 2. `debug_attach`

用途：attach 到已开启 debug 端口的 runtime。

输入：

```json
{
  "lang": "python",
  "host": "127.0.0.1",
  "port": 5678,
  "mode": "headless",
  "owner": "mcp"
}
```

Python debugpy 会映射为：

```json
{
  "connect": {
    "host": "127.0.0.1",
    "port": 5678
  },
  "justMyCode": true
}
```

DAP 映射：`initialize` -> `attach`。

安全点：host/port allowlist、forbidProduction、远程 attach 确认。

失败：`DEBUG_PORT_NOT_ALLOWED`、`ATTACH_FAILED`。

## 3. `set_breakpoint`

用途：设置 Agent-owned 断点，并在 IDE Bridge 在线时同步。

输入：

```json
{
  "sessionId": "sess_001",
  "file": "src/service/order.py",
  "line": 42,
  "condition": "order is not None",
  "requireVerified": false
}
```

DAP 映射：`setBreakpoints`。注意 DAP 对同一 source 是全量覆盖，所以 BreakpointManager 会按文件汇总后发送。

Bridge 消息：`agent_set_breakpoint`。

失败：`SESSION_NOT_FOUND`、`WORKSPACE_VIOLATION`、`BREAKPOINT_NOT_VERIFIED`。

## 4. `wait_for_breakpoint`

用途：等待 `stopped` event。

输入：

```json
{
  "sessionId": "sess_001",
  "timeoutMs": 30000
}
```

DAP 映射：监听 `stopped` event，记录 `threadId`。

Bridge 消息：`ide_breakpoint_hit`，用于通知插件展示确认框。

失败：`BREAKPOINT_TIMEOUT`、`TARGET_PROCESS_EXITED`。

## 5. `get_runtime_snapshot`

用途：读取当前暂停帧的渐进式运行时快照。默认返回低噪音的 `stackFrames`、`arguments`、`locals`、`receiver` 和对象 preview；需要完整上下文时再显式请求 `profile: "full"` 或自定义 category/scope。

输入：

```json
{
  "sessionId": "sess_001",
  "frameIndex": 0,
  "profile": "focused",
  "includeCategories": ["locals", "receiver"],
  "includeScopes": ["Locals"],
  "objectFields": "preview",
  "maxDepth": 1,
  "maxItems": 10,
  "maxStringLength": 1000
}
```

DAP 映射：`threads` -> `stackTrace` -> `scopes` -> `variables`。

跨语言 category：

| category | 说明 |
|---|---|
| `arguments` | 函数/方法参数 |
| `locals` | 当前帧局部变量 |
| `receiver` | `this` / `self` / 当前对象 |
| `closures` | JS/TS 闭包变量 |
| `globals` | 全局/模块级变量 |
| `statics` | Java/C# 等静态字段 |
| `module` | module/script scope |
| `runtime` | 内置、class/function/special/framework runtime |
| `other` | 未识别 scope |

profile：

| profile | 说明 |
|---|---|
| `focused` | 默认，读取 `arguments`/`locals`/`receiver`，对象只给 preview |
| `locals` | 更小输出，只读当前帧关键变量，不展开对象 |
| `custom` | 按 `includeCategories` / `includeScopes` 读取 |
| `full` | 恢复完整 scopes 输出，仍受 limits 限制 |

安全点：深度、数量、字符串长度、敏感字段脱敏。

失败：`VARIABLE_TOO_LARGE`、`SESSION_NOT_FOUND`、adapter-specific variable failure。

## 6. `inspect_variable`

用途：根据 snapshot 返回的 `variablesReference` 定向展开某个变量，避免为了看一个对象而请求 full snapshot。

输入：

```json
{
  "sessionId": "sess_001",
  "variablesReference": 7,
  "start": 0,
  "count": 20,
  "objectFields": "deep",
  "maxDepth": 1,
  "maxItems": 20
}
```

DAP 映射：`variables`。

## 7. `evaluate`

用途：在当前 frame 求值。

输入：

```json
{
  "sessionId": "sess_001",
  "expression": "order.customer.name",
  "mode": "readonly",
  "timeoutMs": 1000
}
```

DAP 映射：`evaluate`。

模式：

| 模式 | 说明 |
|---|---|
| `readonly` | 字段、属性、索引读取，禁止函数调用和赋值 |
| `guarded` | 后续白名单 getter |
| `unsafe` | 必须用户确认，默认策略禁止 |

失败：`EVALUATE_BLOCKED_BY_POLICY`、`EVALUATE_TIMEOUT`。

## 8. `continue_execution`

用途：继续执行暂停线程。

输入：

```json
{
  "sessionId": "sess_001",
  "threadId": 1
}
```

DAP 映射：`continue`。

安全点：必须经过 SessionCoordinator，避免 IDE/MCP 同时控制。

失败：`SESSION_OWNER_CONFLICT`、`SESSION_NOT_FOUND`。

## 9. `list_ide_sessions`

用途：列出已连接 IDEA/VS Code 插件上报的 IDE debug sessions。

输入：

```json
{
  "clientId": "ide_001",
  "workspace": "."
}
```

Bridge 来源：`ide_session_started`、`ide_session_paused`、`ide_session_resumed`、`ide_session_terminated`。

## 10. `adopt_ide_session`

用途：把用户已经在 IDE 中启动的 debug session 注册为 BreakPilot session。未传 `ideSessionId` 时，优先选择当前 workspace 下 active 且 paused 的 IDE session。

输入：

```json
{
  "ideSessionId": "idea_ab12",
  "mode": "ide",
  "owner": "hybrid"
}
```

成功后，`get_runtime_snapshot`、`set_breakpoint`、`continue_execution` 和 `step_*` 会自动走 IDE provider。IDE provider 的执行类命令默认弹用户确认框。

失败：`IDE_NOT_CONNECTED`、`IDE_SESSION_NOT_FOUND`、`WORKSPACE_VIOLATION`。

## 11. `get_active_breakpoint_context`

用途：快捷读取当前 IDE 暂停点。如果未传 `sessionId`，会先自动 adopt active paused IDE session。

输入：

```json
{
  "ideSessionId": "idea_ab12",
  "profile": "focused",
  "objectFields": "preview",
  "maxDepth": 1,
  "maxItems": 10
}
```

输出包含 `stopped`、`topFrame`、`snapshot`、`providerKind`。

## 其他工具

| 工具 | 说明 | DAP/Bridge |
|---|---|---|
| `remove_breakpoint` | 删除 Agent 断点 | `setBreakpoints` 全量刷新 + `agent_remove_breakpoint` |
| `list_sessions` | 列出 session | 内部 SessionStore |
| `list_ide_sessions` | 列出 IDE 上报的 debug session | Bridge registry |
| `adopt_ide_session` | 采纳 IDE 已有 debug session | IDE provider |
| `get_active_breakpoint_context` | 读取当前暂停点上下文 | IDE provider + snapshot |
| `list_breakpoints` | 列出断点 | BreakpointManager |
| `step_over` | 单步跳过 | DAP `next` 或 IDE command |
| `step_into` | 单步进入 | DAP `stepIn` 或 IDE command |
| `step_out` | 单步跳出 | DAP `stepOut` 或 IDE command |
| `inspect_variable` | 定向展开变量引用 | DAP `variables`；IDE provider 返回快照降级 |
| `disconnect` | 断开会话 | DAP `disconnect` 或 IDE detach/stop |
| `ide_status` | 查看 IDE Bridge 在线状态 | Bridge registry |

## CLI 示例

```bash
breakpilot serve --http-port 27890 --ide-bridge-port 27891
breakpilot attach --lang python --host 127.0.0.1 --port 5678 --pretty
breakpilot bp set --session sess_001 --file src/app.py --line 42 --pretty
breakpilot wait --session sess_001 --timeout 30000 --pretty
breakpilot snapshot --session sess_001 --profile focused --max-items 10 --pretty
breakpilot inspect-variable --session sess_001 --ref 7 --depth 1 --max-items 20 --pretty
breakpilot snapshot --session sess_001 --profile full --depth 2 --max-items 20 --pretty
breakpilot eval --session sess_001 --mode readonly order.customer.name --pretty
breakpilot continue --session sess_001 --pretty
breakpilot disconnect --session sess_001 --pretty
breakpilot ide sessions --pretty
breakpilot ide adopt --ide-session idea_ab12 --pretty
breakpilot ide context --ide-session idea_ab12 --profile focused --pretty
```
