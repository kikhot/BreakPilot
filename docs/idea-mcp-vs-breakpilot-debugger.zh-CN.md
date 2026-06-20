# IDEA MCP Debugger 与 BreakPilot MCP Debugger 对照结论

本文对照的是当前会话里可用的 IDEA MCP debugger 工具和当前 BreakPilot 代码中的
`bp_debug_*` 工具。结论按 agent 实际使用场景组织，而不是按源码文件组织。

## 总览结论

BreakPilot 现在已经覆盖了 IDEA MCP debugger 的主要调试闭环：

- 启动或接入调试会话
- 查看调试状态
- continue / step / stop / wait
- 线程、调用栈、栈帧变量
- 表达式求值
- 按路径读取变量
- 设置、列出、删除断点
- 修改变量值的工具入口

但还没有做到完全一一等价。主要差距在四类：

1. **运行入口精度**  
   IDEA MCP 可以通过 `filePath + line` 直接发现并启动可运行入口；BreakPilot 主要通过
   `runConfigName`、`mode=ide` adopt、headless launch/attach 表达。BreakPilot 的
   `filePath + line` IDE 启动依赖 IDE bridge 能力，不等价于 IDEA MCP 的 gutter run
   discovery。

2. **IDE 原生断点能力**  
   IDEA MCP 支持更新已有 breakpoint id、临时断点、log message、log stack、suspend
   policy、enabled 开关、owner 过滤等完整断点模型。BreakPilot 目前只暴露 agent 断点的
   简洁模型，支持 `condition`、`hitCondition`、`logMessage` 等字段，但实际 IDE 插件侧
   对日志断点、临时断点、suspend policy、禁用/启用已有断点还没有完整等价实现。

3. **线程和栈帧定位精度**  
   IDEA MCP 的 `threadId` 是 debugger 显示层使用的 opaque string，`frameIndex` 直接来自
   当前暂停栈。BreakPilot 将线程 id 规整为 number，并返回 compact frame。对于 IDEA
   provider，当前栈能力有时是 partial/top-frame 为主，不总是和 IDEA MCP 的完整栈分页等价。

4. **运行控制能力仍有环境依赖**  
   BreakPilot 的 schema 里有 `pause`，代码也已补 `IdeRuntimeProvider.pause()` 和
   `agent_pause` bridge 消息；但实测如果正在运行的 BreakPilot MCP 服务端仍是旧进程，
   `bp_debug_control(action="pause")` 仍会报 provider 不支持。也就是说“代码能力已补”，
   但运行时是否可用取决于 MCP 服务端和 IDEA 插件是否都加载了最新版本。

## 一一对应表

### 1. 调试会话启动与接入

| IDEA MCP | BreakPilot MCP | 对应程度 | 说明 |
|---|---|---:|---|
| `xdebug_start_debugger_session(configurationName)` | `bp_debug_start(runConfigName)` | 接近一一对应 | 都可通过已有 IDE run configuration 启动调试。BreakPilot 需要 IDE bridge 支持 `agent_start_debug`。 |
| `xdebug_start_debugger_session(filePath, line)` | `bp_debug_start(filePath, line)` | 部分对应 | IDEA MCP 原生从代码位置启动；BreakPilot 也有参数，但依赖 IDEA bridge 从 source line 找 run config。 |
| `xdebug_start_debugger_session(...launch overrides...)` | `bp_debug_start(args/cwd/env/...)` | 部分对应 | BreakPilot headless DAP launch 支持更多 adapter 参数；IDE run config override 能力没有完全按 IDEA MCP 的 `supportsDynamicLaunchOverrides` 暴露。 |
| `xdebug_get_debugger_status()` 后复用 session | `bp_debug_start(mode="ide", ideSessionId)` | BreakPilot 额外能力 | BreakPilot 可以 adopt 已存在 IDE debug session，并把它变成 BreakPilot session。IDEA MCP 本身直接操作 IDE session，不需要 adopt。 |

结论：启动层面不是完全一一对应。IDEA MCP 更贴近 IDE 原生运行入口；BreakPilot 多了
headless DAP launch/attach 和 IDE session adopt。

### 2. 调试状态

| IDEA MCP | BreakPilot MCP | 对应程度 | 说明 |
|---|---|---:|---|
| `xdebug_get_debugger_status()` | `bp_debug_status()` | 一一对应，但视图不同 | IDEA 返回 IDE debug sessions；BreakPilot 返回 `activeSessionId`、BreakPilot sessions、`ideConnected`、`ideSessions`。 |

