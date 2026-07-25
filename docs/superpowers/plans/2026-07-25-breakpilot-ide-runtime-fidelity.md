# BreakPilot IDE Runtime Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents pause-scoped, expandable IDE variable handles, truthful stack pagination, and the strongest verified mutation mechanism available from VS Code or IntelliJ IDEA without breaking older bridge plugins.

**Architecture:** Negotiate protocol-v2 features from each live bridge session before emitting a new message. The core tracks only opaque handles and pause epochs; plugins retain raw DAP references or IDEA `XValue` objects in bounded registries. `IdeRuntimeProvider` translates one provider-independent call into v2 stack/handle/setter requests when negotiated and retains the old snapshot/evaluate-assignment behavior with explicitly weaker capability when it is not.

**Tech Stack:** TypeScript 5.9, Node.js >=22.6, WebSocket IDE bridge, VS Code Debug Adapter Protocol, IntelliJ Platform Kotlin SDK, existing compact inspection models.

## Global Constraints

- Preserve the 15 public `bp_debug_*` tools; add no IDE-specific public tool names.
- Protocol-v2 behavior requires both `debuggerProtocolVersion >= 2` and the exact feature explicitly `true`; a session-level explicit `false` overrides all client aliases or `true` values.
- Legacy/v1 plugins must retain snapshot variable reads and evaluate-assignment only where they already work; never label them native.
- All opaque handles are scoped to `(clientId, ideSessionId, pauseEpoch)` and are invalid after resume, step, stop, frame selection change, reconnect, client disconnect, or IDE session replacement.
- A string handle is opaque to an agent. It must not contain a raw DAP `variablesReference`, raw IDEA object identity, file path, or secret value.
- Native set-value means the plugin used its debugger-native setter and read back the target. If read-back cannot be proven, return `applied:true, verified:false`; do not claim `verified:true`.
- Variable expansion, read-back, and stack reads retain existing redaction, depth, item, and string limits.
- Stack completeness is `"complete"`, `"partial"`, or `"unknown"`. Missing `totalFrames` is `"unknown"`, not a guessed complete stack; compatibility `partial` equals `completeness !== "complete"`.
- New bridge responses must echo `clientId`, `ideSessionId`, `requestId`, and `pauseEpoch`; core must ignore any mismatched response.
- IDE event streaming requires the negotiated `eventStream` feature and must normalize only allowlisted lifecycle, breakpoint, output, thread, process, and invalidation facts into the manager-owned event buffer.
- Do not publish native IDEA mutation support until an SDK-specific modifier adapter compiles and its callback/read-back tests pass.
- Use Conventional Commits in the form `<type>(<scope>): <summary>` and do not stage unrelated user changes.

---

## File Structure

- Create `src/ide/DebuggerFeatureNegotiation.ts`: pure protocol-v2 negotiation and feature truth table.
- Create `src/runtime/RuntimeHandle.ts`: parse-free core handle metadata and stale-epoch assertion.
- Modify `src/types/ide.ts`, `src/ide/IdeProtocol.ts`, `src/ide/IdeClientRegistry.ts`, and `src/ide/IdeBridgeServer.ts`: type/version/features, pause epoch, and new messages.
- Modify `src/types/inspection.ts`, `src/types/sessions.ts`, `src/control/schemaFragments.ts`, `src/control/toolDefinitions.ts`, and `src/control/toolOutputSchemas.ts`: number-or-string references, stack page contract, and mutation evidence.
- Modify `src/runtime/ProviderCapabilities.ts`, `src/runtime/providers/IdeRuntimeProvider.ts`, and `src/sessions/DebugSessionManager.ts`: negotiated behavior, stale correlation, ref-first mutation, and no manager stack re-slicing.
- Modify `src/ide/IdeProtocol.ts`, `src/types/ide.ts`, `src/ide/IdeBridgeServer.ts`, and `src/sessions/DebugSessionManager.ts`: add normalized `ide_debug_event` routing into the shared cursor event buffer.
- Create root TypeScript tests `test/ide-bridge-v2-negotiation.test.ts`, `test/ide-runtime-handles.test.ts`, `test/ide-stack-pagination.test.ts`, and `test/ide-native-set-value.test.ts`.
- Create `breakpilot-vscode/src/debugger/PauseScopedHandleRegistry.ts` and `breakpilot-vscode/src/debugger/StackReader.ts`.
- Modify VS Code `src/debugger/DebugSessionTracker.ts`, `VariableReader.ts`, `CommandExecutor.ts`, `src/bridge/BridgeClient.ts`, `src/bridge/MessageProtocol.ts`, and `src/extension.ts`.
- Create root helper tests `test/vscode-runtime-handles.test.ts` and `test/vscode-stack-reader.test.ts`; compile the extension with its package script.
- Create IntelliJ `PauseScopedHandleRegistry.kt`, `StackReader.kt`, and an SDK-isolating `IdeaValueModifierAdapter.kt`.
- Modify IntelliJ `VariableReader.kt`, `CommandExecutor.kt`, `IdeSessionTracker.kt`, `bridge/MessageProtocol.kt`, `bridge/BridgeClient.kt`, and `plugin/BreakPilotIdeaPlugin.kt`.
- Create IntelliJ unit tests under `breakpilot-idea/src/test/kotlin/debugger/` and add test configuration only if its Gradle build lacks it.

