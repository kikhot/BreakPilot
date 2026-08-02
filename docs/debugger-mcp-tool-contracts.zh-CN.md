# IDEA Debugger 与 BreakPilot MCP 工具参数和返回结构（历史基线）

> 本文记录旧 provider-shaped 契约的实测历史，不再是公共 API 参考。
> 当前 compact/diagnostic 契约以 [mcp-tools.zh-CN.md](mcp-tools.zh-CN.md) 和
> `src/control/toolDefinitions.ts` 为准；旧 `ref/includeFrame/maxItems/details`
> 等字段不得用于新 MCP 调用。

本文记录 2026-06-19 在
`/Users/Quixote/workSpace/Java/spring-boot-demo/simple-springboot-demo`
上实测 IDEA 自带 debugger MCP 工具和 BreakPilot `bp_debug_*` MCP 工具时观察到的参数、返回结构和差异。

范围：

- IDEA：`xdebug_*` debugger 工具，以及 debugger 启动常用的 `get_run_configurations` / `execute_run_configuration`。
- BreakPilot：公开 `bp_debug_*` MCP 工具。

不包含 IDEA MCP 的数据库、文件搜索、Inspection KTS、普通编辑等非 debugger 工具。

## 实测环境

- IDEA projectPath：`/Users/Quixote/workSpace/Java/spring-boot-demo/simple-springboot-demo`
- Run configuration：`DemoApplication`
- 入口：`src/main/java/com/example/demo/DemoApplication.java`
- 请求断点：`src/main/java/com/example/demo/controller/HelloController.java:21`
- 请求：`GET /api/hello?name=Ada%20Lovelace`
- BreakPilot hub：默认 `http://127.0.0.1:57987` 可被 MCP 使用；`27890` 按仓库说明可启动，但本次 MCP 连接实际走默认端口。

## 总体返回差异

IDEA debugger MCP 多数工具直接返回业务 JSON：

```json
{
  "sessions": [],
  "activeSessionId": "DemoApplication"
}
```

少数值读取/表达式工具返回 MCP content 数组，内容是树形文本：

```json
[
  {
    "type": "text",
    "text": "name = \"Ada Lovelace\"\n  ├─ coder = 0\n"
  }
]
```

BreakPilot MCP 重构前曾统一使用 envelope；当前已改为直接返回业务字段：

```json
{
  "status": "paused",
  "reason": "breakpoint",
  "position": {
    "filePath": "/path/to/HelloController.java",
    "line": 21
  }
}
```

失败时：

```json
{
  "error": {
    "code": "IDE_SESSION_NOT_FOUND",
    "message": "IDE debug session was not found."
  }
}
```

BreakPilot 读变量时会把 IDE 的文本树转换成紧凑结构化节点：

```json
{
  "name": "analysis",
  "type": "HelloController$NameAnalysis@6946",
  "value": "...",
  "path": ["analysis"]
}
```

## IDEA Debugger 工具

### get_run_configurations

参数：

```ts
{
  projectPath?: string;
  filePath?: string;
}
```

不传 `filePath` 时返回项目 run configuration：

```ts
{
  configurations: Array<{
    name: string;
    description?: string;
    supportsDynamicLaunchOverrides?: boolean;
  }>;
}
```

传 `filePath` 时返回可运行代码位置：

```ts
{
  filePath: string;
  runPoints: Array<{
    line: number;
    description: string;
    elementText?: string;
  }>;
}
```

实测：

- `DemoApplication` 返回 `supportsDynamicLaunchOverrides: true`。
- `DemoApplication.java` 返回第 7 行和第 9 行两个 run point。

### execute_run_configuration

参数：

```ts
{
  projectPath?: string;
  configurationName?: string;
  filePath?: string;
  line?: number;
  waitForExit?: boolean;
  timeout?: number;
  programArguments?: string;
  workingDirectory?: string;
  envs?: Record<string, string>;
}
```

返回结构：

```ts
{
  output: string;
  fullOutputPath?: string;
  exitCode?: number;
}
```

约束：

- `configurationName` 和 `filePath + line` 二选一。
- 覆盖 `programArguments` / `workingDirectory` / `envs` 前应先看 `get_run_configurations().supportsDynamicLaunchOverrides`。

### xdebug_get_debugger_status

参数：

```ts
{
  projectPath?: string;
}
```

