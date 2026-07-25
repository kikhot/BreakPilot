# BreakPilot Control Runtime Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every public debugger response schema-true at runtime and give every managed debug session a bounded, cursor-addressable stream of truthful runtime events.

**Architecture:** Reuse the existing JSON-schema evaluator in two explicit modes: input mode clones and applies defaults, while output mode only inspects the handler's original value. Route every known tool result through a fail-closed `ToolResponseFinalizer`, then attach one `RuntimeEventBuffer` to each managed session so control waits and event reads observe the same ordered facts without consuming one another.

**Tech Stack:** TypeScript 5.9, Node.js >=22.6 strip-types tests, existing MCP/HTTP/CLI transports, built-in `node:assert/strict`.

## Global Constraints

- Keep all 15 public `bp_debug_*` names and their existing compact top-level response shape.
- Do not add a JSON Schema package; validate only the `JsonSchema` vocabulary already published in `src/types/control.ts`.
- Input validation may clone and apply schema defaults; output validation must not mutate, clone, coerce, add defaults, drop fields, or log runtime values.
- `OUTPUT_CONTRACT_VIOLATION` must fail closed: read-only calls use `outcome:"failed"` and `retrySafe:true`; control or mutation calls use `outcome:"indeterminate"` and `retrySafe:false`.
- Preserve legacy `events.breakpointErrors` and `events.tracepoints` while adding ordered cursor data.
- The per-session event capacity defaults to exactly 256 and can only be lowered by configuration, never increased by a tool request.
- Existing stop waiters must continue to work after event buffering; event draining may not remove a stop from a waiter.
- Use Conventional Commits in the form `<type>(<scope>): <summary>` and do not stage unrelated user changes.

---

## File Structure

- Create `src/control/ToolResponseFinalizer.ts`: output-only schema validation, trusted fallback construction, and audit-safe issue summaries.
- Modify `src/control/ToolInputValidator.ts`: expose `validateToolOutput` beside the existing input normalizer without changing input behavior.
- Modify `src/control/ToolRouter.ts`: classify each public operation and finalize handler and caught-error results.
- Modify `src/utils/errors.ts`: add stable output-contract and runtime-event error codes.
- Modify `src/http/controlServer.ts`, `src/hub/HubServer.ts`, `src/mcp/stdioServer.ts`, and `src/control/ControlGateway.ts`: preserve structured failures and map output-contract failures correctly in each transport.
- Create `src/runtime/RuntimeEventBuffer.ts`: bounded per-session ordered buffer with replay and atomic default-consumer cursor reads.
- Modify `src/types/sessions.ts`: define normalized event, event page, and cursor input types; make `drainEvents` accept a cursor page request.
- Modify `src/types/policy.ts`, `src/security/PolicyLoader.ts`, and `breakpilot.yaml`: add a policy-bounded `runtime.maxEventBuffer` setting whose default is 256 and whose runtime caller cannot raise it.
- Modify `src/sessions/DebugSessionManager.ts`: own one buffer per session and expose cursor-based `drainEvents` through `bp_debug_control`.
- Modify `src/dap/DapSession.ts` and `src/runtime/providers/DapRuntimeProvider.ts`: publish generic DAP events into the manager-owned buffer without changing stop waiter semantics.
- Modify `src/control/toolDefinitions.ts`, `src/control/toolOutputSchemas.ts`, and `src/control/schemaFragments.ts`: accept drain cursor/limit and describe the expanded event response exactly.
- Create `test/tool-output-validation.test.ts`, `test/runtime-event-buffer.test.ts`, and `test/dap-runtime-events.test.ts`.
- Modify `test/hub-transports.test.ts`, `test/tool-input-validation.test.ts`, `test/operation-capability-gates.test.ts`, and `test/debugger-mcp-contracts.test.ts`.

## Interfaces Established By This Plan

