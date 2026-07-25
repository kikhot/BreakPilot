# BreakPilot Breakpoint And DAP Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing breakpoint-update contract and DAP run-to-line capability into evidence-backed operations that preserve user breakpoints, reject stale stops, and expose safe rollback or cleanup state to agents.

**Architecture:** Keep `DebugSessionManager` as the public orchestration facade but move desired/applied breakpoint transitions into a deterministic `BreakpointReconciler`. Extend `DapSession` with monotonic stop boundaries and standard `gotoTargets`/`goto` primitives; `DapRuntimeProvider` chooses native goto when available and otherwise executes a transactionally restored temporary-breakpoint fallback.

**Tech Stack:** TypeScript 5.9, Node.js >=22.6 strip-types tests, Debug Adapter Protocol, existing BreakPilot session and breakpoint stores.

## Global Constraints

- Preserve the single public `bp_debug_set_breakpoint` tool for both create and update; do not create a parallel update tool.
- `owner` in an update request is an authorization filter, never an instruction to change owner.
- Omitted patch properties remain unchanged; only `condition`, `hitCondition`, `logMessage`, and `column` may be cleared with `null`.
- A patch with a new `filePath` requires a `line`; a patch with only `line` moves within the current file.
- Lock every affected source path in lexicographic order before a multi-source transaction; DAP `setBreakpoints` must receive every desired breakpoint for that source, including user-owned ones.
- Commit desired local breakpoint state only after positive provider evidence; prove rollback or report `outcome:"indeterminate"`, `retrySafe:false`, and affected IDs.
- Run-to-line must ignore a stopped event observed before its command boundary, must never auto-resume after an unrelated stop, and must clean temporary breakpoints in `finally`.
- Advertise `runToLine:"native"` only for live DAP `supportsGotoTargetsRequest`; advertise `"fallback"` only after the temporary-breakpoint path exists; advertise `breakpointUpdate:"fallback"` for source-level DAP reconciliation.
- Validate workspace paths before `goto`, `setBreakpoints`, or provider mutation.
- All response fields added here must be added to exact output schemas before the output-finalizer plan is enabled for the changed tool.
- Use Conventional Commits in the form `<type>(<scope>): <summary>` and do not stage unrelated user changes.

---

## File Structure

- Create `src/sessions/BreakpointReconciler.ts`: patch normalization, owner authorization, source locks, provider apply, commit, and rollback.
- Modify `src/sessions/BreakpointManager.ts`: read/clone/replace source state without premature mutation.
- Modify `src/sessions/DebugSessionManager.ts`: dispatch true update operations, create the reconciler, and validate run-to-line targets/state.
- Modify `src/types/sessions.ts`: add patch/update results, fresh-stop/run-to-line evidence, and provider reconciliation hooks.
- Modify `src/control/toolDefinitions.ts`: split closed create and patch branches without default leakage.
- Modify `src/control/schemaFragments.ts` and `src/control/toolOutputSchemas.ts`: describe update/relocation and extended run-to-line evidence.
- Modify `src/dap/DapSession.ts`: capture stop boundaries, wait for a fresh stop/termination, and wrap `gotoTargets`/`goto` requests.
- Modify `src/dap/DapClient.ts` and `src/types/dap.ts` only as needed to type DAP `gotoTargets`, `goto`, and termination events.
- Modify `src/runtime/providers/DapRuntimeProvider.ts`: native goto and temporary-breakpoint fallback implementation.
- Modify `src/runtime/ProviderCapabilities.ts`: derive DAP update/run-to-line truth from live adapter capabilities.
- Create `test/breakpoint-reconciler.test.ts` and `test/dap-run-to-line.test.ts`.
- Modify `test/tool-contract-boundaries.test.ts`, `test/tool-input-validation.test.ts`, `test/project-breakpoints.test.ts`, `test/provider-capabilities.test.ts`, `test/operation-capability-gates.test.ts`, `test/debugger-mcp-contracts.test.ts`, and the existing DAP session tests.

## Interfaces Established By This Plan

