# BreakPilot Debugger MCP 完全替代 IDEA Debugger MCP 设计文档

日期：2026-06-19

## 目标

BreakPilot Debugger MCP 要完全替代 IDEA Debugger MCP，并成为更适合 agent 的默认调试 MCP。

“完全替代”在这里不是简单复制 IDEA MCP，而是达到下面几个目标：

- IDEA Debugger MCP 能完成的调试动作，BreakPilot MCP 都能完成。
- BreakPilot 保持更少、更稳定、更面向 agent 的返回结构，不照搬 IDE 内部对象。
- BreakPilot 提供 IDEA MCP 没有做好的 agent 原生能力，例如上下文聚合、断点 owner 保护、自动清理、可恢复错误提示。
- IDEA、VS Code、headless DAP 共用一套 control contract；不同 provider 能力不一致时，用明确 warning 或 capability error 表达。

## 当前状态

BreakPilot 已经具备主要调试闭环：

- `bp_debug_start`
- `bp_debug_status`
- `bp_debug_control`
- `bp_debug_threads`
- `bp_debug_call_stack`
- `bp_debug_frame`
- `bp_debug_value`
- `bp_debug_set_value`
- `bp_debug_eval`
- `bp_debug_context`
- `bp_debug_set_breakpoint`
- `bp_debug_list_breakpoints`
- `bp_debug_remove_breakpoint`

与 IDEA Debugger MCP 相比，当前主要缺口是：

- 没有 `bp_debug_run_to_line`。
- `pause` 已经出现在 schema 和 bridge 协议里，但需要验证 MCP 服务端和 IDE 插件都加载新版本后是否端到端稳定。
- `drainEvents` 现在只返回空事件结构。
- 断点 schema 没覆盖 `breakpointId` 更新、relocate、`enabled`、`temporary`、`suspendPolicy`、`isLogMessage`、`isLogStack`、owner filter。
- `bp_debug_list_breakpoints` 主要返回 BreakPilot 本地 store，不是完整 IDE breakpoint source of truth。
- IDEA provider 的 `bp_debug_set_value` 仍然返回不支持变量修改。
- `bp_debug_threads` 和 `bp_debug_call_stack` 只有 `limit`，没有 `offset`。
- IDEA bridge 缺少 run-to-line、真实 breakpoint listing/updating、变量修改、事件 drain 的一等命令。

## 非目标

- 不新增一套平行的 `xdebug_*` 兼容工具。BreakPilot 对外主接口仍然是 `bp_debug_*`。
- 不默认返回 IDEA MCP 那种偏 IDE 内部视图的大对象。
- 不恢复旧的 `ok/data/auditId` 外层 envelope。
- 不让 headless DAP 假装支持 IDE-only 能力；不能完整支持时返回明确 warning 或 unsupported capability。
- 不默认删除或改写用户自己的 IDE 断点，除非调用方显式传入 owner-aware 参数。

## 推荐方案

保持 `bp_debug_*` 作为唯一公开 MCP 调试接口，把它做成 IDEA Debugger MCP 的功能超集。

只新增一个工具：

- `bp_debug_run_to_line`

其余全部是已有工具增强：

- `bp_debug_set_breakpoint`
- `bp_debug_list_breakpoints`
- `bp_debug_remove_breakpoint`
- `bp_debug_threads`
- `bp_debug_call_stack`
- `bp_debug_set_value`
- `bp_debug_control`
- `bp_debug_context`

这样可以避免工具数量膨胀，也能让 agent 更容易学习和选择工具。

## 返回结构原则

所有 debugger 工具继续返回 compact top-level object。

通用字段：

```ts
{
  sessionId?: string;
  status?: "running" | "paused" | "stopped";
  message?: string;
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    details?: object;
  };
}
```

工具自己的有效载荷直接放在顶层：

```ts
{
  sessionId: "bp_...",
  status: "paused",
  position: {
    filePath: "/abs/path/DemoController.java",
    line: 24
  },
  frame: {
    index: 0,
    id: 123,
    filePath: "/abs/path/DemoController.java",
    line: 24,
    function: "hello"
  }
}
```

默认不返回大段 IDE presentation、capability、hub 或 bridge 内部细节。

读类工具增加可选参数：

```ts
detail?: "compact" | "diagnostic"
```

默认值是 `compact`。只有 `diagnostic` 才返回 provider capability、原始 adapter id、bridge id、partial 标记、trace metadata 等额外诊断信息。

## Compact 类型约定

文档中的 compact 类型指 BreakPilot 默认返回给 agent 的低 token 结构。

