# BreakPilot Agent Runtime Parity Completion Design

Date: 2026-07-14

## Goal

Complete the eight remaining debugger boundaries without expanding the public
tool surface, so BreakPilot acts as an agent's runtime eyes and hands rather
than a thin collection of debugger-shaped APIs.

An agent must be able to discover capabilities before acting, issue one
provider-independent command, receive compact evidence that says what actually
happened, and recover deterministically from partial, stale, unsupported, or
indeterminate outcomes.

## Scope

This design completes all of the following:

1. Implement breakpoint update and relocation instead of advertising only a
   contract.
2. Implement DAP run-to-line with native `goto` when available and a safe
   temporary-breakpoint fallback otherwise.
3. Implement real, ordered event draining for DAP, IDEA, and VS Code.
4. Upgrade IDE variable references from snapshots to pause-scoped native
   handles.
5. Upgrade IDE set-value from assignment-only evaluation to native setters
   where the selected value supports them.
6. Return truthful IDE stack pagination and completeness instead of guessing
   from a top-frame snapshot.
7. Validate every debugger tool response against its published output schema
   before any transport returns it.
8. Replace the semantic-only differential fixture workflow with an executable
   capture, hashing, sanitization, lineage, and replay evidence pipeline, and
   perform one real local IDEA/BreakPilot capture against the Spring Boot sample.

## Product Principles

1. **Agent-first, provider-independent surface.** Keep the existing 15
   `bp_debug_*` tools. Provider differences are represented by capabilities,
   completeness, mutation mode, and warnings, not by different workflows.
2. **Few round trips.** Control operations return their resulting stop and top
   frame when available. Variable nodes return opaque references for targeted
   expansion instead of forcing another broad snapshot.
3. **Evidence before success.** Command acknowledgement, requested state, and
   observed runtime state remain distinct. Success requires provider evidence.
4. **Stale means invalid.** Frames and variable references are scoped to a
   pause epoch and fail explicitly after resume, step, stop, or frame change.
5. **Compact by default.** Default results contain stable semantic fields.
   Provider payloads and diagnostic metadata stay behind diagnostic detail.
6. **Safe recovery.** Mutation failures expose whether retry is safe, whether
   state is indeterminate, and whether cleanup remains necessary.
7. **Backward-compatible negotiation.** New bridge features are activated only
   when a connected plugin declares the matching protocol feature. Older
   plugins retain truthful snapshot or assignment fallbacks.

## Non-Goals

- Add a parallel `xdebug_*` API.
- Turn BreakPilot into a full IDE object model.
- Implement time-travel debugging or process replay.
- Claim that a local SHA-256 file alone proves where evidence originated.
- Provision external self-hosted macOS runners, signing keys, or WORM storage in
  this repository. The repository provides the hooks and offline verification;
  external infrastructure can be added later.
- Broaden production-debugging permissions.

## Chosen Approach

Three approaches were considered.

### Provider-local patches

Implement each missing operation directly in `DapRuntimeProvider`,
`IdeRuntimeProvider`, and both plugins. This is initially fast, but duplicates
breakpoint transactions, stale-handle checks, event sequencing, and error
semantics. The three providers would diverge again.

### Shared control-plane services

Introduce focused services for response finalization, breakpoint
reconciliation, event buffering, and runtime handles. Providers execute native
operations and normalize evidence into those services. This requires more
initial work but gives every provider the same public semantics and is the
selected approach.

### DAP-only unification

Route IDE functionality through DAP wherever possible. This simplifies VS Code
but discards IDEA-native breakpoint ownership, `XValueModifier`, run
configuration, and adopted-session advantages. It is rejected.

## Target Architecture

```text
Agent
  |
  v
MCP / HTTP / CLI
  |
  v
ToolRouter
  |-- input schema validation with defaults
  |-- handler dispatch
  `-- ToolResponseFinalizer (strict output validation, no defaults)
  |
  v
DebugSessionManager (public orchestration facade)
  |-- BreakpointReconciler
  |-- RuntimeEventBuffer
  |-- RuntimeHandle / pauseEpoch checks
  `-- capability and security gates
  |
  +-- DapRuntimeProvider ---- DAP adapter
  `-- IdeRuntimeProvider ---- authenticated bridge ---- IDEA / VS Code

