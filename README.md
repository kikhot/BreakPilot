# BreakPilot

BreakPilot is an Agent Runtime Debugger for AI-callable collaborative runtime debugging. It combines:

- a shared control plane used by MCP stdio, HTTP, and CLI flows;
- a minimal MCP stdio adapter;
- an optional local HTTP control API for daemon-backed CLI usage;
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
npm link
breakpilot serve --http-port 27890 --ide-bridge-port 27891
```

In another terminal:

```bash
breakpilot tools --pretty
breakpilot ide status --pretty
breakpilot ide sessions --pretty
breakpilot ide adopt --ide-session idea_ab12 --pretty
breakpilot ide context --ide-session idea_ab12 --pretty
```

For MCP stdio integration:

```bash
breakpilot mcp serve
```

After `npm run build`, the compiled entrypoints are also available:

```bash
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

See [docs/architecture.md](docs/architecture.md), [docs/project-structure.md](docs/project-structure.md), [docs/control-tools.md](docs/control-tools.md), and [docs/mcp-tools.md](docs/mcp-tools.md) for the full design.