## Interfaces Established By This Plan

```ts
export interface DebuggerFeatureMap {
  breakpointUpdate?: boolean;
  eventStream?: boolean;
  stackPagination?: boolean;
  variableHandles?: boolean;
  nativeSetVariable?: boolean;
}

export interface DebuggerProtocolInfo {
  debuggerProtocolVersion?: number;
  debuggerFeatures?: DebuggerFeatureMap;
}

export type RuntimeReference = number | string;

export interface RuntimeReferenceHandle {
  handle: string;
  sessionId: string;
  ideSessionId: string;
  pauseEpoch: number;
}

export interface RuntimeStackRequest {
  offset: number;
  limit: number;
  pauseEpoch?: number;
}

export interface RuntimeStackResult {
  threadId: ThreadId | null;
  stackFrames: AnyRecord[];
  offset: number;
  totalFrames?: number;
  completeness: "complete" | "partial" | "unknown";
  nextOffset?: number;
  truncationReason?: "limit" | "provider" | "timeout" | "noSuspendContext";
  pauseEpoch?: number;
}

export interface NativeSetVariableResult {
  applied: boolean;
  verified: boolean;
  mutationMode: "native" | "evaluateAssignment";
  oldValue: string | number | boolean | null;
  newValue?: string;
  value?: AnyRecord;
  message?: string;
  warnings?: string[];
}

export function negotiateDebuggerFeatures(
  client: DebuggerProtocolInfo,
  session: DebuggerProtocolInfo
): Required<DebuggerFeatureMap>;
```

### Task 1: Negotiate Bridge Protocol V2 Truthfully

**Files:**
- Create: `src/ide/DebuggerFeatureNegotiation.ts`
- Modify: `src/types/ide.ts`
- Modify: `src/ide/IdeProtocol.ts`
- Modify: `src/ide/IdeClientRegistry.ts`
- Modify: `src/ide/IdeBridgeServer.ts`
- Create: `test/ide-bridge-v2-negotiation.test.ts`

**Interfaces:**
- Consumes: client registration and live IDE session messages.
- Produces: a per-live-session negotiated feature record and a monotonically maintained `pauseEpoch` that core can use for response correlation.

- [ ] **Step 1: Write failing feature-negotiation tests**

Create `test/ide-bridge-v2-negotiation.test.ts`:

```ts
import assert from "node:assert/strict";
import { negotiateDebuggerFeatures } from "../src/ide/DebuggerFeatureNegotiation.ts";

assert.equal(negotiateDebuggerFeatures({ debuggerProtocolVersion: 1, debuggerFeatures: { variableHandles: true } }, {}).variableHandles, false);
assert.equal(negotiateDebuggerFeatures({ debuggerProtocolVersion: 2, debuggerFeatures: { variableHandles: true } }, {}).variableHandles, true);
assert.equal(negotiateDebuggerFeatures(
  { debuggerProtocolVersion: 2, debuggerFeatures: { nativeSetVariable: true } },
  { debuggerProtocolVersion: 2, debuggerFeatures: { nativeSetVariable: false } }
).nativeSetVariable, false);

const registry = new IdeClientRegistry();
registry.register(v2Client("client-a"));
registry.updateSession("client-a", { ideSessionId: "ide-1", state: "paused", pauseEpoch: 4 });
assert.equal(registry.getSession("client-a", "ide-1")?.pauseEpoch, 4);
```

Add assertions that an old client gets no v2 request, a client replacement invalidates the prior session epoch, and a paused event with a higher epoch replaces lower-epoch state only.

