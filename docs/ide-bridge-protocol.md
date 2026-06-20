# IDE Bridge JSON 协议

传输：localhost WebSocket，默认 `ws://127.0.0.1:57987/bridge`，由 BreakPilot hub 与 MCP Stream/SSE 共享同一个端口。

通用消息：

```json
{
  "id": "msg_001",
  "type": "agent_set_breakpoint",
  "timestamp": "2026-06-04T08:00:00.000Z",
  "sessionId": "sess_001",
  "clientId": "ide_001",
  "ideSessionId": "idea_ab12"
}
```

## 连接流程

1. IDE 插件连接 WebSocket。
2. Bridge 返回 `bridge_welcome`。
3. 插件发送 `ide_register`。
4. 插件发送 `ide_capabilities` 或在 register 中携带 capabilities。
5. 插件每 5 秒发送 `ide_heartbeat`。
6. 断线后插件重连，并重新发送 workspace 和 capabilities。
7. MCP 根据 workspaceRoot 和 clientId 做 session 映射。

## 消息类型

| 类型 | 方向 | 用途 |
|---|---|---|
| `ide_register` | IDE -> MCP | 注册 IDE、workspace、capabilities |
| `ide_heartbeat` | IDE -> MCP | 保活 |
| `ide_capabilities` | IDE -> MCP | 能力协商 |
| `ide_session_started` | IDE -> MCP | IDE debug session 启动 |
| `ide_session_paused` | IDE -> MCP | IDE session 暂停 |
| `ide_session_resumed` | IDE -> MCP | IDE session 继续运行 |
| `ide_session_stopped` | IDE -> MCP | 兼容旧协议的暂停事件 |
| `ide_session_terminated` | IDE -> MCP | IDE session 结束 |
| `ide_breakpoint_added` | IDE -> MCP | 用户或插件添加断点 |
| `ide_breakpoint_removed` | IDE -> MCP | 用户删除断点 |
| `ide_breakpoint_changed` | IDE -> MCP | 条件或位置变化 |
| `ide_breakpoint_hit` | IDE -> MCP | 命中断点 |
| `ide_stack_snapshot` | IDE -> MCP | IDE 调用栈快照 |
| `ide_variables_snapshot` | IDE -> MCP | IDE 变量快照 |
| `ide_command_result` | IDE -> MCP | continue/step/evaluate/stop 执行结果 |
| `agent_set_breakpoint` | MCP -> IDE | Agent 设置断点 |
| `agent_remove_breakpoint` | MCP -> IDE | Agent 删除断点 |
| `agent_request_variables` | MCP -> IDE | 请求 IDE 变量快照 |
| `agent_continue` | MCP -> IDE | 请求 continue |
| `agent_pause` | MCP -> IDE | 请求 pause |
| `agent_step_over` | MCP -> IDE | 请求 step over |
| `agent_step_into` | MCP -> IDE | 请求 step into |
| `agent_step_out` | MCP -> IDE | 请求 step out |
| `agent_evaluate` | MCP -> IDE | 请求 IDE evaluator 求值 |
| `agent_stop_debug` | MCP -> IDE | 请求停止 |
| `user_confirm_continue` | IDE -> MCP | 用户确认 |
| `user_reject_continue` | IDE -> MCP | 用户拒绝 |
| `user_request_ai_analysis` | IDE -> MCP | 用户主动要求 AI 分析 |
| `audit_event` | 双向 | 审计事件 |

## 示例

### `ide_register`

```json
{
  "type": "ide_register",
  "ide": "idea",
  "workspaceRoot": "/path/to/project",
  "capabilities": {
    "visualBreakpoints": true,
    "debugCommands": true,
    "confirmationDialog": true,
    "variableSnapshot": true,
    "provider": "xdebugger"
  }
}
```

### `ide_session_paused`

