# BreakPilot Debugger MCP Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the Phase 1 debugger MCP replacement contract: advertise `bp_debug_run_to_line`, extend existing debugger schemas and shared types, and document the new compact contract without implementing runtime behavior yet.

**Architecture:** This phase is contract-first. `src/control/toolDefinitions.ts` becomes the public MCP schema source, `src/types/sessions.ts` records the shared provider and breakpoint types, and `src/sessions/DebugSessionManager.ts` exposes a minimal `bpDebugRunToLine` stub so the advertised tool fails explicitly instead of being unknown. Runtime behavior, bridge protocol implementation, IDE plugin support, and DAP fallback are left to later plans.

**Tech Stack:** TypeScript on Node 22 strip-types, MCP tool schema objects, built-in `node:assert/strict` tests, existing BreakPilot docs.

---

## Scope Check

The full design spans several independent subsystems: MCP contract, core runtime, IDEA plugin, VS Code plugin, headless DAP, and real-project acceptance. This plan intentionally covers only Phase 1 from the design spec:

- Add `bp_debug_run_to_line` to the MCP contract.
- Add enhanced input fields to existing debugger tools.
- Extend shared TypeScript types so later runtime work has stable names.
- Add a route stub for `bp_debug_run_to_line` that returns `UNSUPPORTED_CAPABILITY`.
- Update MCP docs.
- Add contract tests.

Do not implement native run-to-line, temporary-breakpoint fallback, real IDE breakpoint listing, owner-protected removal behavior, variable mutation, drain events, or plugin bridge changes in this plan.

## File Structure

- Modify `src/control/toolDefinitions.ts`: add shared schema helpers, add `bp_debug_run_to_line`, and extend existing debugger tool schemas.
- Modify `src/control/ToolRouter.ts`: register `bp_debug_run_to_line`.
- Modify `src/sessions/DebugSessionManager.ts`: add `bpDebugRunToLine` stub and extend `DebugToolArgs`.
- Modify `src/types/sessions.ts`: add `ThreadId`, breakpoint advanced fields, run-to-line/provider extension types.
- Modify `src/utils/errors.ts`: add `UNSUPPORTED_CAPABILITY`.
- Create `test/debugger-mcp-contracts.test.ts`: assert schema fields, route behavior, and compact response commitments.
- Modify `test/smoke.ts`: assert `bp_debug_run_to_line` is advertised.
- Modify `docs/mcp-tools.md`: document the new contract in English.
- Modify `docs/mcp-tools.zh-CN.md`: document the new contract in Chinese.

## Task 1: Add Failing Contract Test

**Files:**
- Create: `test/debugger-mcp-contracts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/debugger-mcp-contracts.test.ts` with this exact content:

```ts
import assert from "node:assert/strict";

import { ToolRouter } from "../src/control/ToolRouter.ts";
import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import type { AnyRecord } from "../src/types/json.ts";

function tool(name: string): AnyRecord {
  const found = toolDefinitions.find((candidate) => candidate.name === name);
  assert.ok(found, `expected ${name} to exist`);
  return found as unknown as AnyRecord;
}

function properties(name: string): AnyRecord {
  return ((tool(name).inputSchema as AnyRecord).properties ?? {}) as AnyRecord;
}

function propertyNames(name: string): string[] {
  return Object.keys(properties(name)).sort();
}

function assertHasProperties(name: string, expected: string[]): void {
  const names = propertyNames(name);
  for (const field of expected) {
    assert.ok(names.includes(field), `${name} should expose ${field}`);
  }
}

const runToLine = tool("bp_debug_run_to_line");
assert.equal(runToLine.description, "Run the selected debug session to a source line.");
assert.deepEqual((runToLine.inputSchema as AnyRecord).required, ["filePath", "line"]);
assertHasProperties("bp_debug_run_to_line", [
  "projectPath",
  "sessionId",
  "filePath",
  "line",
  "threadId",
  "timeout",
  "includeFrame",
  "detail"
]);

assertHasProperties("bp_debug_set_breakpoint", [
  "breakpointId",
  "enabled",
  "temporary",
  "suspendPolicy",
  "isLogMessage",
  "isLogStack",
  "owner",
  "detail"
]);

assertHasProperties("bp_debug_list_breakpoints", [
  "owner",
  "includeDisabled",
  "detail"
]);

assertHasProperties("bp_debug_remove_breakpoint", [
  "owner"
]);

assertHasProperties("bp_debug_threads", [
  "offset",
  "detail"
]);

assertHasProperties("bp_debug_call_stack", [
  "offset",
  "detail"
]);

assertHasProperties("bp_debug_set_value", [
  "detail"
]);

assertHasProperties("bp_debug_control", [
  "detail"
]);

assertHasProperties("bp_debug_context", [
  "detail"
]);

const manager = new DebugSessionManager({ policy: loadPolicy() });
const router = new ToolRouter(manager);
const listed = router.listTools().map((candidate) => candidate.name);
assert.ok(listed.includes("bp_debug_run_to_line"), "ToolRouter should advertise bp_debug_run_to_line");

const response = await router.callTool("bp_debug_run_to_line", {
  filePath: "src/Hello.java",
  line: 12
});
assert.equal(response.error?.code, "UNSUPPORTED_CAPABILITY");
assert.match(
  response.error?.message ?? "",
  /runtime implementation is not available/i
);

console.log("debugger mcp contract tests ok");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --experimental-strip-types test/debugger-mcp-contracts.test.ts
```

