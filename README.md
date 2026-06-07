# BreakPilot Debug MCP

BreakPilot is an MVP implementation of an AI-callable collaborative runtime debugger. It combines:

- a minimal MCP stdio server;
- an optional local HTTP control API for CLI usage;
- a Debug Adapter Protocol client;
- session, breakpoint, snapshot, evaluate, audit, and policy modules;
- an IDE Bridge protocol with a lightweight WebSocket server;
- VS Code and IntelliJ plugin skeletons for the collaborative mode.

The first runnable scope is intentionally conservative: Headless MCP/CLI support is implemented first, with Python and Node.js adapter hooks. TypeScript source maps, Java/Spring Boot, deep IDE variable inspection, Docker, K8s, and replay are documented extension points rather than hidden promises.

## Quick Start

```bash
npm run smoke
npm run typecheck
npm run build
npm run serve:http
```

In another terminal:

```bash
node --experimental-strip-types src/cli.ts tools
node --experimental-strip-types src/cli.ts ide status --pretty
node --experimental-strip-types src/cli.ts ide sessions --pretty
node --experimental-strip-types src/cli.ts ide adopt --ide-session idea_ab12 --pretty
node --experimental-strip-types src/cli.ts ide context --ide-session idea_ab12 --pretty
```

For MCP stdio integration:

```bash
node --experimental-strip-types src/server.ts
```

After `npm run build`, the compiled entrypoints are also available:

```bash
node dist/src/server.js
node dist/src/cli.js tools
```

## Example MCP Tools

- `debug_launch`
- `debug_attach`
- `set_breakpoint`
- `wait_for_breakpoint`
- `get_runtime_snapshot`
- `inspect_variable`
- `list_ide_sessions`
- `adopt_ide_session`
- `get_active_breakpoint_context`
- `evaluate`
- `continue_execution`

See [docs/architecture.md](docs/architecture.md) and [docs/mcp-tools.md](docs/mcp-tools.md) for the full design.
