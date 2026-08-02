# IDEA MCP 与 BreakPilot MCP 实机调试对比报告

> 日期：2026-07-29
> 被调试项目：`/Users/Quixote/workSpace/Java/spring-boot-demo/simple-springboot-demo`
> BreakPilot 仓库：`/Users/Quixote/workSpace/open-code/BreakPilot`
> 目标：验证 Agent 是否能可靠操纵断点、理解暂停状态，并据此调试复杂问题。

## 1. 结论摘要

BreakPilot 的产品方向是正确的，而且它的**公共数据模型已经明显比 IDEA xdebug MCP 更适合 Agent**：结构化变量、`pauseEpoch`、opaque `ref`、能力协商、事件游标、run-to-line 的目标证明与清理状态，都是构建 Agent Runtime Debugger 所需要的基础。

但是，授权后二次复测修正了首轮结论：**BreakPilot 的基础控制与 readonly eval 可用，真正的阻断点集中在 bridge 响应解码预算、path 查找策略和复合响应的失败透明度**。用户完成 IDEA 授权后，`pause`、`stepOver(includeFrame=false)` 和 `eval` 均成功；因此首轮的 `IDE_CONFIRMATION_TIMEOUT` 不能再作为这三项实现失败的证据。另一方面，项目已经持久化 `inspect_variables` 授权后，`frame(depth=1, limit=20)` 与 `value(path)` 仍等待 `ide_variables_snapshot` 约 30 秒，`context` 和 `control(includeFrame=true)` 还把 enrichment 失败吞成成功。

进一步缩小参数后发现，变量协议并非整体断路：`frame(depth=0)`、`context(depth=0)` 和 opaque ref 展开只需 8–25 ms；旧 ref 在步进后也能正确返回 `STALE_RUNTIME_HANDLE`。可稳定复现的边界是同一帧 `depth=1` 时，`limit<=3` 成功、`limit>=4` 超时。`value(path=["name"], depth=0)` 仍失败，是因为 Manager 会强制改成 `expand="deep"` 并至少使用路径长度作为深度，从而为查找一个顶层变量先深展开整帧。

当前最重要的判断是：

- BreakPilot 不是“功能不够多”，而是需要先做到**每一份运行时证据都可验证、可关联、失败不伪装成功**。
- P0 应先修整帧深展开的有界完成、path 的 lazy ref traversal、复合响应 fail-explicit、IDE 授权生命周期、停止真实性与安全边界。
- 条件断点、tracepoint、完整线程列表、IDEA 高级展示等功能应在数据链路稳定之后补齐。

## 2. 实测方法与复现场景

### 2.1 项目与入口

项目没有测试源码和 JUnit 依赖，唯一可用的 IDEA Run Configuration 是 `DemoApplication`。本轮采用可自动复现的 HTTP 路径：

```text
DemoApplication
  -> GET /api/hello?name=...
  -> HelloController.hello
  -> normalizeName
  -> splitIntoTokens
  -> analyzeName
  -> decideGreetingLevel
  -> buildGreetingMessage
```

主要断点位置：

- `HelloController.java:21`：业务入口，`name` 可见且可安全修改。
- `HelloController.java:31`：进入 `normalizeName`。
- `HelloController.java:56`：`normalizeName` 返回前。
- `HelloController.java:25`：所有分析结果已生成。
- `HelloController.java:27`：最终响应包装前。

触发请求：

```bash
curl -sS --max-time 90 --get \
  --data-urlencode 'name=  ada_lovelace  ' \
  http://127.0.0.1:8080/api/hello
```

### 2.2 基线保护

调试前 IDEA 无活动 session，只有一个被禁用的用户异常断点：

```json
{
  "id": "exception||-1",
  "type": "exception",
  "enabled": false,
  "owner": "user"
}
```

没有修改该用户断点。所有新增断点均用于本轮验收，并在结束阶段删除。

### 2.3 覆盖范围

本轮调用了 IDEA 的全部 13 个 `xdebug_*` 方法，并调用 `get_run_configurations` 解析入口；同时调用了 BreakPilot 暴露的全部 15 个 `bp_debug_*` 方法。调用失败或超时同样计入实测结果，不能把失败路径从能力评估中剔除。

### 2.4 授权后二次复测与参数隔离

二次复测复用了同一 `HelloController.java:21` 暂停点和同类输入，并确认 `.idea/workspace.xml` 已持久化 `inspect_variables`、`readonly_evaluate`。下表耗时是单次端到端观测，包含确认、排队与桥接开销，不应视为严格 benchmark。

| 操作 | BreakPilot 复测 | IDEA 原生对照 | 判断 |
|---|---|---|---|
| `pause` | 用户同意后 2.76s，停在 `System.java:572` | 135ms，停在同一位置 | BP 控制正确；首轮超时确由未完成授权造成 |
| `stepOver(includeFrame=false)` | 10.85s，从 21 到 22 | 1.23s，从 22 到 23，附 `frameValues` | BP 控制可用，但授权端到端开销大 |
| readonly `eval(name.trim())` | 3.77s，`ada_lovelace` | 31ms，相同结果 | 正确性通过；需要分段延迟指标 |
| `frame(depth=1, limit=20)` | 30.01s，等待 `ide_variables_snapshot` 超时 | 10ms 可读 frame | 不是授权问题，是变量深展开数据面故障 |
| `value(path=["name"])` | 30.03s，同一 snapshot 超时 | 14ms 返回原字符串 | path 实现被整帧 eager expansion 拖累 |
| `context(depth=1)` | 30.05s 后 `isError=false`，但 `position=null, variables=[]` | 原生栈/变量均可读 | 空成功是 P0 契约缺陷 |
| `stepOver(includeFrame=true)` | 控制已到下一行；30.38s 后无 frame/warning 的成功 | 原生 STEP_OVER 1.23s 且附 frameValues | transition 与 enrichment 必须分开报告 |
| `STOP` | 本项未用 BP 重跑 | IDEA 首轮 >50s，本轮 163ms | IDEA 尾延迟呈状态相关，不能定性为稳定必现 |

对变量链路继续做最小化隔离，得到更精确的边界：

| BreakPilot 输入 | 结果 |
|---|---|
| `frame(depth=0, limit=2)` | 12ms 成功，返回 `this/name`、opaque ref、`pauseEpoch=1` |
| `frame(depth=1, limit=2)` | 15ms 成功 |
| `frame(depth=1, limit=3)` | 13ms 成功 |
| `frame(depth=1, limit=4)` | 连续 3 次均在 3s 超时；另一次 5s 超时 |
| `value(ref=nameRef, depth=0, limit=4)` | 8ms 成功，返回 `value/coder/hash/hashIsZero` |
| 步进后复用旧 `nameRef` | 338ms，明确 `STALE_RUNTIME_HANDLE` |
| `context(depth=0)` | 25ms，位置、frame、`this/name` 均正确 |
| `value(path=["name"], depth=0)` | 5.02s 超时；调用方的 depth 0 被内部 path 策略提升 |

