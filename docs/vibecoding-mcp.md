# Vibecoding MCP Setup

BreakPilot can be used from vibecoding tools as a local stdio MCP server. Once connected, agents can call runtime debugging tools such as `debug_attach`, `set_breakpoint`, `wait_for_breakpoint`, `get_runtime_snapshot`, and `inspect_variable`.

The examples below use `{BREAKPILOT_ROOT}` as a placeholder for the absolute path to your local BreakPilot checkout. Replace the whole placeholder, including the braces, before running a command or saving config.

For this checkout on Quixote's machine, `{BREAKPILOT_ROOT}` is:

```text
/Users/Quixote/workSpace/open-code/BreakPilot
```

All clients ultimately start the same command. Prefer the installed CLI when `breakpilot` is available in the MCP client's `PATH`:

```bash
breakpilot mcp serve --policy {BREAKPILOT_ROOT}/breakpilot.yaml
```

For source checkout development, or when a GUI/agent runtime cannot find `breakpilot`, use the direct Node fallback:

```bash
node --experimental-strip-types {BREAKPILOT_ROOT}/src/cli.ts mcp serve --policy {BREAKPILOT_ROOT}/breakpilot.yaml
```

Use absolute paths in config files.

## Codex

Codex uses TOML. The top-level key is `mcp_servers`, not `mcpServers`.

Project-local config:

```text
.codex/config.toml
```

Global config fallback:

```text
~/.codex/config.toml
```

Recommended config when `breakpilot` is installed or linked:

```toml
[mcp_servers.breakpilot-debugger]
command = "breakpilot"
args = [
  "mcp",
  "serve",
  "--policy",
  "{BREAKPILOT_ROOT}/breakpilot.yaml"
]
env = { BREAKPILOT_WORKSPACE = "{BREAKPILOT_ROOT}" }
startup_timeout_ms = 20000
```

Source checkout fallback:

```toml
[mcp_servers.breakpilot-debugger]
command = "node"
args = [
  "--experimental-strip-types",
  "{BREAKPILOT_ROOT}/src/cli.ts",
  "mcp",
  "serve",
  "--policy",
  "{BREAKPILOT_ROOT}/breakpilot.yaml"
]
env = { BREAKPILOT_WORKSPACE = "{BREAKPILOT_ROOT}" }
startup_timeout_ms = 20000
```

Quixote machine recommended config:

```toml
[mcp_servers.breakpilot-debugger]
command = "breakpilot"
args = [
  "mcp",
  "serve",
  "--policy",
  "/Users/Quixote/workSpace/open-code/BreakPilot/breakpilot.yaml"
]
env = { BREAKPILOT_WORKSPACE = "/Users/Quixote/workSpace/open-code/BreakPilot" }
startup_timeout_ms = 20000
```

Restart Codex or open a new Codex session, then check MCP status:

```text
/mcp
```

## Claude Code

Claude Code can use a project-scoped `.mcp.json` or the `claude mcp add` command.

Project config:

```text
.mcp.json
```

Recommended config when `breakpilot` is installed or linked:

```json
{
  "mcpServers": {
    "breakpilot-debugger": {
      "command": "breakpilot",
      "args": [
        "mcp",
        "serve",
        "--policy",
        "{BREAKPILOT_ROOT}/breakpilot.yaml"
      ],
      "env": {
        "BREAKPILOT_WORKSPACE": "{BREAKPILOT_ROOT}"
      }
    }
  }
}
```

Source checkout fallback:

```json
{
  "mcpServers": {
    "breakpilot-debugger": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "{BREAKPILOT_ROOT}/src/cli.ts",
        "mcp",
        "serve",
        "--policy",
        "{BREAKPILOT_ROOT}/breakpilot.yaml"
      ],
      "env": {
        "BREAKPILOT_WORKSPACE": "{BREAKPILOT_ROOT}"
      }
    }
  }
}
```

Command-line add:

```bash
claude mcp add --scope project --transport stdio --env BREAKPILOT_WORKSPACE={BREAKPILOT_ROOT} breakpilot-debugger -- breakpilot mcp serve --policy {BREAKPILOT_ROOT}/breakpilot.yaml
```

Inside Claude Code:

```text
/mcp
```

Project-scoped `.mcp.json` may require approval the first time Claude Code loads it.

## Kiro

Kiro uses JSON MCP config.

Workspace config:

```text
.kiro/settings/mcp.json
```

User config:

```text
~/.kiro/settings/mcp.json
```

Recommended config when `breakpilot` is installed or linked:

```json
{
  "mcpServers": {
    "breakpilot-debugger": {
      "command": "breakpilot",
      "args": [
        "mcp",
        "serve",
        "--policy",
        "{BREAKPILOT_ROOT}/breakpilot.yaml"
      ],
      "env": {
        "BREAKPILOT_WORKSPACE": "{BREAKPILOT_ROOT}"
      },
      "disabled": false,
      "autoApprove": [
        "list_sessions",
        "list_breakpoints",
        "ide_status",
        "list_ide_sessions",
        "get_runtime_snapshot",
        "inspect_variable"
      ]
    }
  }
}
```

Source checkout fallback:

```json
{
  "mcpServers": {
    "breakpilot-debugger": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "{BREAKPILOT_ROOT}/src/cli.ts",
        "mcp",
        "serve",
        "--policy",
        "{BREAKPILOT_ROOT}/breakpilot.yaml"
      ],
      "env": {
        "BREAKPILOT_WORKSPACE": "{BREAKPILOT_ROOT}"
      },
      "disabled": false,
      "autoApprove": [
        "list_sessions",
        "list_breakpoints",
        "ide_status",
        "list_ide_sessions",
        "get_runtime_snapshot",
        "inspect_variable"
      ]
    }
  }
}
```

Keep mutating or execution-control tools under human approval unless your workflow explicitly allows them:

```text
evaluate
continue_execution
disconnect
debug_launch
debug_attach
set_breakpoint
remove_breakpoint
step_over
step_into
step_out
```

## Usage Prompt

Use this style of prompt in Codex, Claude Code, Kiro, or another MCP-capable coding agent:

```text
Use breakpilot-debugger MCP. Attach to the Python debugpy process on 127.0.0.1:5678, set a breakpoint in examples/python/app.py at line 12, wait for the breakpoint, then read a focused runtime snapshot. Do not use unsafe evaluate.
```

Expected tool flow:

```text
debug_attach
set_breakpoint
wait_for_breakpoint
get_runtime_snapshot
inspect_variable
evaluate
continue_execution
disconnect
```

## MCP Mode vs CLI Daemon Mode

For vibecoding agents, prefer MCP mode:

```bash
breakpilot mcp serve
```

MCP mode is a true stdio lifecycle: the MCP client starts the process, and the
process exits when stdin closes or the client sends SIGTERM. It does not start
or reuse the HTTP daemon. IDE plugins discover the active MCP-owned bridge from
`.breakpilot/bridge.json` and reconnect when that file changes.

For manual CLI, scripts, or IDE Bridge work, use daemon mode:

```bash
breakpilot serve --http-port 27890 --ide-bridge-port 27891
```

Do not start both modes by default for the same workflow.