BreakPilot 的状态是 agent 视角，字段更少、更 compact，不返回完整 IDE client、capabilities、
历史 session 等冗余信息。

### 3. 执行控制

| IDEA MCP | BreakPilot MCP | 对应程度 | 当前状态 |
|---|---|---:|---|
| `xdebug_control_session(action="RESUME")` | `bp_debug_control(action="resume")` | 一一对应 | 已实测可用。 |
| `xdebug_control_session(action="WAIT_FOR_PAUSE")` | `bp_debug_control(action="wait")` | 一一对应 | 都等待 breakpoint/pause 事件。 |
| `xdebug_control_session(action="STEP_OVER")` | `bp_debug_control(action="stepOver")` | 一一对应 | 语义对应。 |
| `xdebug_control_session(action="STEP_INTO")` | `bp_debug_control(action="stepInto")` | 一一对应 | 语义对应。 |
| `xdebug_control_session(action="STEP_OUT")` | `bp_debug_control(action="stepOut")` | 一一对应 | 语义对应。 |
| `xdebug_control_session(action="STOP")` | `bp_debug_control(action="stop")` | 一一对应 | 语义对应。 |
| `xdebug_control_session(action="PAUSE")` | `bp_debug_control(action="pause")` | 设计对应，运行需验证 | BreakPilot 代码已补 pause；当前实测旧服务端仍报不支持。 |
| `xdebug_control_session(action="DRAIN_EVENTS")` | `bp_debug_control(action="drainEvents")` | 部分对应 | IDEA MCP 可返回 breakpoint errors / tracepoint outputs；BreakPilot 当前默认返回空事件结构。 |

结论：常用控制能力对应得比较完整，最大缺口是 `pause` 的运行时加载状态和
`drainEvents` 的事件内容。

### 4. 线程列表

| IDEA MCP | BreakPilot MCP | 对应程度 | 说明 |
|---|---|---:|---|
| `xdebug_get_threads(limit, offset)` | `bp_debug_threads(limit)` | 部分对应 | BreakPilot 没有 offset；线程 id 类型也不同。IDEA MCP 返回更贴近 IDE 线程 UI 的字段。 |

BreakPilot 返回更紧凑，适合 agent 快速选择当前线程；但分页能力和 IDE 线程展示细节较少。

### 5. 调用栈

| IDEA MCP | BreakPilot MCP | 对应程度 | 说明 |
|---|---|---:|---|
| `xdebug_get_stack(threadId, limit, offset)` | `bp_debug_call_stack(threadId, limit)` | 部分对应 | BreakPilot 没有 offset；IDEA MCP 的 `threadId` 是 string，BreakPilot 是 number。 |

BreakPilot 返回 frame 的 `index/id/filePath/line/function`，符合“少而关键”的目标。
但 IDEA MCP 的分页和原始 frame presentation 更完整。

### 6. 栈帧变量

| IDEA MCP | BreakPilot MCP | 对应程度 | 说明 |
|---|---|---:|---|
| `xdebug_get_frame_values(frameIndex, depth)` | `bp_debug_frame(frameIndex, depth, limit, expand)` | 一一对应，BreakPilot 更紧凑 | 都能读取当前 frame 的 locals/fields。BreakPilot 节点只保留 `name/value/path/type/ref/children` 等关键字段。 |

BreakPilot 的 `bp_debug_frame` 更适合 agent，因为没有大量 UI presentation 和原始调试器字段。

### 7. 按路径读取变量

| IDEA MCP | BreakPilot MCP | 对应程度 | 说明 |
|---|---|---:|---|
| `xdebug_get_value_by_path(path, depth)` | `bp_debug_value(path, depth)` | 一一对应 | 都按路径读取嵌套变量。 |
| 变量 ref 展开 | `bp_debug_value(ref, start, count)` | BreakPilot 额外/兼容 DAP 能力 | BreakPilot 同时支持按不透明 `ref` 展开变量，方便 headless DAP provider。 |

### 8. 表达式求值

| IDEA MCP | BreakPilot MCP | 对应程度 | 说明 |
|---|---|---:|---|
| `xdebug_evaluate_expression(expression, frameIndex, depth)` | `bp_debug_eval(expression, frameIndex, mode)` | 一一对应，但安全模型不同 | IDEA MCP 直接求值；BreakPilot 加了 `readonly/guarded/unsafe` 安全模式和确认策略。 |

