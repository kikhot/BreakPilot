# IDEA MCP Debugger 与 BreakPilot MCP Debugger 对照报告

本文比较 IDEA 原生 MCP debugger 与当前 BreakPilot Phase 1 的公开契约和 provider
实现。对照目标不是判断“是否存在同名工具”，而是判断 agent 能否可靠地控制断点、
理解暂停现场，并在复杂问题中依据真实能力选择下一步。

## 结论摘要

BreakPilot 已形成完整的 agent 调试控制面：15 个 `bp_debug_*` 工具统一覆盖启动、
run configuration、状态、执行控制、run-to-line、线程、调用栈、栈帧、变量读取与修改、
表达式求值、上下文和断点生命周期。它已经具备此前文档误写为“缺失”的能力：

- `bp_debug_run_to_line` 是公开工具；当前 IDEA/VS Code bridge 声明 native，DAP
  provider 明确为 unsupported，且没有临时断点 fallback。
- `bp_debug_threads` 与 `bp_debug_call_stack` 都支持 `offset + limit`；`threadId` 可以是
  number 或 opaque string。
- `bp_debug_set_value` 有正式入口；当前 IDEA/VS Code 语义是
  `evaluateAssignment`，DAP 是否 native 由 adapter 能力决定。
- `bp_debug_list_breakpoints` 会优先请求 IDE 原生 breakpoint snapshot；没有可用 IDE
  bridge target 时才可能使用 BreakPilot local project store。
- 断点输入已包含 `enabled`、`temporary`、`suspendPolicy`、`isLogMessage`、
  `isLogStack` 和 `owner`；删除与列表也有 owner filter。

BreakPilot 仍未与 IDEA MCP 完全等价。最主要差距已经从“缺工具”转为“provider
保真度和可验证性”：已有 breakpoint id 的更新/迁移目前统一 unsupported；event drain
目前 unsupported；IDEA bridge 对高级断点字段的实际映射不完整；IDE 栈有时只能提供
top-frame snapshot；`evaluateAssignment` 也不等同于原生变量 slot setter。

## 必须分开的三层

对 agent 来说，下面三层不能混为一谈：

1. **契约存在**：`tools/list` 中有工具和严格 input/output schema。
2. **provider 声明支持**：`bp_debug_start` 或 diagnostic status 返回的 capability matrix
   不是 `unsupported`。
3. **运行结果保真**：IDE 插件或 DAP adapter 确实完成操作，并返回可核验的现场证据。

IDEA MCP 与 IDE 本体同进程，通常在第 2、3 层更直接。BreakPilot 多了一层跨 IDE/DAP
抽象，因此必须把 capability matrix 当成权威事实，而不能从工具名推断能力。工具存在但
capability 为 `unsupported` 时，正确行为是返回 `UNSUPPORTED_CAPABILITY`。

## 能力总表

| 调试环节 | IDEA MCP | BreakPilot MCP | 当前判断 |
|---|---|---|---|
| 启动已有 run configuration | 原生 | `bp_debug_start(runConfigName)` | 都支持；BreakPilot 依赖 bridge discovery/fidelity。 |
| 从源码位置发现运行入口 | IDEA 原生 gutter/run discovery | `bp_debug_run_configurations(filePath)` + `bp_debug_start(filePath,line)` | 契约对应；IDEA 的原生解析更成熟。 |
| 复用现有 IDE session | 直接操作 IDE session | `bp_debug_start(mode="ide", ideSessionId)` | BreakPilot 额外提供显式 adopt。 |
| Headless 调试 | 不属于 IDEA MCP 核心定位 | DAP launch/attach | BreakPilot 明显更强。 |
| 状态 | 完整 IDE 视图 | compact 默认、diagnostic 可带 capabilities | BreakPilot 更适合 agent 决策，IDEA 信息更丰富。 |
| pause / resume / step / wait / stop | 原生 | capability-gated control | 常用闭环对应。 |
| drain events | IDEA 可返回 debugger/tracepoint 事件 | `eventDrain: unsupported` | IDEA 更完整。 |
| run-to-line | 原生 | IDE bridge native；DAP unsupported | 工具已存在，provider 覆盖不同。 |
| 线程/调用栈分页 | `offset + limit` | `offset + limit` | 契约已对齐；IDE 栈完整度仍可能为 partial。 |
| frame/value | 原生 debugger object view | compact node、path 与 opaque `ref` | BreakPilot 更稳定、精简。 |
| evaluate | 原生 | `readonly/guarded/unsafe` policy | BreakPilot 的安全控制更强。 |
| set value | 原生 setter | DAP native 或 IDE `evaluateAssignment` | 入口对应，mutation 语义不完全等价。 |
| 创建断点 | 原生完整模型 | location mode + advanced fields | 契约完整度提高，IDE provider 映射仍不齐。 |
| 更新已有断点 | 原生 breakpoint id update/relocate | update mode 已注册，但 capability unsupported | IDEA 明显更强。 |
| 列出断点 | IDE 原生完整对象 | 优先 native snapshot，必要时 local fallback | 已非“仅本地 store”，但字段保真度较低。 |
| 删除断点 | id/location/owner 相关能力 | id 或 location，并支持 owner filter | 基础闭环对应。 |

