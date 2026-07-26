# BreakPilot MCP Tool Reference

Language: English | [中文](mcp-tools.zh-CN.md)

BreakPilot exposes the Agent Runtime Debugger through the `breakpilot-debugger`
MCP server. The public agent-facing tools use the `bp_debug_` prefix. Legacy
DAP-shaped tool names have been removed from MCP routing.

Start MCP with:

```bash
breakpilot mcp serve
```

For HTTP clients, start the hub with `breakpilot serve` and connect to
`http://127.0.0.1:57987/stream` for Streamable HTTP or
`http://127.0.0.1:57987/sse` for legacy SSE.

## Protocol Surface

The stdio adapter accepts newline-delimited JSON-RPC:

| Method | Purpose |
|---|---|
| `initialize` | Returns MCP metadata and tool support. |
| `tools/list` | Returns the advertised `bp_debug_*` tools. |
| `tools/call` | Calls a tool with `{ "name": "...", "arguments": {} }`. |
| `ping` | Health check. |

Tool results expose structured data through `structuredContent`. The `content`
text is only a short human-readable status and is not a data channel.
Successful responses return the tool's business fields directly; BreakPilot no
longer wraps them in `ok`, `data`, `auditId`, or empty `warnings`. Failures use
`{ "error": { "code": "...", "message": "...", "details": {} } }`. `warnings`
is present only when non-fatal warnings exist.

Every public output schema is a concrete success/error union:

```json
{"activeSessionId":"bp_...","sessions":[],"ideConnected":true,"ideSessions":[]}
```

or:

```json
{"error":{"code":"INVALID_ARGUMENT","message":"Invalid arguments for bp_debug_...","details":{"issues":[]}}}
```

The success fields differ by tool, but the root remains a compact object. An
error result has a required `error.code` and `error.message`; `error.details`
contains machine-readable context when available.

## Validation, Defaults, And Detail

BreakPilot validates tool arguments before dispatch. Unknown fields, invalid
ranges, and ambiguous target modes return INVALID_ARGUMENT with issue details.
Successful payloads remain compact top-level objects. Each debug session reports
a provider capability matrix; callers must treat unsupported as authoritative.

Public input objects are closed schemas. Validation happens before the session
manager or provider is called, does not mutate the caller's object, and reports
issues as `{ "path", "keyword", "message" }` entries under
`error.details.issues`. A `oneOf` target must match exactly one branch.

Schema defaults are applied only when a property is absent. Important defaults
include `detail: "compact"`, `frameIndex: 0`, thread/stack `offset: 0`,
breakpoint `enabled: true`, `temporary: false`, and `owner: "agent"`. Start
routing preserves omitted fields: a source location selects IDE launch,
host/port selects attach, and otherwise BreakPilot launches headlessly. Attach
uses `127.0.0.1` internally when its host is omitted. An explicit start `mode`
is authoritative, and an explicitly provided value is never replaced by a
schema default.

`detail: "compact"` is the default agent view. For `bp_debug_status`,
`detail: "diagnostic"` adds `providerKind` and `capabilities` to BreakPilot and
IDE session summaries. `bp_debug_start` always returns those fields so an agent
can choose its next operation safely. Other tools accept the shared detail
selector where advertised, but it never bypasses validation, security policy,
or capability gates.

## Common Parameters

`sessionId` is optional for session-scoped tools. If omitted, BreakPilot selects
the only live session, or the only paused session when one is available. If the
choice is ambiguous, the call fails with `SESSION_AMBIGUOUS` and returns the
candidate sessions.

Use these simplified names in new calls:

| Parameter | Meaning |
|---|---|
| `projectPath` | Optional workspace/project selector used by the hub for multi-project routing. |
| `filePath` | Source file path. |
| `timeout` | Timeout in milliseconds. |
| `ref` | Opaque variable reference returned by frame/value tools. |
| `depth` | Recursive object expansion depth. |
| `limit` | Maximum variables, frames, or threads to return. |
| `maxString` | Maximum string preview length. |
| `expand` | `none`, `preview`, `shallow`, or `deep`. |

## Provider Capabilities

The capability matrix describes the selected live provider, not merely whether
a public tool exists:

| Field | Values | Meaning |
|---|---|---|
| `pause`, `stepping`, `runToLine` | `native`, `fallback`, `unsupported` | Execution-control support. |
| `variableReferences` | `native`, `snapshot`, `unsupported` | Whether values can be expanded through live references or only an IDE snapshot. |
| `setValue` | `native`, `evaluateAssignment`, `unsupported` | Native mutation, assignment-expression emulation, or no mutation. |
| `breakpointUpdate` | `native`, `fallback`, `unsupported` | Update/relocate an existing breakpoint id. |
| `conditionalBreakpoints`, `hitConditionalBreakpoints`, `tracepoints` | `native`, `fallback`, `unsupported` | Advanced breakpoint fidelity. |
| `eventDrain` | `native`, `fallback`, `unsupported` | Buffered debugger/tracepoint event retrieval. |