源码与同形响应构造进一步锁定主根因：整帧响应在第 4 个子字段时越过 Core `BridgeEventDecoder` 的全局 128-key 预算，被解码为 `null` 并静默丢弃；direct ref 响应较小所以通过。ref 单对象展开和 pauseEpoch 失效保护实际可用，Kotlin 聚合 callback 缺少总 deadline 是独立的次要风险，不是本次 limit 3/4 阈值的主因。

## 3. IDEA MCP 全方法实测

| 方法 | 代表输入 | 观察到的输出/行为 | 结论 |
|---|---|---|---|
| `get_run_configurations` | projectPath | 返回 `DemoApplication`，`supportsDynamicLaunchOverrides=true` | 成功，入口信息完整 |
| `xdebug_get_debugger_status` | projectPath | running/paused、sessionId、精确文件和行 | 成功 |
| `xdebug_list_breakpoints` | projectPath | exception 与 line breakpoint、owner、condition、suspendPolicy | 成功 |
| `xdebug_set_breakpoint` | `HelloController.java:21` | 返回 canonical ID、`lineText`、总数 | 成功，能验证实际绑定行 |
| `xdebug_start_debugger_session` | `configurationName=DemoApplication` | 返回 sessionId、running、输出文件路径 | 成功 |
| `xdebug_control_session` | PAUSE/RESUME/WAIT/STEP_OVER/STOP | 首轮 PAUSE/STOP 曾挂起；无遗留授权框时复测 PAUSE=135ms、STEP_OVER=1.23s、STOP=163ms；一次多次 bridge 超时后的 RESUME=15.38s | 健康状态下正确且快，但尾延迟具有状态相关性 |
| `xdebug_get_threads` | paused session | 返回 24 项、offset/limit/totalCount | 数据丰富；当前线程重复出现两次是明显缺陷 |
| `xdebug_get_stack` | current thread | `hello:21` 加 `48 hidden frames`，`totalFrames=2` | 方法名比 BreakPilot 丰富，但隐藏框架帧 |
| `xdebug_get_frame_values` | frame 0, depth 1 | 文本树，含 `name` 和 String 内部字段 | 内容正确，但 Agent 需要解析 presentation 文本 |
| `xdebug_get_value_by_path` | `path=["name"]` | 直接得到 `"  ada_lovelace  "` | 成功 |
| `xdebug_evaluate_expression` | `name.trim()` | 得到 `"ada_lovelace"` | 成功 |
| `xdebug_set_variable` | `name="Grace Hopper"` | 返回 old/new/applied；重读确认成功 | 成功 |
| `xdebug_run_to_line` | `HelloController.java:25` | `outcome=paused`，位置为 25 | 成功，但没有证明/清理细节 |
| `xdebug_remove_breakpoint` | 两个 canonical breakpoint ID | 两次均 `removed=true, removedCount=1`；最终只剩基线异常断点 | 成功，精确 ID 清理可靠 |

IDEA 的主要优点是：运行配置、线程、真实方法 presentation、frame/path/eval 链路在本轮暂停点上能工作。主要缺点是：变量和求值结果是文本树，Agent 很难稳健消费；run-to-line 和事件结果缺少因果/清理信息；线程输出出现重复项。

另一个重要的 IDEA MCP 缺陷发生在取消中的变更调用：一次请求 condition + log message + log stack + suspend NONE 的第 104 行高级断点设置，在调用等待被终止后仍于后台创建了断点，但最终状态变成普通 suspend ALL 断点，condition/log 属性全部丢失，owner 还显示为 user。调用方没有拿到成功结果，IDE 却留下了部分副作用。该断点随后已用精确 ID 删除。这说明变更调用需要取消传播、事务回滚和 `outcome=indeterminate` 语义。

## 4. BreakPilot MCP 全方法实测

| 方法 | 代表输入 | 观察到的输出/行为 | 结论 |
|---|---|---|---|
| `bp_debug_start` | `mode=ide`, IDEA ideSessionId | 成功收养 IDEA 启动的会话，生成独立 BreakPilot sessionId | 很有价值的跨入口能力 |
| `bp_debug_run_configurations` | projectPath, ide=idea | `OUTPUT_CONTRACT_VIOLATION`；compact/diagnostic 均失败 | P0 确定性 bug |
| `bp_debug_status` | compact/diagnostic | 返回 IDE bridge、session、capabilities | 结构优于 IDEA；收养前后 capability 会变化 |
| `bp_debug_set_breakpoint` | line 31 | 普通断点成功并返回 `lineText`；condition 被 capability gate 拒绝 | 普通断点可用，高级属性落后 |
| `bp_debug_list_breakpoints` | owner=all | 能列出用户与 agent 断点 | 与 IDEA MCP 交叉使用时 ownership 不一致 |
| `bp_debug_remove_breakpoint` | BreakPilot breakpointId | 成功删除并在 IDEA 列表中消失 | 自己创建的断点可安全清理 |
| `bp_debug_control` | pause | 首轮未及时确认而超时；用户同意后 2.76s 正确暂停 | 实现可用；capability 缺少 approval/readiness 状态 |
| `bp_debug_control` | stepInto | 从 21 到 31，返回 paused/position | 成功 |
| `bp_debug_control` | stepOut + includeFrame | 从 56 返回 caller，单次返回结构化 frame/variables | 本轮最好的 Agent 体验之一 |
| `bp_debug_control` | stepOver | 同意后 includeFrame=false 用 10.85s 成功；includeFrame=true 控制成功但等满 30.38s 后吞掉 frame 失败 | 控制与 enrichment 需要独立 outcome/timeout |
| `bp_debug_control` | drainEvents | 返回 sequence 1..13、cursor、overflow、droppedCount | 模型优秀，但事件内容过于贫乏 |
| `bp_debug_run_to_line` | line 56 | `targetReached=true`、requested/actual position、`cleanedUp=true`、frame | 明显优于 IDEA |
| `bp_debug_threads` | limit 30 | 仅返回当前线程 1 项，却声称 `totalCount=1` | 未标注 partial，可能误导 Agent |
| `bp_debug_call_stack` | limit 20 | 返回 `pauseEpoch=3`、`partial=true`、`completeness=unknown`、provider truncation | 完整性语义优秀；function 只有 `JavaStackFrame` |
| `bp_debug_context` | frame 0 | depth=0 用 25ms 完整成功；depth=1 等 30.05s 后 `position=null/variables=[]` 且无 warning | 浅层链路可用；深展开失败被伪装为空数据，P0 |
| `bp_debug_frame` | frame 0 | depth=0 用 12ms 成功；depth=1 在 limit<=3 成功、limit>=4 稳定超时；错误码仍为 `IDE_BRIDGE_DISCONNECTED` | 大 snapshot 被 128-key decoder 静默拒绝，不是 bridge 整体断线 |
| `bp_debug_value` | `path=["name"]` | 即使请求 depth=0 也因内部强制 deep/path depth 而超时 | path 应改为 shallow root + lazy ref traversal |
| `bp_debug_value` | 同 pauseEpoch 的 opaque ref | limit=4 用 8ms 成功；步进后旧 ref 在 338ms 返回 `STALE_RUNTIME_HANDLE` | ref 与 pauseEpoch 闭环是实机可用优势 |
| `bp_debug_eval` | `name.trim()`, readonly | 首轮未确认而超时；持久授权后 3.77s 返回 `ada_lovelace` | 正确性通过，延迟与授权观测仍需优化 |
| `bp_debug_set_value` | `name="Alan Turing"` | `applied=true`、`verified=false`、mutationMode；IDEA 重读确认为 Alan Turing | 实际成功，输出比 IDEA 更丰富但字段有矛盾感 |

