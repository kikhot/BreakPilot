# Snapshot Progressive Disclosure Plan

## 背景

当前 `get_runtime_snapshot` 会读取当前暂停帧的所有 DAP scopes，并对变量做递归序列化。不同语言和 debug adapter 的 scope 名称不一样，但都会出现“第一轮诊断需要的信息”和“高级上下文/运行时噪音”混在一起的问题。

以 Python/debugpy 为例，通常会返回：

- `stackFrames`
- `Locals`
- `Globals`
- `special variables`
- `function variables`
- `class variables`
- 对象字段展开结果

Node/TypeScript、Java 等语言会用不同名称表达类似信息，例如：

- Node/TypeScript: `Local`、`Closure`、`Global`、`Script`、`Block`、`this`
- Java: arguments/local variables、`this`、fields、static fields、class/runtime metadata
- 其他 DAP adapter: 可能返回自定义 scope 名称或只返回少量通用 scope

这对“完整调试现场”是有价值的，但对 vibe coding / AI agent 的第一轮诊断来说噪音过大。大多数 bug 第一眼只需要知道：

- 当前停在哪一行；
- 调用栈是什么；
- 当前函数/方法的参数、局部变量和 receiver/`this` 是什么；
- 哪个变量的类型或值异常。

因此默认 snapshot 应该更聚焦，复杂信息应通过显式选项渐进展开。

## 核心判断

可以让 agent 自己选择读取范围，但前提是工具要提供清晰、稳定、低误用成本的选项。

换句话说，不应该只把所有数据一次性返回给 agent，然后期待 agent 自己过滤。更好的设计是：

```text
默认返回低噪音现场
  ↓
agent 如果发现信息不足
  ↓
通过明确参数请求更深/更广的数据
```

这符合三类开发经验：

- Agent 开发：上下文窗口和注意力都是资源，默认输出越干净，推理越稳定。
- CLI 开发：默认命令应服务最常见场景，高级参数服务诊断深水区。
- MCP 开发：tool schema 应表达“可用能力”和“推荐路径”，而不是只暴露底层协议细节。

## 目标体验

默认：

```text
snapshot
  -> stackFrames
  -> variables grouped by normalized categories:
       arguments
       locals
       receiver / this
  -> 对象只给 preview / type / variablesReference，不默认深展开
```

高级：

```text
snapshot --profile full
  -> stackFrames
  -> all raw scopes
  -> all normalized categories
  -> Globals / module / static / closure / runtime scopes
  -> object fields within limits
```

定向：

```text
snapshot --category locals --category globals
snapshot --scope Locals --scope Globals
snapshot --objects shallow
snapshot --objects deep --depth 2 --max-items 20
```

更理想的二阶段探索：

```text
snapshot --profile focused
  -> 返回 arguments / locals / receiver 和 variablesReference

inspect-variable --ref 7
  -> 只展开某个具体对象
```

这样 agent 可以先看当前帧的关键变量，再按需展开某个具体变量，而不是一次性吞下所有 globals/runtime/framework scopes。

## 设计原则

### 1. 默认聚焦

默认 snapshot 应该面向 80% 的调试场景：

- top stack frames；
- top frame 的 arguments、locals、receiver/`this`；
- 变量的 `name/type/valuePreview/kind/variablesReference/truncated/redacted`；
- 不展开 globals/module/static/runtime scopes；
- 不展开大型框架对象；
- 不递归展开对象字段，除非对象很小且策略允许。

### 2. 显式升级

高级数据不是删除，而是显式请求：

- `profile: "full"` 读取所有 scopes；
- `includeCategories: ["locals", "arguments", "receiver"]` 指定跨语言语义分类；
- `includeScopes: ["Locals", "Globals"]` 指定 scope；
- `objectFields: "none" | "preview" | "shallow" | "deep"` 控制对象字段；
- `maxDepth/maxItems/maxStringLength` 继续作为安全阀。

### 3. Agent 可选择，但不能无指导

MCP schema 应告诉 agent：

- 默认用 `focused`；
- 当当前帧关键变量无法解释问题时，再请求 `full` 或指定 category/scope；
- 需要对象深层字段时，优先展开具体变量，而不是全量 snapshot；
- `evaluate` 默认使用 `readonly`。

这不是限制 agent，而是给 agent 一个稳定的决策树。

### 4. 保留可追踪性

无论 focused 还是 full，返回结果里都应包含：

