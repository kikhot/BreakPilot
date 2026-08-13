# BreakPilot Stateless MCP Design

Date: 2026-08-13

## Purpose

Replace BreakPilot's hand-written, sessionful MCP transports with the stable
MCP TypeScript SDK v2 serving model. HTTP becomes stateless by default for
both the current `2026-07-28` protocol and compatible 2025-era clients, while
BreakPilot's explicit debug sessions remain durable application state.

The transport boundary is the important distinction:

- MCP HTTP transport state is request-local and is discarded after every
  request.
- BreakPilot project runtimes, debug sessions, breakpoints, and pause state
  remain in `ProjectRuntimeRegistry` and are addressed explicitly by tool
  arguments such as `projectPath` and `sessionId`.

This design supersedes the current `/stream` implementation backed by
`McpSessionRegistry` and the older `/sse` plus `/message` HTTP+SSE pair.

## Authoritative Baseline

Implementation is pinned to the following official behavior available on
2026-08-13:

- [MCP `2026-07-28` Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP protocol versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [TypeScript SDK v2 protocol eras](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)
- [TypeScript SDK v2 `createMcpHandler`](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/server/createMcpHandler.html)
- [TypeScript SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)

The modern protocol is `2026-07-28`. It has no `initialize` handshake, no MCP
session identifier, and no standalone GET stream. Each POST carries its own
protocol envelope. The SDK calls this the `modern` era.

The SDK's `legacy` era covers MCP revisions from `2024-10-07` through
`2025-11-25`. `createMcpHandler(factory, { legacy: "stateless" })` serves that
wire format with a fresh server for every HTTP request and without creating an
`Mcp-Session-Id`.

## Goals

1. Make stateless HTTP the only default MCP HTTP mode.
2. Serve modern `2026-07-28` and 2025-era clients from one tool definition and
   call path.
3. Preserve all current BreakPilot tool names, schemas, structured results,
   and structured error semantics.
4. Keep project and debug-session routing correct across independent and
   concurrent HTTP requests.
5. Use the official SDK for protocol parsing, version negotiation, codecs,
   cancellation, and response shaping.
6. Close modern request streams and stdio connections deterministically during
   shutdown.
7. Protect the local HTTP service from invalid Host and Origin headers.

## Non-Goals

- A remote or internet-facing MCP deployment.
- OAuth, bearer-token issuance, or multi-tenant authorization.
- Preserving the sessionful 2024 HTTP+SSE `/sse` transport.
- Turning BreakPilot's explicit debug `sessionId` into transport state.
- Renaming tools or redesigning debugger behavior.
- Adding prompts, resources, sampling, elicitation, or MCP tasks.

## Chosen Architecture

### One protocol adapter, one control plane

Add a transport-neutral MCP server factory in `src/mcp/serverFactory.ts`. The
factory receives a `ControlGateway` and returns a fresh SDK v2 low-level
`Server` with the `tools` capability.

The factory installs only these low-level handlers:

- `tools/list` calls `gateway.listTools()` for every request and returns the
  resulting JSON Schemas unchanged.
- `tools/call` passes the tool name and unmodified tool arguments to
  `gateway.callTool()` and converts the existing `ToolResponse` into MCP
  `content`, `structuredContent`, and `isError` fields.

The SDK remains responsible for the MCP envelope and method-level protocol
shape. `ToolRouter`, `ToolInputValidator`, and `ToolResponseFinalizer` remain
the authority for BreakPilot tool arguments and results.

The factory deliberately does not use `McpServer.registerTool()` with
`fromJsonSchema()`. That high-level path performs tool-specific schema
validation before `ToolRouter` and can replace BreakPilot's existing
`structuredContent.error` with an SDK-generated error. Low-level list/call
handlers advertise the exact schemas without transferring validation
ownership to the SDK.

### HTTP serving

`BreakPilotHub` creates one long-lived `McpHttpHandler`:

```text
createMcpHandler(requestScopedFactory, {
  legacy: "stateless",
  responseMode: "auto"
})
```

`toNodeHandler()` adapts its fetch-shaped interface to the existing
`node:http` server. Both HTTP paths dispatch to that same adapter:

- `/mcp` is the canonical MCP endpoint.
- `/stream` is a compatibility alias with identical stateless behavior.

The alias preserves existing endpoint configuration, not the former
sessionful wire behavior. Neither path creates, stores, requires, or returns
an MCP session ID.

The old `/sse` and `/message` routes are removed. They are not needed for
2025-era compatibility because SDK v2 already provides stateless legacy
Streamable HTTP. Requests to the removed paths receive the normal hub `404`.

### HTTP method and response contract

Both `/mcp` and `/stream` follow the same contract:

| Request | Result |
| --- | --- |
| Modern `2026-07-28` POST | Served from a fresh SDK `Server` |
| 2025-era POST | Served from a fresh SDK `Server` through `legacy: "stateless"` |
| GET or DELETE | `405 Method Not Allowed` |
| POST without JSON media type | `415 Unsupported Media Type` |
| JSON-RPC notification | `202` with an empty body |
| Unknown MCP method | SDK protocol error; no BreakPilot fallback routing |
| Incoming `Mcp-Session-Id` | Ignored and never echoed |

Modern validation, including `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`,
and the per-request protocol envelope, is owned by the SDK. Header/body
mismatches and unsupported revisions retain the SDK's protocol-defined HTTP
status and JSON-RPC error codes.

BreakPilot tool failures are successful MCP `tools/call` results with
`isError: true`, explanatory text content, and the existing structured error
object. They are not converted into transport or JSON-RPC failures.

### Request-local project routing

The SDK factory receives the original web `Request` as `requestInfo`. For each
HTTP request, BreakPilot extracts a project hint in this order:

1. `X-BreakPilot-Project` header;
2. `projectPath` query parameter;
3. no request hint.

The factory closes over that one hint in a request-scoped `ControlGateway`.
It never writes the hint to a shared field.

For every tool call, `ProjectRuntimeRegistry.resolveRuntime()` preserves this
selection order:

1. `arguments.projectPath`;
2. `arguments.workspace`;
3. request-local project hint;
4. unique runtime inferred from `arguments.sessionId`;
5. the existing default or ambiguity error.

The selected runtime's canonical workspace root is injected into routed tool
arguments only when the caller did not already supply a project selector.
This makes an initialize/list/call sequence independent across HTTP requests
and prevents concurrent project A and project B requests from contaminating
each other.

Dynamic definitions, including the runtime-derived language enum on
`bp_debug_start`, are listed from the selected request scope rather than
captured once when the hub starts.

### Application state boundary

`ProjectRuntimeRegistry` remains shared across all request-local MCP server
instances. It owns the durable state required by debugger workflows:

```text
HTTP request
  -> fresh MCP Server and transport state
  -> request-scoped ControlGateway
  -> shared ProjectRuntimeRegistry
  -> project RuntimeContext
  -> explicit BreakPilot debug sessionId
```

This is intentional state in the BreakPilot application, not hidden MCP
transport state. Existing execution locks and session coordination continue
to serialize conflicting operations inside a selected debug session.

### stdio serving

Replace the hand-written newline JSON-RPC implementation with SDK v2
`serveStdio(factory, { legacy: "serve" })` using the same server factory.

For stdio, the SDK factory serves one connection rather than one HTTP request.
The connection can negotiate the modern era or open with a 2025-era
`initialize` handshake. This does not reintroduce HTTP session state.

`startStdio()` returns the SDK `StdioServerHandle`. CLI cleanup closes that
handle before closing a hub that the CLI process owns. Stdio remains silent on
stdout except for protocol frames.

## Security Boundary

BreakPilot remains a local debugger service. The initial implementation
accepts loopback bind hosts only (`127.0.0.1`, `localhost`, or `::1`). A
non-loopback host fails startup with an actionable error. Remote serving is a
future feature that must add authentication and explicit Host/Origin
allowlists together.

Before routing a request, the hub applies the official Node
`localhostHostValidation()` and `localhostOriginValidation()` guards. At a
minimum they protect `/mcp` and `/stream`; the implementation applies the same
local-service policy consistently to the hub's HTTP entry so control routes
cannot bypass it.

URL path parsing uses a fixed local base and never constructs authority from an
unvalidated Host header. A present malicious or malformed Host/Origin is
rejected with `403`; non-browser clients without an Origin header continue to
work.

## Lifecycle and Idle Shutdown

`BreakPilotHub` owns the single `McpHttpHandler` and its Node adapter. It also
tracks `activeMcpRequests`, incrementing when `/mcp` or `/stream` is accepted
and decrementing exactly once on the response's `finish` or `close` event.

Every MCP request resets the idle deadline, including discover, list, call,
notification, and subscription/listen requests. Idle shutdown may run only
when all of the following are false:

- `activeMcpRequests > 0`;
- connected IDE clients exist;
- active BreakPilot debug sessions exist.

`McpSessionRegistry` is deleted; it no longer participates in status or idle
decisions.

Hub shutdown proceeds in this order:

1. mark the hub closing so no new MCP dispatch begins;
2. await `McpHttpHandler.close()` to abort modern in-flight exchanges and
   subscription streams;
3. close the Node HTTP listener and let accepted responses settle;
4. stop the IDE bridge and clean up project runtimes;
5. clear the idle timer and remaining lifecycle listeners.

The order prevents runtime cleanup from racing an accepted tool call and makes
modern SSE cancellation observable to handlers through the SDK signal.

## Status and Documentation

`GET /status` reports:

- `mcpUrl`: canonical `http://<host>:<port>/mcp`;
- `streamUrl`: compatibility alias;
- `mcpTransport: "stateless"`;
- supported eras/revisions;
- `activeMcpRequests`;
- the existing bridge and project information.

It no longer reports `sseUrl` or `mcpSessions`.

Update `README.md`, `docs/vibecoding-mcp.md`, and `agents/openai.yaml` to make
`/mcp` primary, mark `/stream` as an alias, and state that 2025 compatibility
does not mean sessionful HTTP.

## Dependency Boundary

Add stable v2 packages as direct runtime dependencies:

- `@modelcontextprotocol/server` for `Server`, `createMcpHandler`, and
  `serveStdio`;
- `@modelcontextprotocol/node` for `toNodeHandler` and local Host/Origin
  validation.

Add `@modelcontextprotocol/client` only as a development dependency if the
official client is used by integration tests. Do not import the private
`@modelcontextprotocol/core-internal` package.

## Test Strategy

All behavior changes follow red-green-refactor. Existing transport tests are
rewritten before the old implementation is removed.

### HTTP protocol compatibility

- A modern auto-negotiating SDK client discovers, lists, and calls through
  `/mcp`.
- A 2025-era initialize/list/call sequence succeeds through both `/mcp` and
  `/stream` without receiving or sending a session ID.
- Repeated calls prove a fresh server instance is used per request while a
  debug session remains reachable by its explicit BreakPilot `sessionId`.
- GET and DELETE return 405; non-JSON POST returns 415.
- Notifications return 202 with an empty body.
- An incoming `Mcp-Session-Id` is ignored and never echoed.
- `/sse` and `/message` return 404.

### Modern validation and security

- Missing or mismatched modern protocol/method/name headers receive the SDK's
  expected 400-class JSON-RPC errors.
- Unsupported versions and unknown methods retain SDK status/error codes.
- Malicious Host, Origin, and opaque `Origin: null` requests receive 403.
- Non-loopback startup is rejected.

### Routing and concurrency

- Header and query project hints select the correct runtime.
- Tool argument `projectPath` and `workspace` override the request hint.
- Explicit `sessionId` continues to route to its unique project.
- Concurrent project A and project B requests return their own dynamic schemas
  and results without cross-request leakage.

### Tool contract parity

- `tools/list` preserves nested `enum`, `oneOf`, `$defs`, required fields, and
  output schemas exactly.
- Invalid tool arguments produce the same BreakPilot error code, diagnostics,
  `structuredContent`, summary text, and `isError` as the direct control path.
- Successful and malformed handler outputs still pass through
  `ToolResponseFinalizer`; the SDK does not replace their error structure.
- Unknown tools keep the current structured failure contract.

### Lifecycle

- Discover/list/call requests reset the idle timer.
- Idle shutdown does not run while an MCP response or listen stream is open.
- `close()` terminates a modern stream and does not clean runtime state before
  an accepted tool request settles.
- stdio supports modern and 2025-era clients through the shared factory.
- EOF and process signals close the stdio handle before an owned hub.

### Release verification

- focused transport and stdio tests;
- all project tests;
- `npm run typecheck`;
- `npm run build`;
- documentation and CLI smoke checks.

## Compatibility and Migration

| Existing consumer | New behavior |
| --- | --- |
| `/stream` with stateless requests | Continues working; now official SDK v2 |
| `/stream` requiring `Mcp-Session-Id` | Must stop relying on the transport session |
| 2025-era Streamable HTTP client | Compatible by default through stateless fallback |
| Modern `2026-07-28` client | Supported at `/mcp` and `/stream` |
| 2024 HTTP+SSE `/sse` client | Unsupported; migrate to Streamable HTTP |
| `breakpilot mcp serve` stdio client | Compatible through SDK era negotiation |
| BreakPilot tool using `sessionId` | Unchanged; this is application state |

No compatibility switch silently restores sessionful HTTP. If remote serving
or frozen HTTP+SSE support is ever required, it must be designed as an
explicitly separate, authenticated deployment mode.

## Success Criteria

The migration is complete when:

1. `/mcp` and `/stream` serve both protocol eras with a fresh server per HTTP
   request;
2. no MCP HTTP response creates or returns `Mcp-Session-Id`;
3. no default route retains the former `/sse` or `/message` session map;
4. modern protocol, method, media-type, Host, and Origin validation match the
   official SDK/spec behavior;
5. concurrent project hints do not leak across requests;
6. every existing tool schema and structured result/error contract remains
   equivalent to the direct control path;
7. idle shutdown and explicit close do not interrupt accepted work or leak
   modern response streams;
8. HTTP and stdio use the same factory and pass modern plus 2025-era tests;
9. the focused tests, full suite, typecheck, build, and documentation checks
   all pass.