返回：

```ts
{
  sessions: Array<{
    id: string;
    name: string;
    state: "running" | "paused" | "stopped";
    runConfigurationName?: string;
    currentPosition?: {
      filePath: string;
      line: number;
    };
  }>;
  activeSessionId?: string;
}
```

实测空闲时返回 `{"sessions":[]}`；暂停时 `activeSessionId` 为 `DemoApplication`。

### xdebug_start_debugger_session

参数：

```ts
{
  projectPath?: string;
  configurationName?: string;
  filePath?: string;
  line?: number;
  timeout?: number;
  graceWaitMs?: number;
  programArguments?: string;
  workingDirectory?: string;
  envs?: Record<string, string>;
}
```

返回：

```ts
{
  sessionId: string;
  name: string;
  state: "running" | "paused" | "stopped";
  runConfigurationName?: string;
  output?: string;
  fullOutputPath?: string;
  exitCode?: number;
}
```

实测启动 `DemoApplication` 时，因为已有入口断点，直接返回：

```json
{
  "sessionId": "DemoApplication",
  "name": "DemoApplication",
  "state": "paused",
  "runConfigurationName": "DemoApplication",
  "fullOutputPath": "/Users/Quixote/Library/Caches/JetBrains/IntelliJIdea2026.1/tmp/..."
}
```

### xdebug_control_session

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  action:
    | "STEP_INTO"
    | "STEP_OVER"
    | "STEP_OUT"
    | "RESUME"
    | "PAUSE"
    | "STOP"
    | "WAIT_FOR_PAUSE"
    | "DRAIN_EVENTS";
  timeout?: number;
  eventsLimit?: number;
  clearEventsAfterRead?: boolean;
}
```

常见返回：

```ts
{
  status: "running" | "paused" | "stopped";
  newPosition?: {
    filePath: string;
    line: number;
  };
  frameValues?: string;
  message?: string;
  breakpointErrorsTail?: unknown[];
  tracepointOutputsTail?: unknown[];
}
```

实测：

- `RESUME` 返回 `{"status":"running","breakpointErrorsTail":[]}`。
- `WAIT_FOR_PAUSE` 已暂停时返回 `status:"paused"`、`newPosition`、`frameValues` 和 `message:"Session 'DemoApplication' is already paused."`。
- `STEP_OVER` 返回下一行位置和浅层 `frameValues`。
- `STEP_INTO` 受 IDE step filter 影响，本次从第 25 行直接到了第 27 行，没有进入私有方法。
- `STEP_OUT` 从 controller 返回到 Spring `InvocableHandlerMethod.java:252`。
- `DRAIN_EVENTS` 返回 `tracepointOutputsTail: []`。
- `PAUSE` 可在运行中的 JVM 上暂停，本次停在 JDK `System.java:572`。
- `STOP` 返回 `{"status":"stopped","breakpointErrorsTail":[]}`。

### xdebug_get_threads

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}
```

返回：

```ts
{
  threads: Array<{
    id: string;
    name: string;
    state: string;
    isCurrent: boolean;
    additionalInfo?: string;
    additionalInfoTooltip?: string;
    frameCount: number;
  }>;
  offset: number;
  limit: number;
  totalCount: number;
}
```

实测线程 id 是展示字符串，例如 `"http-nio-8080-exec-1"@6,594 in group "main": RUNNING`。

### xdebug_get_stack

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  threadId?: string;
  limit?: number;
  offset?: number;
}
```

返回：

```ts
{
  frames: Array<{
    presentation: string;
    index: number;
    file: string;
    line: number;
    isCurrent: boolean;
  }>;
  threadId: string;
  totalFrames: number;
}
```

实测 controller 请求栈有 49 层，前几层包括 `HelloController.hello`、JDK invoke frame 和 Spring MVC frame。

### xdebug_get_frame_values

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  frameIndex?: number;
  depth?: number;
}
```

返回 MCP content 数组：

```ts
Array<{
  type: "text";
  text: string;
}>
```

实测第 24 行返回 `name`、`normalizedName`、`tokens`、`analysis`，其中 `analysis.score = 28`。

### xdebug_get_value_by_path

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  frameIndex?: number;
  path: string[];
  depth?: number;
}
```

返回 MCP content 数组：

```ts
Array<{
  type: "text";
  text: string;
}>
```

实测 `path:["name"]` 返回字符串值和内部字段 `value/coder/hash/hashIsZero`。

### xdebug_evaluate_expression

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  frameIndex?: number;
  expression: string;
  depth?: number;
}
```