```ts
export interface BreakpointPatchRequest {
  breakpointId: string;
  filePath?: string;
  line?: number;
  column?: number | null;
  condition?: string | null;
  hitCondition?: string | null;
  logMessage?: string | null;
  enabled?: boolean;
  owner?: "agent" | "user" | "all";
  requireVerified?: boolean;
}

export interface BreakpointUpdateResult {
  operation: "updated" | "relocated";
  breakpointId: string;
  previous: BreakpointRecord;
  current: BreakpointRecord;
  changedFields: string[];
  verified: boolean;
  rollbackApplied?: boolean;
  warnings?: string[];
}

export interface ReconciliationFailureDetails {
  outcome: "indeterminate";
  retrySafe: false;
  rollbackApplied: boolean;
  affectedIds: string[];
  recommendedAction: string;
}

export interface FreshStopBoundary {
  stopSequence: number;
}

export interface RunToLineResult {
  status: "paused" | "stopped" | "timeout";
  targetReached: boolean;
  requestedPosition: { filePath: string; line: number; column?: number };
  resolvedPosition?: AnyRecord;
  position?: AnyRecord;
  frame?: AnyRecord;
  variables?: AnyRecord[];
  temporaryBreakpointId?: string;
  cleanedUp: boolean;
  cleanupRequired?: boolean;
  message?: string;
  warnings?: string[];
}

export class BreakpointReconciler {
  update(session: DebugSessionRecord, patch: BreakpointPatchRequest): Promise<BreakpointUpdateResult>;
  withTemporaryBreakpoint<T>(
    session: DebugSessionRecord,
    target: BreakpointInput,
    action: (temporary: BreakpointRecord, boundary: FreshStopBoundary) => Promise<T>
  ): Promise<T>;
}

export interface DapSession {
  captureStopBoundary(): FreshStopBoundary;
  waitForStopOrTerminationAfter(boundary: FreshStopBoundary, timeoutMs: number): Promise<StoppedEvent | { terminated: true }>;
  gotoTargets(filePath: string, line: number, column?: number): Promise<DapGotoTarget[]>;
  goto(threadId: number, targetId: number): Promise<void>;
}
```

### Task 1: Freeze Patch Semantics At The Tool Boundary

**Files:**
- Modify: `src/control/toolDefinitions.ts`
- Modify: `src/control/schemaFragments.ts`
- Modify: `test/tool-contract-boundaries.test.ts`
- Modify: `test/tool-input-validation.test.ts`

**Interfaces:**
- Consumes: `bp_debug_set_breakpoint` arguments and the existing input validator, whose only conditional composition primitive is `oneOf`.
- Produces: four closed patch shapes that cannot inject create defaults or accept a relocation without its line.

- [ ] **Step 1: Write failing patch-boundary tests**

Add these tests to `test/tool-contract-boundaries.test.ts`:

```ts
const update = await router.callTool("bp_debug_set_breakpoint", { breakpointId: "bp-1", condition: null });
assert.equal(capturedArgs.condition, null);
assert.equal("enabled" in capturedArgs, false, "update branch receives no create default");
assert.equal("owner" in capturedArgs, false, "owner is not silently reassigned");

const badRelocation = await router.callTool("bp_debug_set_breakpoint", {
  breakpointId: "bp-1", filePath: "/workspace/Foo.java"
});
assert.equal(badRelocation.error?.code, "INVALID_ARGUMENT");

const sameFileMove = await router.callTool("bp_debug_set_breakpoint", { breakpointId: "bp-1", line: 17 });
assert.equal(capturedArgs.line, 17);
```

Add rejection coverage for `column:null`, `condition:null`, `hitCondition:null`, and `logMessage:null` (allowed), and `line:null`/`enabled:null`/unknown patch fields (rejected).

