# BreakPilot Stateless MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace BreakPilot's sessionful hand-written MCP transports with an SDK v2 server that defaults to stateless HTTP while serving modern `2026-07-28` and compatible 2025-era clients.

**Architecture:** A shared low-level SDK `Server` factory advertises the existing JSON Schemas and delegates every tool call to `ControlGateway`, leaving `ToolRouter` as the tool-validation authority. `BreakPilotHub` mounts one `createMcpHandler(..., { legacy: "stateless" })` instance at `/mcp` and `/stream`, creates a request-scoped gateway from each HTTP request, and retains only application/debug state in `ProjectRuntimeRegistry`. Stdio uses the same factory through `serveStdio`.

**Tech Stack:** Node.js `node:http`, TypeScript 5.9, MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/client`), built-in `node:test` and `node:assert`.

## Global Constraints

- The modern MCP protocol revision is exactly `2026-07-28`.
- HTTP compatibility covers SDK `legacy` revisions `2024-10-07` through `2025-11-25` with `legacy: "stateless"`.
- `/mcp` is canonical; `/stream` is an identical stateless alias.
- `/sse` and `/message` are removed and return `404`; there is no hidden sessionful compatibility switch.
- HTTP never creates, requires, or returns `Mcp-Session-Id`; an incoming value is ignored.
- SDK code owns protocol-envelope, HTTP media type, method, and era validation; `ToolRouter`, `ToolInputValidator`, and `ToolResponseFinalizer` own BreakPilot tool validation.
- BreakPilot tool failures remain MCP `tools/call` results with `isError: true`, summary text, and the existing `structuredContent.error` contract.
- Request routing order is `arguments.projectPath`, `arguments.workspace`, request-local hint, unique explicit BreakPilot `sessionId`, then the existing default/ambiguity behavior.
- The request hint order is `X-BreakPilot-Project`, `projectPath` query parameter, then absent.
- The HTTP service accepts loopback binds only and validates Host and Origin before routing.
- `BreakPilotHub.close()` closes the MCP handler and accepted HTTP dispatches before cleaning project runtimes.
- Every production behavior change follows RED → verify failure → GREEN → verify pass → refactor.
- Use Conventional Commits in English and stage only files named by the current task.
- Preserve the user's unrelated untracked files under `docs/superpowers/`.

---

### Task 1: Install SDK v2 and build the shared MCP server factory

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/mcp/serverFactory.ts`
- Create: `test/mcp-server-factory.test.ts`

**Interfaces:**
- Consumes: `ControlGateway.listTools()` and `ControlGateway.callTool(name, args)`.
- Produces: `createBreakPilotMcpServer(gateway: ControlGateway): Server`.
- Produces: `toMcpToolCallResult(name: string, result: ToolResponse): CallToolResult` for HTTP and stdio parity.
- Server identity is `{ name: "breakpilot-debugger", version: "0.1.0" }` and capabilities are `{ tools: {} }`.

- [ ] **Step 1: Add the stable SDK packages without changing runtime source**

Run:

```bash
npm install @modelcontextprotocol/server@^2.0.0 @modelcontextprotocol/node@^2.0.0
npm install --save-dev @modelcontextprotocol/client@^2.0.0
```

Expected: `package.json` and `package-lock.json` contain the three v2 packages; no `@modelcontextprotocol/core-internal` dependency is introduced.

- [ ] **Step 2: Write failing server-factory contract tests**

Create `test/mcp-server-factory.test.ts` using `Client` and a real linked `InMemoryTransport` pair. The fake gateway must advertise a schema containing literal nested `enum`, `oneOf`, `$defs`, and `outputSchema`, and record every call it receives.

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createBreakPilotMcpServer } from "../src/mcp/serverFactory.ts";
import type { ControlGateway } from "../src/control/ControlGateway.ts";

