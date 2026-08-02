# BreakPilot Agent-Readable Compact Contract Design

Date: 2026-08-02

## Purpose

BreakPilot must expose debugger evidence that an agent can understand and act
on without paying for provider-oriented metadata on every call. The public
contract remains structured JSON, but its default representation becomes a
task-complete semantic projection rather than a lightly filtered provider
snapshot.

The existing 15 `bp_debug_*` tool names remain. Inputs and outputs may change
incompatibly because BreakPilot has no external consumers. Existing trust
properties remain mandatory: pause generations, stale-handle rejection,
truthful partial evidence, event cursors, breakpoint ownership, and
side-effect outcome classification.

## Response Modes

Every tool accepts `detail: "compact" | "diagnostic"`; compact is the default.
Diagnostic results are strict supersets of compact results and add one bounded
`diagnostics` object. Detail never changes variable expansion depth.

Compact responses omit false/default fields, empty collections, provider ids,
raw payloads, and healthy completeness declarations. Missing evidence is
explicit through `incomplete`, `warnings`, and continuations.

Pause-bound results contain one root `pauseId`. Public variable handles are
short pause-scoped ids such as `v1`; provider references, parent references,
paths, and mutation mechanisms stay in the Core handle registry. A new pause
invalidates every previous handle.

## Shared Semantic Types

```ts
type Detail = "compact" | "diagnostic";

interface AgentLocation {
  filePath: string;
  line: number;
  column?: number;
  function?: string;
}

interface AgentValue {
  name: string;
  value: string | number | boolean | null;
  type?: string;
  handle?: string;
  mutable?: true;
  redacted?: true;
  children?: AgentValue[];
  nextOffset?: number;
}
```

Workspace source paths are project-relative. External source, archive, and JRT
locations preserve a reusable URI or absolute path. Actual JSON primitives
remain primitives. String previews are converted only when the provider also
proves a primitive type and the text is a canonical literal.

Errors always include `code`, `message`, `retrySafe`, and
`actionMayHaveApplied`; a compact recovery `hint` is optional. Provider details
appear only under bounded diagnostics.

## Tool Projections

- `start`: session id, state, start mode, and the selected launch target.
- `run_configurations`: normalized configurations and runnable locations.
- `status`: de-duplicated live sessions, selected session, and IDE connection.
- `control`: resume/stop return state only; pause/wait/step return pause
  location and top-level locals; event draining returns only events and cursor.
- `run_to_line`: state, target proof, actual location, pause id, and locals.
- `threads`: id, name, current marker, and a continuation only when needed.
- `call_stack`: thread, semantic frames, pause id, and continuation.
- `frame`: semantic frame plus arguments, locals, fields, and named unknown
  scopes.
- `value`: path and handle addressing return the same `AgentValue` shape.
- `set_value`: target, old/new values, applied, and verified facts.
- `eval`: expression, value, optional type, and optional handle.
- `context`: one-call pause snapshot with state, reason, location, stack,
  variables, and pause id.
- breakpoint tools: concise identity, location, verification, ownership, and
  only non-default behavior.

Default context reads five frames and ten top-level variables at depth zero.
Control pause summaries read ten top-level variables at depth zero. Frame reads
twenty top-level variables at depth zero. Direct handle expansion defaults to
depth one and twenty children. Default string previews are capped at 200
characters.

## Canonical Inputs

MCP publishes only canonical names. It removes `workspace`, `file`,
`timeoutMs`, `maxDepth`, `maxItems`, `maxStringLength`, `objectFields`,
`variablesReference`, `lang`, `start`, `count`, and `ref`. CLI flags may retain
their human-facing spelling but must map to `projectPath`, `filePath`,
`timeout`, `depth`, `limit`, `maxString`, `offset`, `handle`, `path`,
`pauseId`, and `detail` before dispatch.

Schemas use JSON Schema 2020-12 local `$defs` and `$ref`. BreakPilot's internal
validator resolves local references, and the published recursive value schema
must not be expanded to a fixed number of levels.

## Architecture

Provider evidence flows through one pure semantic presenter before output
validation. The presenter owns locations, values, scopes, breakpoints, events,
default omission, and diagnostic extensions. `DebugSessionManager` coordinates
providers and passes canonical evidence to that boundary rather than assembling
public JSON ad hoc.

The Core owns a per-session pause handle registry. It maps short public handles
to IDEA or DAP references and mutation metadata. Resume, step, run-to-line,
stop, and a newer pause invalidate the prior registry atomically.

IDEA supplies a real stack-frame presentation or semantic function name. The
Core never exposes `JavaStackFrame` as a business function; failure falls back
to source file and line while the raw frame class remains diagnostic.

MCP `structuredContent` is authoritative. Its text content is a single semantic
summary capped at 160 characters and never duplicates serialized JSON. HTTP and
CLI return the same structured projection.

## Acceptance Criteria

- Complete serialized `tools/list` is at most 30,000 bytes.
- Compact live context for the Spring Boot fixture is at most 2,000 bytes.
- All 15 tools have compact and diagnostic-superset contract tests.
- IDE and DAP references both become short handles and fail stale after step.
- Pause-like controls include actionable evidence without a second frame call.
- Healthy compact results contain no provider ids, repeated pause ids, empty
  collections, or default booleans.
- Core typecheck, all tests, build, IDEA tests, plugin build, and the live
  `simple-springboot-demo` debug loop pass.