```ts
export interface ToolValidationResult {
  value: AnyRecord;
  errors: ToolValidationIssue[];
}

export function validateToolInput(schema: JsonSchema, value: unknown): ToolValidationResult;
export function validateToolOutput(schema: JsonSchema, value: unknown): ToolValidationResult;

export type ToolOperationKind = "read" | "control" | "mutation";

export class ToolResponseFinalizer {
  finalize(
    definition: ToolDefinition,
    candidate: ToolResponse,
    operation: ToolOperationKind
  ): ToolResponse;
}

export type RuntimeEventKind =
  | "breakpoint" | "breakpointError" | "tracepoint" | "output"
  | "stopped" | "continued" | "thread" | "process"
  | "invalidated" | "terminated";

export interface RuntimeEvent extends AnyRecord {
  sequence: number;
  timestamp: string;
  kind: RuntimeEventKind;
  sessionId: string;
  breakpointId?: string;
  threadId?: ThreadId;
  position?: AnyRecord;
  message?: string;
  category?: string;
  data?: AnyRecord;
}

export interface RuntimeEventPage {
  items: RuntimeEvent[];
  cursor: number;
  nextCursor: number;
  oldestCursor: number;
  hasMore: boolean;
  overflowed: boolean;
  droppedCount: number;
  supportedKinds: RuntimeEventKind[];
  breakpointErrors: AnyRecord[];
  tracepoints: AnyRecord[];
}

export class RuntimeEventBuffer {
  constructor(sessionId: string, capacity?: number);
  append(event: Omit<RuntimeEvent, "sequence" | "timestamp" | "sessionId">): RuntimeEvent;
  read(args?: { cursor?: number; limit?: number }): RuntimeEventPage;
}
```

### Task 1: Separate Non-Mutating Output Validation From Input Normalization

**Files:**
- Modify: `src/control/ToolInputValidator.ts`
- Modify: `src/types/control.ts`
- Create: `test/tool-output-validation.test.ts`

**Interfaces:**
- Consumes: `JsonSchema`, `ToolValidationIssue`, and the existing `validateToolInput` behavior.
- Produces: `validateToolOutput(schema, value)`, which reports validation issues but returns the exact original object when it is valid.

- [ ] **Step 1: Write the failing output-validation tests**

Create `test/tool-output-validation.test.ts` with these executable assertions:

```ts
import assert from "node:assert/strict";
import { validateToolInput, validateToolOutput } from "../src/control/ToolInputValidator.ts";
import type { JsonSchema } from "../src/types/control.ts";

const schema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { required: { type: "string" }, optional: { type: "string", default: "added" } },
  required: ["required"]
};
const candidate = { required: "present" };
assert.deepEqual(validateToolInput(schema, candidate).value, { required: "present", optional: "added" });
const output = validateToolOutput(schema, candidate);
assert.equal(output.value, candidate, "output validation returns the original object");
assert.deepEqual(candidate, { required: "present" }, "output validation never applies defaults");
assert.deepEqual(output.errors, []);
assert.equal(validateToolOutput(schema, {}).errors[0]?.path, "$.required");
assert.equal(validateToolOutput(schema, { required: "ok", extra: true }).errors[0]?.keyword, "additionalProperties");
console.log("tool output validation tests ok");
```

- [ ] **Step 2: Run the new test and verify red**

Run:

```bash
node --experimental-strip-types test/tool-output-validation.test.ts
```

Expected: FAIL because `validateToolOutput` is not exported.

- [ ] **Step 3: Implement output-only validation**

In `src/control/ToolInputValidator.ts`, retain the existing clone/default path for inputs and export a separate output path that invokes the same recursive schema checks with defaults disabled:

```ts
export function validateToolOutput(schema: JsonSchema, value: unknown): ToolValidationResult {
  const compatibilityError = preflightCloneSafety(value);
  if (compatibilityError) return { value: {} as AnyRecord, errors: [compatibilityError] };
  const errors = validateNode(schema, value, "$", { applyDefaults: false, clone: false });
  return {
    value: isRecord(value) ? value : ({} as AnyRecord),
    errors
  };
}
```

Refactor the current validator's internal call shape so `validateNode` receives `{ applyDefaults, clone }`. In output mode it must inspect own data properties only, reject accessors/non-JSON values/cycles with the existing JSON-compatibility issue, and never call `structuredClone` or `setOwn`.

- [ ] **Step 4: Run focused validation regressions**

Run:

```bash
node --experimental-strip-types test/tool-output-validation.test.ts
node --experimental-strip-types test/tool-input-validation.test.ts
```

Expected: both PASS; the input test still sees defaults, the output test sees no default injection.

- [ ] **Step 5: Commit the validator boundary**