test("the MCP adapter advertises exact schemas and delegates invalid tool arguments", async () => {
  const calls: unknown[] = [];
  const gateway: ControlGateway = {
    listTools: () => [{
      name: "fixture_tool",
      description: "fixture",
      inputSchema: {
        type: "object",
        properties: { mode: { oneOf: [{ type: "string", enum: ["a", "b"] }, { $ref: "#/$defs/mode" }] } },
        $defs: { mode: { type: "integer", minimum: 1 } },
        required: ["mode"],
        additionalProperties: false
      },
      outputSchema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] }
    }],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { error: { code: "INVALID_ARGUMENT", message: "fixture rejected", retrySafe: true, actionMayHaveApplied: false } };
    }
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createBreakPilotMcpServer(gateway);
  const client = new Client({ name: "factory-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools[0]?.inputSchema, (await gateway.listTools())[0]?.inputSchema);
    assert.deepEqual(listed.tools[0]?.outputSchema, (await gateway.listTools())[0]?.outputSchema);
    const result = await client.callTool({ name: "fixture_tool", arguments: { mode: false } });
    assert.deepEqual(calls, [{ name: "fixture_tool", args: { mode: false } }]);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      error: { code: "INVALID_ARGUMENT", message: "fixture rejected", retrySafe: true, actionMayHaveApplied: false }
    });
    assert.equal(result.content[0]?.type, "text");
  } finally {
    await client.close();
    await server.close();
  }
});
```

The production mutation caught by this test is replacing low-level handlers with high-level schema validation: the invalid `mode: false` call would never reach the gateway.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
node --experimental-strip-types --test test/mcp-server-factory.test.ts
```

Expected: FAIL because `src/mcp/serverFactory.ts` does not exist.

- [ ] **Step 4: Implement the minimal low-level server factory**

Create `src/mcp/serverFactory.ts` with method-string low-level handlers. Do not call `registerTool()` or `fromJsonSchema()`.

```typescript
import { Server, type CallToolResult, type ListToolsResult } from "@modelcontextprotocol/server";
import type { ControlGateway } from "../control/ControlGateway.ts";
import { summarizeToolResult } from "../control/ToolTextSummary.ts";
import type { ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";

export function toMcpToolCallResult(name: string, result: ToolResponse): CallToolResult {
  return {
    content: [{ type: "text", text: summarizeToolResult(name, result as AnyRecord) }],
    structuredContent: result,
    isError: Boolean(result.error)
  };
}

export function createBreakPilotMcpServer(gateway: ControlGateway): Server {
  const server = new Server(
    { name: "breakpilot-debugger", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({
    tools: await gateway.listTools()
  }));
  server.setRequestHandler("tools/call", async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = (request.params.arguments as AnyRecord | undefined) ?? {};
    return toMcpToolCallResult(name, await gateway.callTool(name, args));
  });
  return server;
}
```

Adjust only the narrow type casts required by the published SDK v2 types; preserve the runtime shape above.

- [ ] **Step 5: Run focused tests and typecheck GREEN**

Run:

```bash
node --experimental-strip-types --test test/mcp-server-factory.test.ts
npm run typecheck
```

Expected: PASS with the fake gateway receiving the schema-invalid arguments unchanged.

- [ ] **Step 6: Commit Task 1**

```bash
git add package.json package-lock.json src/mcp/serverFactory.ts test/mcp-server-factory.test.ts
git commit -m "feat(mcp): add shared SDK v2 server factory" -m "Delegate tool-specific validation and result finalization to the existing BreakPilot control plane.\n\nTests: node --experimental-strip-types --test test/mcp-server-factory.test.ts\nTests: npm run typecheck"
```

### Task 2: Replace sessionful Hub MCP routes with stateless SDK HTTP

**Files:**
- Create: `src/hub/HubControlGateway.ts`
- Modify: `src/hub/HubServer.ts`
- Delete: `src/hub/McpSessionRegistry.ts`
- Create: `test/mcp-http-stateless.test.ts`
- Modify: `test/hub-transports.test.ts`

**Interfaces:**
- Consumes: `createBreakPilotMcpServer(gateway)` from Task 1.
- Produces: `HubControlGateway(projects: ProjectRuntimeRegistry, requestProjectPath?: string)` implementing `ControlGateway`.
- Produces: Hub status fields `mcpUrl`, `streamUrl`, `mcpTransport`, `mcpProtocolVersions`, and `activeMcpRequests`.
- `mcpProtocolVersions` is exactly `{ modern: "2026-07-28", legacy: { min: "2024-10-07", max: "2025-11-25", mode: "stateless" } }`.
- `/mcp` and `/stream` call the same `NodeMcpRequestHandler` created once from one `McpHttpHandler`.