- `profile`
- `omittedScopes`
- `availableScopes`
- `limits`

这样 agent 知道“还有哪些东西没看”，并能主动升级请求。

## 多语言适配原则

不能把 `Locals` / `Globals` 写死为唯一模型。`get_runtime_snapshot` 应该引入一层 scope normalization，将 adapter 原始 scope 归一化成跨语言语义分类，同时保留 raw scope 名称用于高级诊断。

推荐归一化分类：

| category | 含义 | 默认 focused |
|---|---|---|
| `arguments` | 当前函数/方法参数 | 是 |
| `locals` | 当前帧局部变量 | 是 |
| `receiver` | `this` / `self` / 当前对象 | 是 |
| `closures` | 闭包捕获变量 | 视语言和数量限制，可 preview |
| `globals` | 全局变量、模块级变量 | 否 |
| `statics` | Java/C# 等静态字段或类级状态 | 否 |
| `module` | JS/TS module/script scope、Python module metadata | 否 |
| `runtime` | `__builtins__`、class/function/special variables、framework runtime | 否 |
| `other` | adapter 未识别 scope | 否，除非 full/custom |

语言映射示例：

| 语言/Adapter | 原始 scope/变量 | 归一化建议 |
|---|---|---|
| Python/debugpy | `Locals` | `arguments + locals`，按 frame 变量统一放入 focused |
| Python/debugpy | `Globals` | `globals` |
| Python/debugpy | `special variables` / `function variables` / `class variables` | `runtime` |
| Python/debugpy | `self` | `receiver` |
| Node/js-debug | `Local` / `Block` / `Catch` | `locals` |
| Node/js-debug | function parameters | `arguments`，若 adapter 不区分则并入 `locals` |
| Node/js-debug | `this` | `receiver` |
| Node/js-debug | `Closure` | `closures` |
| Node/js-debug | `Global` | `globals` |
| Node/js-debug | `Script` / `Module` | `module` |
| TypeScript/js-debug | 同 Node，同时保留 sourcemap 后的 source path | 同 Node |
| Java/JDWP | method arguments | `arguments` |
| Java/JDWP | local variables | `locals` |
| Java/JDWP | `this` | `receiver` |
| Java/JDWP | object fields | 通过 `inspect_variable` 定向展开 |
| Java/JDWP | static fields / class metadata | `statics` / `runtime` |
| 未知 DAP adapter | 已知名称按规则匹配，未知名称 | `other`，只在 full/custom 默认显示 |

多语言设计要点：

- 返回结构中同时保留 `variables` 和 `rawScopes`/`scopeMetadata`，避免归一化丢信息。
- `focused` profile 按 category 选择，不按 raw scope 名称选择。
- 每个 language adapter 可以提供自己的 `ScopeClassifier`。
- 没有专门 classifier 的语言走通用 fallback classifier。
- 不默认调用 getter、方法或属性求值；只读取 DAP 已提供的 variables。
- TypeScript 需要保留 source map 映射后的 frame 信息，方便 agent 对源码文件定位。
- Java 对象字段通常很深，focused 默认只给 `this` preview 和 `variablesReference`，深挖交给 `inspect_variable`。

## MCP API 计划

### 修改 `get_runtime_snapshot`

新增参数：

```json
{
  "profile": "focused",
  "includeCategories": ["arguments", "locals", "receiver"],
  "objectFields": "preview",
  "maxDepth": 1,
  "maxItems": 10,
  "maxStringLength": 2000
}
```

字段说明：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `profile` | `focused | locals | full | custom` | `focused` | 快照预设 |
| `includeCategories` | `string[]` | profile 决定 | 指定跨语言归一化分类 |
| `includeScopes` | `string[]` | profile 决定 | 指定 adapter 原始 scope 名，主要用于高级调试 |
| `objectFields` | `none | preview | shallow | deep` | `preview` | 是否展开对象字段 |
| `maxDepth` | number | profile 决定 | 最大展开深度 |
| `maxItems` | number | profile 决定 | 每个容器最多变量数 |
| `maxStringLength` | number | policy 决定 | 字符串截断长度 |

推荐 profile：

| profile | 返回内容 | 适用场景 |
|---|---|---|
| `focused` | `stackFrames + arguments + locals + receiver + object preview` | 默认第一轮诊断 |
| `locals` | `stackFrames + arguments + locals + receiver`，对象不展开 | 输出最小化 |
| `full` | 所有 scopes + 按限制展开对象 | 复杂问题、框架状态、全局配置 |
| `custom` | 按 `includeCategories/includeScopes/objectFields` 决定 | agent 或高级用户精确控制 |