```bash
git add src/control/ToolInputValidator.ts src/types/control.ts test/tool-output-validation.test.ts
git commit -m "feat(control): validate tool outputs without mutation"
```

### Task 2: Fail Closed At The Shared Tool Router And Transport Boundaries

**Files:**
- Create: `src/control/ToolResponseFinalizer.ts`
- Modify: `src/control/ToolRouter.ts`
- Modify: `src/utils/errors.ts`
- Modify: `src/http/controlServer.ts`
- Modify: `src/hub/HubServer.ts`
- Modify: `src/mcp/stdioServer.ts`
- Modify: `src/control/ControlGateway.ts`
- Modify: `test/tool-output-validation.test.ts`
- Modify: `test/hub-transports.test.ts`

**Interfaces:**
- Consumes: a known `ToolDefinition.outputSchema`, a `ToolResponse`, and `ToolOperationKind`.
- Produces: a schema-valid response or an `OUTPUT_CONTRACT_VIOLATION` error payload with only tool name, issue paths, keywords, issue count, outcome, and retry safety.

- [ ] **Step 1: Add failing finalizer and transport tests**

Append to `test/tool-output-validation.test.ts`:

```ts
const router = createRouterWithHandler("bp_debug_set_value", async () => ({ applied: "yes" }));
const response = await router.callTool("bp_debug_set_value", { path: ["x"], newValue: "1" });
assert.equal(response.error?.code, "OUTPUT_CONTRACT_VIOLATION");
assert.equal((response.error?.details as Record<string, unknown>).outcome, "indeterminate");
assert.equal((response.error?.details as Record<string, unknown>).retrySafe, false);
assert.equal(JSON.stringify(response), JSON.stringify({
  error: {
    code: "OUTPUT_CONTRACT_VIOLATION",
    message: "Debugger tool returned a result that violates its published contract.",
    details: {
      tool: "bp_debug_set_value",
      issues: [{ path: "$.applied", keyword: "type" }],
      issueCount: 1,
      outcome: "indeterminate",
      retrySafe: false
    }
  }
}));
```

Add a `HubServer` test using a malformed `bp_debug_status` success and assert its structured error survives MCP and HTTP routing, while the HTTP response status is `500`.

- [ ] **Step 2: Run the focused tests and verify red**

Run:

```bash
node --experimental-strip-types test/tool-output-validation.test.ts
node --experimental-strip-types test/hub-transports.test.ts
```

Expected: FAIL because malformed handler results currently pass through unchanged and HTTP does not recognize the code.

- [ ] **Step 3: Add the finalizer and router classification**

Create `src/control/ToolResponseFinalizer.ts`:

```ts
const mutationTools = new Set([
  "bp_debug_start", "bp_debug_control", "bp_debug_run_to_line",
  "bp_debug_set_value", "bp_debug_eval", "bp_debug_set_breakpoint", "bp_debug_remove_breakpoint"
]);

export function operationKindForTool(name: string): ToolOperationKind {
  return mutationTools.has(name) ? "mutation" : "read";
}

export class ToolResponseFinalizer {
  constructor(private readonly audit: AuditLogger) {}

  finalize(definition: ToolDefinition, candidate: ToolResponse, operation: ToolOperationKind): ToolResponse {
    const result = validateToolOutput(definition.outputSchema!, candidate);
    if (result.errors.length === 0) return candidate;
    const indeterminate = operation !== "read";
    const issues = result.errors.map(({ path, keyword }) => ({ path, keyword }));
    const auditId = this.audit.record("tool_output_contract_violation", {
      tool: definition.name, issueCount: issues.length, issues
    });
    return fail(new BreakPilotError(ErrorCodes.OUTPUT_CONTRACT_VIOLATION,
      "Debugger tool returned a result that violates its published contract.", {
        tool: definition.name, issues, issueCount: issues.length,
        outcome: indeterminate ? "indeterminate" : "failed",
        retrySafe: !indeterminate
      }), auditId);
  }
}
```

In `ToolRouter.callTool`, create one `ToolResponseFinalizer`, pass the normal handler result through it, and pass the `fail(...)` value from the `catch` through it too. Keep unknown-tool handling separate because no `ToolDefinition` exists. Add `OUTPUT_CONTRACT_VIOLATION` to `ErrorCodes`; map it to HTTP `500`, MCP `isError:true`, and CLI non-zero using their existing error result paths. Never put the invalid candidate payload in an audit record.