- [ ] **Step 1: Write failing legacy and modern endpoint tests**

Create `test/mcp-http-stateless.test.ts` with real `BreakPilotHub`, SDK `Client`, and `StreamableHTTPClientTransport`. Add a helper that opens either a default legacy client or a modern auto-negotiating client:

```typescript
async function connectClient(url: string, modern: boolean): Promise<Client> {
  const client = new Client(
    { name: modern ? "modern-test" : "legacy-test", version: "1.0.0" },
    modern ? { versionNegotiation: { mode: "auto", probe: { timeoutMs: 2_000, maxRetries: 0 } } } : undefined
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}
```

Add separate tests proving:

```typescript
test("/mcp serves modern 2026-07-28 requests without an MCP session", async () => {
  const client = await connectClient(`${handle.url}/mcp`, true);
  assert.equal(client.getProtocolEra(), "modern");
  assert.ok((await client.listTools()).tools.some(({ name }) => name === "bp_debug_start"));
});

test("/mcp and /stream serve 2025-era clients without an MCP session", async () => {
  for (const pathname of ["/mcp", "/stream"]) {
    const client = await connectClient(`${handle.url}${pathname}`, false);
    const result = await client.callTool({ name: "bp_debug_status", arguments: {} });
    assert.equal(result.isError, false);
    assert.deepEqual((result.structuredContent as { sessions?: unknown[] }).sessions, []);
    await client.close();
  }
});
```

Also send a complete raw 2025 `initialize` POST to each path with
`protocolVersion: "2025-11-25"`, empty capabilities, and literal client info.
Assert status `200` and `response.headers.get("mcp-session-id") === null`.

The production mutations caught are routing `/mcp` elsewhere, retaining the old session registry, or configuring `legacy: "reject"`.

- [ ] **Step 2: Write failing HTTP method, media type, notification, and removal tests**

Add literal assertions:

```typescript
assert.equal((await fetch(`${handle.url}/mcp`)).status, 405);
assert.equal((await fetch(`${handle.url}/stream`, { method: "DELETE" })).status, 405);
assert.equal((await fetch(`${handle.url}/mcp`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
assert.equal((await fetch(`${handle.url}/sse`)).status, 404);
assert.equal((await fetch(`${handle.url}/message`, { method: "POST" })).status, 404);
```

Send `notifications/initialized` as a legacy JSON-RPC notification and assert
`202` plus an empty response body. Send a valid legacy `tools/list` request
with `Mcp-Session-Id: attacker-value` and assert the response neither contains
nor echoes that header.

Add a `modernRequest(method, params, headers)` helper whose body puts this
literal envelope inside `params._meta`:

```typescript
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "raw-modern-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {}
}
```

Using `Content-Type: application/json`, `MCP-Protocol-Version: 2026-07-28`,
and the body-matching `Mcp-Method`, prove a raw modern `tools/list` succeeds.
Then mutate one boundary per request and assert the literal result:

- missing `MCP-Protocol-Version` → HTTP `400`, JSON-RPC error `-32020`;
- mismatched `Mcp-Method` → HTTP `400`, JSON-RPC error `-32020`;
- missing or mismatched `Mcp-Name` on `tools/call` → HTTP `400`, JSON-RPC error `-32020`;
- unsupported modern protocol revision → HTTP `400`, JSON-RPC error `-32022`;
- body/header-matched unknown method → HTTP `404`, JSON-RPC error `-32601`.

- [ ] **Step 3: Run the new HTTP test and verify RED**

Run:

```bash
node --experimental-strip-types --test test/mcp-http-stateless.test.ts
```

Expected: FAIL because `/mcp` returns 404 and `/stream` still creates or requires a session.

- [ ] **Step 4: Implement the Hub control gateway**

Create `src/hub/HubControlGateway.ts`:

```typescript
export class HubControlGateway implements ControlGateway {
  private readonly projects: ProjectRuntimeRegistry;
  private readonly requestProjectPath?: string;

  constructor(
    projects: ProjectRuntimeRegistry,
    requestProjectPath?: string
  ) {
    this.projects = projects;
    this.requestProjectPath = requestProjectPath;
  }

  listTools(): ToolDefinition[] {
    return this.projects.getOrCreate(this.requestProjectPath).router.listTools();
  }

  async callTool(name: string, args: AnyRecord = {}): Promise<ToolResponse> {
    try {
      const runtime = this.projects.resolveRuntime(args, this.requestProjectPath);
      const hasProjectSelector =
        typeof args.projectPath === "string" && Boolean(args.projectPath.trim()) ||
        typeof args.workspace === "string" && Boolean(args.workspace.trim());
      const routedArgs = hasProjectSelector
        ? args
        : { ...args, projectPath: runtime.policy.workspace.root };
      return await runtime.router.callTool(name, routedArgs);
    } catch (error) {
      return fail(error, "hub");
    }
  }
}
```

Use parentheses or a helper for the selector expression so precedence is explicit.

- [ ] **Step 5: Mount one SDK handler at both paths and remove old sessions**

In `BreakPilotHub`:

1. Construct one `McpHttpHandler` with `createMcpHandler(({ requestInfo }) => createBreakPilotMcpServer(new HubControlGateway(this.projects, projectHintFromRequest(requestInfo))), { legacy: "stateless", responseMode: "auto" })`.
2. Construct one Node adapter with `toNodeHandler(handler)`.
3. Dispatch both `/mcp` and `/stream` to the same adapter without reading the request body first.
4. Remove `#handleStream`, `#openLegacySse`, `#handleLegacyMessage`, JSON-RPC helpers, heartbeat code, and `McpSessionRegistry`.
5. Delete `src/hub/McpSessionRegistry.ts`.
6. Add canonical status fields and remove `sseUrl` and `mcpSessions`.

Use this request-local hint helper; it must not mutate Hub state:

```typescript
function projectHintFromRequest(request?: Request): string | undefined {
  const fromHeader = request?.headers.get("x-breakpilot-project")?.trim();
  if (fromHeader) return fromHeader;
  const fromQuery = request ? new URL(request.url).searchParams.get("projectPath")?.trim() : undefined;
  return fromQuery || undefined;
}
```

Keep `BreakPilotHub.listTools()` and `callTool()` as compatibility methods that delegate to an unhinted `HubControlGateway`.

- [ ] **Step 6: Update the existing transport regression file**

In `test/hub-transports.test.ts`, preserve direct `/tools/list`, `/tools/call`, output-finalizer, archived-session, and ambiguity assertions. Replace its session-ID setup and every session header with a real legacy SDK client connected to `/stream`; replace the `/sse` success assertion with `404` assertions for `/sse` and `/message`.

- [ ] **Step 7: Run focused tests GREEN**

Run:

```bash
node --experimental-strip-types --test test/mcp-http-stateless.test.ts
node --experimental-strip-types test/hub-transports.test.ts
npm run typecheck
```