响应中新增 metadata：

```json
{
  "profile": "focused",
  "availableCategories": ["arguments", "locals", "receiver", "globals", "runtime"],
  "omittedCategories": ["globals", "runtime"],
  "availableScopes": ["Locals", "Globals"],
  "omittedScopes": ["Globals"],
  "scopeMetadata": [
    {
      "rawName": "Locals",
      "category": "locals",
      "included": true
    }
  ]
}
```

### 新增 `inspect_variable`

新增 MCP tool：

```text
inspect_variable
```

输入：

```json
{
  "sessionId": "sess_001",
  "variablesReference": 7,
  "maxDepth": 1,
  "maxItems": 20
}
```

作用：

```text
只展开某个变量，不重新读取所有 scopes。
```

这比让 agent 用 `snapshot --profile full` 更节省上下文，也更符合 IDE 调试面板的展开模型。

## CLI 计划

### 默认命令

```bash
node dist/src/cli.js snapshot --session "$SESSION" --pretty
```

等价于：

```bash
node dist/src/cli.js snapshot \
  --session "$SESSION" \
  --profile focused \
  --objects preview \
  --pretty
```

### 高级命令

读取所有 scope：

```bash
node dist/src/cli.js snapshot \
  --session "$SESSION" \
  --profile full \
  --depth 2 \
  --max-items 20 \
  --pretty
```

只读当前帧关键变量：

```bash
node dist/src/cli.js snapshot \
  --session "$SESSION" \
  --profile locals \
  --pretty
```

指定 scope：

```bash
node dist/src/cli.js snapshot \
  --session "$SESSION" \
  --category locals \
  --category receiver \
  --objects shallow \
  --pretty
```

指定 adapter 原始 scope：

```bash
node dist/src/cli.js snapshot \
  --session "$SESSION" \
  --scope Locals \
  --scope Globals \
  --objects shallow \
  --pretty
```

定向展开变量：

```bash
node dist/src/cli.js inspect-variable \
  --session "$SESSION" \
  --ref 7 \
  --depth 1 \
  --max-items 20 \
  --pretty
```

## Agent 决策策略

Agent 默认应按以下顺序使用：

```text
1. wait_for_breakpoint
2. get_runtime_snapshot(profile=focused)
3. 查看 stackFrames、arguments、locals、receiver
4. 如果当前帧关键变量已能解释问题，停止继续扩展
5. 如果某个对象 preview 不够，inspect_variable 或 readonly evaluate
6. 如果问题涉及闭包、全局配置、模块状态、静态字段、框架上下文，再按 category 请求
7. 只有仍不够时，再 get_runtime_snapshot(profile=full)
8. continue 或 disconnect
```

推荐规则：

- 不要第一步请求 full snapshot。
- 不要默认读取 globals/runtime/module/static scopes。
- 不要默认深展开 Flask app、Express request、Spring bean、Java entity graph、module、class 等大型对象。
- 优先使用 `readonly evaluate` 查看单个表达式。
- 只有当当前帧关键变量不能解释问题时，才扩大 category/scope。

## 实现计划

### Phase 1: scope normalization

改动文件：

- `src/debug-adapters/LanguageAdapter.ts`
- 新增 `src/inspection/ScopeClassifier.ts`
- `src/types/`

任务：

1. 定义 normalized scope category：
   - `arguments`
   - `locals`
   - `receiver`
   - `closures`
   - `globals`
   - `statics`
   - `module`
   - `runtime`
   - `other`
2. 给每个 adapter 增加 scope classifier：
   - Python/debugpy
   - Node/TypeScript/js-debug
   - Java/JDWP
   - fallback generic DAP classifier
3. 返回 `scopeMetadata`，保留 raw scope 名称、category、included 状态。

### Phase 2: focused snapshot

改动文件：

- `src/control/toolDefinitions.ts`
- `src/cli.ts`
- `src/inspection/SnapshotBuilder.ts`
- `src/inspection/VariableSerializer.ts`
- `src/types/`
- `docs/mcp-tools.md`
- `docs/demo-flask.md`
- `test/smoke.ts`

任务：

