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
  "timeout": 30000,
  "includeFrame": true
}
```

Phase 1 advertises the contract. Runtime support is implemented by later phases
through native IDE bridge support or a temporary-breakpoint fallback.

### `bp_debug_status`

Status is a compact agent view: active BreakPilot sessions for the current
project and a short IDE bridge summary. It does
not return hub diagnostics, language availability details, terminated sessions,
capabilities, or full IDE client records.

### `bp_debug_threads` and `bp_debug_call_stack`

`bp_debug_threads` returns the provider thread list. `bp_debug_call_stack`
accepts optional `threadId` and `limit`, and returns frames with `index`, `id`,
`filePath`, `line`, and `function`.

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

### `bp_debug_set_breakpoint` and `bp_debug_remove_breakpoint`

Set arguments:

```json
{"filePath":"src/App.java","line":42,"condition":"count > 3"}
```

Set results include `breakpointId`, `filePath`, `line`, `verified`, and
`lineText` when the source file is readable.

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