- [ ] **Step 2: Run negotiation tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/ide-bridge-v2-negotiation.test.ts
```

Expected: FAIL because the feature negotiation module and typed pause epoch do not exist.

- [ ] **Step 3: Implement typed negotiation and registry storage**

Create `DebuggerFeatureNegotiation.ts` using explicit booleans only:

```ts
const featureNames = ["breakpointUpdate", "eventStream", "stackPagination", "variableHandles", "nativeSetVariable"] as const;
export function negotiateDebuggerFeatures(client: DebuggerProtocolInfo, session: DebuggerProtocolInfo): Required<DebuggerFeatureMap> {
  const clientV2 = (client.debuggerProtocolVersion ?? 0) >= 2;
  const sessionV2 = (session.debuggerProtocolVersion ?? client.debuggerProtocolVersion ?? 0) >= 2;
  return Object.fromEntries(featureNames.map((feature) => [feature,
    clientV2 && sessionV2 && session.debuggerFeatures?.[feature] !== false && client.debuggerFeatures?.[feature] === true
  ])) as Required<DebuggerFeatureMap>;
}
```

In `src/types/ide.ts`, add `DebuggerProtocolInfo`, optional `pauseEpoch`, `expectedPauseEpoch`, `ref: RuntimeReference`, `offset`, and `limit` to typed bridge payloads. In `IdeProtocol.ts`, add `AGENT_REQUEST_STACK: "agent_request_stack"`, keep `IDE_STACK_SNAPSHOT`, and extend existing variable/set-variable messages rather than adding parallel tool names. Persist raw protocol information and current `pauseEpoch` in `IdeClientRegistry`; only accept a response/message matching a known client and session.

- [ ] **Step 4: Run negotiation and existing IDE registry tests**

Run:

```bash
node --experimental-strip-types --test test/ide-bridge-v2-negotiation.test.ts test/ide-runtime-provider.test.ts
npm run typecheck
```

Expected: PASS; protocol-v1 clients retain no v2 feature even if they send a legacy alias.

- [ ] **Step 5: Commit protocol negotiation**

```bash
git add src/ide/DebuggerFeatureNegotiation.ts src/types/ide.ts src/ide/IdeProtocol.ts src/ide/IdeClientRegistry.ts src/ide/IdeBridgeServer.ts test/ide-bridge-v2-negotiation.test.ts
git commit -m "feat(ide): negotiate debugger protocol features"
```

### Task 2: Publish Pause-Scoped Handles, Stack Pages, And Ref-First Contracts

**Files:**
- Create: `src/runtime/RuntimeHandle.ts`
- Modify: `src/types/inspection.ts`
- Modify: `src/types/sessions.ts`
- Modify: `src/control/schemaFragments.ts`
- Modify: `src/control/toolDefinitions.ts`
- Modify: `src/control/toolOutputSchemas.ts`
- Modify: `src/utils/errors.ts`
- Create: `test/ide-runtime-handles.test.ts`
- Create: `test/ide-stack-pagination.test.ts`
- Create: `test/ide-native-set-value.test.ts`

**Interfaces:**
- Consumes: number-or-string reference values and stack page metadata from a provider.
- Produces: public exact schemas and core stale-handle checks before a bridge request is sent.

- [ ] **Step 1: Write failing public contract tests**

Create `test/ide-runtime-handles.test.ts`:

```ts
const handle = { handle: "bpref_opaque", sessionId: "debug-1", ideSessionId: "ide-1", pauseEpoch: 3 };
assert.doesNotThrow(() => assertHandleEpoch(handle, 3));
assert.throws(() => assertHandleEpoch(handle, 4), (error: Error & { code?: string }) =>
  error.code === "STALE_RUNTIME_HANDLE" && (error as any).details.currentEpoch === 4
);
```

Create `test/ide-stack-pagination.test.ts` asserting that a page with `totalFrames: 10`, `offset: 0`, and two frames has `completeness:"partial"`, `nextOffset:2`, and `partial:true`; a final page with all frames is complete; an absent total is unknown and partial. Create `test/ide-native-set-value.test.ts` asserting schemas accept exactly `{ref:"bpref_opaque",newValue:"42"}` or `{path:["x"],newValue:"42"}`, reject both targets together, and require `verified`/`mutationMode` in a set-value success response.

- [ ] **Step 2: Run the new contract tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/ide-runtime-handles.test.ts test/ide-stack-pagination.test.ts test/ide-native-set-value.test.ts
```

Expected: FAIL because references are numbers only, no stale-handle code exists, and stack/set-value schemas lack the fields.

