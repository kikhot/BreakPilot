# BreakPilot Trustworthy Agent Debugger Design

Date: 2026-07-12

## Goal

Evolve BreakPilot from a collection of debugger-shaped MCP tools into a
trustworthy Agent Runtime Debugger: a cross-provider control plane that lets an
agent manipulate execution and breakpoints, understand runtime evidence, and
recover safely from confirmation, concurrency, reconnect, and stale-state
boundaries.

The public `bp_debug_*` names remain stable. The implementation becomes more
strict about what each provider actually supports and never reports an ignored
request as verified or a timed-out transition as paused.

## Evidence Behind The Design

The design was informed by sanitized semantic notes attributed to a differential
run against the same paused Java request in IDEA native MCP and BreakPilot MCP.
Those notes place both providers at `HelloController.java:24` with
`analysis.score = 28`. The original raw responses, capture transcript, exact
versions, timestamps, and hashes were not retained, so the checked-in fixture is
a deterministic regression oracle rather than independently verifiable capture
evidence.

BreakPilot was better at returning structured frame and value nodes, project
routing, IDE-session adoption, error codes, and aggregated context. It was
worse at preserving method names, non-line breakpoint types, complete thread
lists, breakpoint update semantics, real event draining, and non-blocking user
confirmation. Readonly evaluate, set-value, run-to-line, and step-over all
timed out waiting for IDE confirmation in the unattended flow.

Static inspection also established that advanced breakpoint fields are
advertised but ignored by the IDEA plugin, execution locks are defined but not
used, IDE-path variable redaction is not applied, and Bridge responses are not
fully bound to an authenticated client identity.

## Product Principles

1. **Truth before parity.** Unsupported or partially applied behavior is
   explicit. A provider must not echo requested fields as if they were applied.
2. **Agent-readable by default.** Runtime evidence uses typed JSON with stable
   paths and completeness metadata, not IDE presentation strings.
3. **Atomic control observations.** A state-changing command and the evidence
   produced by its final stop belong to one operation.
4. **Stale state is an error.** Frames, paths, and variable references are bound
   to the stop that created them.
5. **Safe interaction does not block invisibly.** User confirmation is an
   observable asynchronous state, not a hidden 30-second wait.
6. **Provider differences are capabilities.** IDEA, VS Code, and DAP may use
   different implementations while returning the same public result shape.
7. **Local does not mean unauthenticated.** HTTP, MCP, and IDE Bridge traffic
   are bound to a local instance identity and secret.

## Compatibility

- Keep all current `bp_debug_*` tool names.
- Keep existing common input names such as `projectPath`, `sessionId`,
  `filePath`, `line`, `frameIndex`, `path`, and `ref`.
- Successful result payloads may gain `operationId`, `stopEpoch`, `capabilities`,
  `completeness`, `source`, and `warnings`.
- Existing compact fields remain available when they are truthful.
- Fields that are currently advertised but unimplemented are either
  implemented in the corresponding phase or return `UNSUPPORTED_CAPABILITY`
  with `unsupportedFields`.
- No parallel `xdebug_*` compatibility surface is introduced.

## Target Architecture

```text
MCP / CLI / HTTP
        |
        v
Typed Tool Contracts + Runtime Validation
        |
        v
Debug Operation Service ---- Confirmation Service
        |
        v
Session Execution Coordinator (owner, lock, stopEpoch)
        |
        +---- Observation Service
        +---- Breakpoint Reconciler
        +---- Capability Service
        |
        v
DAP / IDEA / VS Code Runtime Providers
        |
        v
Authenticated IDE Bridge or Debug Adapter
```

The existing `DebugSessionManager` remains the public orchestration facade
during migration, but operation, observation, breakpoint, and capability logic
move into focused services. This avoids a single disruptive rewrite of the
2,000-line manager.

## Core Contracts

### Tool Result

Every tool has a concrete output schema. Errors retain the existing structured
shape.

```ts
interface ToolError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

type ToolResult<T> =
  | (T & { warnings?: string[] })
  | { error: ToolError; warnings?: string[] };
```

The router validates input and applies defaults before dispatch. It rejects
unknown mode combinations, invalid ranges, and missing discriminator fields.

### Provider Capability Matrix

```ts
type CapabilityLevel = "native" | "fallback" | "unsupported";

interface RuntimeProviderCapabilities {
  pause: CapabilityLevel;
  stepping: CapabilityLevel;
  runToLine: CapabilityLevel;
  variableReferences: "native" | "snapshot" | "unsupported";
  setValue: "native" | "evaluateAssignment" | "unsupported";
  breakpointUpdate: CapabilityLevel;
  conditionalBreakpoints: CapabilityLevel;
  hitConditionalBreakpoints: CapabilityLevel;
  tracepoints: CapabilityLevel;
  eventDrain: CapabilityLevel;
}
```

