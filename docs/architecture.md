# AI 可调用多语言运行时协同调试系统设计

## 1. 总体结论

整体可行。本质不是“AI 直接调用 IDE”，而是把 IDE Debugger、Debug Adapter、运行时调试协议抽象成 Agent 可调用、可审计、可确认的调试控制面。

推荐架构是：

- 对 Agent 暴露 MCP 和 CLI；
- 核心调试走 DAP Client；
- 语言差异交给 debugpy、js-debug、vscode-java-debug 等 Debug Adapter；
- IDE 插件只负责可视化、用户确认、变量面板和用户操作回传；
- SessionCoordinator 统一仲裁 owner，避免 MCP 和 IDE 同时控制同一个 session。

第一版应该优先 Headless MCP + CLI，再做 VS Code 最小协同。IntelliJ、Java、Docker/K8s、复杂变量树和回放属于后续阶段。

最大价值：Agent 可以基于真实运行时对象定位问题，而不是只猜日志和静态代码。

最大风险：暂停进程、读取变量、evaluate 表达式都可能影响业务或泄露敏感信息，所以必须默认本地、非生产、策略限制、审计、用户确认。

## 2. 可行性分级

| 能力 | 等级 | 理由 |
|---|---:|---|
| MCP Server 启动调试会话 | P0 | 本仓库已实现 `debug_launch` 工具入口和 DAP 会话管理 |
| MCP Server attach 到已有 debug 端口 | P0 | 已实现 `debug_attach`，受 host/port policy 限制 |
| 通过 DAP 设置断点 | P0 | 已实现 `setBreakpoints` 映射 |
| 等待 breakpoint hit | P0 | 已实现 `stopped` event 等待 |
| 读取 stack trace | P0 | DAP 标准能力 |
| 读取 locals / arguments | P0 | 通过 scopes + variables 实现 |
| 读取对象字段 | P0 | 通过 variablesReference 递归展开 |
| 递归展开复杂对象 | P1 | 已有限制深度实现，复杂代理、懒加载需 PoC |
| evaluate 表达式 | P0 | 已实现工具入口 |
| readonly evaluate | P0 | 已有策略拦截明显副作用 |
| unsafe evaluate | P2 | 必须接 IDE 用户确认，第一版默认禁止 |
| continue | P0 | DAP `continue` |
| step over / into / out | P1 | 工具已接，具体 adapter 行为需验证 |
| VS Code 显示 Agent 设置的断点 | P1 | 插件骨架已通过 `vscode.debug.addBreakpoints` 表达 |
| IntelliJ IDEA 显示 Agent 设置的断点 | P2 | XDebugger API 可行，但语言插件差异大 |
| VS Code 命中断点后弹出确认框 | P1 | 插件骨架已设计，命中事件捕获需 DebugAdapterTracker PoC |
| IDEA 命中断点后弹出确认框 | P2 | XDebugSession 可行，变量读取异步复杂 |
| IDE 插件读取变量快照 | P2 | VS Code/IDEA 都依赖调试 API 和 adapter 差异 |
| Headless 模式变量读取 | P0 | 已实现 snapshot builder |
| IDE 协同模式变量读取 | P2 | 协议已定义，插件端需 PoC |
| TypeScript source map 断点映射 | P1 | js-debug 支持，需项目 sourceMap |
| Java pending breakpoint | P1 | Java adapter/IDE 支持，Headless 独立运行需验证 |
| Java 对象字段读取 | P1 | DAP/JDI 支持，getter/代理/懒加载需限制 |
| Python debugpy 支持 | P0 | 默认 adapter 命令 `python -m debugpy.adapter` |
| Node.js Inspector / js-debug 支持 | P1 | 需配置 js-debug adapter 路径 |
| Docker 调试 | P2 | 需要路径映射、端口映射、生命周期处理 |
| K8s port-forward 调试 | P2 | 可做，安全和 Pod 重建复杂 |
| 远程服务器 attach | P2 | 只建议 SSH tunnel，默认策略不开放 |
| 多 session | P1 | SessionStore 已支持，真实并发需压测 |
| 多线程 | P1 | DAP 支持 threads，线程选择策略需完善 |
| 多进程 | P2 | Python/Node adapter 差异较大 |
| Agent 自动修改代码后重新验证 | P1 | 调试系统提供上下文，改代码和测试由 Agent 执行 |
| 生产环境 attach | P3 | 默认禁止 |
| 任意语言统一无副作用 evaluate | P3 | 无法可靠保证 |
| 调试记录回放 | P2 | 可做审计和 snapshot 回放，非时间旅行调试 |
| 自动生成 bug 分析报告 | P1 | 基于审计日志和 snapshot 可生成 |