- [ ] **Step 3: Implement core types and exact schemas**

Create `src/runtime/RuntimeHandle.ts`:

```ts
export function assertHandleEpoch(handle: RuntimeReferenceHandle, currentEpoch: number): void {
  if (handle.pauseEpoch !== currentEpoch) {
    throw new BreakPilotError(ErrorCodes.STALE_RUNTIME_HANDLE, "Runtime reference belongs to an earlier paused state.", {
      handle: handle.handle, currentEpoch, retrySafe: true, recommendedAction: "Request fresh context and use a newly returned reference."
    });
  }
}
```

Replace reference fields in `src/types/inspection.ts` with `RuntimeReference = number | string`, and add `pauseEpoch`, `childrenCount`, `complete`, `truncated`, `modifiable`, and `mutationMode` to variable nodes. Replace `getCallStack`'s `number | object` compatibility parameter with `RuntimeStackRequest` and result with `RuntimeStackResult`. In tool schemas, use an explicit `oneOf` for number or string ref; `bp_debug_set_value` must use closed `oneOf` branches for ref target and path target. Add `STALE_RUNTIME_HANDLE` and `VARIABLE_NOT_MUTABLE` to `ErrorCodes`; widen compact frame identifiers to number|string before protocol-v2 values can reach final output validation.

- [ ] **Step 4: Run model/schema tests**

Run:

```bash
node --experimental-strip-types --test test/ide-runtime-handles.test.ts test/ide-stack-pagination.test.ts test/ide-native-set-value.test.ts
npm run typecheck
```

Expected: PASS; agent-facing schemas make freshness, page completeness, and mutation truth machine-readable.

- [ ] **Step 5: Commit core IDE runtime contracts**

```bash
git add src/runtime/RuntimeHandle.ts src/types/inspection.ts src/types/sessions.ts src/control/schemaFragments.ts src/control/toolDefinitions.ts src/control/toolOutputSchemas.ts src/utils/errors.ts test/ide-runtime-handles.test.ts test/ide-stack-pagination.test.ts test/ide-native-set-value.test.ts
git commit -m "feat(runtime): add pause scoped IDE contracts"
```

### Task 3: Make The Core IDE Provider Correlate V2 Requests And Truthful Fallbacks

**Files:**
- Modify: `src/runtime/ProviderCapabilities.ts`
- Modify: `src/runtime/providers/IdeRuntimeProvider.ts`
- Modify: `src/sessions/DebugSessionManager.ts`
- Modify: `test/ide-runtime-provider.test.ts`
- Modify: `test/provider-capabilities.test.ts`
- Modify: `test/operation-capability-gates.test.ts`

**Interfaces:**
- Consumes: negotiated feature records, current pause epoch, and typed v2 bridge replies.
- Produces: direct stack pages, string-ref expansion/mutation, native-vs-fallback capability truth, and stale-response rejection.

- [ ] **Step 1: Write failing core-provider tests**

Extend `test/ide-runtime-provider.test.ts`:

```ts
await provider.getCallStack(7, { offset: 4, limit: 2, pauseEpoch: 5 });
assert.deepEqual(lastBridgeRequest, {
  type: "agent_request_stack", ideSessionId: "ide-1", threadId: 7,
  offset: 4, limit: 2, expectedPauseEpoch: 5
});
bridge.reply({ type: "ide_stack_snapshot", ideSessionId: "wrong", requestId, pauseEpoch: 5 });
assert.equal(promiseState, "pending");
bridge.reply({ type: "ide_stack_snapshot", ideSessionId: "ide-1", requestId, pauseEpoch: 4 });
await assert.rejects(promise, (error: Error & { code?: string }) => error.code === "STALE_RUNTIME_HANDLE");
```

Add cases for protocol-v1 stack fallback producing `{ completeness:"unknown", partial:true }`, native string-ref variable expansion, native mutation without read-back resulting in `verified:false`, a nonmodifiable ref returning `VARIABLE_NOT_MUTABLE`, and old path assignment retaining `mutationMode:"evaluateAssignment"`.