Expected: PASS; neither endpoint returns an MCP session header.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/hub/HubControlGateway.ts src/hub/HubServer.ts src/hub/McpSessionRegistry.ts test/mcp-http-stateless.test.ts test/hub-transports.test.ts
git commit -m "feat(http): serve MCP requests without transport sessions" -m "Mount the SDK v2 handler at /mcp and /stream, remove HTTP+SSE session state, and keep the shared control plane authoritative.\n\nTests: node --experimental-strip-types --test test/mcp-http-stateless.test.ts\nTests: node --experimental-strip-types test/hub-transports.test.ts\nTests: npm run typecheck"
```

### Task 3: Enforce request-local project routing and schema parity

**Files:**
- Modify: `src/hub/ProjectRuntimeRegistry.ts`
- Modify: `src/control/toolDefinitions.ts`
- Modify: `src/hub/HubControlGateway.ts`
- Create: `test/mcp-project-routing.test.ts`
- Modify: `test/tool-contract-boundaries.test.ts`

**Interfaces:**
- Consumes: `HubControlGateway` from Task 2.
- Produces: every public debugger tool accepts optional `workspace` as a project selector alongside `projectPath`.
- Produces: `resolveRuntime(args, requestProjectPath)` chooses the first nonblank selector in the global routing order.

- [ ] **Step 1: Write failing selector-order and concurrent-isolation tests**

Create two temporary project runtimes and replace only their real
`bpDebugStatus` handlers with complete contract-valid results carrying a
literal project-specific warning. Issue simultaneous MCP calls whose request
headers select different projects:

```typescript
const [a, b] = await Promise.all([
  callStatus(`${handle.url}/mcp`, { "x-breakpilot-project": projectA }),
  callStatus(`${handle.url}/mcp`, { "x-breakpilot-project": projectB })
]);
assert.deepEqual(a.structuredContent?.warnings, ["project-a"]);
assert.deepEqual(b.structuredContent?.warnings, ["project-b"]);
```

Add independent cases proving:

- the header wins over the query hint;
- `arguments.projectPath` wins over both request hints;
- a blank `arguments.projectPath` falls through to a nonblank `arguments.workspace`;
- a unique explicit BreakPilot `sessionId` selects its runtime when no path selector exists;
- list responses in two request scopes carry project-specific dynamic language enums without mutation leakage.

Expected values must be literal warnings/enums derived in the fixture, not generated by the code under test.

- [ ] **Step 2: Add a failing public-schema test for `workspace`**

In `test/tool-contract-boundaries.test.ts`, iterate all 15 definitions and assert that each input schema accepts a literal `{ workspace: "/tmp/project" }` in every branch where `{ projectPath: "/tmp/project" }` is currently accepted. Also call `bp_debug_status` with `workspace` and prove the handler is reached instead of returning `INVALID_ARGUMENT`.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --experimental-strip-types --test test/mcp-project-routing.test.ts test/tool-contract-boundaries.test.ts
```

Expected: FAIL because `workspace` is not advertised and empty `projectPath` currently masks it.

- [ ] **Step 4: Implement first-nonblank runtime selection**

Change `ProjectRuntimeRegistry.resolveRuntime()` from nullish selection to an explicit helper:

```typescript
function firstNonblank(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()));
}

const explicit = firstNonblank(args.projectPath, args.workspace, requestProjectPath);
if (explicit) return this.getOrCreate(explicit);
```

Keep the existing unique-session, default, and ambiguity branches unchanged.

- [ ] **Step 5: Advertise `workspace` without duplicating schema logic**

Add `const workspace: JsonSchema = { type: "string" };` beside `projectPath`.
Include it in the shared `routed` and `breakpointFields` objects and in the
three non-routed definitions (`bp_debug_start`, `bp_debug_run_configurations`,
and `bp_debug_status`). Do not rename or remove `projectPath`.

Refine `HubControlGateway` to use `firstNonblank` semantics for deciding
whether it must inject the canonical project path.

- [ ] **Step 6: Run focused tests GREEN**

Run:

```bash
node --experimental-strip-types --test test/mcp-project-routing.test.ts test/tool-contract-boundaries.test.ts
node --experimental-strip-types --test test/mcp-server-factory.test.ts test/mcp-http-stateless.test.ts
npm run typecheck
```

Expected: PASS with deterministic A/B routing under `Promise.all`.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/hub/ProjectRuntimeRegistry.ts src/control/toolDefinitions.ts src/hub/HubControlGateway.ts test/mcp-project-routing.test.ts test/tool-contract-boundaries.test.ts
git commit -m "fix(mcp): isolate project routing per request" -m "Honor projectPath, workspace, request hints, and explicit debug session routing without shared MCP transport state.\n\nTests: node --experimental-strip-types --test test/mcp-project-routing.test.ts test/tool-contract-boundaries.test.ts\nTests: npm run typecheck"
```

### Task 4: Add local-service security and correct Hub lifecycle accounting

**Files:**
- Modify: `src/hub/HubServer.ts`
- Create: `test/mcp-http-lifecycle.test.ts`
- Modify: `test/mcp-http-stateless.test.ts`

**Interfaces:**
- Consumes: the single `McpHttpHandler` and Node adapter from Task 2.
- Produces: `activeMcpRequests` as an observable status count.
- Produces: idempotent `BreakPilotHub.close()` that rejects new dispatch, closes MCP, waits accepted Node handlers, closes HTTP, then cleans runtimes/IDE state.
- Produces: loopback-only bind validation and official Node Host/Origin guards.

- [ ] **Step 1: Write failing Host, Origin, and bind-policy tests**

Add raw HTTP cases to `test/mcp-http-stateless.test.ts`:

```typescript
assert.equal((await fetch(`${handle.url}/mcp`, {
  method: "POST",
  headers: { host: "attacker.example", "content-type": "application/json" },
  body: legacyListBody
})).status, 403);