`bp_debug_status` and `bp_debug_start` return the selected session's capability
matrix. The agent can choose a fallback before making an unsupported call.

### Debug Operation

```ts
type DebugOperationState =
  | "confirmation_required"
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

interface DebugOperation<T = Record<string, unknown>> {
  operationId: string;
  sessionId: string;
  action: string;
  state: DebugOperationState;
  stopEpoch?: number;
  confirmation?: {
    confirmationId: string;
    expiresAt: string;
    rememberScopes: Array<"once" | "session" | "project">;
  };
  result?: T;
  error?: ToolError;
}
```

Safe read operations remain synchronous. A control or mutation request that
requires consent returns `confirmation_required` immediately. A single public
`bp_debug_operation` tool provides `status`, `wait`, and `cancel` actions for
pending operations. This one addition is preferred over adding separate
confirmation tools for every debugger command.

### Stop Epoch And Handles

```ts
interface RuntimeHandle {
  sessionId: string;
  stopEpoch: number;
  threadId?: number | string;
  frameId?: number | string;
}
```

Every transition to paused increments `stopEpoch`. Frame, value, evaluate, and
set-value requests may carry the epoch returned by the observation that created
their handle. Once execution resumes, old handles fail with
`STALE_RUNTIME_HANDLE`. Compatibility calls that omit epoch may select the
current stop only when unambiguous and return a warning in diagnostic mode.

### Runtime Observation

```ts
interface RuntimeObservation {
  sessionId: string;
  stopEpoch: number;
  reason: "breakpoint" | "step" | "pause" | "exception" | "entry" | "unknown";
  position: { filePath: string | null; line: number | null; column?: number | null };
  thread: RuntimeThread;
  frames: RuntimeFrame[];
  scopes?: RuntimeScope[];
  completeness: "complete" | "partial";
  warnings?: string[];
}
```

Control tools with `includeFrame` and the aggregate context tool return this
model. Provider-specific presentation may be included only in diagnostic
detail.

### Variable Node

```ts
interface RuntimeVariableNode {
  name: string;
  value: string;
  type?: string;
  path: string[];
  ref?: number | string;
  children?: RuntimeVariableNode[];
  childrenCount?: number;
  nextCursor?: string;
  complete: boolean;
  truncated: boolean;
  redacted: boolean;
  presentationPending: boolean;
  cycle?: boolean;
}
```

IDE and DAP providers return the same node shape. Strings, arrays, lists, and
maps prefer logical values over implementation internals. Redaction occurs in
the IDE plugin before transport and again in the daemon.

### Breakpoint Desired And Applied State

Breakpoint specs use a discriminated union for `source`, `exception`,
`function`, `data`, and `unknown` breakpoints. Source breakpoint results expose
both requested and applied state.

```ts
interface BreakpointApplicationResult {
  breakpointId: string;
  requested: BreakpointSpec;
  applied: AppliedBreakpoint;
  unsupportedFields: string[];
  verified: boolean;
  source: "idea" | "vscode" | "dap";
  warnings?: string[];
}
```

Update and relocate use `breakpointId`. Removal is committed to local state only
after provider acknowledgement. IDE reconnect triggers full desired/applied
reconciliation.

## Execution Semantics

- Every pause, resume, step, run-to-line, evaluate, set-value, stop, and
  disconnect operation goes through `SessionCoordinator`.
- One execution-changing operation may run per session.
- Operations carry an `operationId`; provider events are correlated to that
  operation and the selected IDE client/session.
- Command acknowledgement is distinct from the final runtime state.
- A timed-out step never marks the session paused without a matching stop.
- Stop or disconnect failure preserves session state and returns a retryable
  error.
- `runtime.maxPauseMs` starts a watchdog. Policy decides whether expiry resumes,
  stops, or reports a required user action.

Atomic helpers such as step-and-capture are implemented internally first. The
existing `bp_debug_control` surface uses them so callers receive the final stop
and optional observation without manually racing separate requests.

## Confirmation Semantics

- Confirmation policy categorizes safe inspection, execution control,
  breakpoint mutation, runtime mutation, and unsafe evaluation.
- A pending confirmation is visible through `DebugOperation` within one second.
- IDEA and VS Code plugins respond with the operation, client, session, and
  confirmation identities.
- Remembered approval follows the existing once/session/project boundaries.
- Timeout changes the operation to `failed` with `IDE_CONFIRMATION_TIMEOUT`; it
  never leaves an invisible pending command.
- Set-value confirmation describes `set_value`, not the preparatory variable
  read used to resolve its path.

## Breakpoint And Event Semantics

- Advanced fields are applied provider-by-provider or returned in
  `unsupportedFields`.