- [ ] **Step 2: Run provider tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/ide-runtime-provider.test.ts test/provider-capabilities.test.ts test/operation-capability-gates.test.ts
```

Expected: FAIL because the provider derives stack from a snapshot, coerces refs, and has no v2 correlation.

- [ ] **Step 3: Implement negotiated provider behavior**

In `IdeRuntimeProvider`, add a shared request helper that requires matching `clientId`, `ideSessionId`, `requestId`, and `pauseEpoch`. If `stackPagination` is negotiated, send `AGENT_REQUEST_STACK`, return the plugin's page untouched after validating its epoch, and compute `partial` only from `completeness`. If it is not negotiated, retain the existing snapshot call but report `completeness:"unknown"`, `partial:true`, and no fabricated total/next offset.

For `inspectVariable`, pass a string `ref` plus `expectedPauseEpoch` untouched. For `setVariable`, prefer a ref target and only choose `mutationMode:"native"` when `nativeSetVariable` is negotiated and the response proves it. Path target uses existing assignment evaluation with `mutationMode:"evaluateAssignment"`. `ProviderCapabilities` returns `variableReferences:"native"` only with negotiated variable handles and `setValue:"native"` only with negotiated native setter; older plugin states remain `snapshot`/`evaluateAssignment`.

In `DebugSessionManager`, pass `offset`/`limit` to the provider without re-slicing returned stack frames; preserve string refs in `bpDebugValue`; allow ref-first `bpDebugSetValue`; invalidate current handles on control transitions and IDE frame-change state.

- [ ] **Step 4: Run provider and manager regressions**

Run:

```bash
node --experimental-strip-types --test test/ide-runtime-provider.test.ts test/provider-capabilities.test.ts test/operation-capability-gates.test.ts test/ide-runtime-handles.test.ts test/ide-stack-pagination.test.ts test/ide-native-set-value.test.ts
npm test
```

Expected: PASS; core never treats a mismatched epoch or session as current runtime evidence.

- [ ] **Step 5: Commit core v2 provider support**

```bash
git add src/runtime/ProviderCapabilities.ts src/runtime/providers/IdeRuntimeProvider.ts src/sessions/DebugSessionManager.ts test/ide-runtime-provider.test.ts test/provider-capabilities.test.ts test/operation-capability-gates.test.ts
git commit -m "feat(ide): use negotiated runtime handles"
```

### Task 4: Stream Normalized IDE Events Into The Shared Runtime Buffer

**Files:**
- Modify: `src/ide/IdeProtocol.ts`
- Modify: `src/types/ide.ts`
- Modify: `src/ide/IdeBridgeServer.ts`
- Modify: `src/sessions/DebugSessionManager.ts`
- Modify: `src/runtime/ProviderCapabilities.ts`
- Create: `test/ide-runtime-events.test.ts`
- Modify: `breakpilot-vscode/src/debugger/DebugSessionTracker.ts`
- Modify: `breakpilot-vscode/src/bridge/BridgeClient.ts`
- Modify: `breakpilot-idea/src/main/kotlin/debugger/IdeSessionTracker.kt`
- Modify: `breakpilot-idea/src/main/kotlin/bridge/BridgeClient.kt`

**Interfaces:**
- Consumes: an `ide_debug_event` bridge message with session identity, pause epoch, normalized kind, and only allowlisted event data.
- Produces: a `RuntimeEventBuffer` entry with monotonically allocated BreakPilot sequence numbers, so `bp_debug_control(action:"drainEvents")` returns real IDE events without affecting a stop waiter.

- [ ] **Step 1: Write failing IDE event-stream tests**

Create `test/ide-runtime-events.test.ts`:

```ts
bridge.receive({
  type: "ide_debug_event", clientId: "client-1", ideSessionId: "ide-1", pauseEpoch: 6,
  event: { kind: "output", category: "stdout", message: "server ready" }
});
bridge.receive({
  type: "ide_debug_event", clientId: "client-1", ideSessionId: "ide-1", pauseEpoch: 7,
  event: { kind: "stopped", threadId: 4, position: { file: "Foo.java", line: 20 } }
});
const events = await manager.bpDebugControl({ sessionId, action: "drainEvents", cursor: 0, limit: 8 });
assert.deepEqual((events.events as AnyRecord).items.map((event: AnyRecord) => event.kind), ["output", "stopped"]);
assert.equal((events.events as AnyRecord).items[1]?.threadId, 4);
assert.equal(provider.waitForBreakpointCalls, 0, "event drain does not consume or invoke a stop waiter");
```

Add cases that a v1 client or v2 client with `eventStream:false` leaves `eventDrain` unsupported, mismatched client/session messages are ignored, and an unknown event kind is rejected/audited without serializing its payload.

- [ ] **Step 2: Run the event-stream test and verify red**

Run:

```bash
node --experimental-strip-types --test test/ide-runtime-events.test.ts
```

Expected: FAIL because `ide_debug_event` is not a protocol message and manager does not consume IDE events into its buffer.

- [ ] **Step 3: Implement allowlisted bridge event routing**

Add `IDE_DEBUG_EVENT: "ide_debug_event"` to `IdeMessageTypes` and a typed bridge payload:

```ts
export interface BridgeDebugEvent {
  kind: "breakpoint" | "breakpointError" | "tracepoint" | "output" | "stopped" | "continued" | "thread" | "process" | "invalidated" | "terminated";
  breakpointId?: string;
  threadId?: number | string;
  position?: AnyRecord;
  message?: string;
  category?: string;
  data?: AnyRecord;
}
```

In `DebugSessionManager.#wireIdeBridge`, listen for this message, resolve the adopted record by both client and IDE session, require negotiated `eventStream`, normalize only the declared fields, and append to that record's `RuntimeEventBuffer`. The manager must reject raw stack/variable payloads from `data`; retain only an allowlisted scalar/object metadata subset. Update `ProviderCapabilities` so IDE `eventDrain:"native"` requires live negotiated event stream and a manager-attached buffer.

