# Vibecoding MCP Setup

BreakPilot can be used from vibecoding tools as a local stdio MCP server. Once connected, agents can call runtime debugging tools such as `bp_debug_start`, `bp_debug_set_breakpoint`, `bp_debug_control`, `bp_debug_frame`, and `bp_debug_value`.

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
        "bp_debug_status",
        "bp_debug_list_breakpoints",
        "bp_debug_threads",
        "bp_debug_call_stack",
        "bp_debug_frame",
        "bp_debug_value",
        "bp_debug_context"
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
        "bp_debug_status",
        "bp_debug_list_breakpoints",
        "bp_debug_threads",
        "bp_debug_call_stack",
        "bp_debug_frame",
        "bp_debug_value",
        "bp_debug_context"
      ]
    }
  }
}
```

Keep mutating or execution-control tools under human approval unless your workflow explicitly allows them:

```text
bp_debug_start
bp_debug_set_breakpoint
bp_debug_remove_breakpoint
bp_debug_eval
bp_debug_control
bp_debug_set_value
```

## Usage Prompt

Use this style of prompt in Codex, Claude Code, Kiro, or another MCP-capable coding agent:

```text
Use breakpilot-debugger MCP. Attach to the Python debugpy process on 127.0.0.1:5678, set a breakpoint in examples/python/app.py at line 12, wait for the breakpoint, then inspect the top frame variables. Do not use unsafe evaluate.
```

Expected tool flow:

```text
bp_debug_start
bp_debug_set_breakpoint
bp_debug_control(action="wait")
bp_debug_call_stack
bp_debug_frame
bp_debug_value
bp_debug_eval
bp_debug_control(action="resume")
bp_debug_control(action="disconnect")
```

## MCP Stdio And Hub Mode

For vibecoding agents, prefer MCP stdio:

```bash
breakpilot mcp serve
```

MCP stdio proxies to the local BreakPilot hub. If the hub is not already
running, the stdio process starts one in-process and exits it when stdin closes
or the client sends SIGTERM.

For manual CLI, scripts, Streamable HTTP, SSE, or IDE Bridge work, start the
hub explicitly:

```bash
breakpilot serve
```

The hub listens on `127.0.0.1:57987` by default and exposes `/stream`, `/sse`,
`/message`, `/bridge`, and `/status`.