- [ ] **Step 2: Run the focused boundary tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/tool-contract-boundaries.test.ts test/tool-input-validation.test.ts
```

Expected: FAIL because the current `breakpointId` branch reuses defaulted create properties and manager rejects it as unsupported.

- [ ] **Step 3: Define closed create and patch schemas**

In `src/control/toolDefinitions.ts`, create a default-free `breakpointPatchProperties` object and compose exactly these closed `oneOf` branches:

```ts
const patchById: JsonSchema = {
  type: "object", additionalProperties: false,
  properties: { sessionId, breakpointId, condition, hitCondition, logMessage, column, enabled, owner, requireVerified },
  required: ["breakpointId"]
};
const patchWithinSource: JsonSchema = {
  ...patchById,
  properties: { ...patchById.properties, line },
  required: ["breakpointId", "line"]
};
const patchAcrossSource: JsonSchema = {
  ...patchById,
  properties: { ...patchById.properties, filePath, line },
  required: ["breakpointId", "filePath", "line"]
};
```

Add a fourth explicit branch for legacy `file` alias plus `line`, rejecting simultaneous `file` and `filePath`. Keep create shapes separate and retain their current defaults. Do not use unsupported `if`/`then` JSON Schema keywords.

- [ ] **Step 4: Run tool-boundary tests**

Run:

```bash
node --experimental-strip-types --test test/tool-contract-boundaries.test.ts test/tool-input-validation.test.ts
npm run typecheck
```

Expected: PASS; a patch has no hidden defaults and every relocation request has an unambiguous source and line.

- [ ] **Step 5: Commit patch input semantics**

```bash
git add src/control/toolDefinitions.ts src/control/schemaFragments.ts test/tool-contract-boundaries.test.ts test/tool-input-validation.test.ts
git commit -m "feat(control): define breakpoint patch arguments"
```

### Task 2: Add Transactional Desired/Applied Breakpoint Reconciliation

**Files:**
- Create: `src/sessions/BreakpointReconciler.ts`
- Modify: `src/sessions/BreakpointManager.ts`
- Modify: `src/types/sessions.ts`
- Create: `test/breakpoint-reconciler.test.ts`

**Interfaces:**
- Consumes: a selected session, a default-agent authorization policy, `BreakpointManager` source snapshots, and `RuntimeDebugProvider.setBreakpoints(filePath, records)`.
- Produces: a committed `BreakpointUpdateResult`, or a structured `BREAKPOINT_UPDATE_FAILED`/`BREAKPOINT_ROLLBACK_FAILED` error containing recovery facts.

- [ ] **Step 1: Write failing reconciliation tests**

Create `test/breakpoint-reconciler.test.ts` with fake providers recording every source list:

```ts
const result = await reconciler.update(session, { breakpointId: "agent-a", line: 12 });
assert.equal(result.operation, "relocated");
assert.deepEqual(result.changedFields, ["line"]);
assert.equal(result.previous.line, 10);
assert.equal(result.current.line, 12);
assert.deepEqual(provider.calls[0]?.breakpoints.map((bp) => bp.id).sort(), ["agent-a", "user-b"]);

await assert.rejects(
  () => reconciler.update(session, { breakpointId: "user-b", line: 13 }),
  (error: Error & { code?: string }) => error.code === "POLICY_VIOLATION"
);
```

Add independent cases for cross-source relocation with sorted locks, provider failure followed by proven rollback, rollback failure yielding `BREAKPOINT_ROLLBACK_FAILED` plus `{ outcome:"indeterminate", retrySafe:false, rollbackApplied:false, affectedIds:["agent-a","user-b"] }`, and a null condition clear.

- [ ] **Step 2: Run reconciliation tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/breakpoint-reconciler.test.ts
```

Expected: FAIL because no reconciler or source snapshot APIs exist.

- [ ] **Step 3: Implement source snapshots and reconciler locks**

Extend `BreakpointManager` with non-mutating read APIs:

```ts
get(sessionId: string, id: string): BreakpointRecord | undefined;
listSource(sessionId: string, filePath: string): BreakpointRecord[];
replaceSource(sessionId: string, filePath: string, records: BreakpointRecord[]): void;
```

Each returns or stores deep clones so a failed provider call cannot mutate desired state by alias. In `BreakpointReconciler`, compute `next` by applying only own properties in `BreakpointPatchRequest`; retain existing owner. Acquire `Promise` mutexes for `oldPath` and `newPath` in sorted order. Apply the complete source set with `provider.setBreakpoints`, update verification from positive adapter replies, and only then `replaceSource`. On failure, call `setBreakpoints` with the original complete source snapshots; if that recovery call fails, throw `new BreakPilotError(ErrorCodes.BREAKPOINT_ROLLBACK_FAILED, "BreakPilot could not restore the previous breakpoint state.", failureDetails)`.

