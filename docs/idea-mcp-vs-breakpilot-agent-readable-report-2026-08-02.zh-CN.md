# IDEA MCP 与 BreakPilot Agent 可读契约实测报告

日期：2026-08-02

测试项目：`/Users/Quixote/workSpace/Java/spring-boot-demo/simple-springboot-demo`

## 1. 结论

方案 B 可以作为 BreakPilot 的新默认契约。改造后的 `compact` 输出已经符合“让 Agent 控制断点并理解暂停现场”的初衷：一次暂停响应提供状态、原因、业务位置、少量局部变量和唯一 `pauseId`；需要深入时，Agent 再通过短句柄读取对象或显式切换 `detail="diagnostic"`。

IDEA MCP 仍然更适合人直接浏览。它的文本树有缩进、类型、变量路径和 IDE 展示名称，人眼可以快速扫读。新版 BreakPilot 则更适合 Agent 连续决策：字段稳定、值有类型、路径可复用、错误可恢复、旧句柄会被拒绝，并且不同 provider 返回同一种语义结构。

因此两者不是“哪一个 JSON 更漂亮”的关系：

- 面向人类即时阅读，IDEA MCP 当前仍占优。
- 面向 Agent 的低 token 调试闭环，新版 BreakPilot 已经更完整、更安全。
- BreakPilot 仍需改善线程完整性、IDE 客户端生命周期和少数部分结果的解释性。

## 2. 量化结果

| 指标 | 改造前/目标 | 实测结果 | 结论 |
|---|---:|---:|---|
| 15 个工具的完整 `tools/list` JSON | `102,259` bytes | `29,446` bytes | 减少 `71.2%`，低于 30 KB 门禁 |
| 默认 `context` | 目标小于 `2,000` bytes | `515` bytes | 在一个响应内保留了暂停决策所需信息 |
| MCP `content.text` | 不超过 160 字符 | 契约测试通过 | 不再复制 `structuredContent` |
| MCP 工具数 | 保持 15 个 | 15 个 | 工具名称未变 |
| 变量递归 schema | 禁止展开 8 层 | 本地 `$defs/$ref` | 消除工具定义的主要 token 浪费 |

`detail="diagnostic"` 不会改变变量展开深度，只会在同一语义结果上增加有界 `diagnostics`。深入对象必须显式使用 `handle`、`depth`、`limit` 和 `offset`，避免“为了排查问题”无意返回整个对象图。

## 3. 同一暂停点的可读性对比

请求为 `GET /hello?name=Ada-Lovelace`，断点命中 `HelloController.java:21`。

IDEA MCP 使用面向人的展示树，核心信息类似：

```text
hello:21, HelloController (com.example.demo.controller)
  name = "Ada-Lovelace"
  this = {HelloController@...}
```

新版 BreakPilot 默认暂停结果为：

```json
{
  "state": "paused",
  "reason": "breakpoint",
  "at": {
    "filePath": "src/main/java/com/example/demo/controller/HelloController.java",
    "line": 21,
    "column": 1,
    "function": "hello"
  },
  "locals": [
    { "name": "name", "value": "Ada-Lovelace", "handle": "v1", "mutable": true },
    { "name": "this", "value": "HelloController", "handle": "v2" }
  ],
  "pauseId": 1
}
```

IDEA 的结果更像 Debug 工具窗口，适合人阅读；BreakPilot 的结果直接回答 Agent 的五个问题：是否暂停、为什么暂停、停在哪里、当前可见值是什么、后续读取应绑定到哪个暂停代次。

默认 `context` 实测只有 515 bytes，同时包含两个栈帧、两个局部变量、业务函数名和根节点 `pauseId`。变量节点不重复 `pauseId`，健康路径也不返回空数组、默认布尔值、provider 元数据或完整证据标志。

## 4. 真实调试闭环

本轮分别调用了 IDEA MCP 的全部 debugger 方法，并使用工作树构建出的 BreakPilot Core 与 IDEA 插件完成对应的 15 个 `bp_debug_*` 工具闭环。

BreakPilot 实测结果：