实测当前安装插件后，`bp_debug_eval("name.toUpperCase()")` 已返回真实值
`ADA LOVELACE`，不再返回 `Collecting data…`。这说明 IDEA 插件侧 evaluate 结果读取已生效。

### 9. 修改变量

| IDEA MCP | BreakPilot MCP | 对应程度 | 说明 |
|---|---|---:|---|
| `xdebug_set_variable(path, newValue)` | `bp_debug_set_value(path, newValue)` | 工具对应，provider 能力不完全 | BreakPilot 工具有对应入口，但 IDEA provider 当前返回“不支持变量 mutation”。headless DAP provider 支持度取决于 adapter。 |

结论：工具层面对齐了，但 BreakPilot 对 IDEA provider 的 set value 还不是等价能力。

### 10. 断点设置

| IDEA MCP | BreakPilot MCP | 对应程度 | 说明 |
|---|---|---:|---|
| `xdebug_set_breakpoint(filePath, line)` | `bp_debug_set_breakpoint(filePath, line)` | 一一对应 | 都能设置行断点。 |
| `condition` | `condition` | 一一对应 | 都有条件断点字段。 |
| `hitCondition` | `hitCondition` | 一一对应 | 都有 hit condition 字段。 |
| `logMessage` / `isLogMessage` / `isLogStack` | `logMessage` | 部分对应 | BreakPilot schema 有 `logMessage`，但没有单独 `isLogMessage/isLogStack`。 |
| `suspendPolicy` | 无完整对应 | 缺失 | BreakPilot 当前断点工具没有公开 suspend policy。 |
| `temporary` | 无完整对应 | 缺失 | BreakPilot 当前没有临时断点字段。 |
| `enabled` | 无完整对应 | 缺失 | BreakPilot 当前不支持设置时禁用或更新启用状态。 |
| `breakpointId` 模式更新已有断点 | 无完整对应 | 缺失 | BreakPilot set 只创建 agent 断点，不支持按 id 更新/relocate。 |
| `owner` 参数 | 默认 agent-owned | 部分对应 | BreakPilot 断点默认 agent-owned，不暴露 user/agent owner 管理为完整参数。 |

结论：基础断点设置对应；高级断点能力 IDEA MCP 明显更完整。

### 11. 断点列表

| IDEA MCP | BreakPilot MCP | 对应程度 | 说明 |
|---|---|---:|---|
| `xdebug_list_breakpoints(filePath?)` | `bp_debug_list_breakpoints(filePath?)` | 部分对应 | IDEA MCP 返回 IDE 中所有断点，包含 user/agent、enabled、type、suspendPolicy 等；BreakPilot 返回 BreakPilot 管理的紧凑断点。 |

BreakPilot 的 list 更适合 agent 管理自己创建的断点，但不是完整 IDE breakpoint viewer。

### 12. 断点删除

| IDEA MCP | BreakPilot MCP | 对应程度 | 说明 |
|---|---|---:|---|
| `xdebug_remove_breakpoint(breakpointId)` | `bp_debug_remove_breakpoint(breakpointId)` | 一一对应 | 都可按 id 删除。 |
| `xdebug_remove_breakpoint(filePath, line)` | `bp_debug_remove_breakpoint(filePath, line)` | 一一对应 | 都可按位置删除。 |
| `owner=user/agent` filter | 无完整对应 | 缺失 | BreakPilot 没有公开 owner filter。 |

实测当前安装插件后，BreakPilot 创建的 21 行 agent 断点删除后不再命中；后续停在 24 行是用户断点。

### 13. Run-to-line

| IDEA MCP | BreakPilot MCP | 对应程度 | 说明 |
|---|---|---:|---|
| `xdebug_run_to_line(filePath, line)` | 无直接工具 | 缺失 | BreakPilot 当前可用“临时断点 + resume + remove”组合模拟，但没有一条原子工具。 |

这是 IDEA MCP 目前比 BreakPilot 明确多出的一个调试操作。

## IDEA MCP 有、BreakPilot 还没有或不完整的能力

下面是最值得补的差距，按优先级排序。

### P0：`pause` 的实际运行时一致性

BreakPilot 代码已有：

- `bp_debug_control(action="pause")`
- `IdeRuntimeProvider.pause()`
- `agent_pause` bridge 消息
- IDEA / VS Code 插件处理 `agent_pause`