```ts
type CompactPosition = {
  filePath: string | null;
  line: number | null;
};

type CompactFrame = {
  index: number;
  id?: number | string;
  filePath: string | null;
  line: number | null;
  function: string;
};

type CompactVariable = {
  name: string;
  value: string;
  type?: string;
  path?: string[];
  ref?: number;
  children?: CompactVariable[];
};

type CompactScope = {
  scope: string;
  category?: string;
  items: CompactVariable[];
};

type CompactBreakpoint = {
  id: string;
  filePath: string;
  line: number;
  column?: number;
  verified: boolean;
  enabled: boolean;
  owner: "agent" | "user";
  temporary: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  isLogMessage?: boolean;
  isLogStack?: boolean;
  suspendPolicy?: "ALL" | "THREAD" | "NONE";
};
```

## 工具契约设计

### `bp_debug_run_to_line`

新增工具。

输入：

```ts
{
  projectPath?: string;
  sessionId?: string;
  filePath: string;
  line: number;
  threadId?: number | string;
  timeout?: number;
  includeFrame?: boolean;
  detail?: "compact" | "diagnostic";
}
```

输出：

```ts
{
  sessionId: string;
  status: "paused" | "stopped" | "timeout";
  position?: CompactPosition;
  frame?: CompactFrame;
  variables?: CompactScope[];
  temporaryBreakpointId?: string;
  cleanedUp?: boolean;
  message?: string;
  warnings?: string[];
}
```

provider 行为：

- IDEA provider 优先通过原生 bridge 命令 `agent_run_to_line` 实现。
- VS Code provider 如果可以用原生命令或 API 实现，则优先原生实现；否则走 fallback。
- DAP provider 使用 fallback：设置临时断点、resume、wait、清理临时断点。
- 无论 wait timeout、session stopped、还是 run-to-line 成功，临时断点都必须尝试清理。

### `bp_debug_set_breakpoint`

已有工具，增强。

输入：

```ts
{
  projectPath?: string;
  sessionId?: string;
  clientId?: string;
  ide?: "idea" | "vscode";
  breakpointId?: string;
  filePath?: string;
  line?: number;
  column?: number;
  condition?: string | null;
  hitCondition?: string | null;
  logMessage?: string | null;
  enabled?: boolean;
  temporary?: boolean;
  suspendPolicy?: "ALL" | "THREAD" | "NONE";
  isLogMessage?: boolean;
  isLogStack?: boolean;
  owner?: "agent" | "user";
  requireVerified?: boolean;
  detail?: "compact" | "diagnostic";
}
```

校验规则：

- location mode 必须传 `filePath + line`。
- update mode 必须传 `breakpointId`。
- update mode 同时传 `filePath + line` 时表示 relocate line breakpoint。
- `owner` 默认是 `agent`。
- `condition: null`、`hitCondition: null`、`logMessage: null` 表示清空已有值。

输出：

```ts
{
  sessionId?: string;
  breakpoint: CompactBreakpoint;
  lineText?: string;
  message?: string;
  warnings?: string[];
}
```

关键实现要求：

新增断点字段必须贯穿完整链路：

```text
tool schema
-> DebugToolArgs
-> BreakpointRecord / ProjectBreakpointRecord
-> bridge AgentBreakpoint
-> IDEA / VS Code breakpoint object
-> compact response
```

不能只扩 TypeScript schema，否则字段会在插件边界丢失。

### `bp_debug_list_breakpoints`

已有工具，增强。

输入：

```ts
{
  projectPath?: string;
  sessionId?: string;
  clientId?: string;
  ide?: "idea" | "vscode";
  filePath?: string;
  owner?: "agent" | "user" | "all";
  includeDisabled?: boolean;
  detail?: "compact" | "diagnostic";
}
```

输出：

```ts
{
  sessionId?: string;
  breakpoints: CompactBreakpoint[];
  totalCount: number;
  enabledCount: number;
  source: "ide" | "breakpilot" | "merged";
  warnings?: string[];
}
```

行为：

- IDE bridge 可用时，以 IDE 真实 breakpoint 列表为 source of truth。
- BreakPilot 本地 store 只负责补充 owner、BreakPilot id、临时断点等 metadata。
- IDE 查询不可用时，返回 BreakPilot store，并给出 warning。
- session-scoped 且未显式传 owner 时，默认列 agent breakpoints，避免干扰常规 agent 清理流程。
- project/global 查询且未显式传 owner 时，默认 `owner: "all"`，方便替代 IDEA MCP 的完整 breakpoint viewer。

### `bp_debug_remove_breakpoint`

已有工具，增强。

输入：