1. 读取运行配置并启动 `DemoApplication`，得到精简的 session、state、startMode 和实际目标。
2. 第 21 行命中 `name=Ada-Lovelace`，位置被规范化为 workspace 相对路径，函数名为 `hello`。
3. 默认 `context`、`threads`、`call_stack` 和 `frame` 均返回 compact 结构；内部 `JavaStackFrame` 未泄漏。
4. 使用 `v1` 展开变量，子值被分页且根节点保留语义名称；IDEA UUID 没有公开。
5. `eval` 执行 `name + ":" + name.length()`，结果为 `Ada-Lovelace:12`。
6. 使用 path 和 handle 两种目标修改变量，最终恢复为 `Ada-Lovelace`，返回 `applied=true`、`verified=true`。
7. `stepOver` 到第 22 行后，旧 `v1` 稳定返回 `STALE_RUNTIME_HANDLE`，并给出重新获取 context 的恢复建议。
8. 第一次 run-to-line 被用户条件断点截停在 `decideGreetingLevel:118`，如实返回 `reached=false`；继续后到达第 25 行并返回 `reached=true`。
9. drain 返回 continued/stopped 事件和下一游标，没有复制会话快照。
10. 创建、列出并按精确 ID 删除 Agent 断点；用户断点未被修改。
11. stop 后 session 列表为空、IDE 仍连接，8080 已停止。

清理后恢复了原有 5 个行断点和 1 个禁用的异常断点。异常断点当前不进入精简的“源码位置断点”列表，这是有意的投影边界，但需要在后续能力描述中更明确。

## 5. 本轮实测发现并修复的问题

### 5.1 非行断点破坏列表契约

IDEA 的异常断点没有源码行，旧投影会生成缺失 `at` 的非法结果。Core 与 IDEA provider 现在只把可表示的行断点投影到现有 compact 契约，并由测试覆盖。

### 5.2 diagnostic 可能泄漏无界或不可序列化值

启动结果曾把 provider payload 原样放进 diagnostics。现在诊断投影有深度、节点数、键数、数组长度和字符串长度上限，并处理循环引用、`undefined`、函数、symbol 和 bigint。

### 5.3 handle 展开丢失变量语义名称

展开 `v1` 时曾把返回值名称显示为新句柄。现在展开结果继续使用原变量名，provider ref、parent ref 和 path 只保存在内部注册表。

### 5.4 IDEA 顶层对象 handle 修改超时

顶层字符串的 provider 对象引用不适合作为赋值目标。现在有语义 path 时优先使用 path，只有没有 path 才使用 provider ref。

### 5.5 IDEA 赋值验证不可信

旧实现会回显带引号的输入并始终返回 `verified=false`。现在解析 IDEA evaluate-assignment 的实际结果，返回真实 `newValue` 和 `verified=true`。

### 5.6 栈帧展示名包含类名后缀

插件真实 presentation 为 `hello:21, HelloController (...)`。插件现在在 EDT 获取 presentation 后提取业务方法 `hello`，失败时仍可回退到文件名与行号。

## 6. BreakPilot 优于 IDEA MCP 的地方

### 6.1 为连续决策设计，而不是复刻 IDE 面板

BreakPilot 的 compact 响应只保留当前动作需要的信息。pause、wait、step 和 run-to-line 会附带位置与局部变量；resume 和 stop 不会额外采集 frame。这比所有动作统一返回大快照更省 token，也避免过期证据。

### 6.2 IDEA 与 DAP 共用语义契约

Agent 不需要理解 IDEA UUID、DAP numeric reference 或 provider 专有栈帧。相同的 `AgentLocation`、`AgentValue`、错误和事件结构可用于 Java、Node 等不同后端。

### 6.3 暂停代次和短句柄防止误读旧状态

`pauseId` 只在响应根节点出现一次。短句柄只在当前 pause 有效，resume、step、run-to-line、stop 或新 pause 后会原子失效。Agent 不会把上一暂停点的对象误当成当前状态继续读取或修改。

### 6.4 断点 ownership 和保护语义

BreakPilot 区分 Agent 与用户断点，精确 ID 删除并保护非 Agent 断点。IDEA MCP 更接近 UI 操作，本身没有同等级的 ownership 事务语义。

### 6.5 可恢复错误和动作真实性

错误固定包含 `code`、`message`、`retrySafe` 和 `actionMayHaveApplied`，需要时提供 `hint`。run-to-line 被其他断点截停时返回 `reached=false`，而不是把“动作已发送”误报成“目标已到达”。

### 6.6 有界诊断、部分证据和事件游标

健康路径省略完整性噪声；只有部分结果才返回 `incomplete`、`warnings` 或下一游标。事件 drain 可增量消费，diagnostic 也受安全和大小预算约束。