## 3. 前置假设

- 目标项目可以用 debug 模式启动。
- 本地或经授权隧道的 debug/DAP 端口可访问。
- 默认不是生产环境。
- 用户允许 Agent 在受控时间内暂停程序。
- Debug Adapter 已安装，或用户通过 `adapterCommand` 显式配置。
- Python 支持 debugpy。
- Node/TypeScript 支持 `--inspect` 或 js-debug adapter。
- TypeScript 项目开启 sourceMap。
- Java 项目支持 JDWP attach 或 Java Debug Adapter。
- MCP Server、IDE 插件运行在同一可信 workspace。
- 高风险 evaluate、远程 attach、长时间暂停必须经用户确认；低风险 inspection 可按项目记住，调试控制可按 debug session 记住。
- 本地 policy 文件可以限制 workspace、host、port、evaluate 和变量读取范围。

## 4. Not In Scope

- 第一版不支持生产环境 attach。
- 第一版不自动连接公网 debug 端口。
- 第一版不支持任意远程机器无授权调试。
- 第一版不做 Java 热更新。
- 第一版不做 C/C++/Rust 完整调试。
- 第一版不做完整时间旅行调试。
- 第一版不允许任意 unsafe evaluate。
- 第一版不保证所有 IDE 都能完整读取所有变量。
- 第一版不做企业权限中心，只做本地 policy 文件。
- 第一版不做复杂分布式链路调试。
- 第一版不允许 Agent 长时间暂停服务。

## 5. 能力矩阵

| 能力 | Headless MCP | VS Code 协同 | IntelliJ 协同 | Hybrid |
|---|---|---|---|---|
| 设置/删除断点 | DAP | IDE API + Bridge | XDebugger API + Bridge | DAP 为主，IDE 可视化 |
| 断点 IDE 可见 | 否 | 是 | 是 | 是，插件在线时 |
| 等待断点命中 | DAP stopped | IDE/Bridge 或 DAP | IDE/Bridge 或 DAP | DAP/IDE 双路，Coordinator 仲裁 |
| 读取调用栈 | DAP | IDE 或 DAP | IDE 或 DAP | 优先 DAP，必要时 IDE |
| 读取局部变量/对象字段 | DAP variables | 需 PoC | 需 PoC | Headless fallback |
| evaluate | DAP | IDE evaluate 或 DAP | IDE evaluate 或 DAP | readonly 走 DAP，高风险走确认 |
| continue/step | DAP | debug command | XDebugSession | 单一执行 owner |
| 用户确认 | CLI/policy 限制 | 弹窗 | 弹窗 | 推荐 |
| Agent 分析可视化 | 无 | Webview | Tool Window | 插件在线时 |
| 审计日志 | 有 | 有 | 有 | 有 |
| 用户删除断点同步 | 无 | onDidChangeBreakpoints | breakpoint listener | 有 |
| 多 session | 已建模 | 需 session 映射 | 需 session 映射 | 需仲裁 |
| fallback | 日志/测试 | Headless | Headless | 内置 |
| 适合场景 | CI、本地 Agent | 用户正在 VS Code 调试 | Java/IDEA 项目 | 产品化默认 |
| 不适合场景 | 需要用户可视化 | 无插件/无权限 | 无 JetBrains 插件 | 高安全生产环境 |

## 6. 核心角色区分

| 角色 | 做什么 | 不做什么 |
|---|---|---|
| Debug Adapter | 与运行时通信，暴露 DAP | 不做 Agent 策略和用户确认 |
| DAP Client | MCP 内部发送 initialize/launch/attach/setBreakpoints/variables/evaluate | 不直接理解业务代码 |
| IDE Debugger | IDE 原生调试系统 | 不对 Agent 暴露统一 API |
| IDE 插件 | 可视化断点、确认框、面板、同步用户操作 | 不绕过 SessionCoordinator 控制执行 |
| IDE Bridge | MCP 和插件之间的 JSON/WebSocket 通信层 | 不直接调试 runtime |
| MCP Server | 对 Agent 暴露工具，管理 session、policy、audit | 不自己实现 JDWP/Inspector/debugpy |
| CLI | 给人类或无 MCP Agent 使用 | 不替代持久 session daemon |
| Runtime | 被调试程序 | 不信任 Agent |

## 7. Session Ownership 模型

