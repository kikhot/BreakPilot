import type { AnyRecord } from "../types/json.ts";

export function help(): AnyRecord {
  return {
    usage: "breakpilot <command> [options]",
    commands: [
      "serve --http-port 27890 --ide-bridge-port 27891",
      "mcp serve",
      "tools",
      "policy print",
      "launch --lang python --program examples/app.py",
      "attach --lang python --host 127.0.0.1 --port 5678",
      "bp set --session sess_001 --file src/app.py --line 42",
      "bp remove --session sess_001 --id bp_001",
      "bp list --session sess_001",
      "wait --session sess_001 --timeout 30000",
      "snapshot --session sess_001 --profile focused --category locals --depth 1 --max-items 10",
      "snapshot --session sess_001 --profile full --depth 3 --max-items 20",
      "inspect-variable --session sess_001 --ref 7 --depth 1 --max-items 20",
      "eval --session sess_001 --mode readonly order.customer.name",
      "continue --session sess_001",
      "step-over --session sess_001",
      "step-into --session sess_001",
      "step-out --session sess_001",
      "disconnect --session sess_001",
      "ide status",
      "ide sessions",
      "ide adopt --ide-session idea_001",
      "ide context --ide-session idea_001 --profile focused"
    ]
  };
}