Current DAP sessions always report native pause, stepping, and variable
references. Optional DAP mutation and breakpoint features are native only when
the adapter advertises them. DAP run-to-line is `native` only when the live
adapter advertises `gotoTargets` and BreakPilot has the causal DAP primitives
needed to prove a fresh stop. If native goto is unavailable, it is `fallback`
only for a manager-wired DAP session with the shared temporary-breakpoint
transaction; an unwired/direct provider remains `unsupported`. DAP breakpoint
updates use complete-source reconciliation as a fallback; event drain remains
capability-gated. IDE capabilities are derived from the live bridge. The
current IDEA and VS Code bridges advertise native run-to-line and
`evaluateAssignment` set-value; other IDE features are enabled only when the
bridge advertises them.

The manager enforces this matrix before dispatch. `unsupported` pause,
stepping, run-to-line, variable-reference inspection, set-value, breakpoint
update, and event drain produce `UNSUPPORTED_CAPABILITY` without invoking the
provider or fabricating success. Breakpoint creation also gates `condition`,
`hitCondition`, and `logMessage` against `conditionalBreakpoints`,
`hitConditionalBreakpoints`, and `tracepoints`, respectively. Advanced
semantics without an implemented capability (`enabled:false`, temporary,
suspend policy, log-message mode, and log-stack mode) are rejected explicitly
before mutation. When the DAP fallback is advertised, BreakPilot uses a
visible, transactionally restored temporary breakpoint rather than silently
pretending a line was reached.

## Recommended Flow

```json
{"tool":"bp_debug_start","arguments":{"mode":"attach","language":"python","host":"127.0.0.1","port":5678}}
{"tool":"bp_debug_set_breakpoint","arguments":{"filePath":"examples/python/app.py","line":12}}
{"tool":"bp_debug_control","arguments":{"action":"wait","timeout":30000}}
{"tool":"bp_debug_threads","arguments":{}}
{"tool":"bp_debug_call_stack","arguments":{"limit":20}}
{"tool":"bp_debug_frame","arguments":{"frameIndex":0,"expand":"preview","limit":20}}
{"tool":"bp_debug_value","arguments":{"path":["order","total"],"depth":1}}
{"tool":"bp_debug_eval","arguments":{"expression":"order.total","mode":"readonly"}}
{"tool":"bp_debug_control","arguments":{"action":"resume"}}
```

IDE-owned paused sessions can be inspected directly:

```json
{"tool":"bp_debug_start","arguments":{"mode":"ide","ideSessionId":"<ideSessionId>"}}
{"tool":"bp_debug_context","arguments":{"expand":"preview","limit":20}}
```

IDE run-configuration launch is represented by `bp_debug_start`, but requires
IDE bridge support:

```json
{"tool":"bp_debug_start","arguments":{"projectPath":"/path/to/project","runConfigName":"DemoApplication"}}
```

When the connected IDE bridge does not implement that capability, BreakPilot
returns a structured capability error instead of silently falling back.

## Tool Index

| Tool | Purpose |
|---|---|
| `bp_debug_start` | Launch, attach, or adopt a debug session. |
| `bp_debug_run_configurations` | List IDE run configurations or runnable source locations. |
| `bp_debug_status` | Report active session, live sessions, and compact IDE status. |
| `bp_debug_control` | Pause, resume, wait, step, disconnect, stop, or drain events. |
| `bp_debug_run_to_line` | Run the selected debug session to a source line. |
| `bp_debug_threads` | List runtime threads. |
| `bp_debug_call_stack` | Return the call stack for a thread. |
| `bp_debug_frame` | Return structured variables for a frame. |
| `bp_debug_value` | Read a value by path or expand a variable `ref`. |
| `bp_debug_set_value` | Set a variable value when provider support exists. |
| `bp_debug_eval` | Evaluate an expression. |
| `bp_debug_context` | Return current position, stack, and top-frame variables. |
| `bp_debug_set_breakpoint` | Set a source breakpoint. |
| `bp_debug_list_breakpoints` | List breakpoints. |
| `bp_debug_remove_breakpoint` | Remove a breakpoint by id or file/line. |

## Tool Details

### `bp_debug_start`

Starts a session through headless DAP, attaches to a debug port, or adopts an
IDE session.

Common arguments:

| Parameter | Type | Description |
|---|---:|---|
| `mode` | string | `launch`, `attach`, or `ide`. |
| `language` | string | Registered adapter id such as `python`, `node`, `typescript`, or `java`. |
| `program` / `filePath` | string | Launch target. `filePath` can act as `program` in headless launch. |
| `host`, `port` | string/number | Attach endpoint. |
| `runConfigName` | string | IDE run configuration name; requires IDE bridge support. |
| `ideSessionId`, `clientId` | string | IDE session selection for adopt mode. |

### `bp_debug_control`

Arguments:

```json
{
  "sessionId": "optional",
  "action": "pause | resume | wait | stepOver | stepInto | stepOut | stop | disconnect | drainEvents",
  "threadId": 1,
  "timeout": 30000,
  "includeFrame": false
}
```

