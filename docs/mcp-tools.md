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

用途：读取当前暂停帧的 stack、scopes、locals、arguments 和对象字段。

输入：

```json
{
  "sessionId": "sess_001",
  "frameIndex": 0,
  "maxDepth": 3,
  "maxItems": 20,
  "maxStringLength": 1000
}
```

DAP 映射：`threads` -> `stackTrace` -> `scopes` -> `variables`。

安全点：深度、数量、字符串长度、敏感字段脱敏。

失败：`VARIABLE_TOO_LARGE`、`SESSION_NOT_FOUND`、adapter-specific variable failure。

## 6. `evaluate`

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

## 7. `continue_execution`

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

## 其他工具

| 工具 | 说明 | DAP/Bridge |
|---|---|---|
| `remove_breakpoint` | 删除 Agent 断点 | `setBreakpoints` 全量刷新 + `agent_remove_breakpoint` |
| `list_sessions` | 列出 session | 内部 SessionStore |
| `list_breakpoints` | 列出断点 | BreakpointManager |
| `step_over` | 单步跳过 | DAP `next` |
| `step_into` | 单步进入 | DAP `stepIn` |
| `step_out` | 单步跳出 | DAP `stepOut` |
| `disconnect` | 断开会话 | DAP `disconnect` |
| `ide_status` | 查看 IDE Bridge 在线状态 | Bridge registry |

## CLI 示例

```bash
debug-mcp serve --http-port 27890 --ide-bridge-port 27891
debug-mcp attach --lang python --host 127.0.0.1 --port 5678 --pretty
debug-mcp bp set --session sess_001 --file src/app.py --line 42 --pretty
debug-mcp wait --session sess_001 --timeout 30000 --pretty
debug-mcp snapshot --session sess_001 --depth 3 --max-items 20 --pretty
debug-mcp eval --session sess_001 --mode readonly order.customer.name --pretty
debug-mcp continue --session sess_001 --pretty
debug-mcp disconnect --session sess_001 --pretty
```