## 关键差异分析

### 1. 启动与 run configuration

BreakPilot 除了 IDE run configuration，还能执行 headless DAP launch/attach，并能 adopt
已存在的 IDE session。这使同一套 agent 工具可以跨 IDEA、VS Code 和非 IDE 运行环境。

IDEA MCP 的优势是直接复用 IDE 原生 run configuration 与 gutter 上下文。BreakPilot 的
`filePath + line` 契约已经存在，但能否正确找到可运行入口仍取决于 bridge；后续应把
“候选配置、选中原因、不可运行原因”做成稳定的结构化结果。

### 2. 状态与能力矩阵

BreakPilot compact status 只返回 agent 继续调试所需的 live session 摘要；
`detail: "diagnostic"` 才增加 `providerKind` 与 capability matrix。
`bp_debug_start` 则始终返回它们，避免 agent 启动后盲目尝试操作。

能力矩阵目前覆盖：

- `pause`、`stepping`、`runToLine`
- `variableReferences`、`setValue`
- `breakpointUpdate`
- `conditionalBreakpoints`、`hitConditionalBreakpoints`、`tracepoints`
- `eventDrain`

这比返回一组松散布尔值更适合 agent，因为 `native`、`fallback`、`unsupported` 能直接
驱动操作选择。不过当前矩阵还没有解释“为什么 unsupported”、能力来自 client 还是
session override、以及某项 native 能力的版本来源，这些是后续可增强的诊断信息。

### 3. 线程、调用栈与现场读取

旧结论称 BreakPilot 没有 offset、只接受 number thread id，已经不成立。线程和调用栈
都支持 `offset + limit`，thread id schema 允许 number/string。BreakPilot frame 只保留
`index/id/filePath/line/function` 等稳定字段，变量节点使用有序数组、结构化 `path` 和
opaque `ref`，能避免同名变量覆盖，也方便跨 provider 归一化。

IDEA MCP 仍有更完整的 debugger presentation 和原生 frame identity。BreakPilot 的 IDE
provider 在某些暂停状态只能得到 top frame，此时会返回 partial 语义；agent 不应把
partial stack 当作完整调用链。后续应把“完整度、截断原因、可重试方式”都结构化。

### 4. 变量修改

`bp_debug_set_value(path,newValue)` 已存在，并在调用前检查 `setValue` capability：

- DAP adapter 明确声明 `supportsSetVariable` 时为 `native`。
- 当前 IDEA/VS Code bridge 声明 `evaluateAssignment`，即通过当前 frame 中的赋值表达式
  完成修改。
- 不支持时返回 `UNSUPPORTED_CAPABILITY`。

`evaluateAssignment` 比“没有能力”更实用，但不等价于 IDEA 原生 setter：表达式可能受
语言语法、作用域、setter 副作用和求值策略影响。agent 必须能看到该模式，并在修改后
重新读取变量验证结果。

### 5. Run-to-line

`bp_debug_run_to_line(filePath,line)` 已是原子公开工具。当前 IDEA 与 VS Code bridge
声明 native；DAP provider 明确 unsupported。BreakPilot 当前不会自动组合
“临时断点 + resume + wait + cleanup”，因此不会把可能失败的组合流程伪装成成功。

下一步若引入 fallback，能力必须显示为 `fallback`，结果需要报告临时断点 id、是否命中
目标行、cleanup 状态和中途停在其他断点的原因。

### 6. 断点模型

`bp_debug_set_breakpoint` 现在有两个严格互斥分支：

```json
{"filePath":"src/App.java","line":42,"condition":"count > 3"}
```

用于按位置创建；以及：

```json
{"breakpointId":"bp_123","enabled":false}
```

用于表达已有断点更新。未知字段、非法行号，或同时传 id 与 location 会在 dispatch 前
返回带 issue 列表的 `INVALID_ARGUMENT`。

契约存在不代表 update 已实现：当前 `breakpointUpdate` 对所有 provider 都是
`unsupported`，update 分支会明确返回 `UNSUPPORTED_CAPABILITY`。创建分支对
`condition`、`hitCondition`、`logMessage` 已分别强制执行 conditional、hit-conditional、
tracepoint capability gate；provider 未声明能力时会在 mutation 前失败。`enabled:false`、
`temporary:true`、`suspendPolicy`、`isLogMessage:true`、`isLogStack:true` 等尚未实现的
高级语义同样明确拒绝，不会静默忽略。VS Code 已映射 condition/hit/log；IDEA 当前主要
可靠创建行断点，因此 capability 声明仍不能替代真实运行时 E2E 验证。