- [ ] **Step 4: Run output and transport tests**

Run:

```bash
node --experimental-strip-types test/tool-output-validation.test.ts
node --experimental-strip-types test/hub-transports.test.ts
npm run typecheck
```

Expected: PASS; a malformed tool output is replaced once with the precise structured error on every transport.

- [ ] **Step 5: Commit response finalization**

```bash
git add src/control/ToolResponseFinalizer.ts src/control/ToolRouter.ts src/utils/errors.ts src/http/controlServer.ts src/hub/HubServer.ts src/mcp/stdioServer.ts src/control/ControlGateway.ts test/tool-output-validation.test.ts test/hub-transports.test.ts
git commit -m "feat(control): fail closed on invalid tool outputs"
```

### Task 3: Build A Bounded Cursor-Based Runtime Event Buffer

**Files:**
- Create: `src/runtime/RuntimeEventBuffer.ts`
- Modify: `src/types/sessions.ts`
- Modify: `src/types/policy.ts`
- Modify: `src/security/PolicyLoader.ts`
- Modify: `breakpilot.yaml`
- Create: `test/runtime-event-buffer.test.ts`

**Interfaces:**
- Consumes: `RuntimeEvent` content without sequence/timestamp/session identity.
- Produces: monotonically sequenced event pages with retained-range overflow metadata and an atomic default consumer cursor.

- [ ] **Step 1: Write the failing ring-buffer tests**

Create `test/runtime-event-buffer.test.ts`:

```ts
import assert from "node:assert/strict";
import { RuntimeEventBuffer } from "../src/runtime/RuntimeEventBuffer.ts";

const events = new RuntimeEventBuffer("debug-1", 2);
events.append({ kind: "continued" });
events.append({ kind: "stopped", threadId: 7 });
assert.deepEqual(events.read({ cursor: 0, limit: 1 }).items.map((item) => item.sequence), [1]);
assert.deepEqual(events.read({ cursor: 0, limit: 8 }).items.map((item) => item.kind), ["continued", "stopped"]);
assert.deepEqual(events.read().items.map((item) => item.sequence), [1, 2]);
assert.deepEqual(events.read().items, [], "default cursor advances atomically");
events.append({ kind: "output", message: "hello" });
const overflow = events.read({ cursor: 0, limit: 8 });
assert.equal(overflow.overflowed, true);
assert.equal(overflow.droppedCount, 1);
assert.equal(overflow.oldestCursor, 2);
assert.deepEqual(overflow.items.map((item) => item.sequence), [2, 3]);
assert.equal(overflow.items[0]?.sessionId, "debug-1");
console.log("runtime event buffer tests ok");
```

- [ ] **Step 2: Run the new buffer test and verify red**

Run:

```bash
node --experimental-strip-types test/runtime-event-buffer.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement exact ring semantics**

Create `src/runtime/RuntimeEventBuffer.ts` with a private `events: RuntimeEvent[]`, `nextSequence = 1`, and `defaultCursor = 0`. `append` creates `timestamp: new Date().toISOString()` and evicts the oldest element after the configured capacity. `read` must:

```ts
const requestedCursor = args?.cursor ?? this.defaultCursor;
const oldestCursor = this.events[0]?.sequence ?? this.nextSequence;
const overflowed = requestedCursor < oldestCursor - 1;
const effectiveCursor = overflowed ? oldestCursor - 1 : requestedCursor;
const items = this.events.filter((event) => event.sequence > effectiveCursor).slice(0, limit);
const nextCursor = items.at(-1)?.sequence ?? effectiveCursor;
if (args?.cursor === undefined) this.defaultCursor = nextCursor;
return {
  items, cursor: requestedCursor, nextCursor, oldestCursor, hasMore, overflowed, droppedCount,
  supportedKinds: runtimeEventKinds,
  breakpointErrors: items.filter((item) => item.kind === "breakpointError"),
  tracepoints: items.filter((item) => item.kind === "tracepoint")
};
```

Set `limit` to `50` when omitted, clamp it to `1..256`, and compute `droppedCount` as `Math.max(0, oldestCursor - 1 - requestedCursor)`. Add `RuntimeEvent`, `RuntimeEventKind`, `RuntimeEventPage`, and `DrainEventsArgs` to `src/types/sessions.ts`; change `DebugEventBuffer` into a compatibility projection rather than the buffer's internal representation. Add `runtime.maxEventBuffer` to the policy type, loader, and sample YAML with default `256`; `RuntimeEventBuffer` receives `Math.min(policy.runtime.maxEventBuffer, 256)` so no tool call can enlarge retention.

- [ ] **Step 4: Run buffer tests and typecheck**

Run:

```bash
node --experimental-strip-types test/runtime-event-buffer.test.ts
npm run typecheck
```

Expected: PASS; no page can report an event outside its session or fabricate a gap-free history after eviction.

- [ ] **Step 5: Commit the buffer primitive**

```bash
git add src/runtime/RuntimeEventBuffer.ts src/types/sessions.ts src/types/policy.ts src/security/PolicyLoader.ts breakpilot.yaml test/runtime-event-buffer.test.ts
git commit -m "feat(runtime): add bounded debugger event buffer"
```

### Task 4: Publish DAP And Manager Events Without Stealing Stops

**Files:**
- Modify: `src/dap/DapSession.ts`
- Modify: `src/runtime/providers/DapRuntimeProvider.ts`
- Modify: `src/sessions/DebugSessionManager.ts`
- Create: `test/dap-runtime-events.test.ts`
- Modify: `test/operation-capability-gates.test.ts`

**Interfaces:**
- Consumes: DAP client's generic `event` notifications and a session-owned `RuntimeEventBuffer`.
- Produces: normalized DAP `continued`, `stopped`, `output`, `thread`, `process`, and `terminated` events while preserving `waitForBreakpoint` delivery.

- [ ] **Step 1: Write the failing DAP event tests**

Create `test/dap-runtime-events.test.ts` with a fake DAP client that emits one `continued`, one `stopped`, and one `output` event:

```ts
const provider = await createProviderWithDapEvents([
  { event: "continued", body: { threadId: 2 } },
  { event: "stopped", body: { reason: "breakpoint", threadId: 2 } },
  { event: "output", body: { category: "stdout", output: "ready\\n" } }
]);
const stop = await provider.waitForBreakpoint(100);
assert.equal(stop.threadId, 2);
const page = await provider.drainEvents?.({ cursor: 0, limit: 8 });
assert.deepEqual(page?.items.map((event) => event.kind), ["continued", "stopped", "output"]);
assert.equal(page?.items[1]?.threadId, 2);
```

Extend `test/operation-capability-gates.test.ts` to assert DAP `eventDrain` becomes `"native"` only after a live event source is attached, and remains `"unsupported"` for a provider without it.

- [ ] **Step 2: Run the new DAP event tests and verify red**

Run:

```bash
node --experimental-strip-types test/dap-runtime-events.test.ts
node --experimental-strip-types test/operation-capability-gates.test.ts
```

Expected: FAIL because DAP events are not normalized and `drainEvents` has no cursor signature.

- [ ] **Step 3: Add event publication at the DAP session boundary**

In `DapSession`, add a subscribe-only event callback rather than changing the stopped queue:

```ts
onRuntimeEvent(listener: (event: DapProtocolEvent) => void): () => void {
  this.runtimeEventListeners.add(listener);
  return () => this.runtimeEventListeners.delete(listener);
}
```

Call listeners for every generic DAP event before the existing stopped-event queue logic. In `DapRuntimeProvider`, inject or create the session buffer, map known event names to `RuntimeEventKind`, and append only JSON-safe normalized fields. Keep `waitForBreakpoint` bound to the existing stopped queue. Implement `drainEvents(args)` as `return this.events.read(args)`.

In `DebugSessionManager`, create a `RuntimeEventBuffer(sessionId)` when each record is created, wire it into DAP providers, expose a session-local append/read path for the IDE bridge plan, and never share it across records. The IDE bridge's `ide_debug_event` listener is implemented by `2026-07-25-breakpilot-ide-runtime-fidelity.md`; do not advertise `eventDrain:"native"` until the provider has a functioning event source.

- [ ] **Step 4: Run DAP regression tests**

Run:

```bash
node --experimental-strip-types test/dap-runtime-events.test.ts
node --experimental-strip-types test/operation-capability-gates.test.ts
npm test
```

Expected: PASS; draining the event page leaves the same stopped event available to the waiter.

- [ ] **Step 5: Commit DAP event ingestion**

```bash
git add src/dap/DapSession.ts src/runtime/providers/DapRuntimeProvider.ts src/sessions/DebugSessionManager.ts test/dap-runtime-events.test.ts test/operation-capability-gates.test.ts
git commit -m "feat(dap): publish ordered runtime events"
```

### Task 5: Expose Cursor Event Draining Through The Existing Public Tool

**Files:**
- Modify: `src/control/toolDefinitions.ts`
- Modify: `src/control/schemaFragments.ts`
- Modify: `src/control/toolOutputSchemas.ts`
- Modify: `src/sessions/DebugSessionManager.ts`
- Modify: `test/debugger-mcp-contracts.test.ts`
- Modify: `test/hub-transports.test.ts`

**Interfaces:**
- Consumes: `bp_debug_control({ action:"drainEvents", cursor?, limit? })` and provider `RuntimeEventPage`.
- Produces: the existing `events` object extended with `items`, `cursor`, `nextCursor`, `oldestCursor`, `hasMore`, `overflowed`, `droppedCount`, `supportedKinds`, and legacy projections.

- [ ] **Step 1: Write the failing public-contract test**

Add to `test/debugger-mcp-contracts.test.ts`:

```ts
const control = tool("bp_debug_control");
const drainBranch = (control.inputSchema.oneOf as AnyRecord[]).find(
  (branch) => branch.properties?.action?.enum?.includes("drainEvents")
);
assert.deepEqual(drainBranch?.properties?.cursor?.type, "integer");
assert.deepEqual(drainBranch?.properties?.limit?.maximum, 256);
const serialized = JSON.stringify(control.outputSchema);
for (const field of ["items", "nextCursor", "oldestCursor", "overflowed", "droppedCount"]) {
  assert.match(serialized, new RegExp(field));
}
```

Add a manager fixture in `test/hub-transports.test.ts` that returns an overflow page and assert the tool response is successful, has `events.overflowed === true`, and includes the retained page rather than an error.

- [ ] **Step 2: Run public-contract tests and verify red**

Run:

```bash
node --experimental-strip-types test/debugger-mcp-contracts.test.ts
node --experimental-strip-types test/hub-transports.test.ts
```

Expected: FAIL because the drain action has no cursor schema and the output lacks the event page fields.

- [ ] **Step 3: Implement the drain action schema and compatibility projection**

Add a dedicated `drainEvents` input branch requiring `action` and allowing:

```ts
properties: {
  action: { type: "string", enum: ["drainEvents"] },
  cursor: { type: "integer", minimum: 0 },
  limit: { type: "integer", minimum: 1, maximum: 256 },
  sessionId: { type: "string" }
}
```

In `DebugSessionManager.bpDebugControl`, call `provider.drainEvents({ cursor, limit })`, then return:

```ts
events: {
  ...page,
  supportedKinds: runtimeEventKinds,
  breakpointErrors: page.items.filter((item) => item.kind === "breakpointError"),
  tracepoints: page.items.filter((item) => item.kind === "tracepoint")
}
```

Update the exact output schema to require all cursor fields and allow only documented event subfields. A provider lacking the live event capability still returns `UNSUPPORTED_CAPABILITY`; it must not return an empty event list as a fabricated implementation.

- [ ] **Step 4: Run the full control-plane regression suite**

Run:

```bash
node --experimental-strip-types test/debugger-mcp-contracts.test.ts
node --experimental-strip-types test/hub-transports.test.ts
npm test
npm run typecheck
```

Expected: PASS; agents can replay from an explicit cursor and recover from capacity loss in one response.

- [ ] **Step 5: Commit the public event-drain contract**

```bash
git add src/control/toolDefinitions.ts src/control/schemaFragments.ts src/control/toolOutputSchemas.ts src/sessions/DebugSessionManager.ts test/debugger-mcp-contracts.test.ts test/hub-transports.test.ts
git commit -m "feat(control): expose cursor based event draining"
```

## Final Verification

- [ ] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Verify every malformed output test reaches the fallback without the original malformed variable payload appearing in audit fixtures.
- [ ] Verify a DAP stop is independently observable through both `waitForBreakpoint` and `drainEvents`.
- [ ] Inspect `git status --short` and `git diff --cached --stat` before every commit; leave unrelated changes unstaged.