返回 MCP content 数组：

```ts
Array<{
  type: "text";
  text: string;
}>
```

实测：

- `args.length` 返回 `args.length = 0`。
- `name.toUpperCase()` 返回 `"ADA LOVELACE"`。
- `analysis.score()` 返回 `28`。

### xdebug_set_variable

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  frameIndex?: number;
  path: string[];
  newValue: string;
}
```

返回：

```ts
{
  path: string[];
  oldValue: string;
  newValue: string;
  applied: boolean;
}
```

实测在入口帧对 `args` 设置 `new String[]{"probe"}` 返回：

```json
{
  "path": ["args"],
  "oldValue": "[]",
  "newValue": "",
  "applied": true
}
```

注意：返回的 `newValue` 是显示值，不一定保留传入表达式文本。

### xdebug_set_breakpoint

参数：

```ts
{
  projectPath?: string;
  breakpointId?: string;
  filePath?: string;
  line?: number;
  condition?: string | null;
  enabled?: boolean;
  isLogMessage?: boolean;
  isLogStack?: boolean;
  temporary?: boolean;
  suspendPolicy?: "ALL" | "THREAD" | "NONE";
}
```

返回：

```ts
{
  breakpointId: string;
  added: {
    id: string;
    type: "line" | "exception";
    file?: string;
    line?: number;
    enabled: boolean;
    owner: "user" | "agent";
    isLogMessage: boolean;
    isLogStack: boolean;
    temporary: boolean;
    suspendPolicy: string;
    hitCount: number;
  };
  totalBreakpoints: number;
  lineText?: string;
  message?: string;
}
```

实测：

- 新建临时断点返回 `message:"Breakpoint created."`。
- 对已有用户断点位置调用会返回 `message:"Updated existing breakpoint."`，并把该断点 owner 标成 `agent`。本次第 21 行原本是用户断点，因此未在清理时删除它。

### xdebug_list_breakpoints

参数：

```ts
{
  projectPath?: string;
  filePath?: string;
}
```

返回：

```ts
{
  breakpoints: Array<{
    id: string;
    type: string;
    file?: string;
    line?: number;
    enabled: boolean;
    owner: "user" | "agent";
    condition?: string;
    isLogMessage: boolean;
    isLogStack: boolean;
    temporary: boolean;
    suspendPolicy: string;
    hitCount: number;
  }>;
  totalCount: number;
  enabledCount: number;
}
```

### xdebug_remove_breakpoint

参数：

```ts
{
  projectPath?: string;
  breakpointId?: string;
  filePath?: string;
  line?: number;
  owner?: "user" | "agent";
}
```

返回：

```ts
{
  removed: boolean;
  removedCount: number;
  totalBreakpoints: number;
  message: string;
}
```

实测删除临时 agent 断点返回 `removed:true`、`removedCount:1`。

### xdebug_run_to_line

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  filePath: string;
  line: number;
  timeout?: number;
}
```

返回：

```ts
{
  sessionId: string;
  outcome: "paused" | "stopped" | "timeout";
  currentPosition?: {
    filePath: string;
    line: number;
  };
}
```

实测从 controller 第 21 行 run-to-line 到第 24 行，返回 `outcome:"paused"`。

## BreakPilot MCP 工具（当前重构后契约）

2026-06-19 重构后，BreakPilot MCP 默认返回已改为 compact 业务对象：

- 成功响应直接返回工具业务字段，不再包 `ok`、`data`、`auditId` 或空 `warnings`。
- 失败响应返回 `{ "error": { "code": "...", "message": "...", "details": {} } }`。
- `warnings` 仅在存在非致命告警时出现。
- `sessionId` 不再自动重复注入；只有 session summary 或启动结果这类后续调用需要的对象才返回它。
- `stopped.stopped`、bridge 原始 payload、capabilities、provider/client 元数据默认不再返回。
- 变量节点默认只保留 `name`、`value`、`type`、`path`、`ref` 和按需 `children`。

当前关键返回示例：