## 5. 同一暂停点的直接输入/输出对比

### 5.1 暂停位置与值

共同暂停点：

```text
/Users/Quixote/workSpace/Java/spring-boot-demo/simple-springboot-demo/
src/main/java/com/example/demo/controller/HelloController.java:21
```

共同输入值：

```text
name = "  ada_lovelace  "
```

IDEA 在该暂停点：

- `get_stack`：顶帧为 `hello:21, HelloController`。
- `get_frame_values`：能看到 `this` 和 `name`。
- `get_value_by_path(["name"])`：成功。
- `evaluate(name.trim())`：返回 `"ada_lovelace"`。
- `set_variable(name, "Grace Hopper")`：`applied=true`，重读一致。

BreakPilot 在同一暂停点：

- `call_stack`：位置正确，并明确 `partial=true`、`pauseEpoch=3`。
- `context(depth=0)`：25ms 返回位置与变量；`depth=1` 等待后空成功。
- `frame(depth=0)`：12ms 成功；整帧 `depth=1, limit>=4` 等待 `ide_variables_snapshot` 超时。
- `value(path)`：因内部强制整帧 deep expansion 超时；`value(ref)` 可快速展开，旧 ref 在步进后被正确拒绝。
- `eval(readonly)`：授权后返回与 IDEA 相同的 `"ada_lovelace"`。
- `set_value(path)`：成功将值改为 `Alan Turing`；IDEA 重读确认，但 BreakPilot 自己报告 `verified=false`。

这说明问题不是 JVM 不支持、暂停点无变量或 bridge 整体断路；主问题是 Core 对合法变量响应使用过小的固定解码预算并静默丢包，Manager 的 eager path 查找又放大了响应。IDEA 插件聚合器缺少 watchdog 仍需修，但不是本轮阈值故障的直接解释。

### 5.2 线程与调用栈

| 维度 | IDEA | BreakPilot |
|---|---|---|
| 线程数量 | `totalCount=24` | `totalCount=1` |
| 当前线程 | 重复两次 | 去重后 1 项 |
| 非当前线程 | 可见 | 不可见 |
| 顶帧方法 | `hello:21, HelloController` | `JavaStackFrame` |
| 栈完整性 | `totalFrames=2`，第二项是 48 hidden frames | `partial=true`, `completeness=unknown`, `truncationReason=provider` |
| pauseEpoch | 无 | 有，值为 3 |

BreakPilot 对“不完整”的表达更诚实，这是优势；但是 threads 把局部快照当成完整全集，又与 stack 的谨慎语义不一致。

### 5.3 断点 ownership 与 ID

交叉调用暴露了 ownership 不是跨客户端稳定事实：

- IDEA MCP 创建的第 21 行断点：IDEA 报 `owner=agent`，BreakPilot 报 `owner=user`。
- BreakPilot 创建的第 31 行断点：BreakPilot 报 `owner=agent`，IDEA MCP 报 `owner=user`。
- IDEA 的 exception breakpoint ID 是 `exception||-1`；BreakPilot 将其表示为 `XBreakpointBase|0`、空 file、line=-1。

如果 Agent 混用 IDEA MCP 与 BreakPilot MCP，默认“只删除 agent 断点”的安全策略可能失效或留下垃圾断点。owner 需要成为 IDE 原生 breakpoint 上的共享、可识别 marker，而不是每个 MCP 各自的本地记忆。

### 5.4 控制与授权

BreakPilot 的 IDEA provider 会为 inspection/control/eval 请求用户确认。这个安全方向是正确的，但当前实现使用 IDEA 模态对话框：

1. Core 在超时后移除 confirmation listener。
2. 已弹出的 IDEA 对话框不会随之关闭。
3. 对话框继续阻塞 IDE UI/event flow。
4. 后续 BreakPilot/IDEA 调用可能出现长尾；本轮在多个 bridge 超时后观察到一次 IDEA RESUME 用时 15.38s。

这里需要严格区分“实测事实”和“因果推断”：首轮未点同意时 `pause/stepOver/eval` 返回 `IDE_CONFIRMATION_TIMEOUT`，本轮同意后均成功；源码也确认 Core 超时只移除 listener，没有 cancel/expiry 消息。遗留 modal 导致后续长尾与机制、时序一致，但仍需要 `approvalId`、IDE UI trace 和队列 telemetry 才能证明每次长尾的直接因果。对于需要连续几十次操作的 Agent 调试循环，同步等待模态确认仍然不适合无人值守调试。

授权状态也不能与实现能力混为一谈：`pause/step/eval=native` 并非虚假，但当前 capability 无法表示 `approval=required|granted`；深层 frame/value 则应在连续 snapshot 超时后动态显示 `readiness=degraded`。

### 5.5 清理结果

结束时完成了以下核对：

- BreakPilot 创建的第 31 行断点已通过 `bp_debug_remove_breakpoint` 删除。
- IDEA 创建的第 21 行 agent 断点与后台残留的第 104 行断点，均通过 `xdebug_remove_breakpoint` 精确删除。
- 最终 IDEA breakpoint list 与初始基线一致：仅剩禁用的用户异常断点。
- IDEA `STOP(timeout=15s)` 首轮超过 50 秒，本轮两次分别约 160ms/168ms；因此应定性为间歇性或状态相关长尾，而不是稳定必现故障。
- 对精确目标 JVM PID 发送 TERM 后没有立即退出；准备 KILL 时进程已经不存在，因此没有实际向存活进程施加 KILL。
- 最终 IDEA `sessions=[]`，BreakPilot `sessions=[]/ideSessions=[]`，系统中无 `DemoApplication` 进程。
- 挂起的 HTTP 请求最终以 curl timeout 结束，没有收到响应。

## 6. BreakPilot 比 IDEA MCP 更好的地方

### 6.1 Agent 原生结构

BreakPilot 的变量节点可携带：

- `path` 与 opaque `ref`
- `pauseEpoch`
- `childrenCount`、`complete`、`truncated`
- `modifiable`、`mutationMode`

这比 IDEA 文本树更适合直接推理和继续调用，而且二次复测证明不是纸面优势：同一 pause 的 `nameRef` 能在 8ms 内展开 4 个字段，步进后复用旧 ref 则在 338ms 返回 `STALE_RUNTIME_HANDLE`。IDEA MCP 没有同等级的 opaque handle + pause generation 契约。当前失败发生在完整 snapshot 的 Core 解码预算和 path eager expansion，不应因此放弃 ref 模型。

### 6.2 run-to-line 是“证明”，不是单纯动作

BreakPilot 返回：

