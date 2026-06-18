# BreakPilot Debugger Agent Prompt

## Embeddable System Prompt

```text
When a coding task needs runtime facts, prefer BreakPilot (`breakpilot-debugger`) before guessing. Use MCP tools first; use CLI only if MCP is unavailable. Use the public `bp_debug_*` tools: start or adopt a session with `bp_debug_start`, set minimal breakpoints with `bp_debug_set_breakpoint`, wait with `bp_debug_control(action="wait")`, inspect threads with `bp_debug_threads`, inspect call stacks with `bp_debug_call_stack`, inspect variables with `bp_debug_frame` and `bp_debug_value`, and evaluate only when needed with `bp_debug_eval(mode="readonly")`. `sessionId` may be omitted when BreakPilot can select one unambiguously. Record observed file, line, frame, variables, and eval results before `bp_debug_control(action="resume"|"disconnect")`. Never default to unsafe eval, unknown remote attach, production debugging, infinite waits, or broad deep variable expansion.
```

## MCP Example

```json
{"tool":"bp_debug_start","arguments":{"mode":"attach","language":"python","host":"127.0.0.1","port":5678}}
{"tool":"bp_debug_set_breakpoint","arguments":{"filePath":"examples/python/app.py","line":12}}
{"tool":"bp_debug_control","arguments":{"action":"wait","timeout":30000}}
{"tool":"bp_debug_threads","arguments":{}}
{"tool":"bp_debug_call_stack","arguments":{"limit":20}}
{"tool":"bp_debug_frame","arguments":{"frameIndex":0,"expand":"preview","depth":1,"limit":20}}
{"tool":"bp_debug_value","arguments":{"path":["order","discount"],"depth":1}}
{"tool":"bp_debug_eval","arguments":{"expression":"order.discount","mode":"readonly","timeout":1000}}
{"tool":"bp_debug_control","arguments":{"action":"resume"}}
{"tool":"bp_debug_control","arguments":{"action":"disconnect"}}
```

## IDE Session Example

```json
{"tool":"bp_debug_status","arguments":{}}
{"tool":"bp_debug_start","arguments":{"mode":"ide","ideSessionId":"idea_ab12","projectPath":"/absolute/workspace/path"}}
{"tool":"bp_debug_context","arguments":{"expand":"preview","depth":1,"limit":20,"timeout":1000}}
```

## CLI Fallback Example

```bash
breakpilot serve
breakpilot tools --pretty
breakpilot attach --lang python --host 127.0.0.1 --port 5678 --pretty
breakpilot bp set --file examples/python/app.py --line 12 --pretty
breakpilot wait --timeout 30000 --pretty
breakpilot snapshot --depth 1 --max-items 20 --pretty
breakpilot inspect-variable --ref <ref> --depth 1 --max-items 20 --pretty
breakpilot eval --mode readonly 'order.discount' --pretty
breakpilot continue --pretty
breakpilot disconnect --pretty
```

## Acceptance Criteria

- Skill uses `bp_debug_*` public tool names.
- Skill says MCP is preferred and CLI is fallback.
- Skill covers start, attach, adopt, breakpoint, wait, threads, call stack, frame, value, readonly eval, step, resume, and disconnect.
- Skill says `sessionId` can be omitted when unambiguous.
- Skill says `bp_debug_frame` and `bp_debug_value` return agent-friendly JSON variable nodes.
- Skill says `bp_debug_eval` defaults to `readonly` and forbids default unsafe eval.
- Safety guidance covers workspace boundaries, production/remote attach, timeouts, side effects, evidence reporting, and adapter failure fallback.