```json
{
  "activeSessionId": "sess_...",
  "sessions": [
    {
      "sessionId": "sess_...",
      "language": "idea",
      "mode": "ide",
      "state": "paused",
      "ideSessionId": "idea_..."
    }
  ],
  "ideConnected": true,
  "ideSessions": [
    {
      "ideSessionId": "idea_...",
      "name": "DemoApplication",
      "state": "paused",
      "active": true,
      "position": {
        "filePath": "/path/to/DemoApplication.java",
        "line": 10
      }
    }
  ]
}
```

`bp_debug_control(action:"wait")` 默认：

```json
{
  "status": "paused",
  "reason": "breakpoint",
  "position": {
    "filePath": "/path/to/HelloController.java",
    "line": 21
  }
}
```

`bp_debug_frame` 默认变量：

```json
{
  "frame": {
    "index": 0,
    "id": 992833861,
    "filePath": "/path/to/HelloController.java",
    "line": 21,
    "function": "hello"
  },
  "variables": [
    {
      "scope": "locals",
      "items": [
        {
          "name": "name",
          "value": "Ada Lovelace",
          "path": ["name"]
        }
      ]
    }
  ]
}
```

`bp_debug_set_breakpoint` 默认：

```json
{
  "breakpointId": "bp_...",
  "filePath": "/path/to/HelloController.java",
  "line": 25,
  "verified": true,
  "lineText": "String message = buildGreetingMessage(normalizedName, analysis, greetingLevel);"
}
```

## BreakPilot MCP 工具（重构前历史实测，仅供对比）

### bp_debug_status

参数：

```ts
{
  projectPath?: string;
}
```

返回：

```ts
{
  ok: true;
  data: {
    activeSessionId: string | null;
    sessions: Array<{
      sessionId: string;
      language: string;
      mode: "launch" | "attach" | "ide";
      owner: string;
      state: string;
      createdAt?: string;
      workspaceRoot?: string;
      providerKind?: string;
      ideClientId?: string;
      ideSessionId?: string;
      capabilities?: object;
    }>;
    ide?: {
      enabled: boolean;
      connected: boolean;
      clients: number;
      sessions: Array<{
        ideSessionId: string;
        clientId: string;
        name: string;
        state: string;
        active: boolean;
        threadId?: number;
        topFrame?: object;
        capabilities?: object;
      }>;
      capabilities: object;
    };
    capabilities: object;
  };
  warnings: string[];
  auditId: string;
}
```

实测注意点：

- `ide.sessions[].ideSessionId` 是 `idea_6kr2ve` 这类 bridge id，不是 IDEA 的 `DemoApplication`。
- 用 `DemoApplication` 调 `bp_debug_start(mode:"ide")` 会返回 `IDE_SESSION_NOT_FOUND`。

### bp_debug_start

参数：

```ts
{
  projectPath?: string;
  mode?: "launch" | "attach" | "ide";
  language?: "python" | "node" | "typescript" | "java";
  program?: string;
  filePath?: string;
  module?: string;
  args?: string[];
  cwd?: string;
  env?: object;
  host?: string;
  port?: number;
  dapHost?: string;
  dapPort?: number;
  dap?: object;
  adapterCommand?: string;
  adapterArgs?: string[];
  ideSessionId?: string;
  clientId?: string;
  runConfigName?: string;
  line?: number;
}
```

成功返回：

```ts
{
  ok: true;
  data: {
    session: {
      sessionId: string;
      language: string;
      mode: string;
      owner: string;
      state: string;
      workspaceRoot: string;
      providerKind: string;
      ideClientId?: string;
      ideSessionId?: string;
      capabilities: object;
    };
    startMode: string;
  };
  warnings: string[];
  auditId: string;
  sessionId: string;
}
```

实测 adopt IDEA session 后返回 `sessionId:"sess_mqjsd7ht_0001"`、`providerKind:"ide"`。