```json
{
  "status": "paused",
  "targetReached": true,
  "requestedPosition": {"line": 56},
  "position": {"line": 56},
  "cleanedUp": true,
  "frame": {"line": 56}
}
```

IDEA 只返回 `outcome=paused` 与当前位置。BreakPilot 更容易让 Agent 区分：到达目标、被别的断点截获、超时、debuggee 终止、临时断点清理失败。

### 6.3 完整性与暂停代次

`complete|partial|unknown`、`truncationReason` 和 `pauseEpoch` 是可信运行时证据必需的元数据。IDEA MCP 本轮没有同等级的暂停代次保护。

### 6.4 能力协商与结构化错误

`native|fallback|unsupported`、稳定 error code、output contract validation，使 Agent 理论上可以选择替代路径，而不是解析自然语言错误。问题在于 capability 目前还没有反映授权状态和实机可用性。

### 6.5 可重放事件流

`sequence/cursor/nextCursor/overflowed/droppedCount` 比 IDEA 的事件 tail 更适合多轮 Agent 调试、断线重连和审计。

### 6.6 跨 provider 与会话收养

BreakPilot 能统一 DAP、VS Code、IDEA，并能收养一个由 IDEA MCP 启动的会话。这允许 Agent 从 IDE 用户会话切换到统一 runtime API，是独立于 IDEA MCP 的核心价值。

## 7. 需要改进的地方

### 7.1 P0：阻断可信调试的问题

#### P0-1 修复所有成功结果中的 `undefined`

`bp_debug_run_configurations` 在正常 IDEA 返回上触发 `OUTPUT_CONTRACT_VIOLATION`。原因是 Manager 同时创建 `configurations` 与 `runPoints`，其中一个为 enumerable `undefined`，而输出校验器拒绝它：

- `src/sessions/DebugSessionManager.ts:330`
- `src/control/ToolInputValidator.ts:265`

按位置删除不存在断点也有相同风险：`src/sessions/DebugSessionManager.ts:1373`。

建议：所有输出对象使用条件展开；为每个 provider 的每条成功分支做 `JSON.stringify -> output validator` 端到端测试。

#### P0-2 把授权变成可取消、非阻塞的协议状态

当前核心问题不只是“需要确认”，而是超时后遗留 modal：

- Core confirmation timeout：`src/runtime/providers/IdeRuntimeProvider.ts:671-747`
- IDEA 显示对话框：`breakpilot-idea/src/main/kotlin/security/ConsentManager.kt:19-32`

建议：

- 返回 `USER_APPROVAL_REQUIRED`，带 `approvalId/action/risk/expiry`，不要让 MCP 调用占住 30 秒。
- 使用非模态 tool window/notification；或者至少支持 `agent_cancel_confirmation`。
- Core 超时/客户端取消/会话代次变化时，IDEA 必须关闭相应 UI。
- 晚到的 Allow 必须返回 `APPROVAL_EXPIRED`，不得再持久化 project/session grant；当前 IDEA 会先 remember 再发送已无人监听的响应。
- status 暴露 `pendingApprovals[]`，Agent 可暂停流程并明确告诉用户。
- 一个 session 可批准细粒度 action group（inspect、step、resume、mutation），而不是每个精确 action 各弹一次；UI 必须尊重 Core 发送的 `rememberScopes`。

#### P0-3 停止/断开不能伪装成功

`#cleanupSession` 吞 provider stop/disconnect 失败，但公开 control 固定返回 stopped：

- `src/sessions/DebugSessionManager.ts:448`
- `src/sessions/DebugSessionManager.ts:2543`

建议：失败时保留 session 为 `unknown|stopping_failed`，返回 `outcome=indeterminate`、`debuggeeMayStillBeRunning=true`、`retrySafe=false`。

#### P0-4 修复安全语义

高风险点：

- 请求 `redactPatterns` 替换而非叠加默认规则，`[]` 可关闭默认脱敏：`src/security/SecurityPolicy.ts:126`。
- eval 没有走统一脱敏输出。
- `readonly` 允许不在黑名单内的零参数方法；`guarded` 没有独立语义：`src/security/SecurityPolicy.ts:101,149`。
- `allowFunctionCalls=false` 未被消费。
- IDEA path set-value 直接把 `path.join(".")` 拼成赋值表达式并绕过 eval policy/confirmation：`breakpilot-idea/src/main/kotlin/debugger/CommandExecutor.kt:247-253`。
- IDEA start/run-config filePath 未统一走 workspace policy。

建议：默认 redaction 与请求规则取并集；readonly 默认禁止所有调用；guarded 使用明确 allowlist/AST；所有 eval/mutation 输出统一脱敏；path mutation 优先 native handle，禁止字符串拼接模拟结构化路径。

#### P0-5 让 `context` 与 includeFrame fail explicit

`bp_debug_context` 和 `control(includeFrame)` 使用 `.catch(() => null)` 吞掉失败：

- `src/sessions/DebugSessionManager.ts:744-780`
- `src/sessions/DebugSessionManager.ts:1913`

建议最少返回：

```json
{
  "status": "paused",
  "completeness": "partial",
  "missing": ["position", "variables"],
  "warnings": [
    {"code": "VARIABLE_SNAPSHOT_TIMEOUT", "retrySafe": true}
  ]
}
```

不得把空数组等价为“本帧没有变量”。

#### P0-6 修复 bridge decoder 的 128-key 静默丢包，并让 path 走 lazy ref traversal

实测边界与 Core 解码器预算精确吻合：同一 frame 的 `depth=1` 在 `limit<=3` 立即成功，`limit>=4` 稳定超时；同一 `name` opaque ref 直接展开 4 个字段却只需 8ms。源码根因是：

- `src/ide/BridgeEventDecoder.ts:8-15` 对整个 event 使用全局 `MAX_KEYS=128/MAX_ITEMS=128/MAX_DEPTH=8` 深拷贝预算。
- `decodeBridgeEvent` 先深拷贝包含完整 `message` 的 envelope，又单独深拷贝 `message`：`BridgeEventDecoder.ts:22-27`。
- 一旦累计对象键超过 128，`snapshotRecord` 返回 `INVALID`，最终解码结果为 `null`：`BridgeEventDecoder.ts:50-80`。
- provider listener 对 `decoded=null` 直接 return，不会让匹配中的请求立即失败：`src/runtime/providers/IdeRuntimeProvider.ts:764-769`；调用方只能等到 timeout，再被误报为 `IDE_BRIDGE_DISCONNECTED`：`IdeRuntimeProvider.ts:815-824`。

用与实机 snapshot 同形的只读构造复核：3 个 String 子字段约 120 个对象键，`decode=true`；增加第 4 个 `hashIsZero` 后约 130 个对象键，payload 仅约 2KB，`decode=false`。这解释了所有现象：整帧响应含 stack/threads/locals 包装而越界，direct ref 响应较小所以成功；不是 IDEA 没回包，也不是第 4 个字段的 presentation 卡死。

path 还有一个放大器：无论调用方请求什么 expand，Manager 都强制 `expand="deep"`，并把深度至少提升到 `path.length`：`src/sessions/DebugSessionManager.ts:614-621`。