Evidence capture harness
  |-- IDEA native MCP transcript
  |-- BreakPilot MCP transcript
  |-- manifest + raw hashes
  `-- sanitizer + lineage + offline replay
```

`DebugSessionManager` remains the facade during migration. New logic is not
added as another block of private methods in that class; it is placed in units
with independently testable contracts.

## 1. Runtime Output Validation

### Shared schema engine

The current input validator is split into a reusable schema engine with two
public modes:

```ts
validateToolInput(schema, value)
// JSON-safe, cloned, defaults applied

validateToolOutput(schema, value)
// JSON-safe, not mutated, no defaults applied
```

Both modes support the exact schema vocabulary published by BreakPilot. Output
validation must not fill missing fields, drop extra fields, coerce values, or
return a normalized copy. A valid handler result is returned byte-for-byte as
the original JSON-compatible object.

### Response finalizer

`ToolResponseFinalizer` receives the tool definition, candidate result, and
operation classification. `ToolRouter.callTool()` sends both normal handler
results and caught errors through this finalizer before returning. Hub routing
errors created before a project router is selected use the same finalizer.

Malformed output never reaches MCP, HTTP, CLI, or a direct local gateway. It is
replaced with a trusted error:

```json
{
  "error": {
    "code": "OUTPUT_CONTRACT_VIOLATION",
    "message": "Debugger tool returned a result that violates its published contract.",
    "details": {
      "tool": "bp_debug_set_value",
      "issues": [],
      "outcome": "indeterminate",
      "retrySafe": false
    }
  }
}
```

Read-only tools use `outcome:"failed"` and `retrySafe:true`. Start, control,
run-to-line, evaluate, set-value, and breakpoint mutation use
`outcome:"indeterminate"` and `retrySafe:false` because the side effect may
have happened before serialization failed.

Audit records contain the tool name, issue paths, keywords, and issue count.
They never contain the full malformed response or variable values.

HTTP maps `OUTPUT_CONTRACT_VIOLATION` to status 500. MCP keeps a normal
`tools/call` result with `isError:true` and the same structured content. CLI
prints the structured error and exits non-zero.

## 2. Breakpoint Reconciliation and Update

### Patch semantics

The `breakpointId` input branch becomes a true partial patch. Defaults are not
present in the update branch.

```ts
interface BreakpointPatchRequest {
  breakpointId: string;
  filePath?: string;
  line?: number;
  column?: number | null;
  condition?: string | null;
  hitCondition?: string | null;
  logMessage?: string | null;
  enabled?: boolean;
  owner?: "agent" | "user" | "all"; // authorization filter, never reassigned
  requireVerified?: boolean;
}
```

- Omitted fields remain unchanged.
- `null` clears a nullable condition, hit condition, log message, or column.
- A new `filePath` requires a line.
- A line without `filePath` relocates within the existing source.
- Default authorization remains agent-owned breakpoints only.
- User-owned breakpoints require explicit `owner:"user"` or `owner:"all"` and
  an identity that the provider can prove.

### Reconciler

`BreakpointReconciler` owns desired/applied transitions. It performs:

1. Resolve and authorize the current breakpoint.
2. Clone current desired state and apply the explicit patch.
3. Acquire deterministic per-session source locks. Cross-file updates acquire
   both paths in sorted order.
4. Send the provider's new source state or native update request.
5. Commit the local desired state only after positive provider evidence.
6. On failure, restore the old provider state where possible.
7. If restore cannot be proven, return `outcome:"indeterminate"`,
   `retrySafe:false`, `rollbackApplied:false`, and the affected breakpoint IDs.

DAP uses source-level `setBreakpoints` reconciliation and therefore reports
`breakpointUpdate:"fallback"`. IDEA and VS Code use a bridge update command;
they report `native` only when the plugin can mutate or replace the exact
agent-owned object and positively acknowledge the resulting state. Otherwise
they report `fallback`.

The response adds:

```ts
{
  operation: "updated" | "relocated";
  breakpointId: string;
  previous: CompactBreakpoint;
  current: CompactBreakpoint;
  changedFields: string[];
  verified: boolean;
  rollbackApplied?: boolean;
  warnings?: string[];
}
```

## 3. DAP Run-To-Line

### Native path

If the adapter declares `supportsGotoTargetsRequest`, DAP run-to-line performs:

1. `gotoTargets` for the normalized workspace source and line.
2. Select the exact target or the nearest executable target and report any
   relocation.
3. Capture the current stop sequence.
4. Send `goto` with the chosen target and thread.
5. Wait for a stopped or terminated event newer than the captured sequence.

The capability is `native` for this path.

### Temporary-breakpoint fallback

Otherwise `DapRuntimeProvider.runToLine()` uses a transaction provided by the
breakpoint reconciler:

1. Require a paused DAP session and a workspace-contained source path.
2. Capture the current stop sequence.
3. Merge an internal agent-owned temporary breakpoint with every existing
   desired breakpoint for that source; never replace the source with only the
   temporary breakpoint.
4. Continue the selected thread.
5. Wait for a fresh stop, termination, or timeout.
6. Remove the temporary breakpoint in `finally`, restoring the original source
   breakpoint set.

If another breakpoint or exception stops first, BreakPilot returns that real
pause with `targetReached:false` and a warning. It does not automatically
resume. Termination returns `status:"stopped"`; timeout returns
`status:"timeout"`. Every outcome includes `temporaryBreakpointId`,
`cleanedUp`, and any `cleanupRequired` metadata.

The capability is `fallback` only after all cleanup and stale-stop tests pass.

## 4. Runtime Event Buffer

Each managed session owns a bounded `RuntimeEventBuffer`. The default capacity
is 256 normalized events and can be reduced by policy but not enlarged by a
tool call.

```ts
interface RuntimeEvent {
  sequence: number;
  timestamp: string;
  kind:
    | "breakpoint"
    | "breakpointError"
    | "tracepoint"
    | "output"
    | "stopped"
    | "continued"
    | "thread"
    | "process"
    | "invalidated"
    | "terminated";
  sessionId: string;
  breakpointId?: string;
  threadId?: number | string;
  position?: CompactPosition;
  message?: string;
  category?: string;
  data?: Record<string, unknown>;
}
```

Sequences are monotonic per managed session. The stopped event used by
`waitForBreakpoint` is also copied into the event buffer; reading events never
steals it from the control waiter.

`bp_debug_control(action:"drainEvents")` retains its public action name but
uses cursor-based reads:

```ts
{
  action: "drainEvents";
  cursor?: number;
  limit?: number;
}
```

It returns:

```ts
{
  status: string;
  events: {
    items: RuntimeEvent[];
    cursor: number;
    nextCursor: number;
    oldestCursor: number;
    hasMore: boolean;
    overflowed: boolean;
    droppedCount: number;
    supportedKinds: string[];
    breakpointErrors: object[];
    tracepoints: object[];
  };
}
```

The existing `events` container is preserved. Its two legacy arrays are
derived views for compatibility. Events remain in the bounded ring until
capacity eviction, so an explicit cursor permits replay. Without a cursor, the
session's default consumer cursor advances atomically. A cursor older than the
retained range returns the oldest retained page with `overflowed:true` and the
exact `droppedCount`; partial event evidence is a normal truthful result, not a
tool failure.

DAP events are normalized from `DapClient`'s generic event stream. IDE events
are normalized from bridge session, breakpoint, output, and invalidation
messages. Plugins advertise `eventStream` and `eventKinds`; capability becomes
native only when the live session declares a real source.

## 5. Pause Epoch and Native Variable Handles

### Public handle

Variable `ref` accepts the existing number or a new opaque string. Agents must
not parse string handles.

```ts
interface RuntimeReferenceHandle {
  handle: string;
  sessionId: string;
  pauseEpoch: number;
}
```

Every transition to a new paused stop increments a session `pauseEpoch`.
Selecting a different frame while paused also increments the epoch because
IDEA and VS Code may expose frame-scoped value objects. Resume, step,
run-to-line, stop, frame change, and bridge session replacement invalidate old
handles. A stale handle returns `STALE_RUNTIME_HANDLE` with the current epoch
and `retrySafe:true`; it never resolves against the next pause.

Variable nodes add truthful metadata:

```ts
{
  ref?: number | string;
  pauseEpoch?: number;
  childrenCount?: number;
  complete?: boolean;
  truncated?: boolean;
  modifiable?: boolean;
  mutationMode?: "native" | "evaluateAssignment" | "unsupported";
}
```

