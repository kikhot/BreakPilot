# BreakPilot MCP Tool Reference

Language: English | [中文](mcp-tools.zh-CN.md)

BreakPilot exposes the Agent Runtime Debugger through an MCP stdio server named
`breakpilot-debugger`. Agents use it to launch or attach to local debug targets,
set breakpoints, inspect paused runtime state, evaluate safe expressions, and
coordinate with supported IDE sessions.

Start MCP with:

```bash
breakpilot mcp serve
```

## Protocol Surface

The MCP stdio adapter accepts newline-delimited JSON-RPC messages.

| JSON-RPC method | Purpose |
|---|---|
| `initialize` | Returns MCP protocol metadata, the server name `breakpilot-debugger`, and tool capability support. |
| `tools/list` | Returns every callable BreakPilot tool definition with JSON Schema input. |
| `tools/call` | Calls a tool by `{ "name": "...", "arguments": { ... } }`. |
| `ping` | Health check; returns an empty object. |

`tools/call` returns MCP text content containing the BreakPilot JSON response.
When the tool response has `ok: false`, MCP marks the tool result as
`isError: true`.

## Shared Response Format

Successful tool responses use:

```json
{
  "ok": true,
  "sessionId": "sess_abc123",
  "data": {},
  "warnings": [],
  "auditId": "audit_abc123"
}
```