| Owner | 控制权 | 适用模式 | 规则 |
|---|---|---|---|
| `mcp` | MCP/DAP 控制 launch、breakpoint、continue、step、evaluate | Headless | IDE 只可旁观或显示同步 |
| `ide` | IDE Debugger 控制执行 | IDE 协同 | MCP 通过 Bridge 请求 IDE 操作 |
| `hybrid` | Coordinator 动态仲裁 | Hybrid | 同一时刻只允许一个 execution-control owner |

状态机：

```text
created -> initializing -> running -> paused -> running
                         \-> failed
paused -> terminated
running -> terminated
```

所有断点、continue、step、evaluate 都必须经过 SessionCoordinator。用户在 IDE 中 continue、删除断点、添加断点时，插件通过 Bridge 回传 `ide_*` 消息。Agent 断点和用户断点通过 `owner`、`breakpointId` 和 UI 标记区分。多 Agent 请求同一 session 时，执行类操作加锁，读操作可并发。

状态不一致时：

1. Bridge heartbeat 检测插件在线状态；
2. MCP 以 DAP session 状态为准；
3. IDE 插件重连后发送 capabilities、workspace、active sessions；
4. MCP 重新广播 agent-owned breakpoints；
5. 若 IDE owner 不可用，Hybrid 可降级 Headless。

## 8. 总体架构

```text
Claude/Codex/Cursor/Cline
        | MCP stdio / CLI / HTTP JSON
        v
+------------------------------+
| Protocol Adapters            |
| - src/mcp/stdioServer.ts     |
| - src/http/controlServer.ts  |
| - src/cli.ts + src/cli/      |
+--------------+---------------+
               |
               | shared control tools
               v
+------------------------------+
| Control Plane                |
| - src/control/ToolRouter     |
| - toolDefinitions            |
| - DebugSessionManager        |
| - SessionCoordinator         |
| - BreakpointManager          |
| - RuntimeSnapshotBuilder     |
| - SecurityPolicy             |
| - AuditLogger                |
+--------------+---------------+
               |
               | DAP requests/events
               v
+------------------------------+
| DAP Client                   |
| initialize/launch/attach     |
| setBreakpoints/stopped       |
| stackTrace/scopes/variables  |
| evaluate/continue/step       |
+------+-----------+-----------+
       |           |
       v           v
 debugpy      js-debug / java-debug
       |           |
       v           v
 Python       Node/TS/Java Runtime

               ^
               |
       localhost WebSocket
               |
+--------------+---------------+
| IDE Bridge                   |
+--------------+---------------+
               |
       +-------+--------+
       v                v
 VS Code Extension   IntelliJ Plugin
 Breakpoint UI       XDebugger UI
 Confirmation        Confirmation
 AI Debug Panel      Tool Window
```

对外使用 MCP 是为了让 Claude Code、Codex、Cursor、Cline、自研 Agent 用统一工具调用。保留 CLI 是为了人类、脚本和不支持 MCP 的 Agent。内部优先 DAP 是因为 DAP 已经屏蔽了 debugpy、JDWP/JDI、Node Inspector、Delve、gdb/lldb 的大量差异。第一版不建议直接实现 JDWP、CDP 或 pydevd，也不建议封装 `jdb`、`pdb`、`node inspect` 这类交互式 CLI，因为它们缺少稳定结构化事件、变量引用、断点验证和多 session 管理。

## 9. 三种运行模式

### Headless

```text
Agent -> MCP/CLI -> DAP Client -> Debug Adapter -> Runtime
```

适合 CI、本地脚本、无 IDE 插件场景。能设置断点、等待暂停、读栈和变量、readonly evaluate、continue/step。不显示 IDE 断点，确认只能通过 policy/CLI 或未来 TUI 实现。

### IDE 协同

```text
Agent -> MCP -> IDE Bridge -> IDE Plugin -> IDE Debugger -> Runtime
```

适合用户正在 IDE 中调试。IDE 负责显示断点、暂停状态、变量树和确认框。MCP 不直接抢执行控制。变量读取和断点命中事件依赖 IDE API，需按 VS Code/IDEA 分别 PoC。

### Hybrid

最终推荐模式。插件在线时同步断点和确认，DAP 仍保留 Headless fallback。Coordinator 保证 continue/step/evaluate 同一时刻只有一个 owner。

## 10. 技术选型