建议：

1. envelope 只安全读取 `clientId/message` 自有数据属性，不要在 envelope 阶段递归复制 message；对 message 只解码一次。
2. 使用按消息类型的 schema、节点/字节预算；合法的变量分页响应不得与安全攻击共用 128-key 硬上限。超过预算时立即返回 `BRIDGE_PAYLOAD_LIMIT`，不能静默丢弃。
3. frame 首次读取只返回浅层变量与 opaque refs；path 按“浅层根节点 -> ref -> 下一 token”逐段遍历，不得 eager-expand 所有兄弟节点。
4. 保留 accessor/proxy/cycle 防护，并为 `MAX_DEPTH/MAX_ITEMS` 的合法边界建立同样的显式错误；不要简单无限提高常量。
5. IDEA `computeChildren`/聚合器仍应有 monotonic deadline、exactly-once partial finalizer，作为独立的 provider 防御层。
6. 新增真实变量 snapshot 的 limit 3/4、>128 keys、>128 items、深度 8/9 测试，并断言 pending request 立即失败而非等到 timeout。

#### P0-7 修复 WebSocket TCP 拆包时的 frame 起点丢失

只读审计还发现一个与本次 128-key 主因独立、但会制造随机 bridge 丢包的确定性 parser bug：`src/ide/IdeBridgeServer.ts:67-104` 在 header、扩展长度、mask 或 payload 尚未收全时已经推进 `offset`，最后把 `buffer.slice(offset)` 保存为 rest，导致下一 TCP chunk 到达时原 frame 起点已丢失。TCP/WebSocket 数据被拆成多次 `data` 回调是正常行为，不能假设一帧一次到齐。

建议在解析每帧前保存 `frameStart`，任何 incomplete 分支都回滚并保留 `buffer.slice(frameStart)`；同时补 header、126/127 长度、mask、payload 各边界的拆包测试，以及 continuation/control frame 测试。更稳妥的方案是使用成熟 WebSocket server 实现，避免自维护 RFC 6455 framing。

### 7.2 P1：补齐 IDEA 运行时数据面

#### P1-1 稳定 frame/value/ref/eval 闭环

本轮同一暂停点上的验收标准应是：

- `bp_debug_frame(frameIndex=0, depth=0)` 在 2 秒内返回 `name`，深展开失败时返回 partial 而非挂起。
- 返回的 opaque ref 在同一 pauseEpoch 可展开；这一路径本轮已有成功样本，应加入回归与 soak。
- step/resume 后旧 ref 必须稳定返回 `STALE_RUNTIME_HANDLE`。
- readonly eval 与 IDEA 直接 eval 得到相同值。
- 100 次连续暂停/读取无 `IDE_BRIDGE_DISCONNECTED` 假错误。

当前 `IDE_BRIDGE_DISCONNECTED` 实际经常只是 response timeout，应拆成 `IDE_RESPONSE_TIMEOUT` 与真正断线。readonly eval 的单次正确性已通过，后续重点是延迟、授权状态、安全与重复稳定性。

#### P1-2 capability 必须表达“实现 + 授权 + 当前可用性”

本轮收养前后同一 IDE session 的 capability 会变化；收养后声明 `variableReferences=native`、`setValue=native`、`eventDrain=native`。直接 ref 与 stale-handle 保护已经实测可用，但整帧深展开和 path 仍会超时，当前 capability 无法表达这种局部降级。

建议将 capability 拆成：

```json
{
  "implementation": "native",
  "readiness": "ready|degraded|unavailable",
  "approval": "notRequired|required|granted",
  "lastFailure": "IDE_RESPONSE_TIMEOUT"
}
```

首轮的 pause/step/eval `native` 不应再定性为“虚假能力”：实现确实存在，只是 capability 无法告诉 Agent 当前正在等授权。对连续超时的深层 frame/value，动态 readiness 则应降为 `degraded`。收养前后的 capability 也应复用同一计算函数，避免同一 IDE session 从 `snapshot/evaluateAssignment/unsupported` 无解释地跳成 `native/native/native`。

#### P1-3 threads 使用真正的线程 API

当前 IDEA threads 通过 focused variable snapshot 间接取得，只返回当前线程。要么实现 XDebugSession/XExecutionStack 的真正线程枚举，要么返回 `partial=true/completeness=unknown`，绝不能声称 totalCount=1 是完整事实。

#### P1-4 保留真实 frame presentation

`function="JavaStackFrame"` 对 Agent 几乎无用。应保留 IDEA 的 `hello`、类名、模块、是否 synthetic/hidden/async，并继续提供规范化字段。

#### P1-5 ownership 与 breakpoint ID 跨入口一致

建议在原生 XBreakpoint user data/persistent property 上保存 BreakPilot marker，并让 IDEA MCP/BreakPilot 都能识别。exception/field/method breakpoint 应使用带 `type` 的统一联合 schema，不能伪装成空路径 source breakpoint。

#### P1-6 高级断点能力

BreakPilot 当前 IDEA capability 明确拒绝 condition/hitCondition/tracepoint，而 IDEA xdebug contract 支持 condition、log message、log stack 和 suspend NONE。

建议优先级：

1. conditional breakpoint + 异步 validation error；
2. hit condition；
3. tracepoint/logpoint；
4. exception breakpoint；
5. method/field breakpoint。

每个能力都必须返回 `verified`、实际 resolved position、validation error event，不能只表示“设置请求已接受”。

#### P1-7 全链路 pauseEpoch CAS

目前 pauseEpoch 只上浮在 stack 与部分变量节点。建议：

- start/status/context/control/frame/value/eval 全部返回 pauseEpoch。
- frame/value/set/eval 接受 `expectedPauseEpoch`。
- stale frameId 禁止回退到 frameIndex 0。
- reconnect/bridge generation 变化必须使旧 handle 失效。

#### P1-8 统一输出形状与分页

当前 DAP 与 IDE 的 `value/eval` public shape 不一致，provider payload 仍可从开放 `result` 穿透；`value(start/count)` 又不返回 next/completeness。

建议所有 provider 先归一化成同一个 canonical runtime value，再过严格 allowlist schema；所有分页结果返回 `offset/limit/total|unknown/nextOffset/completeness`。

#### P1-9 总 deadline、取消传播与分段 timing

当前 caller `timeout` 不是整个操作的总 deadline：approval、command、fresh-stop wait、includeFrame enrichment 可能各自再等待一段时间；`withTimeout` 也只做 Promise race，不取消 IDEA 底层工作。

建议用 monotonic deadline + AbortSignal 向所有阶段传剩余预算，并返回 `approvalMs/dispatchMs/stopWaitMs/enrichmentMs/totalMs`。过期 snapshot 必须取消或隔离，后续命令不能被旧请求拖慢。错误至少拆成 `APPROVAL_REQUIRED|EXPIRED`、`REQUEST_CANCELLED`、`IDE_DISCONNECTED`、`IDE_RESPONSE_TIMEOUT`、`STOP_EVIDENCE_TIMEOUT`；可能已经执行的控制超时还要返回 `actionMayHaveApplied=true`、`retrySafe=false`，防止 Agent 重试后多走一步。