### bp_debug_control

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  threadId?: number;
  action:
    | "pause"
    | "resume"
    | "wait"
    | "stepOver"
    | "stepInto"
    | "stepOut"
    | "stop"
    | "disconnect"
    | "drainEvents";
  timeout?: number;
  includeFrame?: boolean;
  expand?: "none" | "preview" | "shallow" | "deep";
  depth?: number;
  limit?: number;
  maxString?: number;
  terminateDebuggee?: boolean;
}
```

成功返回：

```ts
{
  ok: true;
  data: {
    status: "running" | "paused" | "stopped";
    sessionId: string;
    stopped?: object;
    position?: {
      filePath: string;
      line: number;
      frameIndex: number;
    };
    frame?: object;
    result?: object;
    events?: {
      breakpointErrors: unknown[];
      tracepoints: unknown[];
    };
    alreadyStopped?: boolean;
  };
  warnings: string[];
  auditId: string;
  sessionId: string;
}
```

失败返回示例：

```json
{
  "ok": false,
  "error": {
    "code": "TOOL_FAILED",
    "message": "Runtime provider does not support pause.",
    "details": {
      "providerKind": "ide"
    }
  }
}
```

实测：

- `wait` 在暂停时返回 `position` 和可选 `frame`。
- `resume` 返回 `status:"running"`。
- `stepInto` 成功进入 `HelloController.java:134`。
- `stepOut` 回到 `HelloController.java:25`。
- `pause` 对 IDE provider 返回不支持。
- `disconnect` 在 IDEA 已 stop 后返回 `status:"stopped"` 和 warning `Debug session was already absent.`。

### bp_debug_context

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  timeout?: number;
  expand?: "none" | "preview" | "shallow" | "deep";
  depth?: number;
  limit?: number;
}
```

返回：

```ts
{
  ok: true;
  data: {
    sessionId: string;
    status: string;
    stopped?: object;
    position?: {
      filePath: string;
      line: number;
      frameIndex: number;
    };
    stack?: StackResult;
    frame?: FrameResult;
  };
  warnings: string[];
  auditId: string;
  sessionId: string;
}
```

用途：一次拿当前位置、栈和 top frame 变量。

### bp_debug_threads

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  threadId?: number;
  limit?: number;
}
```

返回：

```ts
{
  ok: true;
  data: {
    sessionId: string;
    threads: Array<{
      id: number;
      name: string;
      state: string;
      isCurrent: boolean;
      frameCount: number;
      partial?: boolean;
    }>;
    totalCount: number;
  };
  warnings: string[];
  auditId: string;
  sessionId: string;
}
```

实测 BreakPilot thread id 是数字，和 IDEA 直接返回的展示字符串不同。

### bp_debug_call_stack

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  threadId?: number;
  limit?: number;
}
```

返回：

```ts
{
  ok: true;
  data: {
    sessionId: string;
    threadId: number;
    frames: Array<{
      index: number;
      id: number;
      filePath: string;
      line: number;
      column?: number;
      function: string;
      presentation: string;
    }>;
    totalFrames: number;
    partial: boolean;
    capabilities?: object;
  };
  warnings: string[];
  auditId: string;
  sessionId: string;
}
```

实测 `capabilities.stack` 曾返回 `topFrameOnly`，即底层 IDE bridge 能力可能影响完整性。

### bp_debug_frame

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  threadId?: number;
  frameIndex?: number;
  frameId?: number;
  expand?: "none" | "preview" | "shallow" | "deep";
  depth?: number;
  limit?: number;
  maxString?: number;
}
```

返回：

```ts
{
  ok: true;
  data: {
    sessionId: string;
    threadId: number;
    frame: {
      index: number;
      id: number;
      filePath: string;
      line: number;
      column?: number;
      function: string;
      presentation: string;
    };
    variables: VariableScope[];
    presentation: string;
  };
  warnings: string[];
  auditId: string;
  sessionId: string;
}
```

变量 scope：

```ts
{
  scope: string;
  category: string;
  rawScopes: string[];
  expensive: boolean;
  items: VariableNode[];
}
```

### bp_debug_value

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  threadId?: number;
  frameIndex?: number;
  frameId?: number;
  path?: string[];
  ref?: number;
  start?: number;
  count?: number;
  expand?: "none" | "preview" | "shallow" | "deep";
  depth?: number;
  limit?: number;
  maxString?: number;
}
```

返回：

```ts
{
  ok: true;
  data: {
    sessionId: string;
    path?: string[];
    ref?: number;
    value: VariableNode;
    presentation: string;
  };
  warnings: string[];
  auditId: string;
  sessionId: string;
}
```

实测 `path:["analysis"]` 返回 record 字段 `vowelCount/consonantCount/uppercaseCount/score/balanced/multiPart/tokenSummaries`。

