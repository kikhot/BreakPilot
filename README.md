# BreakPilot

BreakPilot is an Agent Runtime Debugger for AI-callable collaborative runtime debugging. It combines:

- a shared control plane used by MCP stdio, HTTP, and CLI flows;
- a shared SDK-backed MCP server for stdio and stateless HTTP;
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
breakpilot serve
```

In another terminal:

```bash
breakpilot tools --pretty
breakpilot ide status --pretty
breakpilot ide sessions --pretty
breakpilot ide adopt --ide-session idea_ab12 --pretty
breakpilot ide context --ide-session idea_ab12 --pretty
```

For MCP integration, prefer stdio:

```bash
breakpilot mcp serve
```

`breakpilot mcp serve` negotiates modern `2026-07-28` and compatible 2025-era
clients through the same control plane. It connects to the local hub and starts
an in-process hub if one is not already available.

`breakpilot serve` starts the loopback-only local hub on `127.0.0.1:57987`:

```text
MCP HTTP: http://127.0.0.1:57987/mcp
Compatibility alias: http://127.0.0.1:57987/stream
Transport mode: stateless for modern 2026-07-28 and compatible 2025-era clients
```

`/mcp` is canonical. `/stream` is a URL compatibility alias for the same
stateless handler, not the former sessionful HTTP+SSE transport. 2025-era
compatibility is enabled by default, and clients neither receive nor need
`Mcp-Session-Id`. The old `/sse` and `/message` routes were removed.

An explicit `sessionId` passed to `bp_debug_*` tools is durable BreakPilot
debugger workflow state, separate from MCP transport state, and remains usable
across independent HTTP requests. The hub also serves the IDE bridge WebSocket
at `/bridge`; it binds to loopback by default and validates local Host and
Origin values.

After `npm run build`, the compiled entrypoints are also available:

```bash
node dist/src/cli.js tools
```

## CLI Help, Version, and Language

The CLI provides human-readable help and version output (machine-readable
commands still emit JSON):

```bash
breakpilot --help        # or -h, or: breakpilot help
breakpilot --version     # or -v; prints the package.json version
breakpilot <command> --help   # per-command help, e.g. breakpilot bp set --help
```

Help and version text can be rendered in English (`en_US`, default) or
Simplified Chinese (`zh_CN`); unsupported values fall back to English:

```bash
breakpilot --help --locale zh_CN
```

Breakpoint commands accept both `breakpoint` and the `bp` alias:

```bash
breakpilot breakpoint set --file <file> --line <line>
breakpilot bp set --file <file> --line <line>
```

## Example MCP Tools

- `bp_debug_start`
- `bp_debug_status`
- `bp_debug_control`
- `bp_debug_threads`
- `bp_debug_call_stack`
- `bp_debug_frame`
- `bp_debug_value`
- `bp_debug_eval`
- `bp_debug_context`
- `bp_debug_set_breakpoint`

See [docs/architecture.md](docs/architecture.md), [docs/project-structure.md](docs/project-structure.md), [docs/control-tools.md](docs/control-tools.md), [docs/mcp-tools.md](docs/mcp-tools.md), and [docs/vibecoding-mcp.md](docs/vibecoding-mcp.md) for the full design and agent setup.