1. 给 `get_runtime_snapshot` 增加 `profile/includeCategories/includeScopes/objectFields` schema。
2. CLI `snapshot` 增加 `--profile`、`--category`、`--scope`、`--objects`。
3. `SnapshotBuilder` 按 profile 和 category 过滤 scopes。
4. `VariableSerializer` 支持对象字段展开模式：
   - `none`
   - `preview`
   - `shallow`
   - `deep`
5. 响应中加入：
   - `profile`
   - `availableCategories`
   - `omittedCategories`
   - `availableScopes`
   - `omittedScopes`
   - `scopeMetadata`
6. 默认 profile 改为 `focused`。
7. 保留 `profile=full` 兼容旧的完整输出。

### Phase 3: variable drill-down

新增：

- MCP tool: `inspect_variable`
- CLI command: `inspect-variable`

任务：

1. 根据 `variablesReference` 定向读取子变量。
2. 支持分页：`start/count`。
3. 支持深度限制：`maxDepth/maxItems`。
4. 响应复用当前 `SerializedVariable` 格式。

### Phase 4: multi-language validation

验证矩阵：

| 语言 | 目标 | focused 应包含 | full 应包含 |
|---|---|---|---|
| Python Flask/debugpy | 请求体类型错误 | `amount`、`discount`、`order`、`self` 若存在 | `Globals`、runtime groups |
| Node/Express/js-debug | request body / async handler bug | params/body/local variables、`this` 若存在 | closure/global/module scopes |
| TypeScript/js-debug | source map 后的 TS 源码断点 | TS source frame、locals、arguments | JS runtime/module scopes |
| Java/Spring/JDWP | controller/service 参数错误 | method arguments、locals、`this` preview | static fields/class metadata/object fields |

验收时必须确认：

- focused 不依赖 raw scope 名称；
- 各语言缺少某类 category 时优雅降级；
- unknown adapter 使用 fallback classifier；
- `profile=full` 仍能取回完整原始 scopes；
- `inspect_variable` 可跨语言展开对象字段。

### Phase 5: agent-facing guidance

新增或更新：

- `AGENTS.md`
- Codex skill: `breakpilot-debugger`
- `docs/mcp-tools.md`

内容：

```text
默认 focused snapshot。
只有在当前帧关键变量不足时才扩大 category 或 full snapshot。
优先 inspect_variable / readonly eval。
结束后 disconnect。
```

## 兼容性策略

当前项目还处于早期阶段，可以接受默认行为从“完整 snapshot”改成“focused snapshot”。但为了避免老用户困惑：

- 文档明确说明默认行为变化；
- 提供 `--profile full` 恢复旧体验；
- 提供 `--scope <rawScopeName>` 处理特殊 adapter；
- MCP schema 的 description 写清楚推荐用法；
- CLI help 中展示 focused/full 两种模式。

## 验收标准

### focused 模式

输入：

```bash
node dist/src/cli.js snapshot --session "$SESSION" --pretty
```

输出应包含：

- `stackFrames`
- normalized categories: `arguments` / `locals` / `receiver`，按语言可用性返回
- raw scope metadata
- `availableCategories`
- `omittedCategories`
- `availableScopes`
- `omittedScopes`

输出不应默认包含：

- globals/module/static/runtime categories
- Python `__builtins__`
- Node global/module scopes
- Java static/class metadata
- 大型框架对象深层字段

### full 模式

输入：

```bash
node dist/src/cli.js snapshot --session "$SESSION" --profile full --pretty
```

输出应包含：

- 当前 adapter 提供的所有 raw scopes
- 所有可归一化 categories
- 对象字段展开结果

但仍必须受限于：

- `maxDepth`
- `maxItems`
- `maxStringLength`
- redaction policy

### agent 行为

给 agent 一个断点场景时，它应优先调用：

```text
get_runtime_snapshot(profile=focused)
```

只有当 focused 输出不足时，才调用：

```text
inspect_variable
```

或：

```text
get_runtime_snapshot(profile=custom, includeCategories=[...])
```

最后才调用：

```text
get_runtime_snapshot(profile=full)
```

## 结论

应该让 agent 自己选择读取范围，但工具需要提供默认聚焦、显式升级、定向展开的结构化能力。

推荐方案是：

```text
默认 snapshot = stackFrames + arguments + locals + receiver + object preview
高级 snapshot = category/custom 或 profile full
定向深挖 = inspect_variable 或 readonly evaluate
```

这能同时满足：

- 人类 CLI 输出可读；
- vibe coding 上下文更干净；
- MCP tool schema 对 agent 更友好；
- 复杂场景仍能完整观测运行时。