但本轮实测中当前 BreakPilot MCP 服务端仍返回：

```json
{
  "error": {
    "code": "TOOL_FAILED",
    "message": "Runtime provider does not support pause."
  }
}
```

这说明运行中的服务端没有加载最新 `IdeRuntimeProvider.pause()`。这不是接口设计缺失，而是部署/重启状态问题。

### P1：`xdebug_run_to_line`

IDEA MCP 有原生 `run_to_line`。BreakPilot 没有直接对应工具。

建议新增：

```json
bp_debug_run_to_line({
  "filePath": "...",
  "line": 42,
  "timeout": 30000
})
```

内部可以先实现为：设置临时断点、resume、wait、自动删除临时断点。

### P1：高级断点模型

IDEA MCP 的断点模型更完整：

- update existing breakpoint by `breakpointId`
- relocate breakpoint
- `enabled`
- `temporary`
- `suspendPolicy`
- `isLogMessage`
- `isLogStack`
- owner filter

BreakPilot 现在只提供简化 agent 断点。建议保留默认简洁输出，但补齐输入能力。

### P1：真实 IDE breakpoint list/reconcile

BreakPilot 当前 list 更像“BreakPilot store list”，不是完整 IDE breakpoint list。  
如果目标是完全对齐 IDEA MCP，需要新增 bridge 查询：

```json
agent_list_breakpoints -> ide_breakpoints_snapshot
```

这样 `bp_debug_list_breakpoints` 才能返回 IDE 真实状态，而不只信本地 store。

### P2：变量修改在 IDEA provider 中未实现

BreakPilot 有 `bp_debug_set_value`，但 IDEA provider 当前不支持 mutation。  
IDEA MCP 有 `xdebug_set_variable`。如果要对齐，需要 IDEA 插件实现对当前 frame 变量的 setter。

### P2：事件/tracepoint 输出

IDEA MCP 的 `DRAIN_EVENTS` 可以返回 breakpoint errors 和 tracepoint outputs。  
BreakPilot 当前 `drainEvents` 默认是空结构，还没有完整 JVM tracepoint event buffer。

### P2：分页和 offset

IDEA MCP 的线程、栈支持 offset/limit。  
BreakPilot 多数只支持 limit，不支持 offset。

## BreakPilot 比 IDEA MCP 多出来的能力

BreakPilot 不是单纯复制 IDEA MCP，它有一些额外定位：

1. **IDE session adopt**
   `bp_debug_start(mode="ide", ideSessionId)` 可以把已有 IDE session 纳入 BreakPilot。

2. **Headless DAP launch/attach**
   `bp_debug_start(mode="launch|attach", language, host, port, adapter...)` 支持非 IDE provider。

3. **跨 IDE 设计**
   BreakPilot bridge 同时面向 IDEA / VS Code，而 IDEA MCP 只面向 JetBrains IDE。

4. **更 compact 的 agent 结果**
   BreakPilot 默认不返回 `ok/data/auditId`，也不返回大量 presentation/capability/hub 细节。

5. **evaluate 安全模型**
   BreakPilot 有 `readonly/guarded/unsafe` 和确认策略，IDEA MCP 更偏直接执行。

## 最终判断

如果按“能否完成一次常规 agent 调试闭环”判断：

**BreakPilot 已经基本具备。**

常规流程：

```text
status -> start/adopt -> set_breakpoint -> wait/resume -> call_stack -> frame/value -> eval -> remove_breakpoint -> resume/stop
```

当前已可跑通。

如果按“是否与 IDEA MCP debugger 完全一一等价”判断：

**还没有。**

还缺这些关键等价能力：

- `pause` 的运行时版本一致性需要解决
- `run_to_line`
- 完整 breakpoint update/temporary/enabled/suspendPolicy/log stack
- 真实 IDE breakpoint list/reconcile
- IDEA provider 的 set variable
- drainEvents 的真实事件/tracepoint 输出
- stack/thread offset 分页

如果按“agent 友好程度”判断：

**BreakPilot 的输出方向更合理。**

BreakPilot 返回更少、更关键、更稳定的字段；IDEA MCP 更像 IDE 原生调试器对象视图，
能力更全，但返回结构更偏工具内部视角。建议 BreakPilot 后续继续保持 compact 默认输出，
只在显式参数下返回更多诊断细节。