Expected: FAIL with an assertion like `expected bp_debug_run_to_line to exist`.

## Task 2: Add Shared Error And Type Contracts

**Files:**
- Modify: `src/utils/errors.ts`
- Modify: `src/types/sessions.ts`

- [ ] **Step 1: Add unsupported capability error code**

In `src/utils/errors.ts`, add `UNSUPPORTED_CAPABILITY` to `ErrorCodes` after `UNSUPPORTED_LANGUAGE`:

```ts
  UNSUPPORTED_LANGUAGE: "UNSUPPORTED_LANGUAGE",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  INVALID_LANGUAGE_IDENTIFIER: "INVALID_LANGUAGE_IDENTIFIER",
```

- [ ] **Step 2: Extend session and breakpoint types**

In `src/types/sessions.ts`, replace the existing `RuntimeDebugProvider`, `BreakpointInput`, `BreakpointRecord`, and `ProjectBreakpointRecord` block with this expanded version while keeping the existing imports:

```ts
export type ThreadId = number | string;

export type DetailLevel = "compact" | "diagnostic";

export interface RunToLineArgs {
  filePath: string;
  line: number;
  threadId?: ThreadId | null;
  timeoutMs?: number;
}

export interface RunToLineResult {
  status: "paused" | "stopped" | "timeout";
  position?: AnyRecord;
  frame?: AnyRecord;
  variables?: AnyRecord[];
  temporaryBreakpointId?: string;
  cleanedUp?: boolean;
  message?: string;
  warnings?: string[];
}

export interface BreakpointFilter {
  filePath?: string;
  owner?: "agent" | "user" | "all";
  includeDisabled?: boolean;
}

export interface DebugEventBuffer {
  breakpointErrors: AnyRecord[];
  tracepoints: AnyRecord[];
}

export interface RuntimeDebugProvider {
  kind: RuntimeProviderKind;
  sessionId: string;
  language: DebugLanguage;
  workspaceRoot: string;
  capabilities: AnyRecord;
  threadId: ThreadId | null;
  setBreakpoints(filePath: string, breakpoints: BreakpointRecord[]): Promise<DapBreakpoint[]>;
  removeBreakpoint?(breakpoint: BreakpointRecord): Promise<AnyRecord>;
  waitForBreakpoint(timeoutMs?: number): Promise<StoppedEvent>;
  runToLine?(args: RunToLineArgs): Promise<RunToLineResult>;
  listBreakpoints?(filter?: BreakpointFilter): Promise<BreakpointRecord[]>;
  updateBreakpoint?(breakpoint: BreakpointRecord): Promise<BreakpointRecord>;
  drainEvents?(): Promise<DebugEventBuffer>;
  listThreads?(args?: { offset?: number; limit?: number }): Promise<AnyRecord[]>;
  getCallStack?(threadId?: ThreadId | null, args?: { offset?: number; limit?: number }): Promise<AnyRecord>;
  getRuntimeSnapshot(args: AnyRecord, limits: Required<VariableLimits>): Promise<RuntimeSnapshot>;
  inspectVariable?(args: AnyRecord, limits: Required<VariableLimits>): Promise<InspectVariableResult | AnyRecord>;
  setVariable?(args: AnyRecord): Promise<AnyRecord>;
  evaluate(expression: string, options?: AnyRecord): Promise<AnyRecord>;
  pause?(threadId?: ThreadId | null): Promise<AnyRecord>;
  continue(threadId?: ThreadId | null): Promise<AnyRecord>;
  step(kind: RuntimeStepKind, threadId?: ThreadId | null): Promise<AnyRecord>;
  disconnect(options?: { terminateDebuggee?: boolean; restart?: boolean }): Promise<AnyRecord>;
}

export interface BreakpointInput {
  id?: string;
  file: string;
  line: number;
  column?: number;
  condition?: string | null;
  hitCondition?: string | null;
  logMessage?: string | null;
  enabled?: boolean;
  temporary?: boolean;
  suspendPolicy?: "ALL" | "THREAD" | "NONE";
  isLogMessage?: boolean;
  isLogStack?: boolean;
  owner?: "agent" | "user" | string;
}

export interface BreakpointRecord extends BreakpointInput {
  id: string;
  sessionId: string;
  verified: boolean;
  adapterBreakpointId?: number | string;
  ideBreakpointId?: string;
  message?: string;
  createdAt: string;
}

export interface ProjectBreakpointRecord extends BreakpointInput {
  id: string;
  workspaceRoot: string;
  clientId: string;
  ide: string;
  ideSessionId?: string;
  verified: boolean;
  adapterBreakpointId?: number | string;
  ideBreakpointId?: string;
  message?: string;
  createdAt: string;
}
```