| 层 | 推荐 | 理由 |
|---|---|---|
| MCP Server | Node.js | 与 DAP、VS Code、WebSocket 生态贴近 |
| CLI | Node.js，共享核心逻辑 | 避免两套 session 管理 |
| 内部协议 | DAP | 多语言统一抽象 |
| Python | debugpy adapter | 成熟、DAP 支持好 |
| Node/TS | vscode-js-debug | 支持 Inspector、source map、async stack |
| Java | vscode-java-debug / JDI | 第一版后置 |
| VS Code 插件 | TypeScript | 官方扩展生态 |
| IDEA 插件 | Kotlin | JetBrains 平台主流 |
| IDE Bridge | localhost WebSocket | 双向、低延迟、插件易接 |
| 远程 | SSH tunnel、Docker exec、kubectl port-forward | 不暴露公网 debug 端口 |

不推荐：第一版直接实现 JDWP；直接封装 pdb/jdb/node inspect；只做 IDEA 插件；只做 VS Code 插件；让 Agent 直连裸 debug 端口；MCP 和 IDE 无协调地同时控制 session。

## 11. 变量序列化

统一格式：

```json
{
  "sessionId": "sess_001",
  "source": "headless",
  "threadId": 1,
  "frameId": 1001,
  "variables": {
    "Locals": {
      "variables": {
        "order": {
          "name": "order",
          "type": "Order",
          "kind": "object",
          "valuePreview": "Order(id=SO001)",
          "value": {},
          "truncated": false,
          "redacted": false
        }
      }
    }
  },
  "limits": {
    "maxDepth": 3,
    "maxItems": 50,
    "maxStringLength": 2000
  }
}
```

实现策略：

- 基本类型直接读 `value`；
- 对象、数组、Map、List 通过 `variablesReference` 按深度展开；
- 使用 `maxDepth`、`maxItems`、`maxStringLength` 限制；
- 使用 `variablesReference` 防循环；
- password、token、secret、key、authorization、cookie、credential 默认脱敏；
- 代理对象、懒加载对象、连接、socket、线程等只给摘要，避免触发副作用；
- Agent 先看摘要，再按需扩大深度或读取指定引用。

## 12. 表达式求值

| 模式 | 策略 | 第一版状态 |
|---|---|---|
| readonly | 字段、属性、索引读取，禁止调用函数和赋值 | 已实现基础拦截 |
| guarded | 白名单 getter，可配置 | 后续 |
| unsafe | 任意表达式，必须用户确认 | 默认禁止 |

DAP `evaluate` 的边界由 adapter 决定。Python、Node、Java 对表达式、上下文、超时、副作用的支持都不同，所以不能承诺“任意语言无副作用 evaluate”。所有 evaluate 都写审计日志，高风险必须走 IDE 确认。

## 13. 断点设计

当前实现普通行断点、条件、命中次数、logMessage 字段透传。DAP 映射：

- `setBreakpoints`
- `setFunctionBreakpoints`
- `setExceptionBreakpoints`
- `breakpoint event`
- `stopped event`
- `threads`
- `stackTrace`

TypeScript source map、Java pending breakpoint、异常断点、函数断点、临时断点、行号修正属于 P1/P2。Agent 断点通过 `owner: agent` 和 `breakpointId` 与用户断点区分。用户在 IDE 删除 Agent 断点时，插件应发 `ide_breakpoint_removed`。

## 14. 用户确认机制

IDE bridge 使用结构化确认请求，而不是只传裸 action 字符串。请求包含 `actionKind`、`riskLevel`、`title`、`description`、`expressionPreview`、`sessionName`、`file`、`line` 和 `rememberScopes`。

权限分层：

- `safe_inspection`：变量快照、inspect variable、readonly evaluate。默认首次按项目确认，可记住到当前 workspace。
- `debug_control`：continue、step over/into/out、stop debug。默认首次按 debug session 确认，可记住到本次 debug session；`stop_debug` 也只允许 session 级记忆。
- `high_risk`：unsafe evaluate、函数调用 evaluate、remote attach、workspace 外目标。默认每次确认，不提供永久允许；只有 IDEA Settings 中开启 advanced high-risk approvals 且 allowlist 命中时才可自动允许。
- `breakpoint_management`：Agent 设置或移除断点。IDE 插件使用 notification/tool window 状态提示，不弹 modal。

IDEA 插件提供 `Settings | Tools | BreakPilot`，可配置 safe inspection、debug control、trusted project、advanced high-risk allowlist，并可重置当前项目、当前 debug session 或全部 BreakPilot 决策。超时策略仍由 `breakpilot.yaml` 控制。所有 MCP 侧确认请求和执行结果写审计日志。