All expansion requests still pass through security limits and redaction. A
native handle cannot bypass depth, item, string, or secret policies.

### VS Code

The extension records adapter initialize capabilities per debug session.
`variablesReference` values are wrapped in pause-scoped opaque handles whose
registry stores the DAP reference, parent reference, variable name, evaluate
name, session, and epoch.

Expansion uses `customRequest("variables")`. Native mutation uses
`customRequest("setVariable", {variablesReference,name,value})` only when the
adapter declares `supportsSetVariable`. `supportsSetExpression` remains a
separately reported fallback and is not called native set-variable.

### IDEA

The plugin keeps a pause-scoped registry of `XValue` and selected frame
objects. Serialization registers expandable or modifiable values and returns
opaque handles. Expansion calls `XValue.computeChildren` for the registered
value.

Mutation first resolves `getModifierAsync()` or `getModifier()`, then calls
`XValueModifier.setValue`. Callbacks are ignored if their epoch has become
obsolete. Values without a modifier may use the existing assignment evaluator
only when a stable evaluate name exists; otherwise the node reports
`modifiable:false`.

### Set-value contract

`bp_debug_set_value` accepts exactly one target:

```ts
{ ref: number | string, newValue: string, ...sessionSelection }
```

or the compatible path target:

```ts
{ path: string[], newValue: string, frameIndex?: number, ...sessionSelection }
```

Reference targeting is preferred because it avoids another broad snapshot and
works for shadowed locals, arrays, and names containing dots. Path targeting
remains an evaluate-assignment fallback.

The result is explicit:

```ts
{
  applied: boolean;
  verified: boolean;
  mutationMode: "native" | "evaluateAssignment";
  oldValue: string | number | boolean | null;
  newValue?: string;
  value?: CompactVariable;
  message?: string;
  warnings?: string[];
}
```

Native setters read the selected value back before claiming `verified:true`.
Assignment fallbacks also read back when possible; a successful evaluator with
no read-back is `applied:true, verified:false`.

## 6. Truthful IDE Stack Pagination

Stack reads use dedicated bridge messages rather than piggybacking on a
variable snapshot:

```text
agent_request_stack
ide_stack_snapshot
```

The request carries session, pause epoch, thread, offset, and limit. The
response carries:

```ts
{
  threadId: number | string | null;
  frames: CompactFrame[];
  offset: number;
  totalFrames?: number;
  completeness: "complete" | "partial" | "unknown";
  truncationReason?: "limit" | "provider" | "timeout" | "noSuspendContext";
  nextOffset?: number;
  pauseEpoch: number;
}
```

The existing `partial` boolean remains as a compatibility projection of
`completeness !== "complete"`.

VS Code sends DAP `stackTrace` with the requested `startFrame` and `levels`,
preserves `totalFrames`, and reads `threads` when needed. IDEA calls
`XExecutionStack.computeStackFrames(offset, ...)`, distinguishes provider
completion from local limit truncation, and uses top-frame fallback only when
the suspend context or stack provider cannot supply a list.

An agent can use `nextOffset` directly without computing pagination or guessing
whether twenty returned frames are the complete stack.

## 7. IDE Bridge Compatibility

Bridge registration adds a protocol version and feature map:

```ts
{
  debuggerProtocolVersion: 2,
  debuggerFeatures: {
    breakpointUpdate: true,
    eventStream: true,
    stackPagination: true,
    variableHandles: true,
    nativeSetVariable: true
  }
}
```

Features are read from the live client and may be overridden by a session. A
canonical explicit `false` wins over aliases and older client claims.

New messages include:

- `agent_update_breakpoint` / `ide_breakpoint_updated`
- `agent_request_stack` / `ide_stack_snapshot`
- handle-bearing `agent_request_variables`
- handle-bearing `agent_set_variable`
- normalized `ide_debug_event`

Core sends a new message only when the selected live session advertises it.
Older plugins keep the existing snapshot and evaluate-assignment behavior and
continue to report those exact capability levels.

## 8. Differential Evidence Pipeline

### Capture

An executable harness records IDEA native MCP and BreakPilot MCP against the
same paused Java request in:

```text
/Users/Quixote/workSpace/Java/spring-boot-demo/simple-springboot-demo
```