- [ ] **Step 3: Run typecheck to verify current downstream failures**

Run:

```bash
npm run typecheck
```

Expected: FAIL if call sites still assume numeric `threadId` or `adapterBreakpointId`. Use the error list to drive the next tasks.

## Task 3: Update Breakpoint Store To Preserve New Fields

**Files:**
- Modify: `src/sessions/BreakpointManager.ts`

- [ ] **Step 1: Preserve advanced breakpoint fields in session breakpoints**

In `BreakpointManager.add`, after `logMessage: breakpoint.logMessage,` add:

```ts
      enabled: breakpoint.enabled ?? true,
      temporary: breakpoint.temporary ?? false,
      suspendPolicy: breakpoint.suspendPolicy,
      isLogMessage: breakpoint.isLogMessage,
      isLogStack: breakpoint.isLogStack,
```

- [ ] **Step 2: Preserve advanced breakpoint fields in project breakpoints**

In `BreakpointManager.addProject`, after `logMessage: breakpoint.logMessage,` add:

```ts
      enabled: breakpoint.enabled ?? true,
      temporary: breakpoint.temporary ?? false,
      suspendPolicy: breakpoint.suspendPolicy,
      isLogMessage: breakpoint.isLogMessage,
      isLogStack: breakpoint.isLogStack,
```

- [ ] **Step 3: Allow string adapter breakpoint ids in project updates**

In `BreakpointManager.updateProject`, keep the existing patch shape if it already accepts `number | string`. If it only accepts `number`, replace the patch type with:

```ts
  updateProject(
    breakpointId: string,
    patch: Partial<Pick<ProjectBreakpointRecord, "verified" | "message" | "adapterBreakpointId" | "ideBreakpointId" | "line" | "column">>
  ): ProjectBreakpointRecord | undefined {
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: still may FAIL because schemas/routes are not updated yet, but `BreakpointManager` should not report type errors about the new fields.

## Task 4: Add MCP Tool Schema Contract

**Files:**
- Modify: `src/control/toolDefinitions.ts`

- [ ] **Step 1: Add shared schema helpers**

Near the existing shared constants in `src/control/toolDefinitions.ts`, add:

```ts
const threadId = {
  oneOf: [{ type: "number" }, { type: "string" }],
  description: "Optional runtime thread id. IDE providers may expose opaque string ids."
} as const;