assert.equal((await fetch(`${handle.url}/mcp`, {
  method: "POST",
  headers: { origin: "https://attacker.example", "content-type": "application/json" },
  body: legacyListBody
})).status, 403);
```

Use `node:http.request` if `fetch` refuses a custom Host header. Also test
`Origin: null`, malformed Origin, and `new BreakPilotHub({ host: "0.0.0.0" }).start()` rejecting with an error that names loopback binding.

The production mutation caught is moving URL parsing or MCP dispatch before validation.

- [ ] **Step 2: Write failing active-request and shutdown-order tests**

Create `test/mcp-http-lifecycle.test.ts`. Use a deferred, contract-valid
`bpDebugStatus` handler to keep a real MCP tool request in flight.

```typescript
assert.equal(hub.status().activeMcpRequests, 1);
await delay(idleTimeoutMs * 2);
assert.equal(idleCalls, 0);
releaseStatus({ sessions: [], ideConnected: false });
await callPromise;
await waitUntil(() => idleCalls === 1);
```

Add a close-order case that starts a modern call, invokes `hub.close()`, and
proves `projects.cleanupAll()` is not entered until the accepted gateway call
has settled. The client may receive cancellation; the assertion is about the
Hub's cleanup ordering. Call `close()` twice and assert both promises settle.

Add an ordinary `tools/list` request case proving it also resets the idle deadline; this catches implementations that schedule idle only in `callTool()`.

- [ ] **Step 3: Run security/lifecycle tests and verify RED**

Run:

```bash
node --experimental-strip-types --test test/mcp-http-stateless.test.ts test/mcp-http-lifecycle.test.ts
```

Expected: FAIL because no official guards or active-request lifecycle exist.

- [ ] **Step 4: Enforce loopback and validate before routing**

Import `localhostHostValidation`, `localhostOriginValidation`, and
`toNodeHandler` from `@modelcontextprotocol/node`.

1. Reject hosts other than `127.0.0.1`, `localhost`, `::1`, and bracketed `::1` before calling `listen()`.
2. Construct the official Host and Origin guard functions once.
3. Run both guards at the beginning of the HTTP request callback, before `#pathname()`.
4. Parse paths against the fixed base `http://localhost`, never `req.headers.host`.
5. Render IPv6 host URLs with brackets in status/handle URLs.

- [ ] **Step 5: Track responses and logical handler dispatches**

Add:

```typescript
activeMcpRequests = 0;
private readonly mcpDispatches = new Set<Promise<void>>();
private closing = false;
private closePromise: Promise<void> | null = null;
```

When an MCP path is accepted, increment once and attach one idempotent callback
to both response `finish` and `close`. The callback decrements once and
reschedules idle. Separately add the promise returned by the Node adapter to
`mcpDispatches` and remove it in `finally`; this keeps logical tool work visible
even if a client closes its response early.

Idle checks must require `activeMcpRequests === 0`, no IDE clients, and no
active debug sessions. Remove every reference to MCP session pruning.

- [ ] **Step 6: Implement idempotent close ordering**

The one stored close promise performs:

```typescript
this.closing = true;
clearTimeout(this.idleTimer);
await this.mcpHandler.close();
await Promise.allSettled([...this.mcpDispatches]);
await closeNodeServer(this.server);
this.ideBridge.stop();
await this.projects.cleanupAll("hub_shutdown");
```

Ensure errors from one cleanup phase do not skip later phases, and new MCP
requests after `closing` receive `503` without entering the SDK handler.

- [ ] **Step 7: Run lifecycle and regression tests GREEN**

