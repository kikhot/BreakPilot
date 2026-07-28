# IDEA MCP Debugger 与 BreakPilot MCP Debugger 对照报告

本文按 Agent 是否能控制、理解并验证调试现场来比较两者。工具名相近不代表能力等价；
BreakPilot 以 capability、pause epoch、因果请求和运行时证据作为判断依据。

## 当前结论

BreakPilot 已形成跨 IDEA、VS Code 和 headless DAP 的统一 Agent 调试控制面：

- DAP run-to-line 在 adapter 支持 goto 时为 `native`，否则由 manager 使用可回滚临时断点
  事务提供 `fallback`；结果明确报告目标是否命中和 cleanup 证据。
- IDEA/VS Code bridge v2 提供暂停代次绑定的 opaque variable handle、分页调用栈、原生
  variable setter 及写后回读验证；v1 客户端仍保持诚实的 snapshot/
  `evaluateAssignment` 降级。
- IDEA/VS Code 事件经过会话、client、pause epoch 校验后进入有界 event buffer，
  `eventDrain` 只在协商成功且真实事件源已接线时声明 `native`。
- DAP 与 IDE breakpoint update 都使用按源文件完整对账的事务 fallback；更新、迁移和失败
  回滚保留 owner 保护。IDE 对账只删除 BreakPilot 自己拥有的陈旧断点，不触碰用户断点。
- 所有公开工具输出都会在返回前执行 runtime output-schema validation；违反契约会变成
  `OUTPUT_CONTRACT_VIOLATION`，不会把畸形 provider 数据交给 Agent。
- 差分证据已具备 capture、raw hash、确定性脱敏、lineage 和 offline replay 流水线。
  仓库内 fixture 明确标记为 `synthetic-replay`；只有显式 live E2E 成功并保留 raw digest
  的 bundle 才能标记为 `captured-replay`。
- bridge v2 重连会推进暂停代次、清除旧 origin 与待发送消息；旧连接生成的变量句柄、命令
  回执和响应不能穿越连接代际。IDEA 变量读取与 VS Code 一致执行请求级限制和脱敏。

## 能力对照

| 调试环节 | IDEA MCP | BreakPilot MCP | 判断 |
|---|---|---|---|
| IDEA run configuration / gutter 启动 | IDE 原生 | bridge v2 因果启动 | IDEA 的入口解析更丰富；BreakPilot 可跨 IDE。 |
| Headless launch/attach | 非核心定位 | DAP | BreakPilot 更强。 |
| pause/resume/step/wait/stop | 原生 | capability-gated，使用 origin + pause epoch | BreakPilot 多一层可验证因果边界。 |
| run-to-line | 原生 | IDE native；DAP native/fallback | 已覆盖，DAP fallback 为可回滚事务。 |
| 线程与调用栈 | IDE 原生对象 | 稳定 frame 字段、offset/limit、completeness | IDEA presentation 更丰富；BreakPilot 更适合跨 provider。 |
| 变量展开 | 原生对象引用 | v2 pause-scoped opaque ref；v1 snapshot | v2 已具备可持续展开能力，并能拒绝 stale handle。 |
| set value | 原生 setter | v2 native + read-back；v1/DAP 按能力降级 | 每次结果报告 `mutationMode/applied/verified`。 |
| debugger events | 原生事件 | v2 有界、可 drain、字段 allowlist | BreakPilot 额外提供 cursor/overflow 语义。 |
| breakpoint update | 原生 | DAP/IDE 完整 source reconciliation fallback | BreakPilot 强调 owner 与原子回滚。 |
| 高级断点字段 | IDEA 完整 | VS Code 较完整；IDEA 映射仍需扩展 | IDEA 仍更成熟。 |
| 安全策略 | IDE 用户边界 | workspace、endpoint、production、redaction、evaluate mode | BreakPilot 更适合自主 Agent。 |

## 为什么 v2 对 Agent 更友好

### 精确关联而不是“最近一次响应”

每个 v2 请求和结果绑定 BreakPilot session、IDE client、IDE session、request id、
origin request id 和 pause epoch。continue/step/run-to-line 的成功不能只由 command ack
证明，还必须观察到由同一 origin 导致、且 epoch 更新的运行状态。旧暂停或其他 session
的消息不能误满足当前请求。

### 暂停作用域引用