The fixed acceptance point remains `HelloController.java:24`. The harness first
captures IDEA native MCP evidence, then adopts the same still-paused IDE session
through BreakPilot and captures BreakPilot context, stack, and variables.

Every JSON-RPC request, response, error, and retry is appended to provider
NDJSON transcripts. A manifest records:

- BreakPilot, application, harness, and sanitizer revisions;
- Node, Java, Gradle, OS, IDEA, native MCP, and plugin versions;
- plugin artifact SHA-256;
- MCP server identity and selected IDE session identity;
- exact run configuration, application request, source marker, timestamps,
  and attempt outcome.

Raw transcripts are closed and hashed before sanitization. They remain in an
ignored local evidence directory or approved external secure storage and are
never committed without a separate secret review.

### Deterministic sanitizer

A versioned TypeScript sanitizer:

- uses allowlisted provider structures;
- replaces absolute paths, ports, process IDs, timestamps, session IDs, frame
  IDs, thread IDs, and variable references with stable relational tokens;
- removes authorization headers, environment values, tokens, and high-entropy
  secrets;
- preserves provider field structure, ordered variable paths, stop position,
  method name, completeness, and semantic values;
- is deterministic and idempotent;
- generates a lineage file mapping every canonical assertion to transcript
  sequence, JSON Pointer, and raw digest.

### Replay

Offline replay verifies manifest shape, raw hashes when raw access exists,
sanitized hashes, sanitizer determinism, lineage pointers, and the extracted
cross-provider semantic model. The committed semantic fixture is generated by
the extractor, never manually edited.

Normal `npm test` runs sanitizer, hash, schema, lineage, and offline replay
tests. Live capture is an explicit local command suitable for manual, nightly,
or release execution on a configured macOS IDEA runner. Missing IDEA
infrastructure is reported as unavailable; it is not silently marked as a
successful live capture.

Suggested commands:

```text
npm run evidence:differential:capture
npm run evidence:differential:verify
npm run test:e2e:idea-differential
```

## Agent-Friendly Workflow After Completion

The normal workflow remains small:

1. `bp_debug_start` returns provider, capabilities, and current pause epoch.
2. `bp_debug_set_breakpoint` creates or patches an agent-owned breakpoint.
3. `bp_debug_control(wait|pause|step*)` returns the resulting stop and top-frame
   evidence.
4. `bp_debug_context` returns compact stack and variables with completeness and
   opaque references.
5. `bp_debug_value(ref)` expands only the relevant object.
6. `bp_debug_set_value(ref,newValue)` uses the strongest truthful mutation mode
   and reports read-back verification.
7. `bp_debug_run_to_line` chooses native or fallback without changing the
   public call.
8. `bp_debug_control(drainEvents)` returns ordered evidence and a reusable
   cursor.

Every error includes a stable code and enough recovery metadata for an agent to
choose one next action without reading provider internals.

## Error Semantics

New or standardized codes include:

- `OUTPUT_CONTRACT_VIOLATION`
- `STALE_RUNTIME_HANDLE`
- `BREAKPOINT_UPDATE_FAILED`
- `BREAKPOINT_ROLLBACK_FAILED`
- `RUN_TO_LINE_CLEANUP_FAILED`
- `VARIABLE_NOT_MUTABLE`
- `EVIDENCE_VERIFICATION_FAILED`

Errors that may follow an executed side effect include:

```ts
{
  outcome: "indeterminate";
  retrySafe: false;
  cleanupRequired?: boolean;
  affectedIds?: string[];
  recommendedAction?: string;
}
```

Read-only stale, pagination, and schema-input errors are retry-safe and provide
the current epoch or valid range. Event cursor loss is returned as an
`overflowed` batch with the exact retained range so the agent can continue from
the oldest available event without a second recovery call.

## Security and Resource Limits

- Output validation and event normalization never log raw variable payloads.
- Runtime event buffers are policy-bounded per session.
- Opaque reference registries are bounded and cleared on every epoch change.
- Native variable expansion and read-back reapply redaction and inspection
  limits.
- Breakpoint paths and run-to-line targets are workspace validated before local
  state or provider mutation.
- Evidence raw files are ignored by Git and separated from committed sanitized
  artifacts.
- Sanitization fails closed on unknown sensitive structures or secret-scan
  findings.

## Migration Phases

Each phase is independently testable and committed separately.