For `wait` and step actions, BreakPilot returns current `status`, `reason`,
and `position` by default. Pass `includeFrame: true` to include top-frame
variables, controlled by `expand`, `depth`, `limit`, and `maxString`.

### `bp_debug_run_to_line`

Runs the selected session to a source line.

```json
{
  "filePath": "src/App.java",
  "line": 42,
  "column": 1,
  "timeout": 30000,
  "includeFrame": true
}
```

Call this tool only when the selected session reports `runToLine` as supported.
The result always includes `status`, `targetReached`, `requestedPosition`, and
`cleanedUp`. Treat `targetReached`, not merely `status: "paused"`, as proof that
execution reached the requested source position. A nearby executable target is
reported in `resolvedPosition`; another fresh stop is returned as
`paused + targetReached:false` and is never auto-resumed. A terminal event is
`stopped + targetReached:false`; a fresh-wait timeout is
`timeout + targetReached:false`.

DAP uses native `gotoTargets`/`goto` only when the live adapter can support a
causal target proof. Otherwise, a manager-wired DAP session may use the
`fallback` temporary-breakpoint transaction, which returns
`temporaryBreakpointId` and sets `cleanedUp:true` only after the complete
original source list has been acknowledged restored. If that restoration cannot
be proved, the call fails with `RUN_TO_LINE_CLEANUP_FAILED` and
`cleanupRequired:true`; agents should inspect/reconcile breakpoints before
retrying.

### `bp_debug_status`

Status defaults to a compact agent view: active BreakPilot sessions for the
current project and a short IDE bridge summary. It does not return hub
diagnostics, language availability details, terminated sessions, capabilities,
or full IDE client records. Pass `detail: "diagnostic"` to add `providerKind`
and the capability matrix to each live BreakPilot or IDE session summary.

### `bp_debug_threads` and `bp_debug_call_stack`

`bp_debug_threads` and `bp_debug_call_stack` both accept `offset` and `limit`.
Thread ids may be numbers or opaque strings. Stack frames contain `index`, `id`,
`filePath`, `line`, and `function`; an IDE provider may mark a result `partial`
when only a top-frame snapshot is available.

### `bp_debug_frame`

Returns frame metadata and grouped variables.

```json
{
  "frameIndex": 0,
  "expand": "preview",
  "depth": 1,
  "limit": 20,
  "maxString": 2000
}
```

Variable nodes are ordered arrays, not maps, so duplicate variable names do not
overwrite each other:

```json
{
  "name": "analysis",
  "value": "NameAnalysis(...)",
  "type": "HelloController$NameAnalysis",
  "path": ["analysis"],
  "ref": 7072
}
```

### `bp_debug_value`

Reads a value either by path from the current frame or by expanding an opaque
variable reference:

```json
{"path":["analysis","score"]}
```

```json
{"ref":7072,"depth":1,"limit":20}
```

Array and list indexes are path strings such as `"0"`. Do not parse `ref`; pass
it back as returned.

### `bp_debug_set_breakpoint`, list, and remove

`bp_debug_set_breakpoint` has exactly two mutually exclusive target modes.
Location mode creates a breakpoint and requires `filePath` (or compatibility
alias `file`) plus `line`:

```json
{"filePath":"src/App.java","line":42,"condition":"count > 3","enabled":true,"owner":"agent"}
```

It also accepts `hitCondition`, `logMessage`, `temporary`, `suspendPolicy`,
`isLogMessage`, `isLogStack`, and `requireVerified`. `condition`,
`hitCondition`, and `logMessage` dispatch only when the selected provider
advertises the matching capability. The retained advanced semantic fields are
validated by the typed contract but currently return `UNSUPPORTED_CAPABILITY`
when their non-default behavior is requested; they are never silently ignored.
Returned verification still describes the breakpoint the provider actually
acknowledged.

Update mode accepts `breakpointId` plus update fields, but cannot also contain
`filePath` or `line`:

```json
{"breakpointId":"bp_123","enabled":false}
```

The update branch is registered so clients can validate a stable contract, but
all current providers report `breakpointUpdate: "unsupported"`; the call
therefore returns `UNSUPPORTED_CAPABILITY` rather than claiming an update.

Set results include `breakpointId`, `filePath`, `line`, `verified`, and
`lineText` when the source file is readable.

`bp_debug_list_breakpoints` can query a connected IDE's native breakpoint
snapshot and supports `filePath`, `owner`, and `includeDisabled` filters. When
there is no usable IDE bridge target, BreakPilot may return its local project
store; an error from an otherwise selected native query remains an explicit
error. Provider-specific fields are not guaranteed to have IDEA-level fidelity.

Remove accepts either:

```json
{"breakpointId":"bp_123"}
```

or:

```json
{"filePath":"src/App.java","line":42}
```

## Safety

BreakPilot still enforces workspace boundaries, attach host/port policy,
production-environment blocking, variable limits, redaction rules, and evaluate
mode restrictions. Use `bp_debug_eval` with `mode: "readonly"` by default.
