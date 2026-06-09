# Control Tools

BreakPilot tools are part of the shared control plane, not MCP-only code. The same tool definitions and `ToolRouter` are used by:

- MCP stdio requests through `src/mcp/stdioServer.ts`;
- HTTP daemon requests through `src/http/controlServer.ts`;
- CLI commands through `src/cli/commands.ts` and `src/cli/controlClient.ts`.

The tool names, schemas, and responses are documented in [mcp-tools.md](mcp-tools.md) because MCP is the primary agent-facing protocol, but those names are also the stable internal control API used by the CLI daemon.

Shared control-plane modules:

- `src/control/toolDefinitions.ts`
- `src/control/ToolRouter.ts`

Do not add shared command mapping, router behavior, or tool schemas under `src/mcp/`; reserve that directory for the MCP stdio / JSON-RPC adapter.