IDEA 与 VS Code 插件为变量生成 CSPRNG opaque handle。handle 只能在创建它的 IDE session
和 pause epoch 内展开或修改；resume、step、frame 选择变化和 terminate 都会使其失效并
返回 `STALE_RUNTIME_HANDLE`。Agent 不需要理解 XValue 或 DAP
`variablesReference` 的内部编号。

### 调用栈完整度

v2 直接调用 IDE/DAP 的分页 stack API，返回 `offset`、`limit`、`nextOffset`、
`totalFrames`（可信时）以及 `complete|partial|unknown`。如果 adapter 没有提供可信总数，
BreakPilot 不会猜测完整性。v1 snapshot 路径仍可能只有 top frame，并明确标记 partial。

### 原生变量修改证据

v2 setter 使用变量父容器和变量名执行 native slot mutation，并在同一 pause epoch 内回读。
结果区分命令已应用和读回值已验证；格式化后的展示值与输入不一致时 `verified:false`，
不会伪造精确相等。旧客户端继续声明 `evaluateAssignment`，Agent 可据此降低信任等级。

### 断点与事件事务

断点更新以完整 source list 对账，所有受影响源都获得 provider evidence 后才提交本地状态；
失败时尝试恢复原始列表，无法证明恢复则返回 indeterminate/cleanup 指引。事件流只接受
allowlist 字段，拒绝泄露原始 stack/variable payload，并用 cursor 报告丢失和 overflow。

## BreakPilot 优于 IDEA MCP 的地方

1. compact、严格且跨 provider 的稳定输出，Agent 不需要适配 IDE UI 对象。
2. capability 是可编程真值，`native/fallback/unsupported` 会在 dispatch 前强制执行。
3. 请求、暂停代次、变量引用和状态迁移具有显式因果关联，降低复杂调试中的串线风险。
4. 安全策略、输出 schema runtime validation、redaction 与 event allowlist 适合自动化调用。
5. breakpoint reconciliation、temporary run-to-line 和 mutation 都返回可核验结果与恢复语义。
6. 可离线验证的差分证据流水线能检测 transcript、hash、lineage 或 semantic 任一层篡改。
   回放路径受 bundle realpath 边界保护，脱敏只接受已审阅字段，并从已哈希 raw 字节生成。

## IDEA MCP 仍然更好的地方

1. run configuration、gutter 上下文、frame presentation 和 debugger object identity 更丰富。
2. IDEA 高级断点属性（enabled、temporary、suspend policy、log/stack 行为）的原生双向映射
   仍比 BreakPilot IDEA 插件完整。
3. 某些语言插件提供的专用 renderer、memory view、异步栈或 evaluator 功能尚未归一化。

## 仍需继续优化的边界

- capability diagnostic 增加来源、协议版本和 unsupported reason，同时保持 compact 不膨胀。
- 补齐 IDEA 高级断点属性的读取、更新确认和逐字段 applied evidence。
- 扩大 IDEA event adapter 对 output/thread/process/invalidated 的覆盖，但继续坚持字段 allowlist。
- 对 native setter 的展示值归一化增加 provider-specific comparator，避免纯格式差异造成假阴性。
- 为 IDEA bridge 增加不依赖 IntelliJ 网络栈的连接代际集成测试；当前代际推进与句柄失效已由
  编译测试和共享暂停态测试覆盖，VS Code 已有真实队列丢弃回归测试。
- 用当前 Spring Boot 样例执行一次经人工审查的 live differential capture。没有 IDEA 原生 MCP
  配置或暂停 session 时，E2E 命令必须非零退出，不能把 synthetic fixture 当作现场证明。

## 差分证据命令

离线验证仓库 fixture：

```bash
npm run evidence:differential:verify -- \
  --evidence-dir "$PWD/test/fixtures/evidence/differential-v1"
```

真实采集配置必须放在已忽略的绝对路径下，包含 IDEA 原生 MCP 与 BreakPilot MCP 的独立
stdio 命令、当前 source marker、hub URL `http://127.0.0.1:57987` 和 bridge URL
`ws://127.0.0.1:57987/bridge`：

```bash
npm run test:e2e:idea-differential -- \
  --config /absolute/ignored/differential-config.json
```

raw transcript 只写入 `.breakpilot/evidence/differential/<runId>/raw/`。SHA-256 证明本地文件
完整性，不独立证明响应来源；来源可信度由 manifest、provider-local session identity、
lineage 和现场操作记录共同给出。初始化失败记录为 `infrastructure_unavailable`；初始化成功后
的工具、脱敏、lineage 或回放失败记录为 `failed`，不会混淆两类结果。