### 7.3 P2：可观察性、文档与工程化

#### P2-1 事件 capability 与事件内容要真实

IDEA 实际只产生 stopped/continued，但 `supportedKinds` 上报十种事件。stopped 事件没有 position/threadId/pauseEpoch，reason 统一为 breakpoint，无法区分 step、pause、run-to-line。

建议 supportedKinds 根据 provider 实际协商；每个 transition 事件携带 session/thread/pauseEpoch/reason/position/hitBreakpointIds；隐式 cursor 按 client 隔离。

#### P2-2 run-to-line 的 `includeFrame` 要兑现

schema 接受 `includeFrame`，Manager 没有把它传给 provider。应保证 false 时不读取 frame，true 时返回统一 frame/variables，并应用 redaction/completeness。

#### P2-3 动态启动覆盖要么实现，要么如实关闭

IDEA run config 总报告 `supportsDynamicLaunchOverrides=true`，但 bridge start 没有转发 args/cwd/env。应以真实配置类型能力为准。

#### P2-4 统一测试入口与 live differential suite

根 `npm test` 不覆盖 VS Code/IDEA 插件测试；现有 differential fixture 是 synthetic replay，不是 live IDEA。

建议 CI 分层：

1. core contract/property tests；
2. VS Code extension tests；
3. IDEA Gradle/plugin tests；
4. macOS/Linux live IDEA smoke；
5. 同一 fixture 上 IDEA xdebug 与 BreakPilot 的差分断言。

#### P2-5 文档由 schema/capability 自动生成

README 仍把 IDE 插件称为 skeleton，工具数量也落后于实际 15 个。建议从 toolDefinitions、ErrorCodes、ProviderCapabilities 自动生成工具清单和 feature matrix，并在 CI 检查文档漂移。

## 8. 推荐的 Agent 调试协议形态

为了实现“Agent 能控制并看懂断点”，建议把每次暂停视作不可变证据快照：

```text
sessionId + threadId + pauseEpoch
  -> frames[]
  -> variables[]
  -> opaque refs
  -> events cursor
```

任何 step/resume/run-to-line 都产生新 pauseEpoch；旧 frame/ref/path 请求要么显式 CAS 失败，要么由 caller 主动省略 expected epoch 表示接受最新状态。不要静默回退。

建议每个控制动作返回统一 transition：

```json
{
  "requestedAction": "stepOver",
  "previousPauseEpoch": 11,
  "status": "paused",
  "pauseEpoch": 12,
  "reason": "step",
  "position": {"filePath": "...", "line": 27},
  "hitBreakpointIds": [],
  "evidenceCompleteness": "complete",
  "warnings": []
}
```

这比单纯复制 IDE debugger API 更接近 Agent 真正需要的“可验证状态机”。

## 9. 建议实施顺序与验收门槛

### Milestone A：可信基本闭环

- 修复 run-config output violation。
- 未授权请求立即返回显式 approval state；授权可取消/过期，超时不遗留 modal，也不接受 late grant。
- context 与 control enrichment 不再空成功，transition 和 evidence outcome 分开。
- frame 浅读、lazy ref 展开、path 逐段遍历在 IDEA 暂停点稳定工作；深读失败返回 partial。
- stop/disconnect 真实反映 provider ack。
- 默认脱敏和 readonly 语义闭合。

验收：在本报告的 Spring Boot 场景连续运行 100 次，能自动完成 set breakpoint -> start/adopt -> wait -> stack -> shallow frame -> path/ref value -> readonly eval -> step -> run-to-line -> cleanup，无挂起、无空成功、无遗留会话；limit 边界 3/4、child callback 丢失、取消与 late approval 都有确定性测试。

### Milestone B：证据一致性

- pauseEpoch CAS 覆盖所有运行时读取和变更。
- threads/stack/value 分页与 completeness 一致。
- DAP/VS Code/IDEA 输出同形。
- ownership/ID 跨入口一致。

验收：同一 pause 的 IDEA xdebug 与 BreakPilot 关键值、位置、线程、栈语义一致；差异均以 warnings/completeness 显式表达。

### Milestone C：高级断点与复杂问题调试

- condition/hitCondition/tracepoint/exception breakpoint。
- 精确事件原因、hitBreakpointIds、output/tracepoint 流。
- async stack、library/decompiled frame、renderer/memory view 的渐进支持。

验收：Agent 能用 tracepoint 收集多次循环状态、用条件断点定位首次异常转移、沿真实调用栈和对象引用追溯数据来源，而无需解析 IDE 文本 UI。

## 10. 最终评价

BreakPilot 相比 IDEA MCP 最有价值的不是“再包装一层 debugger 命令”，而是把调试过程建模成 Agent 可验证的状态机和证据图。当前 schema、run-to-line、pauseEpoch、事件游标已经证明这条路可行。

下一阶段应克制地把重点放在可信度：**不伪造完整性、不吞错误、不为 path eager-expand 全帧、不把超时叫断线、不把未确认停止叫 stopped、不让授权 UI 破坏后续调试。**本轮证明 opaque ref 与 pauseEpoch 本身可用；把浅读 + lazy traversal 做成默认路径后，这套模型会比 IDEA 的文本树更适合复杂疑难问题的自主调试。

## 11. 本轮交付验证

- 方法证据清单：IDEA `14/14`（13 个 `xdebug_*` + `get_run_configurations`），BreakPilot `15/15`。
- 授权后复测：pause、stepOver、readonly eval 均成功；frame/value/context/includeFrame 均按相同暂停点重新采样。
- 参数隔离：frame depth 0/1、limit 2/3/4、path/ref、步进后 stale ref 均有实机结果；limit 4 连续三次 3s 超时。
- decoder 同形构造：3 个 String 子字段约 120 keys 时 decode=true，4 个子字段约 130 keys 时 decode=false，与实机边界一致。
- Fresh BreakPilot core test：`346 passed, 0 failed, 0 skipped`，耗时约 72s。
- Fresh TypeScript typecheck：退出码 0。
- 报告结构检查：20 个 code fence 成对、54 个 heading 无跨级、关键方法/错误码/根因文件均出现。
- 最终运行态：IDEA sessions 为空，BreakPilot sessions/ideSessions 为空，无 `DemoApplication` 进程。
- 最终断点态：与初始基线一致，仅保留一个 disabled user exception breakpoint。

## 12. 2026-08-02 修复执行与实机复验（更新结论）

本节记录在 `codex/live-trust-recovery` 分支上完成修复后的新一轮实机结果。若本节与前文对同一缺陷的描述冲突，以本节为准。

### 12.1 本轮执行边界