Run:

```bash
node --experimental-strip-types --test test/mcp-http-stateless.test.ts test/mcp-http-lifecycle.test.ts test/mcp-project-routing.test.ts
node --experimental-strip-types test/hub-transports.test.ts
npm run typecheck
```

Expected: PASS with no idle callback while a request is active and cleanup after the deferred call settles.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/hub/HubServer.ts test/mcp-http-lifecycle.test.ts test/mcp-http-stateless.test.ts
git commit -m "fix(http): secure and drain stateless MCP requests" -m "Validate local Host and Origin values, account for every MCP response, and close accepted work before runtime cleanup.\n\nTests: node --experimental-strip-types --test test/mcp-http-stateless.test.ts test/mcp-http-lifecycle.test.ts\nTests: npm run typecheck"
```

### Task 5: Migrate stdio and CLI cleanup to the shared SDK factory

**Files:**
- Modify: `src/mcp/stdioServer.ts`
- Modify: `src/cli/commands/mcp.ts`
- Create: `test/mcp-stdio-server.test.ts`
- Modify: `test/mcp-stdio-lifecycle.e2e.test.ts`

**Interfaces:**
- Consumes: `createBreakPilotMcpServer(gateway)` from Task 1.
- Produces: `startStdio(gateway: ControlGateway, options?: ServeStdioOptions): StdioServerHandle`.
- CLI cleanup closes the returned handle before closing an owned `HubServerHandle`.

- [ ] **Step 1: Write failing modern and legacy stdio tests**

Create `test/mcp-stdio-server.test.ts` using two real linked
`InMemoryTransport` pairs passed through `ServeStdioOptions.transport`.

For the first pair, connect a default SDK client and assert legacy list/call
behavior. For the second, connect a client with:

```typescript
{
  versionNegotiation: {
    mode: "auto",
    probe: { timeoutMs: 2_000, maxRetries: 0 }
  }
}
```

Assert `client.getProtocolEra() === "modern"`, exact schema availability, and
the same structured status result. Close each client and returned server
handle in `finally`.

The production mutation caught is keeping the hand-written 2025-only line parser.

- [ ] **Step 2: Strengthen the child-process lifecycle test**

In `test/mcp-stdio-lifecycle.e2e.test.ts`, keep the literal legacy initialize,
list, successful call, structured error, stdout cleanliness, and stdin-EOF exit
assertions. Make the initialize request complete with protocol version,
capabilities, and client info so the SDK accepts it for the intended reason.
Assert no protocol diagnostics appear on stdout.

- [ ] **Step 3: Run stdio tests and verify RED**

Run:

```bash
node --experimental-strip-types --test test/mcp-stdio-server.test.ts
node --experimental-strip-types test/mcp-stdio-lifecycle.e2e.test.ts
```

Expected: FAIL because `startStdio()` returns `void` and cannot negotiate the modern era.

- [ ] **Step 4: Replace the manual parser with `serveStdio`**

Reduce `src/mcp/stdioServer.ts` to the shared factory wrapper:

```typescript
import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { ControlGateway } from "../control/ControlGateway.ts";
import { createBreakPilotMcpServer } from "./serverFactory.ts";

export function startStdio(
  gateway: ControlGateway,
  options: ServeStdioOptions = {}
): StdioServerHandle {
  return serveStdio(
    () => createBreakPilotMcpServer(gateway),
    { ...options, legacy: "serve" }
  );
}
```

Do not write banners or logs to stdout.

- [ ] **Step 5: Close stdio before an owned Hub**

Capture the return value in `src/cli/commands/mcp.ts` and make the existing
one-shot cleanup callback perform:

```typescript
await stdio.close().catch(() => undefined);
if (hub.owned) await hub.handle?.close().catch(() => undefined);
```

Keep signal and EOF handling idempotent.

- [ ] **Step 6: Run stdio tests GREEN**

Run:

```bash
node --experimental-strip-types --test test/mcp-stdio-server.test.ts
node --experimental-strip-types test/mcp-stdio-lifecycle.e2e.test.ts
npm run typecheck
```

Expected: PASS for modern and legacy eras, and the spawned CLI exits after stdin EOF.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/mcp/stdioServer.ts src/cli/commands/mcp.ts test/mcp-stdio-server.test.ts test/mcp-stdio-lifecycle.e2e.test.ts
git commit -m "feat(mcp): negotiate both protocol eras over stdio" -m "Use the shared SDK v2 factory and close the stdio serving handle before an owned Hub.\n\nTests: node --experimental-strip-types --test test/mcp-stdio-server.test.ts\nTests: node --experimental-strip-types test/mcp-stdio-lifecycle.e2e.test.ts\nTests: npm run typecheck"
```