```ts
{
  projectPath?: string;
  sessionId?: string;
  clientId?: string;
  ide?: "idea" | "vscode";
  breakpointId?: string;
  filePath?: string;
  line?: number;
  owner?: "agent" | "user" | "all";
}
```

输出：

```ts
{
  breakpointId?: string;
  removed: boolean;
  protected?: boolean;
  message?: string;
  warnings?: string[];
}
```

行为：

- 默认 owner filter 是 `agent`。
- 如果按位置匹配到了 user breakpoint，但 owner 不是 `user` 或 `all`，返回 `protected: true`，不删除。
- 按 `breakpointId` 删除必须是幂等的。
- 删除 agent breakpoint 时，要同时删除 IDE 里的断点和 BreakPilot store 里的记录。

### `bp_debug_threads`

已有工具，增强。

输入：

```ts
{
  projectPath?: string;
  sessionId?: string;
  offset?: number;
  limit?: number;
  detail?: "compact" | "diagnostic";
}
```

输出：

```ts
{
  sessionId: string;
  threads: Array<{
    id: number | string;
    name: string;
    state: string;
    isCurrent: boolean;
    frameCount: number;
    partial?: boolean;
  }>;
  totalCount: number;
  offset: number;
}
```

线程 id 可以是 number 或 string。BreakPilot 不应该为了统一类型强行把 IDE opaque thread id 转成 number。

### `bp_debug_call_stack`

已有工具，增强。

输入：

```ts
{
  projectPath?: string;
  sessionId?: string;
  threadId?: number | string;
  offset?: number;
  limit?: number;
  detail?: "compact" | "diagnostic";
}
```

输出：

```ts
{
  sessionId: string;
  threadId?: number | string;
  frames: CompactFrame[];
  totalFrames: number;
  offset: number;
  partial?: boolean;
  warnings?: string[];
}
```

当前 IDEA 插件使用 `computeStackFrames(0, maxFrames)`。需要扩展为接受 `offset`，从指定 offset 开始收集 frame。

### `bp_debug_set_value`

已有工具，增强。

输入：

```ts
{
  projectPath?: string;
  sessionId?: string;
  frameIndex?: number;
  path: string[];
  newValue: string;
  detail?: "compact" | "diagnostic";
}
```

输出：

```ts
{
  sessionId: string;
  path: string[];
  oldValue?: string;
  newValue?: string;
  applied: boolean;
  message?: string;
  warnings?: string[];
}
```

IDEA provider 需要通过当前 debugger value modifier 实现变量修改。并不是所有变量都可修改，因此不可修改时返回正常 compact result：

```ts
{
  applied: false,
  message: "Selected value is not modifiable in the current debugger frame."
}
```

这比现在直接报 provider 不支持更适合 agent。

### `bp_debug_control`

已有工具，增强 `pause` 和 `drainEvents`。

`pause`：

- IDEA、VS Code、DAP provider 支持 pause 时都必须端到端可用。
- provider 不支持时，返回明确 unsupported capability，并带 provider 信息。
- pause 后等待 stopped event，并返回当前位置。

`drainEvents` 输出：

```ts
{
  sessionId: string;
  status: "running" | "paused" | "stopped";
  events: {
    breakpointErrors: Array<{
      breakpointId?: string;
      message: string;
      filePath?: string;
      line?: number;
    }>;
    tracepoints: Array<{
      breakpointId?: string;
      message: string;
      filePath?: string;
      line?: number;
      stack?: CompactFrame[];
    }>;
  };
}
```

IDEA 和 VS Code 插件需要 buffer tracepoint output 和 breakpoint validation errors，供 MCP drain。

### `bp_debug_context`

已有工具，保留并强化。

定位：

- 这是 BreakPilot 相比 IDEA MCP 更适合 agent 的核心工具。
- breakpoint、step、pause、wait 之后，推荐优先调用它。

输出：

```ts
{
  sessionId: string;
  status: "running" | "paused" | "stopped";
  position?: CompactPosition;
  frames: CompactFrame[];
  variables: CompactScope[];
  warnings?: string[];
}
```

增强：

- 如果没有 BreakPilot session，但 IDE bridge 里只有一个 compatible paused session，自动 adopt。
- 如果存在多个候选 session，返回 compact ambiguity error，并列出候选 session id 和 position。

## Bridge 协议设计

新增 message types：

```ts
AGENT_RUN_TO_LINE
AGENT_LIST_BREAKPOINTS
AGENT_UPDATE_BREAKPOINT
AGENT_SET_VARIABLE
AGENT_DRAIN_EVENTS
AGENT_REQUEST_THREADS
AGENT_REQUEST_STACK
IDE_BREAKPOINTS_SNAPSHOT
IDE_EVENTS_DRAINED
```