const detail = {
  type: "string",
  enum: ["compact", "diagnostic"],
  default: "compact",
  description: "Response detail level. Default compact returns only agent-relevant fields."
} as const;

const owner = {
  type: "string",
  enum: ["agent", "user", "all"],
  description: "Breakpoint owner filter. Defaults are tool-specific."
} as const;

const suspendPolicy = {
  type: "string",
  enum: ["ALL", "THREAD", "NONE"],
  description: "Debugger suspend policy for breakpoint hits."
} as const;
```

- [ ] **Step 2: Replace numeric thread schemas**

Replace each inline `threadId: { type: "number" }` with:

```ts
        threadId,
```

Do this in `bp_debug_control`, `bp_debug_call_stack`, `bp_debug_frame`, `bp_debug_value`, and `bp_debug_eval`.

- [ ] **Step 3: Add `bp_debug_run_to_line` definition**

Insert this tool after `bp_debug_control`:

```ts
  {
    name: "bp_debug_run_to_line",
    description: "Run the selected debug session to a source line.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        filePath: { type: "string" },
        line: { type: "number" },
        threadId,
        timeout,
        includeFrame: { type: "boolean", default: false },
        detail
      },
      required: ["filePath", "line"]
    },
    outputSchema: toolResponseOutputSchema
  },
```

- [ ] **Step 4: Extend existing tool schemas**

Add `detail` to these tools' properties:

```ts
bp_debug_control
bp_debug_threads
bp_debug_call_stack
bp_debug_frame
bp_debug_value
bp_debug_set_value
bp_debug_eval
bp_debug_context
bp_debug_set_breakpoint
bp_debug_list_breakpoints
```

Add `offset` to `bp_debug_threads` and `bp_debug_call_stack`:

```ts
        offset: { type: "number", default: 0 },
```

Add these fields to `bp_debug_set_breakpoint`:

```ts
        breakpointId: { type: "string" },
        enabled: { type: "boolean", default: true },
        temporary: { type: "boolean", default: false },
        suspendPolicy,
        isLogMessage: { type: "boolean", default: false },
        isLogStack: { type: "boolean", default: false },
        owner: { type: "string", enum: ["agent", "user"], default: "agent" },
```

Add these fields to `bp_debug_list_breakpoints`:

```ts
        owner,
        includeDisabled: { type: "boolean", default: true },
        detail
```

Add `owner` to `bp_debug_remove_breakpoint`:

```ts
        owner
```

- [ ] **Step 5: Run contract test to verify schema still fails only on route**

Run:

```bash
node --experimental-strip-types test/debugger-mcp-contracts.test.ts
```

Expected: FAIL because `bp_debug_run_to_line` is advertised but `ToolRouter` does not route it yet.

## Task 5: Add Route Stub For `bp_debug_run_to_line`

**Files:**
- Modify: `src/control/ToolRouter.ts`
- Modify: `src/sessions/DebugSessionManager.ts`

- [ ] **Step 1: Register the tool route**

In `ToolRouter` constructor, add this handler after `bp_debug_control`:

```ts
      ["bp_debug_run_to_line", (args: AnyRecord) => this.manager.bpDebugRunToLine(args)],
```

- [ ] **Step 2: Extend `DebugToolArgs`**

In `DebugSessionManager.ts`, extend `DebugToolArgs` with:

```ts
  offset?: number;
  detail?: "compact" | "diagnostic";
  enabled?: boolean;
  temporary?: boolean;
  suspendPolicy?: "ALL" | "THREAD" | "NONE";
  isLogMessage?: boolean;
  isLogStack?: boolean;
  includeDisabled?: boolean;
```

Change the existing `threadId?: number;` to:

```ts
  threadId?: number | string;
