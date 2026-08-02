---
name: breakpilot-debugger
description: Use when static analysis or logs cannot establish runtime values, branches, call order, paused state, variable mutation, or breakpoint behavior in a local authorized debug session.
---

# breakpilot-debugger

Use BreakPilot as an Agent Runtime Debugger. Prefer MCP (`breakpilot mcp serve`);
use the CLI and local daemon (`breakpilot serve`) only when MCP is unavailable.

## Evidence Loop

1. Call `bp_debug_status`; reuse a relevant live session when possible.
2. Snapshot `bp_debug_list_breakpoints` and preserve user-owned breakpoints.
3. Start/adopt with `bp_debug_start`, then set the minimum breakpoint.
4. Call `bp_debug_control(action="wait", timeout=...)`.
5. Use its default `at`, `locals`, and root `pauseId` for the first decision.
6. Call `bp_debug_context` for one bounded stack-and-variable view.
7. Drill into one returned `handle` with `bp_debug_value`; never invent or parse a handle.
8. Use `bp_debug_eval(mode="readonly")` only when the returned variables are insufficient.
9. After step/resume/run-to-line, discard old handles and paths; request fresh context.
10. Restore breakpoint state and stop/disconnect the session.

`sessionId` may be omitted only when BreakPilot can select unambiguously.
`detail="compact"` is the default. Request `detail="diagnostic"` only for bounded
provider/correlation evidence; it does not increase variable depth.

## Quick Reference

| Need | Tool |
|---|---|
| task-complete pause view | `bp_debug_context` |
| threads / deeper stack page | `bp_debug_threads`, `bp_debug_call_stack` |
| selected frame | `bp_debug_frame` |
| expand returned object | `bp_debug_value(handle="v1", depth=1)` |
| mutate returned object | `bp_debug_set_value(handle="v1", newValue="...")` |
| control flow | `bp_debug_control`, `bp_debug_run_to_line` |
| breakpoint lifecycle | set/list/remove breakpoint tools |

## MCP Example

```json
{"tool":"bp_debug_status","arguments":{}}
{"tool":"bp_debug_start","arguments":{"mode":"ide","projectPath":"/absolute/project"}}
{"tool":"bp_debug_set_breakpoint","arguments":{"filePath":"src/App.java","line":42}}
{"tool":"bp_debug_control","arguments":{"action":"wait","timeout":30000}}
{"tool":"bp_debug_context","arguments":{}}
{"tool":"bp_debug_call_stack","arguments":{"limit":10}}
{"tool":"bp_debug_frame","arguments":{"frameIndex":0}}
{"tool":"bp_debug_value","arguments":{"handle":"v1","depth":1,"limit":20}}
{"tool":"bp_debug_eval","arguments":{"expression":"order.total","mode":"readonly"}}
{"tool":"bp_debug_control","arguments":{"action":"stepOver"}}
{"tool":"bp_debug_control","arguments":{"action":"resume"}}
{"tool":"bp_debug_control","arguments":{"action":"disconnect"}}
```

## Safety

- Use bounded timeouts and targeted expansion; default depth is zero.
- Do not use unsafe eval, side-effectful expressions, production, unknown remote targets, or paths outside the authorized project without explicit permission.
- A successful pause must have current location/variable evidence; report `incomplete` and `warnings` instead of guessing.
- Treat `STALE_RUNTIME_HANDLE` as a request for fresh context, never as permission to reuse a provider reference.