保留现有 message types：

```ts
AGENT_SET_BREAKPOINT
AGENT_REMOVE_BREAKPOINT
AGENT_REQUEST_VARIABLES
AGENT_CONTINUE
AGENT_PAUSE
AGENT_STEP_OVER
AGENT_STEP_INTO
AGENT_STEP_OUT
AGENT_EVALUATE
AGENT_STOP_DEBUG
```

bridge 继续用 `requestId` 做 request/response correlation。带 `error` 的返回统一使用 compact structured error：

```ts
{
  code: "IDE_SESSION_NOT_FOUND" | "IDE_COMMAND_FAILED" | "UNSUPPORTED_CAPABILITY" | string;
  message: string;
}
```

## Provider 设计

### `RuntimeDebugProvider`

扩展 provider interface：

```ts
type ThreadId = number | string;

interface RuntimeDebugProvider {
  runToLine?(args: {
    filePath: string;
    line: number;
    threadId?: ThreadId | null;
    timeoutMs?: number;
  }): Promise<RunToLineResult>;

  listBreakpoints?(filter?: BreakpointFilter): Promise<BreakpointRecord[]>;
  updateBreakpoint?(breakpoint: BreakpointRecord): Promise<BreakpointRecord>;
  drainEvents?(): Promise<DebugEventBuffer>;

  listThreads?(args?: { offset?: number; limit?: number }): Promise<PagedThreads>;
  getCallStack?(threadId?: ThreadId | null, args?: { offset?: number; limit?: number }): Promise<PagedStack>;
}
```

provider 支持级别：

- `native`：provider 直接实现该能力。
- `fallback`：BreakPilot 通过低层能力组合模拟。
- `unsupported`：工具返回 compact unsupported capability result 或 error。

### IDEA Provider

需要升级：

- 通过 `agent_run_to_line` 实现 native run-to-line。
- 通过 `agent_list_breakpoints` 获取 IDE 真实 breakpoints。
- 通过 `agent_update_breakpoint` 支持已有 breakpoint id 更新和 relocate。
- 通过 `agent_set_variable` 实现 debugger-backed mutation。
- 通过 `agent_drain_events` drain tracepoint 和 breakpoint validation events。
- 如果 IDEA 暴露非数字线程 identity，支持 string thread id。

### VS Code Provider

需要升级：

- 从 `vscode.debug.breakpoints` 支持 breakpoint listing。
- diagnostic 模式保留 VS Code breakpoint id。
- 支持 enabled、condition、hit condition、log message。
- VS Code extension API 不能完整实现的高级字段，返回 capability warning，不静默丢字段。
- native run-to-line 不足时，走 fallback。

### DAP Provider

需要升级：

- 通过临时断点 fallback 实现 run-to-line。
- stack trace 支持 `offset`。
- adapter 支持 `setVariable` 时实现变量修改。
- 尽量把 DAP breakpoint verification failure 映射到 drainable events。

## 数据模型更新

扩展 `BreakpointInput`、`BreakpointRecord`、`ProjectBreakpointRecord`：

```ts
{
  enabled?: boolean;
  temporary?: boolean;
  suspendPolicy?: "ALL" | "THREAD" | "NONE";
  isLogMessage?: boolean;
  isLogStack?: boolean;
  hitCondition?: string;
  logMessage?: string;
  owner?: "agent" | "user";
}
```

IDEA 和 VS Code 插件里的 bridge `AgentBreakpoint` 也要扩展同样字段。

BreakPilot id 和 IDE 原生 id 要分开存：

```ts
{
  id: string;                 // BreakPilot id
  adapterBreakpointId?: string | number;
  ideBreakpointId?: string;
  owner: "agent" | "user";
}
```

这样可以避免 BreakPilot 把 IDE 原生断点 id 和 agent 断点 id 混淆，从而误删用户断点。

## 错误与恢复设计

错误应该帮助 agent 自动恢复，而不是只说明失败。

多 session 示例：

```ts
{
  error: {
    code: "SESSION_AMBIGUOUS",
    message: "Multiple debug sessions are active. Pass sessionId to choose one.",
    details: {
      sessions: [
        { sessionId: "bp_1", state: "paused", position: { filePath: "...", line: 24 } },
        { sessionId: "bp_2", state: "running" }
      ]
    }
  }
}
```

session 正在运行示例：

```ts
{
  error: {
    code: "SESSION_RUNNING",
    message: "The session is running. Call bp_debug_control({ action: 'wait' }) or pause before reading frame variables."
  }
}
```

