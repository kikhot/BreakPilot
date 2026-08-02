# BreakPilot Debugger Agent Prompt

## Embeddable Prompt

```text
When runtime facts are required, use BreakPilot MCP before guessing. Reuse an unambiguous live session, preserve user breakpoints, and set only the breakpoint needed for the question. A pause/wait/step response already supplies compact location and locals; use bp_debug_context for the bounded task-complete view, then expand only a returned short handle with bp_debug_value. Treat pauseId and handles as pause-scoped and refresh them after every execution transition. Use readonly evaluation by default. Record concrete location, call path, and values before resume, restore breakpoints, and stop or disconnect. Never default to unsafe eval, production/unknown remote attach, unbounded waits, or broad deep expansion.
```

## Canonical MCP Example

```json
{"tool":"bp_debug_status","arguments":{}}
{"tool":"bp_debug_start","arguments":{"mode":"attach","language":"python","host":"127.0.0.1","port":5678}}
{"tool":"bp_debug_set_breakpoint","arguments":{"filePath":"examples/python/app.py","line":12}}
{"tool":"bp_debug_control","arguments":{"action":"wait","timeout":30000}}
{"tool":"bp_debug_context","arguments":{}}
{"tool":"bp_debug_threads","arguments":{"limit":20}}
{"tool":"bp_debug_call_stack","arguments":{"limit":20}}
{"tool":"bp_debug_frame","arguments":{"frameIndex":0}}
{"tool":"bp_debug_value","arguments":{"handle":"v1","depth":1,"limit":20}}
{"tool":"bp_debug_eval","arguments":{"expression":"order.discount","mode":"readonly","timeout":1000}}
{"tool":"bp_debug_control","arguments":{"action":"stepOver"}}
{"tool":"bp_debug_control","arguments":{"action":"resume"}}
{"tool":"bp_debug_control","arguments":{"action":"disconnect"}}
```

## CLI Fallback

CLI aliases remain user-facing and are translated before the control layer:

```bash
breakpilot serve
breakpilot attach --lang python --host 127.0.0.1 --port 5678 --pretty
breakpilot bp set --file examples/python/app.py --line 12 --pretty
breakpilot wait --timeout 30000 --pretty
breakpilot snapshot --depth 0 --max-items 20 --pretty
breakpilot inspect-variable --ref v1 --depth 1 --max-items 20 --pretty
breakpilot eval --mode readonly 'order.discount' --pretty
breakpilot disconnect --pretty
```

The MCP contract uses only `projectPath`, `filePath`, `timeout`, `depth`,
`limit`, `maxString`, `offset`, `handle`, `path`, `pauseId`, and `detail` for
the corresponding concepts. Healthy compact responses omit empty/default
metadata; `diagnostic` only adds bounded `diagnostics`.