```

- [ ] **Step 3: Add the run-to-line stub**

In `DebugSessionManager`, add this method immediately after `bpDebugControl`:

```ts
  async bpDebugRunToLine(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const auditId = this.audit.record("bp_debug_run_to_line_requested", {
      sessionId: normalized.sessionId,
      filePath: normalized.filePath,
      line: normalized.line
    });
    if (!normalized.filePath || !normalized.line) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "bp_debug_run_to_line requires filePath and line.", {});
    }
    return {
      error: {
        code: ErrorCodes.UNSUPPORTED_CAPABILITY,
        message: "bp_debug_run_to_line contract is registered, but the runtime implementation is not available in Phase 1.",
        details: {
          phase: "contract",
          filePath: normalized.filePath,
          line: normalized.line
        }
      }
    };
  }
```

The `auditId` variable is intentionally recorded for consistency even though Phase 1 does not include it in the compact response.

- [ ] **Step 4: Remove unused variable warning if needed**

If `npm run typecheck` reports `auditId` is unused, change the variable line to:

```ts
    this.audit.record("bp_debug_run_to_line_requested", {
```

and remove the closing `);` variable assignment only. Keep the audit event.

- [ ] **Step 5: Run contract test**

Run:

```bash
node --experimental-strip-types test/debugger-mcp-contracts.test.ts
```

Expected: PASS with `debugger mcp contract tests ok`.

## Task 6: Extend Compact Breakpoint Views

**Files:**
- Modify: `src/sessions/DebugSessionManager.ts`

- [ ] **Step 1: Update session breakpoint creation**

In `#setSessionBreakpoint`, extend the `this.breakpoints.add` argument:

```ts
    const breakpoint = this.breakpoints.add(session.sessionId, {
      file,
      line: args.line,
      column: args.column,
      condition: args.condition,
      hitCondition: args.hitCondition,
      logMessage: args.logMessage,
      enabled: args.enabled ?? true,
      temporary: args.temporary ?? false,
      suspendPolicy: args.suspendPolicy,
      isLogMessage: args.isLogMessage,
      isLogStack: args.isLogStack,
      owner: args.owner ?? "agent"
    });
```

- [ ] **Step 2: Update project breakpoint creation**

In `#setProjectBreakpoint`, extend the `this.breakpoints.addProject` argument:

```ts
    const breakpoint = this.breakpoints.addProject({
      workspaceRoot,
      clientId: target.client.clientId,
      ide: target.client.ide,
      ideSessionId: target.session?.ideSessionId,
      file,
      line: args.line,
      column: args.column,
      condition: args.condition,
      hitCondition: args.hitCondition,
      logMessage: args.logMessage,
      enabled: args.enabled ?? true,
      temporary: args.temporary ?? false,
      suspendPolicy: args.suspendPolicy,
      isLogMessage: args.isLogMessage,
      isLogStack: args.isLogStack,
      owner: args.owner ?? "agent"
    });
```

- [ ] **Step 3: Extend breakpoint compact response**

Find `#breakpointView` and `#projectBreakpointView` near the bottom of `DebugSessionManager.ts`. Ensure both return objects include:

```ts
      enabled: breakpoint.enabled ?? true,
      temporary: breakpoint.temporary ?? false,
      suspendPolicy: breakpoint.suspendPolicy,
      isLogMessage: breakpoint.isLogMessage,
      isLogStack: breakpoint.isLogStack,
```

Keep existing fields such as `breakpointId`, `filePath`, `line`, `verified`, `condition`, `hitCondition`, `logMessage`, and `owner`.

- [ ] **Step 4: Run contract and agent shape tests**

Run:

```bash
node --experimental-strip-types test/debugger-mcp-contracts.test.ts
node --experimental-strip-types test/debugger-agent-shape.test.ts
```

Expected: both PASS.

## Task 7: Update Smoke Test And MCP Docs

**Files:**
- Modify: `test/smoke.ts`
- Modify: `docs/mcp-tools.md`
- Modify: `docs/mcp-tools.zh-CN.md`

- [ ] **Step 1: Add smoke assertion**

In `test/smoke.ts`, after the existing assertions for `bp_debug_threads` and `bp_debug_call_stack`, add:

```ts
assert.ok(runtime.router.listTools().some((tool) => tool.name === "bp_debug_run_to_line"));
```

- [ ] **Step 2: Update English tool list**

In `docs/mcp-tools.md`, add `bp_debug_run_to_line` to the tool list:

```markdown
| `bp_debug_run_to_line` | Run the selected debug session to a source line. |
```

Add this section after `bp_debug_control`:

````markdown
### `bp_debug_run_to_line`

Runs the selected session to a source line.

```json
{
  "filePath": "src/App.java",
  "line": 42,
  "timeout": 30000,
  "includeFrame": true
}
```

Phase 1 advertises the contract. Runtime support is implemented by later phases through native IDE bridge support or a temporary-breakpoint fallback.
````

- [ ] **Step 3: Update Chinese tool list**

In `docs/mcp-tools.zh-CN.md`, add `bp_debug_run_to_line` to the tool list:

```markdown
| `bp_debug_run_to_line` | 运行到指定源码行。 |
```

Add this section after `bp_debug_control`:

````markdown
### `bp_debug_run_to_line`

将当前调试会话运行到指定源码行。

```json
{
  "filePath": "src/App.java",
  "line": 42,
  "timeout": 30000,
  "includeFrame": true
}
```

Phase 1 只公开契约。真正运行能力会在后续阶段通过 IDE bridge 原生命令或临时断点 fallback 实现。
````

- [ ] **Step 4: Run smoke test**

Run:

```bash
node --experimental-strip-types test/smoke.ts
```

Expected: PASS with `smoke test passed`.

## Task 8: Run Full Phase 1 Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run contract tests**

Run:

```bash
node --experimental-strip-types test/debugger-mcp-contracts.test.ts
```

Expected: PASS with `debugger mcp contract tests ok`.

- [ ] **Step 2: Run agent shape tests**

Run:

```bash
node --experimental-strip-types test/debugger-agent-shape.test.ts
```

Expected: PASS with `debugger agent shape tests ok`.

- [ ] **Step 3: Run smoke test**

Run:

```bash
node --experimental-strip-types test/smoke.ts
```

Expected: PASS with `smoke test passed`.

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Inspect changed files**

Run:

```bash
git status --short
git diff --stat
```

Expected: changed files are limited to Phase 1 contract files:

```text
src/control/toolDefinitions.ts
src/control/ToolRouter.ts
src/sessions/DebugSessionManager.ts
src/sessions/BreakpointManager.ts
src/types/sessions.ts
src/utils/errors.ts
test/debugger-mcp-contracts.test.ts
test/smoke.ts
docs/mcp-tools.md
docs/mcp-tools.zh-CN.md
```

Other pre-existing dirty files may appear in this repository. Do not stage unrelated files.

- [ ] **Step 6: Commit Phase 1**

Stage only Phase 1 files:

```bash
git add src/control/toolDefinitions.ts src/control/ToolRouter.ts src/sessions/DebugSessionManager.ts src/sessions/BreakpointManager.ts src/types/sessions.ts src/utils/errors.ts test/debugger-mcp-contracts.test.ts test/smoke.ts docs/mcp-tools.md docs/mcp-tools.zh-CN.md
```

Commit:

```bash
git commit -m "feat(mcp): add debugger replacement contracts"
```

Expected: commit succeeds. If unrelated files are staged, unstage them before committing.

## Self-Review

Spec coverage:

- `bp_debug_run_to_line` contract is covered by Tasks 1, 4, 5, 7, and 8.
- Enhanced breakpoint contract is covered by Tasks 1, 2, 3, 4, 6, and 8.
- Thread/call-stack offset and string thread id contract is covered by Tasks 1, 2, 4, and 8.
- Compact response and explicit unsupported behavior are covered by Tasks 1, 5, and 7.
- Runtime behavior, bridge protocol implementation, plugin implementation, and real Spring Boot acceptance are intentionally not covered; they belong to later phase plans.

Placeholder scan:

- This plan contains no placeholder markers or deferred implementation notes.
- Each code-changing step names exact files and includes the exact code to add or the exact command to run.

Type consistency:

- `ThreadId`, `DetailLevel`, `RunToLineArgs`, `RunToLineResult`, `BreakpointFilter`, and `DebugEventBuffer` are introduced before later tasks reference them.
- `UNSUPPORTED_CAPABILITY` is introduced before the run-to-line stub uses it.
- Breakpoint fields use the same names across schema, records, store, and compact response.
