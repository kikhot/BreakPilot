# BreakPilot MCP 工具参考

语言：[English](mcp-tools.md) | 中文

用 `breakpilot mcp serve` 启动 Agent-facing stdio server。MCP、HTTP 与 CLI
共用控制层中的 15 个 `bp_debug_*` 工具和同一份语义结果。

## 返回契约

MCP 把语义对象放在 `structuredContent`。`content.text` 只是最长 160 字符的
单行摘要，不复制 JSON。成功结果直接返回业务字段；健康路径省略空集合、默认布尔值、
provider ID、provider 实现类名和完整证据元数据。

错误固定为：

```json
{"error":{"code":"INVALID_ARGUMENT","message":"Invalid arguments.","retrySafe":true,"actionMayHaveApplied":false}}
```

`hint` 可选。`detail="diagnostic"` 可以增加有界 `diagnostics`；compact 错误不公开
provider details。diagnostic 不增加变量深度，也不绕过脱敏、预算、policy 或能力门禁。

## 规范输入名

MCP 只公开 `projectPath`、`filePath`、`timeout`、`depth`、`limit`、
`maxString`、`offset`、`handle`、`path`、`pauseId`、`detail`，以及
`sessionId/action/threadId/frameIndex/expression` 和断点选项等操作专属字段。

已删除的 MCP 别名：`workspace`、`file`、`timeoutMs`、`maxDepth`、`maxItems`、
`maxStringLength`、`objectFields`、`variablesReference`、`lang`、`start`、
`count`、`ref`。CLI 的 `--workspace/--file/--ref` 仍可用，但会在进入控制层前转换。

默认预算：

| 工具 | 有界默认值 |
|---|---|
| `context` | 5 个栈帧、10 个顶层值、`depth=0`、`maxString=200` |
| pause/wait/step/run-to-line | 10 个顶层值、`depth=0`、`maxString=200` |
| `frame` | 20 个顶层值、`depth=0`、`maxString=200` |
| `value(handle)` | `depth=1`、`limit=20`、`maxString=200` |

## Agent 语义类型

workspace 内源码使用项目相对路径；外部、archive 和 JRT 源码保留可复用的绝对路径或 URI。

```ts
interface AgentLocation {
  filePath: string;
  line: number;
  column?: number;
  function?: string;
}

interface AgentValue {
  name: string;
  value: string | number | boolean | null;
  type?: string;
  handle?: string;
  mutable?: true;
  redacted?: true;
  children?: AgentValue[];
  nextOffset?: number;
}
```

只有 provider 明确报告 primitive kind 且文本是规范字面量时，才转换为原生 JSON 标量；
不会仅凭字符串外观猜测。

`handle` 是 Core 生成的暂停期短 token，例如 `v1`，不会泄露 IDEA UUID 或 DAP numeric
reference。把它传给 `value` 或 `set_value`；resume、step、run-to-line、stop 或新暂停后，
旧 handle 稳定返回 `STALE_RUNTIME_HANDLE`。

## 15 个工具的 compact 结果

| 工具 | 默认语义结果 |
|---|---|
| `bp_debug_start` | `sessionId/state/startMode/target` |
| `bp_debug_run_configurations` | 规范化 `configurations` 和可运行 `runPoints` |
| `bp_debug_status` | 去重 `sessions`、可选 active session、`ideConnected` |
| `bp_debug_control` | resume/stop：`state`；pause/wait/step：`state/reason/at/locals/pauseId`；drain：`events` |
| `bp_debug_run_to_line` | `state/reached/target/at/pauseId/locals` |
| `bp_debug_threads` | `threads[{id,name,current?}]`，有下一页才返回 `nextOffset` |
| `bp_debug_call_stack` | `threadId/frames/pauseId`，有下一页才返回 `nextOffset` |
| `bp_debug_frame` | `frame/arguments/locals/fields/scopes/pauseId` |
| `bp_debug_value` | `value` 下的单个 `AgentValue` |
| `bp_debug_set_value` | `target/oldValue/newValue/applied/verified` |
| `bp_debug_eval` | `expression/value/type?/handle?` |
| `bp_debug_context` | `state/reason/at/stack/arguments/locals/fields/pauseId` |
| `bp_debug_set_breakpoint` | `id/at/verified/owner` 和实际启用的非默认选项 |
| `bp_debug_list_breakpoints` | `breakpoints` |
| `bp_debug_remove_breakpoint` | `id?/removed`，受保护时增加说明 |

只有部分结果才出现 `incomplete`、`warnings`、`nextOffset`、`nextCursor`。
`pauseId` 只在响应根节点出现一次，不在每个变量节点重复。

## 推荐流程

```json
{"tool":"bp_debug_status","arguments":{"projectPath":"/path/to/project"}}
{"tool":"bp_debug_start","arguments":{"mode":"ide","projectPath":"/path/to/project"}}
{"tool":"bp_debug_set_breakpoint","arguments":{"filePath":"src/App.java","line":42}}
{"tool":"bp_debug_control","arguments":{"action":"wait","timeout":30000}}
{"tool":"bp_debug_context","arguments":{}}
{"tool":"bp_debug_value","arguments":{"handle":"v1","depth":1,"limit":20}}
{"tool":"bp_debug_eval","arguments":{"expression":"order.total","mode":"readonly"}}
{"tool":"bp_debug_control","arguments":{"action":"stepOver"}}
{"tool":"bp_debug_control","arguments":{"action":"disconnect"}}
```

wait、pause、step、run-to-line 默认已经带有界位置和 locals；除非需要别的 frame 或更大预算，
不必再重复抓 frame。第一次全面观察使用 `context`，分页和深挖使用定向读取工具。

## 断点、事件与安全

创建断点使用 `filePath + line`；更新使用返回的 `breakpointId`。list 保留
`owner=agent|user`，便于 Agent 保护用户断点。remove 接受 `breakpointId` 或
`filePath + line`，受保护的用户断点返回真实保护结果。

`bp_debug_control(action="drainEvents")` 返回有序语义事件与 `nextCursor`，compact 页面
不重复 raw timestamp、session 和 provider envelope。

默认使用 `bp_debug_eval(mode="readonly")`。BreakPilot 强制执行项目边界、attach endpoint、
production policy、脱敏、输出预算、capability、断点 ownership 与 mutation verification。
部分观察只会返回 `incomplete/warnings`，不会伪装成完整暂停或修改成功。

真实 IDEA 项目下的全工具对比、token 指标和后续优化优先级见
[IDEA MCP 与 BreakPilot Agent 可读契约实测报告](idea-mcp-vs-breakpilot-agent-readable-report-2026-08-02.zh-CN.md)。