### bp_debug_eval

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  threadId?: number;
  frameIndex?: number;
  frameId?: number;
  expression: string;
  mode?: "readonly" | "guarded" | "unsafe";
  timeout?: number;
}
```

成功返回：

```ts
{
  ok: true;
  data: {
    sessionId: string;
    expression: string;
    mode: string;
    result: {
      value: {
        name: string;
        kind: string;
        valuePreview?: string;
        variablesReference?: number;
        truncated: boolean;
        value?: string;
      };
    };
  };
  warnings: string[];
  auditId: string;
  sessionId: string;
}
```

失败返回：

```ts
{
  ok: false;
  error: {
    code: string;
    message: string;
    details?: object;
  };
  auditId: string;
}
```

实测：

- `args.length` 成功返回值 `0`。
- 之后对 `analysis.score()` 的 readonly eval 被 IDE confirmation 拦截，返回 `IDE_CONFIRMATION_TIMEOUT`。

### bp_debug_set_value

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  frameIndex?: number;
  path: string[];
  newValue: string;
}
```

成功返回：

```ts
{
  ok: true;
  data: {
    path: string[];
    oldValue?: string;
    newValue?: string;
    applied: boolean;
  };
  warnings: string[];
  auditId: string;
  sessionId: string;
}
```

失败返回：

```ts
{
  ok: false;
  error: {
    code: "INVALID_ARGUMENT" | string;
    message: string;
    details?: object;
  };
  auditId: string;
}
```

实测在 JDK `System.java` 暂停帧中设置 `path:["args"]` 返回 `Variable path was not found in the selected frame.`。

### bp_debug_set_breakpoint

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  clientId?: string;
  ide?: "vscode" | "idea";
  filePath: string;
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  requireVerified?: boolean;
}
```

返回：

```ts
{
  ok: true;
  data: {
    breakpoint: {
      id: string;
      sessionId?: string;
      file: string;
      line: number;
      owner: "agent";
      verified: boolean;
      adapterBreakpointId?: number;
      createdAt: string;
    };
    breakpoints: Array<object>;
    lineText?: string;
  };
  warnings: string[];
  auditId: string;
  sessionId?: string;
}
```

实测设置 `HelloController.java:25` 返回 `verified:true` 和 `lineText`。

### bp_debug_list_breakpoints

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  clientId?: string;
  ide?: "vscode" | "idea";
  filePath?: string;
}
```

返回：

```ts
{
  ok: true;
  data: {
    workspaceRoot?: string;
    sessionId?: string;
    breakpoints: Array<{
      id: string;
      sessionId?: string;
      file: string;
      line: number;
      owner: string;
      verified?: boolean;
      adapterBreakpointId?: number;
      createdAt?: string;
    }>;
    totalCount: number;
  };
  warnings: string[];
  auditId: string;
  sessionId?: string;
}
```

实测：

- hub 未 adopt session 前返回 workspace 级 breakpoints 空数组。
- adopt 后能列出 BreakPilot 自己设置的第 25 行断点。

### bp_debug_remove_breakpoint

参数：

```ts
{
  projectPath?: string;
  sessionId?: string;
  clientId?: string;
  ide?: "vscode" | "idea";
  breakpointId?: string;
  filePath?: string;
  line?: number;
}
```

返回：

```ts
{
  ok: true;
  data: {
    removed: boolean;
    breakpointId?: string;
  };
  warnings: string[];
  auditId: string;
  sessionId?: string;
}
```

实测删除 `bp_mqjse3r0_0001` 返回 `removed:true`。

## 本次采样结论

1. IDEA 工具更接近 IDE 原生调试器，返回简单直接，但变量和值多为树形文本。
2. BreakPilot 重构前多一层统一 envelope 和审计 id；当前默认已删除 `ok/data/auditId`，改为直接返回关键业务字段。
3. BreakPilot adopt IDEA session 时必须使用 `bp_debug_status().ideSessions[].ideSessionId`，不能用 IDEA session name。
4. BreakPilot 的 IDE provider 当前不支持 `pause`，但支持 `wait/resume/stepInto/stepOut/disconnect`。
5. IDE confirmation 可能拦截 BreakPilot 的 readonly eval，调用方需要处理 `IDE_CONFIRMATION_TIMEOUT`。
6. 对已有 IDEA 用户断点调用 `xdebug_set_breakpoint` 会把 owner 标记成 `agent`；清理时不要盲目 remove，否则可能删除用户原有断点。