## 7. IDEA MCP 当前更好的地方

### 7.1 人类视觉扫读

IDEA 的变量树、缩进、类型和 presentation 与 Debug 工具窗口一致。人在终端中阅读时，比扁平的 JSON 更自然。BreakPilot 的目标不应是消灭这种文本视图，而应保持结构化结果为主，并继续优化 160 字符内的摘要。

### 7.2 线程覆盖更完整

同一现场下 IDEA MCP 返回 24 个线程，虽然当前线程有重复；BreakPilot IDEA provider 实测只返回当前线程。对于死锁、竞态和线程池问题，完整线程枚举是必要能力。

### 7.3 IDE 原生展示细节更丰富

IDEA 已经知道 frame presentation、库帧、对象 renderer 和语言特定值格式。BreakPilot 需要谨慎复用这些语义，同时避免把 provider 类型和大对象直接暴露给 Agent。

## 8. 后续优化优先级

### P0：IDE 客户端生命周期

测试子 IDEA 重启后，Hub 曾保留旧客户端注册，导致 `PROJECT_AMBIGUOUS`。应增加断线即时清理、心跳 TTL 和“同项目优先最新健康连接”的确定性选择；不得依靠用户重启 Hub 恢复。

### P0：明确非行断点能力边界

当前契约只表示带位置的行断点，因此异常断点被过滤。短期应在 status 或 capabilities 中声明支持的断点类型，并在存在未表示断点时给出有界 warning；长期若 Agent 需要异常断点，应新增可表达 location-less breakpoint 的语义变体，而不是伪造 `at`。

### P1：完整线程枚举与去重

IDEA provider 应返回全部线程，标记唯一 current thread，使用 `nextOffset` 分页，并在 Core 去重。该项直接影响复杂并发问题的诊断能力。

### P1：增强部分结果的解释性

- stopped 事件在 provider 可得时附带 compact `at` 和 thread。
- run-to-line 被用户断点中断时增加“继续或移除冲突断点”的 `hint`。
- hidden frame 除 `incomplete:["stack"]` 外，增加有界的 hidden count/summary。
- diagnostic 被截断时显式给出 truncation marker，而不是静默切片。

### P1：减少暂停代次与句柄抖动

step/run-to-line 现场中 `pauseId` 可能跳号，语义上仍单调且安全，但表明事件更新和动作完成可能重复推进代次。应合并成一次原子 pause transition。若 provider 在同一 pause 返回新的 UUID，可按“pause + 稳定 path”复用短句柄，减少重复 context 后的句柄变化。

### P1：能力协商和插件性能

- `temporary=true` 在 IDEA provider 当前不支持，应在 capabilities 中提前声明或实现真正临时断点。
- `StackFramePresentation` 在 EDT 上读取是正确的线程模型，但可考虑批量读取或按 pause 缓存，避免大栈逐帧 `invokeAndWait`。

### P2：进一步收紧公开 schema

为满足 30 KB 门禁，部分变量数组的公开 schema 允许附加字段，运行时投影仍然严格。后续可探索共享 `$defs` 的更小写法，让所有 AgentValue 位置都显式引用递归定义，同时维持预算。

### P2：部署可见性

已连接的旧 MCP 进程不会自动获得新工具 schema。安装构建产物后仍需重启或重新连接 BreakPilot MCP。应在版本握手或 status 中公开 contract version，使 Agent 能判断自己看到的是旧契约还是新契约。

## 9. 验收判断

新版 BreakPilot 已经从“能调用 IDE 调试功能”升级为“能向 Agent 提供可验证、可继续操作的暂停证据”。默认 compact 的信息密度足够完成大多数下一步决策，515-byte context 证明低 token 与全面上下文可以同时成立；handle、pauseId、ownership、事件游标和错误真实性则是 IDEA MCP 文本树不具备的 Agent 安全能力。

后续不建议重新扩大默认 JSON。优化方向应是补齐并发调试数据面、提升部分结果解释性、稳定 IDE 生命周期，并让少量文本摘要更接近 IDEA 的人类可读体验。结构化 `compact` 仍应保持默认，`diagnostic` 和显式 handle 展开继续作为按需深入入口。

测试期间使用的自动授权属性和临时运行配置仅用于隔离的子 IDEA 实机验收，均已从源码和 demo 项目恢复；用户断点和 8080 端口也已恢复到测试前状态。
