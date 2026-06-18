---
name: breakpilot-debugger
description: Use BreakPilot when an AI agent needs runtime debugging facts via MCP or CLI, including starting or adopting debug sessions, breakpoints, threads, call stacks, frames, variables, readonly eval, stepping, and safe cleanup.
---

# breakpilot-debugger

Use BreakPilot when static reading or logs are not enough and the agent needs
runtime evidence from a local, authorized debug session.

- npm package: `@breakpilot/cli`
- CLI command: `breakpilot`
- MCP server identity: `breakpilot-debugger`
- MCP stdio command: `breakpilot mcp serve`
- CLI hub command: `breakpilot serve`
- Public MCP tools: `bp_debug_*`

## When To Use

Use BreakPilot when you need actual runtime facts:

- Current call stack or active thread.
- Local variables, object fields, or collection contents.
- Branch condition results or expression values.
- Runtime behavior that contradicts static reasoning.
- A paused IDE debug session the user expects the agent to inspect.

Do not use BreakPilot when static analysis, type errors, or ordinary test logs
are sufficient, or when the target is production/unknown remote/high risk.

## Startup Choice

Prefer MCP tools when available. Use CLI only as fallback.

Both modes use the same local hub:

- MCP client integration: `breakpilot mcp serve`.
- Local CLI/IDE collaboration: `breakpilot serve`.

## MCP Flow

1. Start, attach, or adopt a session with `bp_debug_start`.
2. Set minimal breakpoints with `bp_debug_set_breakpoint`.
3. Wait with `bp_debug_control(action="wait", timeout=30000)`.
4. Inspect threads with `bp_debug_threads` when thread selection matters.
5. Inspect the call stack with `bp_debug_call_stack`.
6. Inspect variables with `bp_debug_frame`.
7. Drill into one object with `bp_debug_value` by `path` or `ref`.
8. Use `bp_debug_eval` only when needed, with `mode: "readonly"` by default.
9. Use `bp_debug_control(action="stepOver"|"stepInto"|"stepOut")` only for a specific control-flow question.
10. Resume or disconnect with `bp_debug_control(action="resume"|"disconnect")`.

`sessionId` can be omitted when BreakPilot can select one unambiguously. If
multiple sessions are active, pass the exact `sessionId`.

## Tool Selection

- `bp_debug_start`: `mode: "launch"`, `mode: "attach"`, or `mode: "ide"`.
- `bp_debug_status`: list sessions, active session, IDE status, and language support.
- `bp_debug_control`: pause, resume, wait, step, stop, disconnect, or drain events.
- `bp_debug_threads`: list runtime threads.
- `bp_debug_call_stack`: inspect a selected or active thread stack.
- `bp_debug_frame`: get structured JSON variables for a frame.
- `bp_debug_value`: expand by `ref` or read by `path`, such as `["order", "total"]`.
- `bp_debug_eval`: evaluate expressions; default to `readonly`.
- `bp_debug_context`: get current position, stack, and top-frame variables in one call.
- `bp_debug_set_breakpoint`, `bp_debug_list_breakpoints`, `bp_debug_remove_breakpoint`: manage breakpoints.

## Examples

Headless attach:

```json
{"tool":"bp_debug_start","arguments":{"mode":"attach","language":"python","host":"127.0.0.1","port":5678}}
{"tool":"bp_debug_set_breakpoint","arguments":{"filePath":"examples/python/app.py","line":12}}
{"tool":"bp_debug_control","arguments":{"action":"wait","timeout":30000}}
{"tool":"bp_debug_call_stack","arguments":{"limit":20}}
{"tool":"bp_debug_frame","arguments":{"frameIndex":0,"expand":"preview","depth":1,"limit":20}}
{"tool":"bp_debug_value","arguments":{"path":["order","discount"],"depth":1}}
{"tool":"bp_debug_eval","arguments":{"expression":"order.discount","mode":"readonly"}}
{"tool":"bp_debug_control","arguments":{"action":"resume"}}
```

Paused IDE session:

```json
{"tool":"bp_debug_status","arguments":{}}
{"tool":"bp_debug_start","arguments":{"mode":"ide","ideSessionId":"<ideSessionId>","projectPath":"/absolute/workspace/path"}}
{"tool":"bp_debug_context","arguments":{"expand":"preview","limit":20}}
```

CLI fallback:

```bash
breakpilot attach --lang python --host 127.0.0.1 --port 5678 --pretty
breakpilot bp set --file examples/python/app.py --line 12 --pretty
breakpilot wait --timeout 30000 --pretty
breakpilot snapshot --depth 1 --max-items 20 --pretty
breakpilot inspect-variable --ref <ref> --depth 1 --max-items 20 --pretty
breakpilot eval --mode readonly 'order.discount' --pretty
breakpilot continue --pretty
breakpilot disconnect --pretty
```

## Safety Rules

- Do not use `unsafe` eval by default.
- Do not attach to production or unknown remote targets.
- Do not cross workspace boundaries.
- Do not wait forever; always use bounded timeouts.
- Do not execute side-effectful expressions without explicit user permission.
- Treat runtime observations as evidence; do not report guesses as facts.
- If BreakPilot cannot connect to an adapter or IDE bridge, fall back to static analysis and state the limitation.