### Task 6: Publish migration guidance and run release verification

**Files:**
- Modify: `README.md`
- Modify: `docs/vibecoding-mcp.md`
- Modify: `agents/openai.yaml`
- Modify if required by assertions: `test/agent-documentation-contract.test.ts`

**Interfaces:**
- Documents `/mcp` as canonical and `/stream` as a stateless alias.
- Documents modern `2026-07-28`, default 2025-era compatibility, removal of `/sse`, and the separation between MCP transport state and BreakPilot debug `sessionId`.

- [ ] **Step 1: Update user and agent documentation**

Replace claims that the Hub exposes legacy SSE with these exact operational facts:

```text
MCP HTTP: http://127.0.0.1:57987/mcp
Compatibility alias: http://127.0.0.1:57987/stream
Transport mode: stateless for modern 2026-07-28 and compatible 2025-era clients
```

State that `/sse` and `/message` were removed. Explain that a
`bp_debug_*` tool's explicit `sessionId` continues a debugger workflow and is
not an MCP transport session. Keep `breakpilot mcp serve` as the recommended
stdio integration.

- [ ] **Step 2: Run documentation contract tests**

Run:

```bash
node --experimental-strip-types --test test/agent-documentation-contract.test.ts
```

Expected: PASS. If a documented endpoint assertion fails, update that test to
assert the new consumer-visible examples, not the source text of implementation
files.

- [ ] **Step 3: Run all focused MCP tests together**

Run:

```bash
node --experimental-strip-types --test test/mcp-server-factory.test.ts test/mcp-http-stateless.test.ts test/mcp-project-routing.test.ts test/mcp-http-lifecycle.test.ts test/mcp-stdio-server.test.ts
node --experimental-strip-types test/hub-transports.test.ts
node --experimental-strip-types test/mcp-stdio-lifecycle.e2e.test.ts
```

Expected: all focused tests pass with no leaked process or port.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all commands exit 0 and output contains no unexpected warnings or unhandled rejections.

- [ ] **Step 5: Audit the transport-state removal**

Run:

```bash
rg -n "McpSessionRegistry|mcpSessions|mcp-session-id|/sse|/message" src test README.md docs/vibecoding-mcp.md agents/openai.yaml
```

Expected: matches exist only in deliberate negative compatibility tests or migration prose; no runtime session registry, emitted session header, or active legacy route remains.

- [ ] **Step 6: Commit Task 6**

```bash
git add README.md docs/vibecoding-mcp.md agents/openai.yaml test/agent-documentation-contract.test.ts
git commit -m "docs(mcp): document stateless dual-era serving" -m "Make /mcp canonical, describe the /stream alias and debugger session boundary, and remove HTTP+SSE guidance.\n\nTests: npm test\nTests: npm run typecheck\nTests: npm run build"
```

Only add `test/agent-documentation-contract.test.ts` if it changed.

## Final Review Gate

After Task 6, generate one review package covering the implementation range
from design commit `b4bb208` to `HEAD`. Dispatch an independent reviewer with
the design spec, this plan, the SDD ledger, and the review package. A clean
review must explicitly confirm:

1. modern and legacy HTTP are both request-stateless;
2. no sessionful HTTP route or registry survives;
3. low-level handlers preserve BreakPilot input/output error contracts;
4. request hints cannot leak between concurrent projects;
5. Host/Origin, idle, close, and stdio lifecycle behavior is covered by real tests;
6. full test, typecheck, and build evidence is present.

If the reviewer finds Critical or Important issues, dispatch one fix agent for
the complete finding set, rerun the covering tests, and perform one scoped
re-review before claiming completion.