Failed tool responses use:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "sessionId is required.",
    "details": {}
  },
  "auditId": "audit_abc123"
}
```

Common error codes include `SESSION_NOT_FOUND`, `ADAPTER_START_FAILED`,
`ATTACH_FAILED`, `LAUNCH_FAILED`, `BREAKPOINT_NOT_VERIFIED`,
`BREAKPOINT_TIMEOUT`, `EVALUATE_BLOCKED_BY_POLICY`, `DEBUG_PORT_NOT_ALLOWED`,
`WORKSPACE_VIOLATION`, `IDE_NOT_CONNECTED`, `IDE_SESSION_NOT_FOUND`,
`SESSION_OWNER_CONFLICT`, `POLICY_VIOLATION`, `UNSUPPORTED_LANGUAGE`,
`INVALID_LANGUAGE_IDENTIFIER`, `INVALID_ARGUMENT`, and `TOOL_FAILED`.

## Common Concepts

`sessionId` is returned by `debug_launch`, `debug_attach`, or
`adopt_ide_session`. Pass it to session-scoped tools.

`lang` is the preferred language selector. Supported built-in identifiers are
reported dynamically by `list_supported_languages`; the default registry includes
`python`, `node`, `typescript`, and `java`. When `lang` is omitted, launch can
infer from the `program` extension. The advertised MCP attach schema does not
include a source path, so `debug_attach` should pass `lang` explicitly.

`mode` describes the runtime coordination mode:

| Value | Meaning |
|---|---|
| `headless` | BreakPilot controls a DAP session directly. Default for launch/attach. |
| `ide` | BreakPilot adopts and queries an IDE-owned debug session. |
| `hybrid` | BreakPilot coordinates MCP calls with IDE bridge state. |

`owner` controls who is allowed to drive execution:

| Value | Meaning |
|---|---|
| `mcp` | MCP owns execution. Default for launch/attach. |
| `ide` | IDE owns execution. |
| `hybrid` | Shared ownership, used most often for adopted IDE sessions. |

`objectFields` controls variable expansion:

| Value | Meaning |
|---|---|
| `none` | Do not expand object children. |
| `preview` | Keep object previews and `variablesReference`, but do not fetch children. |
| `shallow` | Expand one object level. |
| `deep` | Expand recursively up to `maxDepth`. |

## Recommended Flows

Headless DAP debugging:

```json
{"tool":"debug_launch","arguments":{"lang":"python","program":"examples/python/app.py"}}
{"tool":"set_breakpoint","arguments":{"sessionId":"<sessionId>","file":"examples/python/app.py","line":12}}
{"tool":"wait_for_breakpoint","arguments":{"sessionId":"<sessionId>","timeoutMs":30000}}
{"tool":"get_runtime_snapshot","arguments":{"sessionId":"<sessionId>","profile":"focused","objectFields":"preview"}}
{"tool":"inspect_variable","arguments":{"sessionId":"<sessionId>","variablesReference":7}}
{"tool":"evaluate","arguments":{"sessionId":"<sessionId>","expression":"order.customer.name","mode":"readonly"}}
{"tool":"continue_execution","arguments":{"sessionId":"<sessionId>"}}
{"tool":"disconnect","arguments":{"sessionId":"<sessionId>"}}
```

Paused IDE debugging:

```json
{"tool":"ide_status","arguments":{}}
{"tool":"list_ide_sessions","arguments":{"workspace":"/absolute/workspace/path"}}
{"tool":"adopt_ide_session","arguments":{"ideSessionId":"<ideSessionId>","workspace":"/absolute/workspace/path"}}
{"tool":"get_active_breakpoint_context","arguments":{"sessionId":"<sessionId>","profile":"focused"}}
```

## Tool Index

| Tool | Purpose |
|---|---|
| `debug_launch` | Start a target program through a DAP adapter. |
| `debug_attach` | Attach to an existing debug target through a DAP adapter. |
| `set_breakpoint` | Set an agent-owned source breakpoint. |
| `wait_for_breakpoint` | Wait for a stopped event. |
| `get_runtime_snapshot` | Read stack frames and scoped variables from a paused runtime. |
| `inspect_variable` | Expand one `variablesReference`. |
| `evaluate` | Evaluate an expression with policy-controlled risk mode. |
| `continue_execution` | Resume a paused thread. |
| `step_over` | Step over the current statement. |
| `step_into` | Step into a call. |
| `step_out` | Step out of the current frame. |
| `remove_breakpoint` | Remove an agent-owned breakpoint. |
| `list_breakpoints` | List breakpoints for a session. |
| `list_sessions` | List active BreakPilot sessions. |
| `list_supported_languages` | Report registered adapter capabilities and availability. |
| `disconnect` | Disconnect a debug session and clear agent breakpoints. |
| `ide_status` | Report IDE bridge status and connected clients. |
| `list_ide_sessions` | List IDE-reported debug sessions. |
| `adopt_ide_session` | Convert an IDE session into a BreakPilot session. |
| `get_active_breakpoint_context` | Adopt or use an active paused IDE session and return context. |

## `debug_launch`

Launch a target program through a registered Debug Adapter Protocol adapter.

Required by schema: none. Operationally, provide either `lang` or an inferable
`program`; most adapters also need `program`, `module`, `mainClass`, or a
raw `dap` launch object.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `lang` | string | No | inferred | Registered language identifier such as `python`, `node`, `typescript`, or `java`. |
| `program` | string | No | none | Program path or, for Java, a main class / `.java` file used to derive `mainClass`. Must stay inside the workspace when present. |
| `module` | string | No | none | Python module name for module launch. |
| `args` | string[] | No | `[]` | Program arguments. |
| `cwd` | string | No | workspace root | Runtime working directory passed to the adapter. |
| `env` | object | No | process env | Extra environment for adapter/target configuration. Production-like env markers may be blocked by policy. |
| `mode` | string | No | `headless` | `headless`, `ide`, or `hybrid`. |
| `owner` | string | No | `mcp` | `mcp`, `ide`, or `hybrid`. |
| `adapterCommand` | string | No | adapter default/env | Override the debug adapter executable. |
| `adapterArgs` | string[] | No | adapter default | Override adapter process arguments. |
| `dap` | object | No | generated | Raw adapter-specific DAP launch arguments. Use this only when you need to pass adapter-native settings directly. |

Adapter notes:

| Language | Launch configuration highlights |
|---|---|
| `python` | `{ program, module, args, cwd, env, justMyCode: true, stopOnEntry: false }` |
| `node` / `typescript` | `{ type: "pwa-node", request: "launch", program, args, cwd, env, sourceMaps: true }` |
| `java` | `{ request: "launch", mainClass, classpath: ".", cwd, args, stopOnEntry: true }`; supports `vmArgs`, `javaPath`, `classpath`, and explicit `mainClass`. |

Example:

```json
{
  "lang": "python",
  "program": "examples/python/app.py",
  "args": ["--port", "5000"],
  "cwd": ".",
  "mode": "headless",
  "owner": "mcp"
}
```

Success data is a `SessionSummary` with `sessionId`, `language`, `mode`,
`owner`, `state`, `workspaceRoot`, `providerKind`, optional IDE IDs, and provider
`capabilities`.

## `debug_attach`

Attach to an already running target through a DAP adapter or adapter-managed
attach transport.

Required by schema: none. Operationally, pass `lang` explicitly because the
advertised MCP attach schema does not include a source path for language
inference. `host` and `port` default to language-specific local values, but
callers should pass them explicitly for clarity.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `lang` | string | No | inferred | Registered language identifier. Recommended for MCP attach because no source path is advertised in the attach schema. |
| `host` | string | No | `127.0.0.1` | Target host. Must be allowed by policy. Java attach uses `localhost` when no host is supplied. |
| `port` | number | No | Python `5678`, Node `9229` | Target debug port. Must be allowed by policy. |
| `mode` | string | No | `headless` | `headless`, `ide`, or `hybrid`. |
| `owner` | string | No | `mcp` | `mcp`, `ide`, or `hybrid`. |
| `adapterCommand` | string | No | adapter default/env | Override adapter executable. |
| `adapterArgs` | string[] | No | adapter default | Override adapter process arguments. |
| `dapHost` | string | No | none | Connect directly to an existing DAP server instead of spawning/using adapter transport. |
| `dapPort` | number | No | none | Existing DAP server port used with `dapHost`. |
| `dap` | object | No | generated | Raw adapter-specific attach arguments. |

Adapter notes:

| Language | Attach behavior |
|---|---|
| `python` | Can connect directly to a debugpy DAP socket, or delegate through `debugpy.adapter` when adapter overrides are used. Normalized config is `{ connect: { host, port }, justMyCode: true }`. |
| `node` / `typescript` | Uses the JS debug adapter with `{ type: "pwa-node", request: "attach", address, port, cwd, sourceMaps: true }`. |
| `java` | Treats `host:port` as a JDWP endpoint and delegates through the Java bridge. The port must be an integer in `1..65535`. |

Example:

```json
{
  "lang": "node",
  "host": "127.0.0.1",
  "port": 9229,
  "cwd": "."
}
```

Success data is the same `SessionSummary` shape as `debug_launch`.

## `set_breakpoint`

Set an agent-owned line breakpoint and synchronize it to the runtime provider.
For DAP sessions, BreakPilot also broadcasts breakpoint changes to IDE clients
connected to the same workspace.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `sessionId` | string | Yes | none | Debug session id returned by launch, attach, or adopt. |
| `file` | string | Yes | none | Source file path. It is resolved against the workspace and must pass workspace policy. |
| `line` | number | Yes | none | 1-based source line. |
| `column` | number | No | none | Optional source column. |
| `condition` | string | No | none | Conditional breakpoint expression. |
| `hitCondition` | string | No | none | Adapter-specific hit-count condition. |
| `logMessage` | string | No | none | Adapter-specific logpoint message. |
| `requireVerified` | boolean | No | `false` | If true, return `BREAKPOINT_NOT_VERIFIED` when the adapter does not verify this breakpoint. |

Example:

```json
{
  "sessionId": "sess_abc123",
  "file": "app/service/order.py",
  "line": 42,
  "condition": "order is not None",
  "requireVerified": true
}
```

Success data:

```json
{
  "breakpoint": {
    "id": "bp_abc123",
    "sessionId": "sess_abc123",
    "file": "/absolute/path/app/service/order.py",
    "line": 42,
    "verified": true,
    "createdAt": "2026-06-16T00:00:00.000Z"
  },
  "breakpoints": []
}
```

## `wait_for_breakpoint`

Wait until the target runtime stops at a breakpoint or step event. Always use a
finite timeout in agent workflows.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `sessionId` | string | Yes | none | Debug session id. |
| `timeoutMs` | number | No | `30000` | Maximum wait time in milliseconds. |

Example:

```json
{
  "sessionId": "sess_abc123",
  "timeoutMs": 30000
}
```

Success data contains `stopped`, a DAP-style stopped event with fields such as
`reason`, `threadId`, `description`, `allThreadsStopped`, and sometimes
`topFrame` when BreakPilot recovered a missed stopped event from stack trace.

## `get_runtime_snapshot`

Read a progressive runtime snapshot from a paused session. Start with
`profile: "focused"` and `objectFields: "preview"`; use `inspect_variable` for
targeted expansion before requesting a broad `full` snapshot.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `sessionId` | string | Yes | none | Debug session id. |
| `threadId` | number | No | provider thread | Thread to inspect. |
| `frameId` | number | No | selected by `frameIndex` | DAP frame id to inspect directly. |
| `frameIndex` | number | No | `0` | Stack frame index when `frameId` is not supplied. |
| `profile` | string | No | `focused` | `focused`, `locals`, `full`, or `custom`. |
| `includeCategories` | string[] | No | profile-derived | Categories to include for `custom` snapshots. |
| `includeScopes` | string[] | No | none | Raw adapter scope names, such as `Locals` or `Globals`, to include. |
| `objectFields` | string | No | profile-derived | `none`, `preview`, `shallow`, or `deep`. |
| `maxDepth` | number | No | policy/schema default | Maximum recursive object depth. Schema default is `1`; policy may provide broader defaults. |
| `maxItems` | number | No | policy/schema default | Maximum variables per scope/object. Schema default is `10`; policy may provide broader defaults. |
| `maxStringLength` | number | No | `2000` | Maximum string preview length. |

Profiles:

| Profile | Behavior |
|---|---|
| `focused` | Includes arguments, locals, and receiver-like values. Best default for agents. |
| `locals` | Similar focused categories with `objectFields: "none"` unless overridden. |
| `custom` | Includes only `includeCategories` and/or `includeScopes`. |
| `full` | Includes every scope category, still bounded by limits. |

Scope categories:

| Category | Meaning |
|---|---|
| `arguments` | Function or method arguments. |
| `locals` | Local variables in the selected frame. |
| `receiver` | `this`, `self`, or equivalent current object. |
| `closures` | Closure-captured variables. |
| `globals` | Global variables. |
| `statics` | Static fields. |
| `module` | Module/script scope. |
| `runtime` | Built-in, class/function, framework, or runtime scopes. |
| `other` | Scope that could not be classified. |

Example:

```json
{
  "sessionId": "sess_abc123",
  "frameIndex": 0,
  "profile": "focused",
  "objectFields": "preview",
  "maxDepth": 1,
  "maxItems": 10
}
```

Success data is a `RuntimeSnapshot`:

```json
{
  "sessionId": "sess_abc123",
  "source": "headless",
  "language": "python",
  "profile": "focused",
  "threadId": 1,
  "frameId": 7,
  "stackFrames": [],
  "variables": {
    "locals": {
      "name": "locals",
      "category": "locals",
      "rawScopes": ["Locals"],
      "expensive": false,
      "variables": {}
    }
  },
  "availableCategories": [],
  "omittedCategories": [],
  "availableScopes": [],
  "omittedScopes": [],
  "scopeMetadata": [],
  "limits": {
    "maxDepth": 1,
    "maxItems": 10,
    "maxStringLength": 2000
  }
}
```

Serialized variables include `name`, `type`, `kind`, `valuePreview`, `value`,
`variablesReference`, `truncated`, optional `redacted`, optional `cycle`, and
optional `presentationError`.

## `inspect_variable`

Expand one DAP `variablesReference` returned by a snapshot or previous variable
inspection. This is the preferred way to drill into a single object, array, map,
or scope without collecting a full runtime snapshot.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `sessionId` | string | Yes | none | Debug session id. |
| `variablesReference` | number | Yes | none | DAP variables reference to expand. |
| `start` | number | No | `0` | Start offset for indexed variables. |
| `count` | number | No | none | Number of child variables to request. Also influences `maxItems`. |
| `objectFields` | string | No | `deep` | `none`, `preview`, `shallow`, or `deep`. |
| `maxDepth` | number | No | `1` | Recursive child depth. |
| `maxItems` | number | No | `20` | Maximum serialized child variables. |
| `maxStringLength` | number | No | `2000` | Maximum string preview length. |

Example:

```json
{
  "sessionId": "sess_abc123",
  "variablesReference": 7,
  "start": 0,
  "count": 20,
  "objectFields": "deep",
  "maxDepth": 1
}
```

Success data usually contains `variablesReference`, `start`, `count`, and a
serialized `variables` map. IDE providers may return provider-specific context.

## `evaluate`

Evaluate an expression in the current debug frame with policy-controlled risk
mode. Use `readonly` by default. In `readonly`, BreakPilot rejects calls,
assignment, imports/requires, construction, deletion, `await`, semicolon
sequences, and expressions longer than policy allows.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `sessionId` | string | Yes | none | Debug session id. |
| `expression` | string | Yes | none | Expression to evaluate. |
| `mode` | string | No | policy default or `readonly` | `readonly`, `guarded`, or `unsafe`. |
| `threadId` | number | No | provider thread | Thread context. |
| `frameId` | number | No | current frame | Frame context. |
| `timeoutMs` | number | No | policy timeout / `1000` schema | Evaluation timeout in milliseconds. |

Modes:

| Mode | Behavior |
|---|---|
| `readonly` | Intended for property, field, and index inspection only. |
| `guarded` | Reserved for policy-mediated broader inspection. |
| `unsafe` | Requires explicit IDE confirmation when policy requires it; blocked for headless providers in that case. |

Example:

```json
{
  "sessionId": "sess_abc123",
  "expression": "order.customer.name",
  "mode": "readonly",
  "timeoutMs": 1000
}
```

Success data contains `{ "result": <adapter result>, "mode": "readonly" }`.

## `continue_execution`

Continue a paused runtime thread.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `sessionId` | string | Yes | none | Debug session id. |
| `threadId` | number | No | provider thread | Thread to continue. |

Example:

```json
{
  "sessionId": "sess_abc123",
  "threadId": 1
}
```

Success data contains the provider `result`. For DAP sessions, the session state
changes to `running`.

## `step_over`

Step over the current statement in the selected or provider-default thread.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `sessionId` | string | Yes | none | Debug session id. |
| `threadId` | number | No | provider thread | Thread to step. |

Example:

```json
{
  "sessionId": "sess_abc123",
  "threadId": 1
}
```

Success data contains the provider step `result`; the session moves to
`running` until the next stop.

## `step_into`

Step into the next call in the selected or provider-default thread.

Parameters and response are the same as `step_over`.

Example:

```json
{
  "sessionId": "sess_abc123"
}
```

## `step_out`

Step out of the current frame in the selected or provider-default thread.

Parameters and response are the same as `step_over`.

Example:

```json
{
  "sessionId": "sess_abc123"
}
```

## `remove_breakpoint`

Remove one agent-owned breakpoint. BreakPilot updates the runtime provider and,
for DAP sessions, broadcasts the removal to connected IDE clients.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `sessionId` | string | Yes | none | Debug session id. |
| `breakpointId` | string | Yes | none | Breakpoint id returned by `set_breakpoint` or `list_breakpoints`. |

Example:

```json
{
  "sessionId": "sess_abc123",
  "breakpointId": "bp_abc123"
}
```

Success data contains `{ "removed": true }` or `{ "removed": false }` if no
matching BreakPilot-owned breakpoint was found.

## `list_breakpoints`

List BreakPilot-managed breakpoints for a session.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `sessionId` | string | Yes | none | Debug session id. |

Example:

```json
{
  "sessionId": "sess_abc123"
}
```

Success data contains `{ "breakpoints": [...] }`.

## `list_sessions`

List active BreakPilot sessions.

Required parameters: none.

Example:

```json
{}
```

Success data contains `{ "sessions": [...] }`, where each entry is a
`SessionSummary`.

## `list_supported_languages`

Report registered language adapters and live environment availability. Each
adapter validates its local toolchain and returns availability warnings/errors
without treating ordinary missing dependencies as a tool failure.

Required parameters: none.

Example:

```json
{}
```

Success data:

```json
{
  "languages": [
    {
      "language": "python",
      "displayName": "Python",
      "supportsAttach": true,
      "availability": {
        "available": true,
        "errors": [],
        "warnings": []
      }
    }
  ]
}
```

## `disconnect`

Disconnect a debug session, clear BreakPilot-owned breakpoints, remove the
session from the store, and notify IDE clients to clear agent breakpoints.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `sessionId` | string | Yes | none | Debug session id. |
| `terminateDebuggee` | boolean | No | `false` | Request target termination when supported. |
| `restart` | boolean | No | `false` | Request adapter restart behavior when supported. |

Example:

```json
{
  "sessionId": "sess_abc123",
  "terminateDebuggee": false
}
```

Success data contains `{ "disconnected": true, "result": ... }`. If the adapter
does not acknowledge disconnect, `warnings` contains a message and the session
is still cleaned up locally.

## `ide_status`

Return IDE bridge status and connected IDE clients.

Required parameters: none.

Example:

```json
{}
```

Success data is either `{ "enabled": false, "clients": [] }` when the bridge is
not available, or the bridge status object with connected clients.

## `list_ide_sessions`

List debug sessions reported by connected IDE plugins.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `clientId` | string | No | all clients | Filter sessions by IDE client id. |
| `workspace` | string | No | all workspaces | Filter sessions by workspace. Resolved relative to BreakPilot workspace root. |

Example:

```json
{
  "workspace": "/absolute/workspace/path"
}
```

Success data contains `{ "sessions": [...] }`. IDE session entries are reported
by the VS Code / IntelliJ bridge and generally include `clientId`,
`ideSessionId`, `workspaceRoot`, `language`, `state`, and current pause metadata.

## `adopt_ide_session`

Adopt an existing IDE debug session as a BreakPilot session. Use this when the
user already has VS Code or IntelliJ paused at a breakpoint and wants the agent
to inspect runtime state without launching a separate debuggee.

Required by schema: none. Operationally, provide enough filters to select one
IDE session. If multiple sessions are active, pass `clientId` and/or
`ideSessionId`.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `clientId` | string | No | inferred | IDE bridge client id. |
| `ideSessionId` | string | No | inferred | IDE debug session id. |
| `workspace` | string | No | selected session workspace | Workspace filter. |
| `lang` | string | No | IDE session language or `idea` | Runtime language override. |
| `mode` | string | No | `ide` | `ide` or `hybrid`. |
| `owner` | string | No | `hybrid` | `ide` or `hybrid`. |

Example:

```json
{
  "ideSessionId": "idea_ab12",
  "workspace": "/absolute/workspace/path",
  "mode": "ide",
  "owner": "hybrid"
}
```

Success data is a `SessionSummary`. If the same IDE session was already adopted,
BreakPilot returns the existing `sessionId` with a warning.

## `get_active_breakpoint_context`

Adopt or use the active paused IDE session and return the current breakpoint
context. This is the fastest single call for "inspect what is currently paused
in my IDE".

Required by schema: none. Operationally, either pass `sessionId` for an already
adopted IDE session or enough IDE filters to identify the active paused session.

| Parameter | Type | Required | Default | Description |
|---|---:|---:|---|---|
| `sessionId` | string | No | auto-adopt | Existing BreakPilot session id. |
| `clientId` | string | No | inferred | IDE client filter when auto-adopting. |
| `ideSessionId` | string | No | inferred | IDE session filter when auto-adopting. |
| `workspace` | string | No | inferred | Workspace filter. |
| `timeoutMs` | number | No | `1000` | Short wait for an IDE stopped/breakpoint event before snapshotting. |
| `frameIndex` | number | No | `0` | Stack frame index for `topFrame`. |
| `profile` | string | No | `focused` | Snapshot profile. |
| `objectFields` | string | No | `preview` | Snapshot object expansion. |
| `maxDepth` | number | No | `1` | Snapshot object depth. |
| `maxItems` | number | No | `10` | Snapshot item limit. |
| `maxStringLength` | number | No | `2000` | Snapshot string limit. |

Example:

```json
{
  "workspace": "/absolute/workspace/path",
  "profile": "focused",
  "objectFields": "preview",
  "timeoutMs": 1000
}
```

Success data:

```json
{
  "stopped": null,
  "topFrame": {},
  "snapshot": {},
  "ideSessionId": "idea_ab12",
  "providerKind": "ide"
}
```

## Safety Notes

Keep debugging local and authorized. BreakPilot policy checks workspace paths,
allowed attach hosts/ports, production-like environment markers, variable
limits, redaction, and evaluate mode. Prefer:

- `profile: "focused"` before `profile: "full"`;
- `inspect_variable` before broad object expansion;
- `evaluate` with `mode: "readonly"`;
- short, explicit `timeoutMs`;
- `disconnect` or `remove_breakpoint` cleanup after collecting evidence.
