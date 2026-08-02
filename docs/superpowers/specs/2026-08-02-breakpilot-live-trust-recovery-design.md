# BreakPilot Live Trust Recovery Design

Date: 2026-08-02

## Purpose

Restore the smallest trustworthy IDEA-backed debugging loop before expanding
BreakPilot's feature surface. The work is driven by the live Spring Boot
differential run against
`/Users/Quixote/workSpace/Java/spring-boot-demo/simple-springboot-demo`.

The loop is trustworthy only when an agent can create and remove its own
breakpoint without changing pre-existing breakpoints, read one selected value
without expanding unrelated values, distinguish missing evidence from empty
evidence, and receive an error that describes the actual failed layer.

This design is a focused child of
`2026-07-31-breakpilot-agent-eyes-and-hands-optimization-design.md`. It changes
the delivery order, not the program-level architecture: live data-loss and
evidence-integrity defects are repaired before the build-identity and broader
contract slice.

## Confirmed Failures

The 2026-08-02 live run reproduced these failures:

1. An adopted IDEA session contained a pre-existing BreakPilot-owned
   breakpoint at `HelloController.java:133`. Creating a new breakpoint in the
   same source caused the pre-existing breakpoint to disappear. Recreating it
   through BreakPilot and disconnecting removed it again.
2. IDEA MCP and BreakPilot reported different owners and IDs for the same
   native breakpoint. BreakPilot also lost IDEA tracepoint fields when listing
   the breakpoint.
3. `bp_debug_frame(depth=1, limit=3)` succeeded while the same request with
   `limit=4` timed out. `bp_debug_value(path=["name"], limit=2)` succeeded and
   `limit=4` timed out, while expanding the returned opaque reference with four
   children succeeded immediately.
4. These response timeouts were reported as `IDE_BRIDGE_DISCONNECTED` even
   though status, stack, evaluation, and later requests proved the bridge was
   still connected.
5. `bp_debug_context` and control enrichment converted frame failures into
   successful empty data without a warning.
6. `bp_debug_run_configurations` returned an output-contract violation because
   its success object contained enumerable `undefined` properties.

## Chosen Approach

Implement two vertical trust slices in this order.

### Slice A: Breakpoint ownership and lifecycle safety

- Import the provider's complete native breakpoint snapshot when adopting an
  IDEA session.
- Keep provider identity, native identity, owner, origin, and lifecycle
  identity distinct in the Core model.
- Use exact native add/update/remove operations for the IDEA provider. Do not
  apply DAP source-replacement semantics to an incomplete adopted-session
  catalog.
- Treat a pre-existing breakpoint as outside the adopted session's cleanup
  lifecycle, even when it is agent-owned by an earlier client or session.
- Disconnect and cleanup remove only breakpoints proven to have been created by
  the current lifecycle.
- Preserve condition, enabled state, suspend policy, temporary state, log
  message, and log stack fields in native snapshots.
- If ownership cannot be proven, fail closed and retain the breakpoint.

The public tool names remain unchanged. Existing opaque BreakPilot IDs remain
accepted, while responses add only truthful fields already allowed by the
current contract or separately covered by schema tests.

### Slice B: Bounded variable evidence and explicit failures

- Complete the existing bridge decoder candidate with message-specific depth,
  record, array, item, and total-key limits. A rejected correlated response
  fails its pending request immediately with a typed bridge error.
- Make shallow frame reads the root of path resolution. Resolve a path one
  token at a time by following only the selected opaque reference; never force
  whole-frame `expand="deep"`.
- Preserve the existing pause-epoch binding. Stepping invalidates all earlier
  refs and path traversal state.
- Keep the current `CollectingValueNode` candidate, but specify an exactly-once
  bounded state machine for provisional empty presentations, refinement,
  duplicate callbacks, timeout, and late callbacks.
- Represent completed and missing evidence separately. Context and
  `includeFrame` retain successful transition data and attach explicit partial
  evidence when enrichment fails.
- Classify a connected response timeout as `IDE_RESPONSE_TIMEOUT`; reserve
  disconnection errors for observed transport or registry loss.
- Use one monotonic deadline for each operation. Every phase receives only the
  remaining budget.
- Remove enumerable `undefined` from run-configuration success objects and
  validate the real serialized result.

## Data Flow

### Adopted breakpoint flow

```text
IDEA native snapshot
  -> import immutable baseline entries
  -> create current-lifecycle breakpoint with exact native add
  -> update/remove by native identity
  -> disconnect removes current-lifecycle IDs only
  -> verify baseline snapshot is unchanged
```