```json
{
  "type": "ide_session_paused",
  "clientId": "ide_001",
  "ideSessionId": "idea_ab12",
  "workspaceRoot": "/path/to/project",
  "name": "Debug Application",
  "state": "paused",
  "threadId": 0,
  "topFrame": {
    "id": 1234,
    "name": "XStackFrame",
    "line": 42,
    "source": {
      "path": "/path/to/project/src/App.java"
    }
  }
}
```

### `agent_set_breakpoint`

```json
{
  "type": "agent_set_breakpoint",
  "requestId": "ide_req_001",
  "sessionId": "sess_001",
  "ideSessionId": "idea_ab12",
  "workspaceRoot": "/path/to/project",
  "breakpoint": {
    "id": "bp_001",
    "file": "/path/to/project/src/app.py",
    "line": 42,
    "owner": "agent",
    "verified": true
  }
}
```

### `ide_breakpoint_hit`

```json
{
  "type": "ide_breakpoint_hit",
  "sessionId": "sess_001",
  "threadId": 1,
  "reason": "breakpoint",
  "description": "Paused on breakpoint"
}
```

### `agent_request_variables`

```json
{
  "type": "agent_request_variables",
  "requestId": "ide_snapshot_001",
  "sessionId": "sess_001",
  "ideSessionId": "idea_ab12",
  "options": {
    "maxDepth": 3,
    "maxItems": 20
  }
}
```

### `ide_variables_snapshot`

```json
{
  "type": "ide_variables_snapshot",
  "requestId": "ide_snapshot_001",
  "sessionId": "sess_001",
  "ideSessionId": "idea_ab12",
  "snapshot": {
    "source": "ide",
    "ide": "vscode",
    "threadId": 1,
    "frameId": 1001,
    "variables": {}
  }
}
```

### 用户确认

MCP 向 IDE 发送结构化确认请求。IDE 插件根据本地 Settings、项目 trusted 状态、session 级记忆和 allowlist 决定自动确认或弹出 modal。

```json
{
  "type": "agent_request_confirmation",
  "confirmationId": "confirm_001",
  "sessionId": "sess_001",
  "ideSessionId": "idea_ab12",
  "action": "readonly_evaluate",
  "actionKind": "safe_inspection",
  "riskLevel": "safe",
  "title": "Allow BreakPilot to inspect the paused debug state?",
  "description": "BreakPilot wants to read a field or expression from the paused frame. Function calls are blocked by policy.",
  "expressionPreview": "order[\"discount\"]",
  "sessionName": "Debug Application",
  "file": "/path/to/project/src/App.java",
  "line": 42,
  "rememberScopes": ["once", "project"]
}
```

字段约束：

- `actionKind`: `safe_inspection`、`debug_control`、`high_risk`、`breakpoint_management`。
- `riskLevel`: `safe`、`control`、`high`。
- `rememberScopes`: 当前请求允许的记忆范围。`safe_inspection` 默认 `once/project`，`debug_control` 默认 `once/session`，`high_risk` 默认只有 `once`。
- `expressionPreview` 只用于 UI 展示和 allowlist 匹配，真正执行的表达式仍随 `agent_evaluate` 请求发送。

IDE 用户确认后回传：

```json
{
  "type": "user_confirm_continue",
  "confirmationId": "confirm_001",
  "sessionId": "sess_001",
  "ideSessionId": "idea_ab12",
  "action": "continue",
  "rememberScope": "session"
}
```

拒绝时继续发送 `user_reject_continue`。IDE 自动确认也必须发送 `user_confirm_continue`，便于 MCP 侧保持同一审计路径。

## 多窗口、多 Agent、路径映射

- 多 IDE 窗口以 `clientId + workspaceRoot` 区分。
- 同 workspace 多窗口同时在线时，Hybrid 模式应选择 active debug session 的窗口为 primary。
- 多 Agent 同时请求同一 session 时，SessionCoordinator 对 continue/step/evaluate 加锁。
- 远程路径通过 policy 配置映射表，第一版仅本地路径。
- IDE 插件重连后应重新上报当前断点和 active debug sessions。