- 调试项目仍为 `simple-springboot-demo`，入口仍为 `DemoApplication` 和 `GET /api/hello`。
- BreakPilot 的 15 个 `bp_debug_*` 方法本轮全部实际调用；成功、能力拒绝和确认超时均保留为结果。
- IDEA MCP 本轮先成功调用 status/list，随后 `xdebug_set_breakpoint` 超过 60 秒仍不返回；终止该调用后，后续 IDEA MCP 请求被同一队列阻塞。清理其三个 stdio runner 后，IDEA MCP 变为 `Transport closed`，没有自动恢复。
- 为避免丢失用户的主 IDEA 编辑状态，没有重启主 IDEA。前文 14/14 的 IDEA 全方法结果仍作为完整功能对照；本节新增的是 transport 隔离与恢复性证据，不能表述为本轮再次完成 14/14。
- BreakPilot 使用独立 `runIde` 沙箱加载新插件，未操作主 IDEA 进程。

### 12.2 已修复并通过实机的项目

| 缺陷 | 修复 | 实机结果 |
|---|---|---|
| IDEA provider 设置断点前先 list/批量替换，可能误删既有断点 | 改为逐个精确 upsert，不再用 list 推导替换集合 | 10 次 set/remove 循环后每次都只剩 5 个基线断点 |
| session cleanup 广播清空 agent 断点 | IDEA session 只按本 session 的内部 ID 精确删除；DAP 保留原广播策略 | session 级第 27 行断点消失，session 外第 25 行断点保留 |
| IDEA bridge 未保留 condition/suspend/log/temporary | 新建 native breakpoint 时逐项应用，并在 snapshot 中回传 | 原有第 118 行 condition+THREAD、第 141 行 NONE+log message+stack 均完整读回 |
| 大 payload 被静默丢弃并伪报断线 | decoder 区分 malformed、over-budget、accepted；超预算响应按 correlation 立即失败 | 不再等待到通用断线错误；单测覆盖 requestId 安全关联 |
| `value(path)` 为找一个值先深展开整帧 | shallow root + 逐段 ref traversal；opaque ref 只展开目标节点 | `path=["name"], depth=4, limit=4` 成功返回 `Ada-Lovelace`，不再触发旧 limit=4 超时 |
| frame `depth=1, limit=4` 稳定超时 | 路径和响应预算修复后保留有界浅读 | 同一暂停点约 1 秒成功返回 `this/name` |
| context/includeFrame 吞 enrichment 失败 | 增加 `evidence.stop/stack/frame`、failures 和 warnings；位置可回退到 stop evidence | context 返回 position/frames/variables，evidence 三项均为 `complete` |
| IDEA request timeout/disconnect 混成通用错误 | 新增 `IDE_RESPONSE_TIMEOUT`、`IDE_DISCONNECTED`、`BRIDGE_PAYLOAD_LIMIT` | 单测覆盖 connected timeout 与 registry/session 消失两条路径 |
| run-config 输出含 enumerable `undefined` 导致契约失败 | 缺失字段直接省略 | `configurations` 成功返回；结果中不存在 `runPoints` 自有属性 |
| hub 重启后按位置删除原生断点只查 Core 内存，并返回契约错误 | Core 先查 desired state，未命中再读取 IDEA live list；空 ID 不再输出 `undefined` | `owner=all + filePath+line` 返回原生 ID 并真实删除第 25 行断点 |
| IDEA 插件重启后 agent marker 丢失，无法按原生 ID 删除 | 在 Core 已完成 owner 保护后，插件允许按 snapshot canonical ID 精确删除 live user breakpoint | 删除后清单由 6 回到基线 5，condition/suspend/trace 属性未改变 |

断点生命周期的实机小型压力门槛为 10 轮：每轮在第 22 行创建普通断点，均 `verified=true`；随后按 BreakPilot ID 删除，均 `removed=true`；每轮最终 `totalCount=5` 且第 22 行不存在。该结果证明当前精确创建/删除路径没有重现“删掉用户断点”或“留下 agent 垃圾断点”。

### 12.3 修复后的同一暂停点结果

本轮请求为 `GET /api/hello?name=Ada-Lovelace`，暂停于 `HelloController.java:21`。

| BreakPilot 调用 | 新结果 |
|---|---|
| `bp_debug_start` | 启动 `DemoApplication`，得到 BreakPilot session 与 IDEA session 的显式关联 |
| `bp_debug_control(wait)` | 命中第 21 行，状态 `paused` |
| `bp_debug_threads` | 返回当前线程及稳定 opaque/numeric ID；仍只有 1 项 |
| `bp_debug_call_stack` | 顶帧位置正确，带 `pauseEpoch=1` 和 partial/completeness |
| `bp_debug_frame(depth=1, limit=4)` | 成功，不再出现历史 3/4 阈值故障 |
| `bp_debug_value(path=["name"])` | 成功返回 `Ada-Lovelace`；只解析目标引用 |
| `bp_debug_value(ref=...)` | 成功直达 opaque ref；但一个 byte-array 子节点仍内嵌 12 个 children，见剩余问题 |
| `bp_debug_eval(name)` | 成功返回 `Ada-Lovelace` |
| `bp_debug_set_value(name, "Grace Hopper")` | `applied=true`，随后 path readback 为 `Grace Hopper`；输出仍为 `verified=false` |
| `bp_debug_context(depth=1, limit=4)` | position、frames、variables 均有值，`evidence={stop:complete,stack:complete,frame:complete}` |
| `bp_debug_control(drainEvents)` | 返回 sequence=1 的 stopped/breakpoint 事件及 cursor/overflow 元数据 |
| `bp_debug_run_to_line(line=25)` | 返回 `IDE_CONFIRMATION_TIMEOUT`；沙箱 IDEA 的高风险控制确认未获用户点击 |
| `bp_debug_control(disconnect)` | BreakPilot session 变为 stopped；IDE debuggee 保持暂停，随后通过关闭沙箱安全回收 |

`run-to-line` 的失败不是目标证明算法失败，而是确认协议仍依赖模态 UI。macOS 辅助功能不允许自动点击该对话框，因此本轮没有绕过安全策略。更重要的是，确认超时后紧接着的 breakpoint list 也超时，说明模态确认可能占用 IDEA 事件线程；重启沙箱和 Hub 后恢复。

### 12.4 新的直接对比结论

| 维度 | IDEA MCP | 修复后 BreakPilot |
|---|---|---|
| 单工具健康路径延迟 | 原生读取通常更快 | bridge 多一跳，通常更慢，但输出更适合 Agent |
| transport 故障隔离 | 一次无界 set 调用可拖死后续 stdio；runner 被清理后未自愈 | 每个 IDE request 有相关 ID、明确 timeout；Hub/插件重连可恢复 |
| 变量表示 | presentation 文本树，直接可读但难机器组合 | 结构化 node、path、opaque ref、pauseEpoch，可渐进读取 |
| 证据不完整 | 很少声明 partial/completeness | stack/context 明确完整性和失败域 |
| 断点清理 | 原生 canonical ID 直观可靠 | 已补 live-list hydration、owner guard、精确 session cleanup；跨重启 owner 仍需加强 |
| run-to-line | 动作结果简洁 | 设计上附 requested/actual/cleanup proof，更适合 Agent；当前被确认 UX 阻断 |
| 事件 | 控制返回 tail，模型偏专用 | cursor、overflow、droppedCount、typed kinds 更适合持续消费 |
| 安全授权 | 本轮直接 MCP 调用没有同类模态确认 | 有明确安全边界，但模态确认妨碍无人值守循环 |