In VS Code, make `DebugSessionTracker` forward DAP adapter output/continued/stopped/thread/terminated/invalidate events as `ide_debug_event` in arrival order, without exposing raw adapter packets. In IntelliJ, make `IdeSessionTracker` forward pause/resume/termination and available breakpoint/output/invalidation notifications using the same normalized envelope. Both plugins declare `eventStream:true` only for sessions actually wired to those sources.

- [ ] **Step 4: Run event, capability, and extension compilation tests**

Run:

```bash
node --experimental-strip-types --test test/ide-runtime-events.test.ts test/provider-capabilities.test.ts
npm --prefix breakpilot-vscode run compile
gradle -p breakpilot-idea compileKotlin
```

Expected: PASS; the shared event drain reports real, ordered IDE events and a legacy client keeps an honest unsupported capability.

- [ ] **Step 5: Commit IDE event streaming**

```bash
git add src/ide/IdeProtocol.ts src/types/ide.ts src/ide/IdeBridgeServer.ts src/sessions/DebugSessionManager.ts src/runtime/ProviderCapabilities.ts test/ide-runtime-events.test.ts breakpilot-vscode/src/debugger/DebugSessionTracker.ts breakpilot-vscode/src/bridge/BridgeClient.ts breakpilot-idea/src/main/kotlin/debugger/IdeSessionTracker.kt breakpilot-idea/src/main/kotlin/bridge/BridgeClient.kt
git commit -m "feat(ide): stream normalized debugger events"
```

### Task 5: Implement VS Code Handles, Paged Stacks, And Native SetVariable

**Files:**
- Create: `breakpilot-vscode/src/debugger/PauseScopedHandleRegistry.ts`
- Create: `breakpilot-vscode/src/debugger/StackReader.ts`
- Modify: `breakpilot-vscode/src/debugger/DebugSessionTracker.ts`
- Modify: `breakpilot-vscode/src/debugger/VariableReader.ts`
- Modify: `breakpilot-vscode/src/debugger/CommandExecutor.ts`
- Modify: `breakpilot-vscode/src/bridge/MessageProtocol.ts`
- Modify: `breakpilot-vscode/src/bridge/BridgeClient.ts`
- Modify: `breakpilot-vscode/src/extension.ts`
- Create: `test/vscode-runtime-handles.test.ts`
- Create: `test/vscode-stack-reader.test.ts`

**Interfaces:**
- Consumes: adapter `initialize` capabilities, a DAP variable reference plus parent/name metadata, and an active pause epoch.
- Produces: opaque handle tokens, `stackTrace` pages, `setVariable` read-back evidence, and session-level v2 capability declarations.

- [ ] **Step 1: Write failing VS Code pure-helper tests**

Create `test/vscode-runtime-handles.test.ts`:

```ts
const handles = new PauseScopedHandleRegistry(2);
const ref = handles.register({ sessionId: "s", pauseEpoch: 3, dapVariablesReference: 19, parentVariablesReference: 7, name: "score" });
assert.match(ref, /^bpref_/);
assert.equal(handles.resolve(ref, "s", 3)?.parentVariablesReference, 7);
assert.equal(handles.resolve(ref, "s", 4), undefined);
handles.invalidateSession("s");
assert.equal(handles.resolve(ref, "s", 3), undefined);
```

Create `test/vscode-stack-reader.test.ts` with a fake `customRequest` and assert it sends `{ threadId:2,startFrame:3,levels:2 }`, preserves `totalFrames:8`, returns `nextOffset:5`, and reports `unknown` rather than complete when `totalFrames` is absent.

