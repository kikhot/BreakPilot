---
name: breakpilot-debugger
description: Use BreakPilot when a coding agent needs runtime debugging facts via MCP or CLI, including breakpoints, focused snapshots, variable inspection, readonly eval, stepping, IDE paused sessions, and safe cleanup.
---

# breakpilot-debugger

Use BreakPilot when an AI Agent needs runtime facts from a local, authorized debug session. BreakPilot is the Agent Runtime Debugger for this project.

- npm package: `@breakpilot/cli`
- CLI command: `breakpilot`
- MCP server identity: `breakpilot-debugger`
- MCP stdio command: `breakpilot mcp serve`
- CLI daemon command: `breakpilot serve --http-port 27890 --ide-bridge-port 27891`
- Default control URL: `http://127.0.0.1:27890`

## When To Use

Use BreakPilot when static reasoning or test output is not enough:

- A test fails but logs do not explain the runtime state.
- Runtime behavior contradicts code-level reasoning.
- You need actual variable values, call stack, branch condition results, or object fields.
- The bug likely involves async timing, type conversion, state pollution, boundary inputs, framework request data, source maps, or adapter/runtime differences.
- An IDE debug session is already paused and the user expects the Agent to inspect it.
- You need to prove a hypothesis before editing code.

Do not use BreakPilot when:

- Static reading, type errors, or normal logs are enough.
- There is no runnable/debuggable target.
- The user explicitly forbids running programs or debugging.
- The target looks like production, an unknown remote host, or a high-risk system that cannot be safely paused.
- The needed expression would mutate state and the user has not allowed it.
- The issue is unrelated to runtime state.

## Startup Choice

Prefer MCP tools when available. Use CLI only as fallback.

Do not start both MCP stdio and the CLI daemon by default.

Use one of these modes:

- MCP client integration: configure/start `breakpilot mcp serve`.
- Local CLI/IDE collaboration: start `breakpilot serve --http-port 27890 --ide-bridge-port 27891`.

Important environment variables:

- `BREAKPILOT_CONTROL_URL`
- `BREAKPILOT_POLICY`
- `BREAKPILOT_WORKSPACE`
- `BREAKPILOT_PYTHON_ADAPTER`
- `BREAKPILOT_JS_DEBUG_COMMAND`
- `BREAKPILOT_JS_DEBUG_ARGS`
- `BREAKPILOT_JAVA_ADAPTER_COMMAND`
- `BREAKPILOT_JAVA_ADAPTER_ARGS`

## Standard Debugging Flow

1. Confirm the target: language, workspace, start command, debug adapter, attach/launch mode, port, and whether an IDE session is already paused.
2. If an IDE is already paused, use the IDE flow first: `ide_status`, `list_ide_sessions`, `adopt_ide_session`, then `get_active_breakpoint_context`.
3. If the target already exposes a debug port, use `debug_attach`.
4. If BreakPilot should start the target, use `debug_launch`.
5. Set the smallest useful number of breakpoints with `set_breakpoint`.
6. Wait with `wait_for_breakpoint` and always provide a timeout.
7. Read `get_runtime_snapshot` with `profile: "focused"` first.
8. If an object only has a preview, use `inspect_variable` with its `variablesReference`.
9. Use `evaluate` only when needed, with `mode: "readonly"` by default.
10. Use `step_over`, `step_into`, or `step_out` only when one paused frame is insufficient.
11. Before `continue_execution`, record the paused file, line, function/frame, relevant variables, and evaluated facts.
12. Clean up with `continue_execution`, `remove_breakpoint`, or `disconnect` as appropriate.
13. Convert observed runtime facts into a code fix, test, or narrow recommendation. Mark guesses as guesses.

## MCP Tool Strategy

Use this order for normal headless debugging:

1. `debug_attach` or `debug_launch`
2. `set_breakpoint`
3. `wait_for_breakpoint`
4. `get_runtime_snapshot` with `profile: "focused"`
5. `inspect_variable` for specific `variablesReference` drill-down
6. `evaluate` with `mode: "readonly"` if snapshot data is insufficient
7. Optional `step_over`, `step_into`, `step_out`
8. `continue_execution`
9. `remove_breakpoint` or `disconnect`

Tool selection rules:

- `debug_launch`: start a target through a DAP adapter.
- `debug_attach`: connect to an already running debug port or existing DAP server.
- `set_breakpoint`: set minimal agent-owned line breakpoints; use conditions only when they reduce noise.
- `wait_for_breakpoint`: never wait forever; use a bounded `timeoutMs`, normally `30000`.
- `get_runtime_snapshot`: default to `profile: "focused"`, `objectFields: "preview"`, small `maxDepth` and `maxItems`.
- `inspect_variable`: prefer this over `profile: "full"` when only one object/array/map needs expansion.
- `evaluate`: default to `mode: "readonly"` and short `timeoutMs`; do not use `unsafe` without explicit user permission.
- `continue_execution`: call only after recording the paused context and useful runtime facts.
- `remove_breakpoint`: remove agent-owned breakpoints that are no longer needed.
- `list_sessions` and `list_breakpoints`: use when IDs are unknown or state may be stale.
- `disconnect`: clean up a session; avoid terminating the debuggee unless the user asked for it.
- `step_over`, `step_into`, `step_out`: use sparingly to answer a specific control-flow question.
- IDE flow: use `ide_status`, `list_ide_sessions`, `adopt_ide_session`, then `get_active_breakpoint_context`.

Use `profile: "full"` only after focused snapshot plus targeted variable inspection are insufficient.

## IDE Paused Session Flow

When the user has an IDE debug session already paused:

1. Call `ide_status`.
2. Call `list_ide_sessions` with the workspace when known.
3. Call `adopt_ide_session` for the active paused session.
4. Call `get_active_breakpoint_context` with `profile: "focused"`.
5. Use `inspect_variable` or readonly `evaluate` only if the focused context is insufficient.
6. Continue, step, or disconnect only after recording observed facts.

## CLI Fallback

Use CLI only when MCP tools are unavailable but shell commands can be run.

Start the daemon:

```bash
breakpilot serve --http-port 27890 --ide-bridge-port 27891
```

Discover tools:

```bash
breakpilot tools --pretty
```

Attach and inspect:

```bash
breakpilot attach --lang python --host 127.0.0.1 --port 5678 --pretty
breakpilot bp set --session <sessionId> --file <file> --line <line> --pretty
breakpilot wait --session <sessionId> --timeout 30000 --pretty
breakpilot snapshot --session <sessionId> --profile focused --max-items 10 --pretty
breakpilot inspect-variable --session <sessionId> --ref <variablesReference> --depth 1 --max-items 20 --pretty
breakpilot eval --session <sessionId> --mode readonly '<expression>' --pretty
breakpilot continue --session <sessionId> --pretty
breakpilot disconnect --session <sessionId> --pretty
```

Always parse `sessionId` and `variablesReference` from JSON output. Never guess IDs.

## Safety Rules

- Do not use `unsafe` eval by default.
- Do not attach to production or unknown remote targets.
- Do not cross workspace boundaries.
- Do not wait forever; always set a timeout.
- Do not execute side-effectful expressions without explicit user permission.
- Treat runtime observations as evidence; do not report guesses as facts.
- If BreakPilot cannot connect to the adapter, fall back to static analysis and state the limitation.