1. **Contract finalization.** Shared schema engine, fail-closed output
   finalizer, transport status mapping, and output validation tests.
2. **Runtime primitives.** Pause/stop sequence, handle epoch model, bounded
   event buffer, and normalized DAP/bridge event ingestion.
3. **Breakpoint reconciliation.** Partial patch contract, desired/applied
   transactions, owner protection, rollback, provider bridge update.
4. **DAP run-to-line.** Native goto plus temporary-breakpoint fallback and
   cleanup evidence.
5. **IDE stack fidelity.** Dedicated stack protocol, pagination,
   completeness, and plugin implementations.
6. **VS Code native variables.** Adapter capability capture, opaque handles,
   native setVariable, invalidation, and read-back.
7. **IDEA native variables.** XValue registry, XValueModifier mutation,
   invalidation, and assignment fallback.
8. **Evidence and acceptance.** Capture/sanitize/replay scripts, fixture
   migration, documentation, and one live Spring Boot differential run.

## Testing Strategy

All behavior changes follow red-green-refactor. A production method is not
added until a test has failed for the missing behavior.

### Core tests

- Valid and malformed success/error output for all 15 tools.
- No default injection or mutation during output validation.
- Breakpoint partial patch, same-source update, cross-source relocation,
  owner protection, provider failure, rollback success, and rollback failure.
- DAP native goto, target relocation, fallback target hit, other stop first,
  stale stop, termination, timeout, provider failure, and cleanup failure.
- Event ordering, cursor replay, default cursor advancement, capacity overflow,
  cross-session isolation, and no interference with stop waiters.
- Stale handles after resume, step, frame change, reconnect, and stop.
- Stack completeness and next-offset rules.

### Provider and plugin tests

- Capability truth tables for old and protocol-v2 clients.
- VS Code adapter initialize capability capture, variables expansion,
  setVariable request shape, read-back, and epoch invalidation.
- IDEA XValue handle registration, child expansion, modifier callback,
  non-modifiable values, obsolete callback suppression, stack pagination, and
  timeout fallback.
- Bridge request identity, session/epoch correlation, and new-message timeout
  cleanup.

### Evidence tests

- Sanitizer determinism and idempotence.
- Secret, absolute-path, volatile-ID, and unknown-field rejection.
- Manifest and SHA-256 verification.
- Lineage pointer resolution.
- Offline semantic extraction and symmetric value comparison.
- Live harness failure reporting when IDEA or either MCP server is unavailable.

### Regression gates

- `npm test`
- `npm run typecheck`
- `npm run build`
- VS Code extension tests and compile.
- IDEA Gradle tests and Kotlin compile against the configured IDEA SDK.
- Runtime smoke test.

## Real Acceptance Scenario

Using the configured Spring Boot project and the same request:

1. IDEA native MCP and BreakPilot observe the same stop at
   `HelloController.java:24`.
2. Both expose the real `hello` frame and the same selected semantic values,
   including `analysis.score = 28`.
3. BreakPilot reports whether the stack is complete and supplies `nextOffset`
   when it is not.
4. A returned variable handle expands on demand and becomes stale after resume.
5. Native set-value changes a modifiable local and read-back verifies it; a
   non-modifiable value returns a clean, truthful result.
6. Breakpoint update and relocation preserve user-owned breakpoints.
7. DAP run-to-line reaches the target through native goto or fallback and
   leaves no temporary breakpoint.
8. Event drain returns real ordered events and a reusable cursor.
9. Every returned result passes its advertised output schema at runtime.
10. The live capture produces raw hashes, sanitized transcripts, lineage, and a
    replayable semantic artifact with honest provenance.

## Success Criteria

- All eight listed boundaries are implemented; none remains hard-coded
  unsupported when its provider path is available.
- An agent uses the same public calls for IDEA, VS Code, and DAP.
- Capability claims are computed from live provider/session features.
- No mutation or control result reports success without provider evidence.
- No stale variable or frame reference can read a later pause.
- Partial stack and event loss are machine-readable.
- Breakpoint and run-to-line rollback/cleanup state is machine-readable.
- Every tool response is runtime schema-valid before transport.
- The committed differential artifact is generated from a hashed, versioned,
  replayable capture process rather than hand-authored semantic JSON.
- Existing user breakpoints, compact output defaults, and current public tool
  names remain compatible.