- [ ] **Step 2: Run pure-helper tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/vscode-runtime-handles.test.ts test/vscode-stack-reader.test.ts
```

Expected: FAIL because neither helper exists.

- [ ] **Step 3: Implement plugin-native VS Code runtime operations**

Implement a bounded registry that produces random `bpref_` tokens and stores `{ dapVariablesReference, parentVariablesReference, name, evaluateName?, threadId, frameId, sessionId, pauseEpoch, modifiable }`; no raw DAP reference appears in the token. `StackReader` must issue `customRequest("stackTrace", { threadId, startFrame: offset, levels: limit })`, use explicit `totalFrames` when supplied, and calculate completeness/next offset without assuming a page length proves completeness.

Capture the debug adapter `initialize` response in `DebugSessionTracker`; increment/invalidate epoch at real stop, continue, termination, reconnect, and frame selection change (deduplicate tracker and UI events describing the same stop). `VariableReader` registers every expandable/modifiable variable and expands a string handle only after registry/epoch validation. For native mutation it calls:

```ts
session.customRequest("setVariable", {
  variablesReference: descriptor.parentVariablesReference,
  name: descriptor.name,
  value: newValue
});
```

then reads the same parent variables and compares the named child before setting `verified:true`. `supportsSetExpression` remains evaluate-assignment fallback. Add protocol-v2 client declarations and session-level feature state; dispatch the new stack request in `CommandExecutor`.

- [ ] **Step 4: Run helper tests and extension compilation**

Run:

```bash
node --experimental-strip-types --test test/vscode-runtime-handles.test.ts test/vscode-stack-reader.test.ts
npm --prefix breakpilot-vscode run compile
```

Expected: PASS; native set-variable request never uses a child variable reference as its parent slot.

- [ ] **Step 5: Commit VS Code runtime fidelity**

```bash
git add breakpilot-vscode/src/debugger/PauseScopedHandleRegistry.ts breakpilot-vscode/src/debugger/StackReader.ts breakpilot-vscode/src/debugger/DebugSessionTracker.ts breakpilot-vscode/src/debugger/VariableReader.ts breakpilot-vscode/src/debugger/CommandExecutor.ts breakpilot-vscode/src/bridge/MessageProtocol.ts breakpilot-vscode/src/bridge/BridgeClient.ts breakpilot-vscode/src/extension.ts test/vscode-runtime-handles.test.ts test/vscode-stack-reader.test.ts
git commit -m "feat(ide): add vscode native runtime handles"
```

### Task 6: Implement IntelliJ Handles, Stack Paging, And Modifier-Backed Mutation

**Files:**
- Create: `breakpilot-idea/src/main/kotlin/debugger/PauseScopedHandleRegistry.kt`
- Create: `breakpilot-idea/src/main/kotlin/debugger/StackReader.kt`
- Create: `breakpilot-idea/src/main/kotlin/debugger/IdeaValueModifierAdapter.kt`
- Modify: `breakpilot-idea/src/main/kotlin/debugger/VariableReader.kt`
- Modify: `breakpilot-idea/src/main/kotlin/debugger/CommandExecutor.kt`
- Modify: `breakpilot-idea/src/main/kotlin/debugger/IdeSessionTracker.kt`
- Modify: `breakpilot-idea/src/main/kotlin/bridge/MessageProtocol.kt`
- Modify: `breakpilot-idea/src/main/kotlin/bridge/BridgeClient.kt`
- Modify: `breakpilot-idea/src/main/kotlin/plugin/BreakPilotIdeaPlugin.kt`
- Create: `breakpilot-idea/src/test/kotlin/debugger/PauseScopedHandleRegistryTest.kt`
- Create: `breakpilot-idea/src/test/kotlin/debugger/StackPaginationModelTest.kt`
- Modify: `breakpilot-idea/build.gradle.kts` only if it lacks Kotlin test dependencies/source-set setup.

**Interfaces:**
- Consumes: a suspend context's `XExecutionStack` and `XValue` objects at one epoch.
- Produces: opaque plugin-local handles, page-complete stack evidence, and native modifier outcomes that are discarded if callbacks become stale.

- [ ] **Step 1: Write failing Kotlin model tests and an SDK compile spike**

Create `PauseScopedHandleRegistryTest.kt`:

```kotlin
@Test fun `handle resolves only in original epoch`() {
  val registry = PauseScopedHandleRegistry(maxEntries = 2)
  val ref = registry.register("session", 3, fakeXValue, frameKey = "frame-1", evaluateName = "score")
  assertNotNull(registry.resolve(ref, "session", 3))
  assertNull(registry.resolve(ref, "session", 4))
  registry.invalidate("session")
  assertNull(registry.resolve(ref, "session", 3))
}
```

Create `StackPaginationModelTest.kt` asserting final vs limited vs provider-timeout pages calculate `complete`, `partial`, `unknown`, and `nextOffset` exactly. Add a compile-only test target that instantiates `IdeaValueModifierAdapter` against the configured IntelliJ SDK; it must fail if `XValueModifier` APIs are not available under the assumed signature.

- [ ] **Step 2: Run Kotlin tests/compile and verify red**

Run:

```bash
gradle -p breakpilot-idea test
gradle -p breakpilot-idea compileKotlin
```

Expected: FAIL initially because the registry/stack/modifier classes and possibly test setup do not exist.

- [ ] **Step 3: Implement IntelliJ runtime operations Behind The SDK Adapter**

Keep raw `XValue`/frame objects only in `PauseScopedHandleRegistry`. `StackReader` invokes `XExecutionStack.computeStackFrames(offset, container)`, makes `limit` a local cap, and records whether completion came from the provider, the local page limit, timeout, or no suspend context. It returns `ide_stack_snapshot` with `offset`, `totalFrames` only when known, `completeness`, `nextOffset`, `truncationReason`, and epoch.

In `VariableReader`, register each expandable/modifiable `XValue`, return `ref`, `pauseEpoch`, child metadata, and request children through `XValue.computeChildren` only after resolving the exact registry entry. `IdeaValueModifierAdapter` is the only class that touches the configured SDK's `getModifier`/`getModifierAsync` and `setValue` signature. It must provide:

```kotlin
fun setValue(entry: HandleEntry, newValue: String, expectedEpoch: Long, callback: (NativeMutationOutcome) -> Unit)
```

Every callback compares current epoch before publishing and performs a read-back through the same entry/parent. No modifier plus a stable evaluation name permits the existing assignment fallback; no modifier and no stable name returns `VARIABLE_NOT_MUTABLE` without evaluation. `IdeSessionTracker` owns epoch changes/invalidation, and bridge messages advertise v2 features only when the adapter is actually initialized and enabled.

- [ ] **Step 4: Run IntelliJ tests and compilation**

Run:

```bash
gradle -p breakpilot-idea test
gradle -p breakpilot-idea compileKotlin
```

Expected: PASS; stale callback tests show that an old modifier result cannot update a newer pause state.

- [ ] **Step 5: Commit IntelliJ runtime fidelity**

```bash
git add breakpilot-idea/src/main/kotlin/debugger/PauseScopedHandleRegistry.kt breakpilot-idea/src/main/kotlin/debugger/StackReader.kt breakpilot-idea/src/main/kotlin/debugger/IdeaValueModifierAdapter.kt breakpilot-idea/src/main/kotlin/debugger/VariableReader.kt breakpilot-idea/src/main/kotlin/debugger/CommandExecutor.kt breakpilot-idea/src/main/kotlin/debugger/IdeSessionTracker.kt breakpilot-idea/src/main/kotlin/bridge/MessageProtocol.kt breakpilot-idea/src/main/kotlin/bridge/BridgeClient.kt breakpilot-idea/src/main/kotlin/plugin/BreakPilotIdeaPlugin.kt breakpilot-idea/src/test/kotlin/debugger/PauseScopedHandleRegistryTest.kt breakpilot-idea/src/test/kotlin/debugger/StackPaginationModelTest.kt breakpilot-idea/build.gradle.kts
git commit -m "feat(ide): add idea native runtime handles"
```

## Final Verification

- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, `npm --prefix breakpilot-vscode run compile`, `gradle -p breakpilot-idea test`, `gradle -p breakpilot-idea compileKotlin`, and `npm run check:runtime`.
- [ ] Confirm a v1 bridge client never receives a v2 stack or opaque-handle command.
- [ ] Confirm a returned opaque ref becomes stale after every required lifecycle transition and cannot read a later pause.
- [ ] Confirm a stack with no trusted total reports `unknown`, never `complete`.
- [ ] Confirm native setter verification always derives from a fresh read-back, including failure/obsolete callback routes.
- [ ] Inspect `git status --short` and `git diff --cached --stat` before every commit; leave unrelated changes unstaged.