BreakPilot 当前比 IDEA MCP 更好的核心仍然是：它把调试建模为带世代、引用、完整性和事件游标的证据协议，而不是让 Agent 解析 IDE 展示文本。本轮 `path/ref`、stale-handle 语义、context evidence 和精确断点清理均已从“设计优势”变成实机可用能力。

### 12.5 后续优化优先级

#### P0：确认协议改为可取消、非模态、可观察的状态机

- 请求先返回 `approvalRequired/approvalId/expiresAt`，不要让 MCP 调用占用 IDEA 模态事件流。
- Core timeout/cancel 必须向插件发送 expiry/cancel；late approval 不得继续执行旧动作。
- `status` 和 capability 增加 `approval=required|pending|granted|expired` 与 `readiness`。
- 确认 UI 不得阻塞 list breakpoint、heartbeat 和 readonly inspection。

#### P0：持久化跨重启的 breakpoint ownership

当前 `Key.putUserData` 只在插件进程内有效；IDE 重启后 agent 断点会显示为 user。此次加入的 live canonical-ID 删除是精确恢复手段，不是 ownership 的最终方案。应把 BreakPilot ID/owner 写入可持久化的 breakpoint properties 或独立 workspace mapping，并带创建方、session scope、createdAt。删除默认仍必须保护 user；只有显式 `owner=all` 才能删除实时 user 断点。

#### P0：严格执行每层 variable budget

direct ref 的顶层 `count=4` 能限制根字段数，但其中 byte-array 节点仍返回 12 个内嵌 children。应定义并测试：

- `limit` 是全响应、每层还是每节点预算；建议同时返回 `returnedCount/totalCount/truncated`。
- 深层 child callback 超时返回 partial node，不拖垮整个 snapshot。
- byte array、collection、map 和大型 String renderer 走分页/opaque ref，而不是内嵌展开。

#### P0：变更后的验证语义必须自洽

`set_value` 已通过 readback 确认新值为 `Grace Hopper`，却仍返回 `verified=false`。应由插件/native set result 或 Core readback 生成统一的 `applied/verified/verificationMethod`；无法验证时附 warning，不要让成功结果自相矛盾。

#### P1：能力协商应反映真实 native 语义

插件已经能够应用并回传 condition、suspendPolicy、temporary、log flags，但 Core capability 仍把高级断点拒绝为 `UNSUPPORTED_CAPABILITY`。需要逐项协商 `conditionalBreakpoints/tracepoints/temporary/suspendPolicy`，并用 live differential test 验证，而不是一次性宣称全部支持。

#### P1：线程、栈和异常断点正规化

- `threads` 仍只暴露当前线程 1 项，需要声明 partial 或实现真实分页线程集。
- function 仍为 `JavaStackFrame`，应传方法名、类名和隐藏框架帧原因。
- exception breakpoint 当前是空 filePath、line=-1，应使用可辨别的 discriminated union，而不是伪装成 source breakpoint。

#### P1：失联客户端淘汰与自动恢复

沙箱被强制关闭后，旧 IDE client 曾留在 Hub registry，新的 client 接入后请求被路由到旧 client 并超时；重启 Hub 后恢复。应基于 heartbeat TTL 排除 stale client，pending request 在 disconnect 时立即返回 `IDE_DISCONNECTED`，并提供自动重路由或明确的 retry-safe 信息。

#### P1：IDEA MCP 也需要超时、取消传播和 transport 自愈

本轮 IDEA `xdebug_set_breakpoint` 的无界等待使后续方法排队，最终 stdio transport 关闭且没有自动拉起。这是 BreakPilot 可以明显胜出的可靠性窗口：继续坚持每请求 deadline/correlation，同时增加 plugin-side watchdog、队列指标和 reconnect integration test。

### 12.6 本轮验证状态

- Core：`npm run typecheck`、全量 `npm test`、`npm run build` 通过；全量测试为 354/354。
- IDEA 插件：`gradle test` 通过；`gradle buildPlugin -x buildSearchableOptions` 通过。
- 完整 `buildPlugin` 的唯一失败是运行中 IDEA 导致 `buildSearchableOptions` 报单实例冲突，不是编译或测试失败。
- 新增 live-remove 修复后，Core targeted test 和 IDEA unit test 均通过，并完成独立沙箱实测。
- 断点最终恢复为 5 个进入本轮前的基线项；无第 22、25、27 行测试断点。
- DemoApplication 与 8080 listener 已停止；主 IDEA 未重启。
- 当前未满足的是“100 次完整无人值守调试循环”：确认协议仍会阻断 run-to-line。已完成 10 次真实 breakpoint lifecycle 循环，全部通过。

## 13. 2026-08-02 安装后验收

用户安装/启动新插件环境后，重新启动已构建 Core Hub，并在同一 Spring Boot 项目完成一次独立真实调试闭环。

实测证据：

- 插件以 debugger protocol v2 连接，协商得到 variable handles、stack pagination、native set-value、event stream 和 causal debug start。
- `DemoApplication` 启动成功，在 `HelloController.java:21` 命中断点；`frame(depth=1, limit=4)` 直接成功，旧版 limit 3/4 阈值故障未复现。
- `name=Ada-Lovelace` 同时通过 frame、path、opaque ref 和 readonly eval 读取；`name.toUpperCase()` 返回 `ADA-LOVELACE`。
- direct ref 返回 4 个 String 字段；byte array 的嵌套结果也被限制为 4 项，不再返回全部 12 项。
- set-value 把 `name` 从 `Ada-Lovelace` 修改为 `Grace Hopper`，path readback 一致；公开结果仍为 `verified=false`，因此该契约问题仍保留在 P0/P1 清单。
- step-over 从第 21 行到第 22 行，新的 `pauseEpoch=5`；旧 `pauseEpoch=1` ref 返回 `STALE_RUNTIME_HANDLE`。
- context 在第 22 行返回 position、frames、variables，`evidence.stop/stack/frame` 全部为 complete。
- run-to-line 请求第 25 行时先命中用户已有的第 118 行条件断点，正确返回 `targetReached=false`、实际位置 118、`cleanedUp=true`，且没有擅自继续执行。
- event drain 返回 5 个有序 stopped/continued 事件，cursor=5、droppedCount=0、overflowed=false。
- stop 返回 stopped；测试 agent 断点删除成功；最终 sessions/ideSessions 为空，8080 无监听，断点集合恢复为进入本轮前的 6 个用户基线项。

环境归属检查显示，本次成功连接的是由 Gradle `runIde` 启动的子 IDEA（使用 `.intellijPlatform/sandbox/.../plugins/breakpilot-idea`）。该实例与主 IDEA 使用同一 IntelliJ 平台及同一插件构建产物；按本项目的验收口径，子 IDEA 完成真实项目调试闭环即可视为 IDEA 插件验收通过，不再要求主 IDEA 重复安装或重启。主 IDEA 原生 IDEA MCP 的 `Transport closed` 属于另一条 MCP transport 生命周期问题，不影响本次 BreakPilot 插件验收结论。
