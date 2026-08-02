# BreakPilot MCP Tool Reference

Language: English | [中文](mcp-tools.zh-CN.md)

Start the agent-facing stdio server with `breakpilot mcp serve`. The same 15
`bp_debug_*` tools and semantic results are used by MCP, HTTP, and CLI through
the shared control plane.

## Result Contract

MCP returns the semantic object in `structuredContent`. `content.text` is a
single-line summary of at most 160 characters; it never copies the JSON.
Successful results contain business fields directly. Empty collections,
default booleans, provider IDs, provider class names, and healthy evidence
metadata are omitted unless they are needed for the decision.

All errors have this stable shape:

```json
{"error":{"code":"INVALID_ARGUMENT","message":"Invalid arguments.","retrySafe":true,"actionMayHaveApplied":false}}
```

`hint` is optional. `detail="diagnostic"` may add bounded `diagnostics`; compact
errors never expose provider details. Diagnostic detail does not increase
variable depth or bypass redaction, limits, policy, or capability gates.

## Canonical Inputs

MCP publishes canonical names only: `projectPath`, `filePath`, `timeout`,
`depth`, `limit`, `maxString`, `offset`, `handle`, `path`, `pauseId`, and
`detail`, plus operation-specific fields such as `sessionId`, `action`,
`threadId`, `frameIndex`, `expression`, and breakpoint options.

The removed MCP aliases are `workspace`, `file`, `timeoutMs`, `maxDepth`,
`maxItems`, `maxStringLength`, `objectFields`, `variablesReference`, `lang`,
`start`, `count`, and `ref`. CLI flags such as `--workspace`, `--file`, and
`--ref` remain available and are translated before dispatch.

Defaults:

| Tool | Bounded default |
|---|---|
| `context` | 5 stack frames, 10 top-level values, `depth=0`, `maxString=200` |
| pause/wait/step/run-to-line | 10 top-level values, `depth=0`, `maxString=200` |
| `frame` | 20 top-level values, `depth=0`, `maxString=200` |
| `value(handle)` | `depth=1`, `limit=20`, `maxString=200` |

## Semantic Types

Locations use project-relative paths for workspace sources. External, archive,
and JRT sources retain reusable absolute paths or URIs.

```ts
interface AgentLocation {
  filePath: string;
  line: number;
  column?: number;
  function?: string;
}

interface AgentValue {
  name: string;
  value: string | number | boolean | null;
  type?: string;
  handle?: string;
  mutable?: true;
  redacted?: true;
  children?: AgentValue[];
  nextOffset?: number;
}
```

Primitive JSON values are emitted only when the provider reports a primitive
kind and the text is a canonical literal. BreakPilot does not infer a number or
boolean from an arbitrary string.

`handle` is a Core-owned pause-scoped token such as `v1`. It hides IDEA UUIDs
and DAP numeric references. Pass it back to `value` or `set_value`; after a
resume, step, run-to-line, stop, or newer pause, an old handle returns
`STALE_RUNTIME_HANDLE`.

## Tool Index And Compact Results

| Tool | Default semantic result |
|---|---|
| `bp_debug_start` | `sessionId/state/startMode/target` |
| `bp_debug_run_configurations` | normalized `configurations` and runnable `runPoints` |
| `bp_debug_status` | de-duplicated `sessions`, optional active session, `ideConnected` |
| `bp_debug_control` | resume/stop: `state`; pause/wait/step: `state/reason/at/locals/pauseId`; drain: `events` |
| `bp_debug_run_to_line` | `state/reached/target/at/pauseId/locals` |
| `bp_debug_threads` | `threads[{id,name,current?}]`, optional `nextOffset` |
| `bp_debug_call_stack` | `threadId/frames/pauseId`, optional `nextOffset` |
| `bp_debug_frame` | `frame/arguments/locals/fields/scopes/pauseId` |
| `bp_debug_value` | one `AgentValue` under `value` |
| `bp_debug_set_value` | `target/oldValue/newValue/applied/verified` |
| `bp_debug_eval` | `expression/value/type?/handle?` |
| `bp_debug_context` | `state/reason/at/stack/arguments/locals/fields/pauseId` |
| `bp_debug_set_breakpoint` | `id/at/verified/owner` plus enabled non-default options |
| `bp_debug_list_breakpoints` | `breakpoints` |
| `bp_debug_remove_breakpoint` | `id?/removed`, plus protection message when relevant |

`incomplete`, `warnings`, `nextOffset`, and `nextCursor` appear only for partial
results. `pauseId` appears once at the response root, never on every value.

## Recommended Flow

```json
{"tool":"bp_debug_status","arguments":{"projectPath":"/path/to/project"}}
{"tool":"bp_debug_start","arguments":{"mode":"ide","projectPath":"/path/to/project"}}
{"tool":"bp_debug_set_breakpoint","arguments":{"filePath":"src/App.java","line":42}}
{"tool":"bp_debug_control","arguments":{"action":"wait","timeout":30000}}
{"tool":"bp_debug_context","arguments":{}}
{"tool":"bp_debug_value","arguments":{"handle":"v1","depth":1,"limit":20}}
{"tool":"bp_debug_eval","arguments":{"expression":"order.total","mode":"readonly"}}
{"tool":"bp_debug_control","arguments":{"action":"stepOver"}}
{"tool":"bp_debug_control","arguments":{"action":"disconnect"}}
```

Wait, pause, step, and run-to-line already collect a bounded location and local
view. Do not request another frame unless a different frame or larger budget is
needed. Use `context` for the first comprehensive observation and the focused
read tools for pagination or deeper expansion.

## Breakpoints And Events

Create or update a breakpoint with `bp_debug_set_breakpoint`. Creation uses
`filePath + line`; update uses the returned `breakpointId`. List results keep
`owner` (`agent` or `user`) so an agent can preserve user breakpoints. Removal
accepts `breakpointId` or `filePath + line`; protected user breakpoints return a
truthful protection result.

`bp_debug_control(action="drainEvents")` returns ordered semantic events and a
`nextCursor`. Raw timestamps, session repetition, and provider event envelopes
are not copied into the compact page.

## Safety

Use `bp_debug_eval(mode="readonly")` by default. BreakPilot enforces authorized
project paths, attach endpoints, production policy, redaction, bounded output,
capability checks, breakpoint ownership, and mutation verification. A partial
observation is reported with `incomplete`/`warnings`; it is never promoted to a
complete pause or mutation claim.

See the [live IDEA MCP comparison report](idea-mcp-vs-breakpilot-agent-readable-report-2026-08-02.zh-CN.md)
for the full-tool exercise, token measurements, and prioritized follow-up work.