保护用户断点示例：

```ts
{
  removed: false,
  protected: true,
  message: "Matched breakpoint is user-owned. Pass owner: 'user' or owner: 'all' to remove it."
}
```

## 测试与验收

### 单元测试

新增或更新测试：

- tool schema 包含新增和增强字段。
- `bp_debug_run_to_line` 在 provider 支持 native method 时优先使用 native method。
- `bp_debug_run_to_line` fallback 会设置临时断点、resume、wait、清理。
- `bp_debug_set_breakpoint` 支持按 `breakpointId` 更新。
- `bp_debug_set_breakpoint` 支持 `breakpointId + filePath + line` relocate。
- `bp_debug_remove_breakpoint` 支持 owner-protected remove。
- `bp_debug_threads` 和 `bp_debug_call_stack` 支持 offset/limit。
- `bp_debug_set_value` 支持 compact non-modifiable result。
- `drainEvents` 返回 buffered events，并在读取后清空。

### IDEA 插件测试或编译检查

验证：

- 新 message protocol 和字段可以编译。
- `agent_list_breakpoints` 返回 user 和 agent breakpoints。
- `agent_update_breakpoint` 保留 owner metadata。
- `agent_run_to_line` 在 paused JVM session 可用。
- `agent_set_variable` 在不可修改时返回 `applied: false`，而不是模糊失败。

### VS Code 编译检查

验证：

- breakpoint schema 扩展可以编译。
- 现有 add/remove breakpoint 行为不回退。
- 不支持的高级字段会返回 warning，而不是静默丢弃。

### 真实项目验收

使用项目：

```text
/Users/Quixote/workSpace/Java/spring-boot-demo/simple-springboot-demo
```

验收流程：

1. 通过 BreakPilot start 或 adopt 一个 Spring Boot debug session。
2. 设置 agent breakpoint。
3. list breakpoints，确认返回来自 IDE source of truth。
4. 命中 breakpoint。
5. 调用 `bp_debug_context`。
6. 用 offset/limit 读取 threads。
7. 用 offset/limit 读取 call stack。
8. evaluate 一个表达式。
9. 调用 `bp_debug_set_value`，确认变量可修改或返回 clean non-modifiable result。
10. 用 `bp_debug_run_to_line` 跑到后续行。
11. drain events。
12. 只删除 agent breakpoints，并确认 user breakpoints 保留。
13. stop 或 resume session。

## 落地阶段

### Phase 1：契约与类型

- 添加 `bp_debug_run_to_line` tool definition。
- 给 breakpoint、thread、stack、set value、detail 增强 schema。
- 扩展 TypeScript session 和 breakpoint 类型。
- 更新 docs 和 oracle tests。

### Phase 2：Core Control Runtime

- 添加 `bp_debug_run_to_line` manager route。
- 实现 fallback run-to-line。
- 给 threads 和 call stack 打通 offset/limit。
- 实现 owner-aware breakpoint removal。
- 添加 event buffer 抽象。

### Phase 3：IDEA Bridge 与插件

- 添加新 bridge message types。
- 扩展 `BridgeMessage` 和 `AgentBreakpoint`。
- 实现真实 IDE breakpoint listing 和 update。
- 实现 run-to-line。
- 实现 set-variable 结果处理。
- 实现 event draining。
- 重启 MCP 服务端、重新安装插件后，验证 `pause` 端到端可用。

### Phase 4：VS Code Bridge

- 扩展协议和 breakpoint handling。
- 实现 VS Code 可支持的字段。
- 不支持的字段返回 capability warning。

### Phase 5：Headless DAP

- 实现 run-to-line fallback。
- adapter 支持时实现 DAP `setVariable`。
- 将 breakpoint verification failure 映射为可 drain 事件。

### Phase 6：验收与文档

- 运行单元测试。
- 运行 TypeScript typecheck。
- 编译 IDEA plugin。
- 编译 VS Code plugin。
- 用 Spring Boot demo 只通过 BreakPilot MCP 跑完整验收流程。
- 更新 debugger MCP 文档和推荐 agent workflow。

## 成功标准

满足下面条件时，BreakPilot 可以认为已经完全替代 IDEA Debugger MCP：

- Spring Boot 验收流程不需要调用任何 IDEA Debugger MCP 工具。
- IDEA Debugger MCP 的每个能力，在 BreakPilot 中都有等价或更好的工作流。
- BreakPilot 默认保护用户断点。
- BreakPilot 默认返回 compact、直接、低 token 的结果。
- 需要诊断时，可以显式请求更多 detail。
- provider-specific unsupported 行为明确、可理解、可恢复。