Use `BREAKPOINT_UPDATE_FAILED` for a provider failure with proven rollback and preserve the original provider error message only in a safe `causeCode` field, not an arbitrary provider payload.

- [ ] **Step 4: Run reconciliation and existing breakpoint tests**

Run:

```bash
node --experimental-strip-types --test test/breakpoint-reconciler.test.ts test/project-breakpoints.test.ts
npm run typecheck
```

Expected: PASS; user breakpoints remain in DAP source replacement lists and local desired state changes only after evidence.

- [ ] **Step 5: Commit the reconciliation service**

```bash
git add src/sessions/BreakpointReconciler.ts src/sessions/BreakpointManager.ts src/types/sessions.ts test/breakpoint-reconciler.test.ts test/project-breakpoints.test.ts
git commit -m "feat(sessions): reconcile breakpoint updates safely"
```

### Task 3: Wire Real Updates Into The Manager And Exact Output Contract

**Files:**
- Modify: `src/sessions/DebugSessionManager.ts`
- Modify: `src/control/toolOutputSchemas.ts`
- Modify: `src/control/schemaFragments.ts`
- Modify: `src/utils/errors.ts`
- Modify: `test/debugger-mcp-contracts.test.ts`
- Modify: `test/project-breakpoints.test.ts`

**Interfaces:**
- Consumes: a validated `BreakpointPatchRequest` and `BreakpointReconciler.update`.
- Produces: a backward-compatible breakpoint response plus immutable `previous`, `current`, `operation`, and `changedFields` evidence.

- [ ] **Step 1: Add failing manager-level update tests**

Replace the legacy “breakpoint update is unsupported” assertion in `test/debugger-mcp-contracts.test.ts`:

```ts
const updated = await manager.bpDebugSetBreakpoint({ sessionId, breakpointId: "bp-1", line: 24 });
assert.equal(updated.operation, "relocated");
assert.equal(updated.breakpointId, "bp-1");
assert.equal((updated.previous as AnyRecord).line, 20);
assert.equal((updated.current as AnyRecord).line, 24);
assert.deepEqual(updated.changedFields, ["line"]);
assert.equal(updated.verified, true);
```

Add a project-session test asserting a protocol-v1 IDE client receives `UNSUPPORTED_CAPABILITY` rather than a fake native update; protocol-v2 bridge mutation coverage is supplied by the IDE-runtime plan.

- [ ] **Step 2: Run manager contract tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/debugger-mcp-contracts.test.ts test/project-breakpoints.test.ts
```

Expected: FAIL because `bpDebugSetBreakpoint` hard-codes an unsupported response for `breakpointId`.

- [ ] **Step 3: Dispatch the reconciler and publish truthful result fields**

In `DebugSessionManager.bpDebugSetBreakpoint`, branch on `breakpointId`, resolve the session, check workspace path only if the patch changes source, then call `this.breakpointReconciler.update(session, patch)`. Return a compatibility projection of `current` at top level and append:

```ts
{
  operation: result.operation,
  breakpointId: result.breakpointId,
  previous: compactBreakpoint(result.previous),
  current: compactBreakpoint(result.current),
  changedFields: result.changedFields,
  verified: result.verified,
  rollbackApplied: result.rollbackApplied
}
```

Add `BREAKPOINT_UPDATE_FAILED` and `BREAKPOINT_ROLLBACK_FAILED` to `ErrorCodes`. Extend `setBreakpointSuccessSchema` so both create and update result variants are exactly valid; retain existing flat create fields to avoid breaking callers.

- [ ] **Step 4: Run manager, contract, and full unit regressions**

Run:

```bash
node --experimental-strip-types --test test/debugger-mcp-contracts.test.ts test/project-breakpoints.test.ts test/breakpoint-reconciler.test.ts
npm test
```

Expected: PASS; update fields are present only for updates, and old create callers retain their existing flat fields.

- [ ] **Step 5: Commit manager update dispatch**

```bash
git add src/sessions/DebugSessionManager.ts src/control/toolOutputSchemas.ts src/control/schemaFragments.ts src/utils/errors.ts test/debugger-mcp-contracts.test.ts test/project-breakpoints.test.ts
git commit -m "feat(control): execute breakpoint update requests"
```

### Task 4: Add Fresh Stop Boundaries And Standard DAP Goto Primitives

**Files:**
- Modify: `src/types/dap.ts`
- Modify: `src/dap/DapClient.ts`
- Modify: `src/dap/DapSession.ts`
- Create: `test/dap-session-boundaries.test.ts`

**Interfaces:**
- Consumes: generic DAP event notifications, `gotoTargets`, `goto`, and existing stopped/terminated event handling.
- Produces: a monotonic stop sequence, an awaitable fresh-stop boundary, and typed native goto requests without changing `waitForBreakpoint` behavior.

- [ ] **Step 1: Write failing DAP boundary tests**

Create `test/dap-session-boundaries.test.ts` with a fake request transport:

```ts
const stale = session.captureStopBoundary();
fake.emitStopped({ reason: "breakpoint", threadId: 1 });
const boundary = session.captureStopBoundary();
const pending = session.waitForStopOrTerminationAfter(boundary, 50);
fake.emitStopped({ reason: "step", threadId: 2 });
assert.equal((await pending).threadId, 2);