### Path read flow

```text
paused session + expected pause epoch
  -> shallow frame locals
  -> select root token
  -> expand selected ref
  -> select next token
  -> repeat within one deadline
  -> return selected node or explicit partial/error
```

No step expands unrelated siblings.

## Error and Evidence Semantics

- `IDE_RESPONSE_TIMEOUT`: the selected IDE remained connected but did not
  answer within the remaining deadline.
- `IDE_DISCONNECTED`: the selected IDE connection was absent or was observed
  closing.
- `BRIDGE_PAYLOAD_LIMIT`: a correlated response exceeded a documented message
  budget; the pending request fails immediately.
- An applied control action with failed enrichment remains applied and returns
  partial evidence. It must not invite an automatic second control action.
- Empty arrays mean empty data only when evidence for that field completed.
- Cleanup that cannot prove ownership returns a protected/not-removed result;
  it never guesses.

## Test Strategy

Every behavior change follows red-green-refactor.

### Core breakpoint tests

- Adopt a provider with a pre-existing agent breakpoint in one source.
- Create and remove a second breakpoint in the same source.
- Disconnect the adopted session.
- Assert the original breakpoint retains its native identity, owner, location,
  enabled state, condition, suspend policy, and logging fields.
- Assert user-owned and foreign-agent breakpoints are never removed by default.

### Core bridge and variable tests

- Prove the historical limit-3 response succeeds and limit-4 response fails
  before the decoder fix.
- After the fix, accept a bounded page above 128 total keys.
- Reject an over-budget correlated page immediately with
  `BRIDGE_PAYLOAD_LIMIT`, not a later timeout.
- Prove a top-level path read requests a shallow root and expands only the
  selected ref.
- Prove old refs return `STALE_RUNTIME_HANDLE` after the pause epoch changes.
- Prove frame, path, ref, and mutation apply the same inspection limits and
  redaction rules.

### IDEA plugin tests

- Accept provisional empty expandable presentations followed by final content.
- Accept documented refinements without double completion.
- Finalize exactly once on timeout and ignore late callbacks.
- Preserve all native breakpoint fields during snapshot round-trip.

### Contract tests

- Context and control enrichment failures expose missing fields and structured
  warnings.
- Run-configuration config and run-point modes survive public routing and JSON
  serialization without `undefined`.
- Connected response timeout and observed disconnect use different codes.

### Live acceptance

Rebuild and restart both the loaded Core MCP server and IDEA plugin, then use
the Spring Boot project to verify:

1. baseline breakpoint snapshot;
2. create/start/adopt/wait;
3. stack and shallow frame;
4. `frame(depth=1, limit=4)`;
5. path and opaque-ref reads;
6. readonly eval and safe mutation with read-back;
7. step and stale-ref rejection;
8. run-to-line;
9. exact breakpoint cleanup and disconnect;
10. final baseline equality, empty sessions, and no port-8080 listener.

The initial release gate is ten consecutive loops. After the remaining P0
slices land, the program-level 100-loop gate remains mandatory.

## Compatibility and Migration

- Preserve all 15 public `bp_debug_*` names.
- Prefer additive output fields and structured warnings.
- Correct false success, false disconnection, and destructive cleanup even
  where old callers could observe a behavior change.
- Preserve the current uncommitted `BridgeEventDecoder`, `VariableReader`, and
  related test work; extend it instead of replacing it.
- Do not bundle build identity, asynchronous approval UI, complete threads,
  advanced breakpoints, or tracepoint parity into this recovery slice.

## Success Criteria

The recovery is complete when:

1. create/remove/disconnect cannot change any pre-existing native breakpoint;
2. IDEA and BreakPilot preserve the same breakpoint semantic fields even if a
   legacy owner marker remains unknown;
3. bounded frame and path reads no longer fail at the historical limit-4
   boundary;
4. opaque refs remain valid only for their originating pause epoch;
5. no context or control enrichment failure appears as unexplained empty
   success;
6. a connected timeout is never reported as a disconnection;
7. both run-configuration modes pass the output contract;
8. focused Core and IDEA tests, full test suites, build, and ten live loops all
   pass without leaked sessions, JVMs, approvals, or breakpoints.

## Non-Goals

- Full thread enumeration and rich frame presentation.
- Conditional, hit-count, exception, method, field, or tracepoint parity.
- A new public API version or incompatible tool rename.
- The final asynchronous approval UI and complete lifecycle state machine.
- The full 100-loop release gate before the remaining P0 slices are complete.