- Disabled breakpoints are not sent as active DAP breakpoints.
- Temporary breakpoints have explicit ownership and cleanup lifecycle.
- Non-line breakpoints retain their native type; they never use empty path and
  line `-1` as a source breakpoint surrogate.
- Provider breakpoint errors, verification changes, tracepoints, exceptions,
  and log-stack output enter a bounded sequence-numbered buffer.
- `drainEvents` returns real events and a cursor; an unsupported provider
  returns `UNSUPPORTED_CAPABILITY`, not an empty successful result.

## Agent-Readable Evidence

- Frames preserve real method/function presentation and classify application,
  framework, library, and hidden-marker frames.
- Threads support `current`, `application`, and `all` scopes with stable
  deduplication.
- Compact output defaults to application-relevant evidence; diagnostic output
  preserves provider presentation and partial metadata.
- Pending IDE presentations wait within a bounded budget. If still pending, the
  node is marked `presentationPending:true`; placeholder text is not presented
  as the final value.
- Large values use cursor/ref expansion and a total observation budget, not an
  unbounded `maxItems^maxDepth` tree.

## Bridge Security And Recovery

- Hub startup creates an instance ID and cryptographically random secret.
- HTTP control, Streamable MCP, SSE, and WebSocket Bridge authenticate.
- WebSocket validates path, Origin policy, instance, and workspace trust.
- Requests and responses bind `{instanceId, clientId, ideSessionId, requestId}`.
- Plugin client identity is stable within its installation/project scope.
- Reconnect registration includes a complete capabilities, active sessions,
  and breakpoint snapshot.
- Adopted providers rebind to the reconnected client or enter an explicit
  `disconnected` state.
- WebSocket frame decoding preserves incomplete headers and payloads across TCP
  chunks; pending queues are bounded and tied to socket generation.

## Migration Phases

The work is split into independently testable plans:

1. **Typed contracts and differential baseline.** Exact schemas, runtime input
   validation, capability matrix, and a deterministic semantic parity fixture;
   live capture evidence remains a future acceptance layer.
2. **Operations and control correctness.** Operation store, asynchronous
   confirmation, execution locks, stop epochs, atomic control observations, and
   pause watchdog.
3. **Breakpoint truth and events.** Desired/applied reconciliation, advanced
   breakpoint support, update/relocate, provider event buffers, and real drain.
4. **Runtime evidence and variable safety.** Semantic frames/threads, complete
   variable nodes, correct frame-bound eval/set-value, and double redaction.
5. **Bridge security and reconnect.** Authentication, identity binding, robust
   framing, replay, and provider rebinding.
6. **Provider parity and product acceptance.** DAP run-to-line fallback,
   cross-provider behavior, diagnostics, documentation, and end-to-end tests.

## Testing Strategy

Each phase follows red-green-refactor and retains a working public surface.

Required automated coverage:

- Tool schema snapshots and runtime validation tests.
- Model/property tests for operation state and session locks.
- Stale stop-epoch tests.
- Breakpoint desired/applied and owner-protection tests.
- Condition, logpoint, temporary, disabled, and non-line breakpoint tests.
- Tracepoint and breakpoint-error drain tests.
- Variable completeness, pagination, cycle, and redaction tests.
- Bridge authentication, wrong-client response, TCP fragmentation, reconnect,
  and replay tests.
- Provider capability tests for IDEA, VS Code, Python, Node/TypeScript, and Java.

The Java acceptance scenario uses
`/Users/Quixote/workSpace/Java/spring-boot-demo/simple-springboot-demo` and must
prove:

1. Both IDEA native MCP and BreakPilot stop at `HelloController.java:24`.
2. Both observe `analysis.score = 28`.
3. BreakPilot returns the real `hello` frame, not `JavaStackFrame`.
4. Set-value read-back, step, and run-to-line reach the same final state.
5. Confirmation returns pending without blocking.
6. User-owned breakpoints survive cleanup.
7. Reconnect preserves an adopted session.
8. Sensitive variable names and values are redacted.

## Success Criteria

- All public debugger tools have concrete input and output schemas.
- Unsupported behavior is discoverable before execution and explicit afterward.
- No control command reports a runtime state that was not observed.
- Concurrent agents cannot race execution control in one session.
- Stale frames and values are rejected deterministically.
- Breakpoint requested/applied state is truthful across providers.
- Runtime evidence includes completeness and redaction metadata.
- IDE confirmation is non-blocking and observable.
- Bridge traffic is authenticated and correlated to the correct client/session.
- IDEA, VS Code, and Headless DAP use the same agent-facing workflow.

## Non-Goals

- Production-environment debugging.
- Time-travel debugging or replay of process state.
- Direct implementation of every runtime's native debug protocol.
- A second public `xdebug_*` compatibility API.
- Full distributed tracing or multi-process orchestration in this program.