await session.gotoTargets("/workspace/Foo.java", 9);
assert.deepEqual(fake.requests[0], {
  command: "gotoTargets", arguments: { source: { path: "/workspace/Foo.java" }, line: 9 }
});
await session.goto(2, 33);
assert.deepEqual(fake.requests[1], { command: "goto", arguments: { threadId: 2, targetId: 33 } });
```

Add cases where termination follows the boundary, a timeout occurs, and the ordinary `waitForBreakpoint` still returns the earlier stopped event.

- [ ] **Step 2: Run the new DAP tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/dap-session-boundaries.test.ts
```

Expected: FAIL because the fresh boundary and goto helpers do not exist.

- [ ] **Step 3: Implement sequence-aware DAP session methods**

Add typed `DapGotoTarget`/`DapGotoTargetsResponse` definitions in `src/types/dap.ts`. In `DapSession`, increment `stopSequence` whenever a stopped event is observed and retain `{ sequence, event }` entries for fresh-boundary waiters in addition to the existing FIFO queue. Implement:

```ts
captureStopBoundary(): FreshStopBoundary { return { stopSequence: this.stopSequence }; }
waitForStopOrTerminationAfter({ stopSequence }: FreshStopBoundary, timeoutMs: number) { /* resolve only sequence > stopSequence */ }
async gotoTargets(filePath: string, line: number, column?: number) {
  const response = await this.client.request("gotoTargets", {
    source: { path: filePath }, line, ...(column === undefined ? {} : { column })
  });
  return (response.targets ?? []) as DapGotoTarget[];
}
async goto(threadId: number, targetId: number) {
  await this.client.request("goto", { threadId, targetId });
}
```

Termination/exited events must satisfy fresh waiters without erasing stopped FIFO entries. Clean waiter timers/listeners in every completion branch.

- [ ] **Step 4: Run fresh-stop and existing DAP tests**

Run:

```bash
node --experimental-strip-types --test test/dap-session-boundaries.test.ts test/dap-session-start.test.ts
npm run typecheck
```

Expected: PASS; an old stop cannot satisfy a later goto/continue operation.

- [ ] **Step 5: Commit DAP session primitives**

```bash
git add src/types/dap.ts src/dap/DapClient.ts src/dap/DapSession.ts test/dap-session-boundaries.test.ts
git commit -m "feat(dap): add fresh stop and goto primitives"
```

### Task 5: Implement Native Goto And Safe Temporary-Breakpoint Run-To-Line

**Files:**
- Modify: `src/runtime/providers/DapRuntimeProvider.ts`
- Modify: `src/runtime/ProviderCapabilities.ts`
- Modify: `src/sessions/DebugSessionManager.ts`
- Modify: `src/control/toolOutputSchemas.ts`
- Create: `test/dap-run-to-line.test.ts`
- Modify: `test/provider-capabilities.test.ts`
- Modify: `test/operation-capability-gates.test.ts`

**Interfaces:**
- Consumes: `DapSession` fresh-boundary/goto methods, `BreakpointReconciler.withTemporaryBreakpoint`, source validation, and DAP adapter capabilities.
- Produces: a `RunToLineResult` with native/fallback evidence, target truth, and cleanup proof for every termination, timeout, and failure path.