## 15. 安全设计

关键防护：

- workspace 限制，禁止跨项目读文件；
- host/port allowlist，默认只允许 localhost；
- forbidProduction 默认开启；
- runtime maxPauseMs；
- unsafe evaluate 必须确认；
- 变量脱敏；
- 审计日志；
- Docker/K8s namespace 和 path mapping 后续纳入 policy；
- 插件只信任同 workspace MCP Server；
- 不自动连接公网 debug 端口。

## 16. 错误码

| 错误码 | 场景 | 恢复策略 | 可重试 |
|---|---|---|---|
| `SESSION_NOT_FOUND` | session 不存在 | list sessions 或重建 | 是 |
| `ADAPTER_START_FAILED` | adapter 命令不存在或启动失败 | 安装/配置 adapterCommand | 是 |
| `ATTACH_FAILED` | attach 参数或端口错误 | 检查 debug 端口 | 是 |
| `BREAKPOINT_NOT_VERIFIED` | adapter 无法验证断点 | 检查行号/source map/class loading | 是 |
| `BREAKPOINT_TIMEOUT` | 超时未暂停 | 触发请求或扩大 timeout | 是 |
| `SOURCE_MAP_NOT_FOUND` | TS 映射缺失 | 开启 sourceMap | 是 |
| `VARIABLE_TOO_LARGE` | 变量过大 | 降低 maxItems/maxDepth | 是 |
| `EVALUATE_TIMEOUT` | 表达式超时 | 简化表达式 | 是 |
| `EVALUATE_BLOCKED_BY_POLICY` | 策略禁止 | 走确认或改 readonly | 否 |
| `TARGET_PROCESS_EXITED` | 目标进程退出 | 重启 session | 是 |
| `DEBUG_PORT_NOT_ALLOWED` | host/port 不在 allowlist | 修改 policy | 否 |
| `WORKSPACE_VIOLATION` | 跨 workspace 文件 | 修正路径或 policy | 否 |
| `IDE_NOT_CONNECTED` | 插件离线 | Headless fallback | 是 |
| `IDE_CONFIRMATION_TIMEOUT` | 用户未确认 | 按 policy continue/stop | 是 |
| `USER_REJECTED_CONTINUE` | 用户拒绝 | 停止或等待用户 | 否 |
| `SESSION_OWNER_CONFLICT` | 控制权冲突 | 等当前操作完成 | 是 |
| `IDE_BRIDGE_DISCONNECTED` | Bridge 断开 | 重连并同步状态 | 是 |

## 17. MVP Roadmap

| 阶段 | 目标 | 交付 | 不做 |
|---|---|---|---|
| 1 | Headless MCP + CLI，Python + Node hooks | 本仓库核心服务、CLI、DAP、policy、audit、VS Code 最小骨架 | Java 深度、Docker/K8s、IDE 变量树 |
| 2 | TypeScript source map、VS Code Panel、step、脱敏完善 | js-debug PoC、Webview、条件断点、snapshot UX | IDEA |
| 3 | Java + IntelliJ | vscode-java-debug/JDI PoC、IDEA Tool Window、MyBatis Demo | 生产 attach |
| 4 | Docker/K8s/远程/回放/报告 | path mapping、port-forward、审计回放、报告生成 | 无授权公网调试 |

## 18. 技术评审问题

- VS Code Extension API 是否能稳定获取变量，还是必须 `DebugSession.customRequest`？
- VS Code breakpoint hit 是否需要 DebugAdapterTracker 捕获 stopped event？
- IDEA XDebugger API 在 Java/Python/Node 插件中的变量读取差异是什么？
- IntelliJ `XValue` 异步 children 如何可靠序列化？
- vscode-js-debug 是否适合作为独立 DAP adapter 分发？
- Java adapter 如何 Headless 独立启动？
- IDE owner 和 MCP owner 如何在真实并发中仲裁？
- readonly evaluate 如何做语言级静态判定？
- 企业客户是否接受 Agent 暂停进程和读取变量？
- Docker/K8s 路径映射如何统一？

## 19. 最终推荐

最小可行版本：Node.js MCP Server + CLI daemon + DAP Client + debugpy Python PoC + js-debug Node PoC + VS Code 最小插件。不要从 IDEA 或 Java 全量开始，也不要直接封装交互式调试 CLI。

一句话：这个项目本质上是：给 AI Agent 增加一个受策略、审计和用户确认约束的 IDE 级运行时调试控制面。
