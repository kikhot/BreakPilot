# Python Debug Example (debugpy)

A minimal Flask app with an intentional demo bug: in `calculate_total`, the
`discount` field may arrive from JSON as a string, so `amount - discount` can
raise a `TypeError` or produce a wrong result. Line 12 (`return amount - discount`)
is the natural breakpoint.

Python debugging works because **debugpy is itself a native DAP adapter** — no
bridge is needed.

## Prerequisites

```bash
python3 -m pip install flask debugpy
```

## 1. Start the target under debugpy (attach mode)

```bash
python -m debugpy --listen 127.0.0.1:5678 --wait-for-client examples/python/app.py
```

`5678` is already in `breakpilot.yaml` `network.allowedPorts`.

## 2. Drive it with BreakPilot

MCP tool sequence (use the actual `sessionId` returned by `debug_attach`):

```json
{"tool":"debug_attach","arguments":{"lang":"python","host":"127.0.0.1","port":5678}}
{"tool":"set_breakpoint","arguments":{"sessionId":"<id>","file":"examples/python/app.py","line":12}}
{"tool":"wait_for_breakpoint","arguments":{"sessionId":"<id>","timeoutMs":30000}}
{"tool":"get_runtime_snapshot","arguments":{"sessionId":"<id>","profile":"focused"}}
{"tool":"evaluate","arguments":{"sessionId":"<id>","expression":"order[\"discount\"]","mode":"readonly"}}
{"tool":"continue_execution","arguments":{"sessionId":"<id>"}}
{"tool":"disconnect","arguments":{"sessionId":"<id>"}}
```

CLI equivalent:

```bash
breakpilot attach --lang python --host 127.0.0.1 --port 5678 --pretty
breakpilot bp set --session <id> --file examples/python/app.py --line 12 --pretty
breakpilot wait --session <id> --timeout 30000 --pretty
breakpilot snapshot --session <id> --profile focused --max-items 10 --pretty
```

Trigger the breakpoint by sending a request in another terminal:

```bash
curl -s -X POST http://127.0.0.1:5000/order \
  -H 'content-type: application/json' \
  -d '{"amount": 100, "discount": "30"}'
```

> macOS note: AirPlay Receiver also listens on port `5000`. If requests behave
> oddly, run the app on another port (`PORT=5050 python ... examples/python/app.py`)
> or disable AirPlay Receiver in System Settings → General → AirDrop & Handoff.