- [ ] **Step 1: Write failing native and fallback tests**

Create `test/dap-run-to-line.test.ts` with these focused cases:

```ts
const native = await providerWith({ supportsGotoTargetsRequest: true }).runToLine!({
  filePath: "/workspace/Foo.java", line: 20, threadId: 3
});
assert.equal(native.status, "paused");
assert.equal(native.targetReached, true);
assert.equal(native.cleanedUp, true);
assert.match(native.warnings?.join(" ") ?? "", /nearest executable target/i);

const fallback = await fallbackProvider.runToLine!({ filePath: "/workspace/Foo.java", line: 20 });
assert.equal(fallback.temporaryBreakpointId, "temporary-1");
assert.equal(fallback.cleanedUp, true);
assert.deepEqual(fallbackProvider.lastSetBreakpoints.map((bp) => bp.id).sort(), ["agent-existing", "user-existing"]);
```

Add separate cases for another breakpoint stopping first (`targetReached:false`, no continuation request after it), a stale stop before the fresh boundary, adapter termination (`status:"stopped"`), timeout (`status:"timeout"`), target lookup empty, provider failure, and cleanup failure yielding `RUN_TO_LINE_CLEANUP_FAILED`, `cleanupRequired:true`, `outcome:"indeterminate"`, and `retrySafe:false`.

- [ ] **Step 2: Run run-to-line tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/dap-run-to-line.test.ts
```

Expected: FAIL because the DAP provider does not implement `runToLine`.

- [ ] **Step 3: Implement the native path and fallback transaction**

In `DapRuntimeProvider.runToLine`, reject a non-paused session or invalid workspace source before provider action. For the native path:

```ts
const targets = await this.session.gotoTargets(filePath, line, column);
const target = chooseExactThenNearestTarget(targets, line, column);
if (!target) throw new BreakPilotError(ErrorCodes.UNSUPPORTED_CAPABILITY, "No executable goto target is available.");
const boundary = this.session.captureStopBoundary();
await this.session.goto(threadId, target.id);
const stop = await this.session.waitForStopOrTerminationAfter(boundary, timeoutMs);
```

Set `targetReached` only after comparing the observed stop position with the selected target position. For the fallback, call `reconciler.withTemporaryBreakpoint`, capture a boundary before `continue`, wait for a post-boundary stop or termination, and return the actual stopping position. The reconciler's `finally` restores the complete original source list. A different stop is success at the transport level but `targetReached:false` with a warning and no automatic resume.

Derive capabilities in `ProviderCapabilities`: native when `supportsGotoTargetsRequest === true`; otherwise fallback only when the DAP session supports `setBreakpoints` and control continuation. Update `runToLineSuccessSchema` to require `targetReached`, `requestedPosition`, and `cleanedUp` for successful results while allowing truthful optional cleanup/error fields.

- [ ] **Step 4: Run native/fallback and capability regressions**

Run:

```bash
node --experimental-strip-types --test test/dap-run-to-line.test.ts test/provider-capabilities.test.ts test/operation-capability-gates.test.ts
npm test
npm run typecheck
```

Expected: PASS; every advertised DAP run-to-line capability has a working implementation and removes temporary state on every route.

- [ ] **Step 5: Commit run-to-line support**

```bash
git add src/runtime/providers/DapRuntimeProvider.ts src/runtime/ProviderCapabilities.ts src/sessions/DebugSessionManager.ts src/control/toolOutputSchemas.ts test/dap-run-to-line.test.ts test/provider-capabilities.test.ts test/operation-capability-gates.test.ts
git commit -m "feat(dap): support safe run to line"
```

## Final Verification

- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run check:runtime`.
- [ ] Confirm a DAP source replacement list always contains unchanged user and agent breakpoints.
- [ ] Confirm a run-to-line callback can never consume an earlier stop and can never leave an unreported temporary breakpoint.
- [ ] Confirm protocol-v1 IDE clients still produce a capability error for update rather than a fabricated successful update.
- [ ] Inspect `git status --short` and `git diff --cached --stat` before every commit; leave unrelated changes unstaged.