`bp_debug_list_breakpoints` 已能请求 IDEA/VS Code 原生 breakpoint snapshot，并区分
agent/user owner；这修正了“只读 BreakPilot store”的旧结论。仍需注意：没有可用 bridge
target 时才可能使用 local store；已经选中的 native query 若失败会返回明确错误。IDEA
MCP 返回的 breakpoint type、suspend policy、presentation 等字段也更完整。

## BreakPilot 当前更好的地方

1. **agent-first 的稳定输出**：默认直接返回 compact 顶层业务字段，没有
   `ok/data/auditId` envelope，也不强迫 agent 理解 IDE UI 对象。
2. **严格 typed contract**：15 个工具都有具体 input/output schema；未知字段、范围错误和
   歧义 target 在 provider 调用前失败。
3. **能力真值可编程**：start 总是返回 capability matrix，diagnostic status 可重新读取；
   agent 可以停止试错式调用。
4. **跨 provider**：同一控制面覆盖 IDEA、VS Code 与 headless DAP，而不是绑定单个 IDE。
5. **变量证据模型**：有序节点、结构化 path、opaque ref、展开深度/数量/字符串限制更适合
   大对象和复杂现场。
6. **安全边界**：workspace、attach endpoint、production policy、redaction，以及
   `readonly/guarded/unsafe` evaluate 模式比直接求值更适合自动化 agent。
7. **确定性语义回归基线（非采集证明）**：`HelloController.java:24` 的 sanitized
   fixture 固定了 IDEA frame presentation 与 BreakPilot path/value 语义，便于测试
   后续变更；但原始响应、采集命令、工具版本、时间戳与哈希均未保留，因此它不能独立证明
   历史采集过程。相邻 README 记录了未来真实采集、哈希、清洗与回放流程。

## IDEA MCP 当前更好的地方

1. **IDE 原生保真度**：线程、frame、run configuration 和 breakpoint 对象直接来自 IDEA
   debugger service，presentation 与 identity 更丰富。
2. **高级断点操作**：已有 breakpoint id 的 update/relocate、enabled 切换、temporary、
   suspend policy、日志/堆栈行为更成熟。
3. **事件输出**：breakpoint error、tracepoint output 与 drain event 链路更完整。
4. **原生变量 setter**：mutation 语义比 `evaluateAssignment` 更明确。
5. **源码入口解析**：从 gutter/location 到可运行 configuration 的 IDE 语义更强。

## 后续优化计划

### P0：让 capability 与每次操作结果完全一致

- condition、hit condition、tracepoint 的逐项 dispatch gate 已完成；下一步让 bridge
  acknowledgement 逐项报告实际应用语义，而不只返回笼统的 verified。
- capability 增加来源与原因诊断，例如 `source=client|session|adapter`、版本和 reason；
  compact 保持不变，只在 diagnostic 暴露。
- 建立 IDEA、VS Code、DAP 三类 provider 的 capability × operation E2E matrix，验证
  声明为 native 的能力确实改变了运行时状态。

### P0：完成 breakpoint update 与原生 reconcile

- 实现 `breakpointId` update/relocate，并保持 owner 保护和原子失败语义。
- 对 `enabled`、`temporary`、`suspendPolicy`、condition/hit/log/stack 建立 IDE 双向映射。
- list 结果报告 `source: "ide" | "local"`、同步时间和 reconcile warning，让 agent
  明确知道看到的是 IDE 真值还是缓存。

### P1：补全事件与复杂控制流

- 实现有界 event buffer，支持 breakpoint verification error、tracepoint output、
  process/thread lifecycle，并让 `eventDrain` capability 变为 truthful native。
- 若实现 DAP run-to-line fallback，必须处理其他断点先命中、超时、用户中断和临时断点
  cleanup，且以 `fallback` 对外声明。

### P1：提高现场证据质量

- stack/frame 返回 completeness、truncation reason 与 next offset；partial 不能只靠调用方猜。
- set-value 结果增加 mutation mode，并在写入后自动读取验证；区分“表达式执行成功”和
  “目标变量已变更”。
- 把 sanitized differential fixture 升级为可选真实 Java E2E：同一断点同时采集 IDEA 与
  BreakPilot 原始结果，再做 provider-independent semantic comparison。

## 最终判断

按“agent 能否完成一次常规调试闭环”衡量，BreakPilot 已经具备可靠基础：

```text
status -> start/adopt -> inspect capabilities -> set breakpoint -> wait/resume
       -> threads/stack -> frame/value -> eval/set-value -> remove -> resume/stop
```

按“是否与 IDEA MCP 完全一一等价”衡量，答案仍是否定的；差距集中在 breakpoint
update、高级断点映射、event drain、原生 mutation 与 IDE 栈保真度。

按“是否更适合自主 agent”衡量，BreakPilot 的方向更合理：它把 compact typed output、
严格校验、能力真值和跨 provider 控制放在第一位。下一阶段最重要的不是继续增加工具名，
而是让每个 capability 声明都能由真实运行证据验证，并让所有 unsupported 行为明确失败。
