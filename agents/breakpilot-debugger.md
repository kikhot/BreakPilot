# BreakPilot Debugger Agent Prompt

## Embeddable System Prompt

```text
When a coding task needs runtime facts, prefer BreakPilot (`breakpilot-debugger`) before guessing. Use MCP tools first; use CLI only if MCP is unavailable. Attach/launch or adopt an IDE session, set minimal breakpoints, wait with a timeout, then call `get_runtime_snapshot` with `profile: "focused"`. If an object is only previewed, use `inspect_variable` before considering `profile: "full"`. Use `evaluate` with `mode: "readonly"` by default. Record observed runtime facts before `continue_execution`, stepping, disconnecting, or editing code. Never default to unsafe eval, unknown remote attach, production debugging, infinite waits, or broad full snapshots.
```

## Python Attach Debugging Example

MCP sequence:

```json
{"tool":"debug_attach","arguments":{"lang":"python","host":"127.0.0.1","port":5678,"mode":"headless","owner":"mcp"}}
{"tool":"set_breakpoint","arguments":{"sessionId":"<sessionId>","file":"examples/flask/app.py","line":12}}
{"tool":"wait_for_breakpoint","arguments":{"sessionId":"<sessionId>","timeoutMs":30000}}
{"tool":"get_runtime_snapshot","arguments":{"sessionId":"<sessionId>","profile":"focused","objectFields":"preview","maxDepth":1,"maxItems":10}}
{"tool":"inspect_variable","arguments":{"sessionId":"<sessionId>","variablesReference":7,"maxDepth":1,"maxItems":20}}
{"tool":"evaluate","arguments":{"sessionId":"<sessionId>","expression":"order[\"discount\"]","mode":"readonly","timeoutMs":1000}}
{"tool":"continue_execution","arguments":{"sessionId":"<sessionId>"}}
{"tool":"disconnect","arguments":{"sessionId":"<sessionId>"}}
```

Use the actual `sessionId` and `variablesReference` returned by prior tool calls.

## IDE Paused Session Adopt Example

```json
{"tool":"ide_status","arguments":{}}
{"tool":"list_ide_sessions","arguments":{"workspace":"/absolute/workspace/path"}}
{"tool":"adopt_ide_session","arguments":{"ideSessionId":"idea_ab12","workspace":"/absolute/workspace/path","lang":"python","mode":"ide","owner":"hybrid"}}
{"tool":"get_active_breakpoint_context","arguments":{"sessionId":"<sessionId>","profile":"focused","objectFields":"preview","maxDepth":1,"maxItems":10,"timeoutMs":1000}}
{"tool":"continue_execution","arguments":{"sessionId":"<sessionId>"}}
```

## CLI Fallback Example

```bash
breakpilot serve --http-port 27890 --ide-bridge-port 27891
breakpilot tools --pretty
breakpilot attach --lang python --host 127.0.0.1 --port 5678 --pretty
breakpilot bp set --session <sessionId> --file examples/flask/app.py --line 12 --pretty
breakpilot wait --session <sessionId> --timeout 30000 --pretty
breakpilot snapshot --session <sessionId> --profile focused --max-items 10 --pretty
breakpilot inspect-variable --session <sessionId> --ref <variablesReference> --depth 1 --max-items 20 --pretty
breakpilot eval --session <sessionId> --mode readonly 'order["discount"]' --pretty
breakpilot continue --session <sessionId> --pretty
breakpilot disconnect --session <sessionId> --pretty
```

Parse `sessionId` and `variablesReference` from JSON output. Do not guess IDs.

## Acceptance Criteria

- Skill uses the name `breakpilot-debugger` and does not use old tool names.
- Skill makes MCP the preferred path and CLI the fallback path.
- Skill says not to start MCP stdio and the CLI daemon together by default.
- Skill covers attach, launch, breakpoint, wait, focused snapshot, inspect variable, readonly eval, step, continue, and disconnect.
- Skill says IDE paused sessions should use `ide_status`, `list_ide_sessions`, `adopt_ide_session`, and `get_active_breakpoint_context`.
- Skill says `get_runtime_snapshot` defaults to `profile: "focused"`.
- Skill says `inspect_variable` is preferred over `profile: "full"` for targeted object expansion.
- Skill says `evaluate` defaults to `mode: "readonly"` and forbids default unsafe eval.
- CLI fallback examples require extracting `sessionId` and `variablesReference` from JSON output.
- Safety guidance covers workspace boundaries, production/remote attach, timeouts, side effects, evidence reporting, and adapter failure fallback.
- Examples match current project facts: `@breakpilot/cli`, `breakpilot`, `breakpilot mcp serve`, `breakpilot serve --http-port 27890 --ide-bridge-port 27891`, and `http://127.0.0.1:27890`.
