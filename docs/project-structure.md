# Project Structure

BreakPilot keeps protocol adapters thin and puts shared debugging behavior behind a neutral control plane.

| Path | Responsibility |
|---|---|
| `src/control/` | Shared tool definitions and `ToolRouter` used by MCP stdio, HTTP, and CLI flows. |
| `src/mcp/` | MCP stdio / JSON-RPC adapter only. It should not own shared tool schemas or routing. |
| `src/http/` | Local HTTP control server for daemon-backed CLI usage. |
| `src/cli.ts`, `src/cli/` | `breakpilot` bin entrypoint plus CLI flag parsing, help, command mapping, and HTTP client. |
| `src/runtime/` | Runtime factory and runtime provider adapters. |
| `src/sessions/` | Session store, breakpoint manager, ownership/coordinator logic, and session orchestration. |
| `src/dap/` | Debug Adapter Protocol client, transport, and session wrapper. |
| `src/debug-adapters/` | Language adapter registry and language-specific DAP adapter startup/argument normalization. |
| `src/inspection/` | Runtime snapshot building, scope classification, variable serialization, and redaction. |
| `src/ide/` | IDE Bridge server, protocol, client registry, and IDE collaboration helpers. |
| `src/security/` | Policy loading and runtime safety checks. |
| `src/audit/` | Audit log writer. |
| `src/types/` | Domain-scoped TypeScript types. |
| `agents/`, `skills/` | Agent-facing prompt and skill artifacts. |
| `breakpilot-vscode/`, `breakpilot-idea/` | IDE plugin skeletons. |

External names remain stable even when internal directories change: package `@breakpilot/cli`, command `breakpilot`, MCP identity `breakpilot-debugger`, MCP command `breakpilot mcp serve`, and daemon command `breakpilot serve --http-port 27890 --ide-bridge-port 27891`.
