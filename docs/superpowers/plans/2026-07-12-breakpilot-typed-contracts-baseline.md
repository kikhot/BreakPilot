# BreakPilot Typed Contracts And Differential Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every public BreakPilot debugger tool advertise and enforce a truthful typed contract, expose provider capabilities, and preserve the IDEA-vs-BreakPilot Java comparison as a repeatable acceptance baseline.

**Architecture:** Split reusable JSON-schema fragments and per-tool schemas out of `toolDefinitions.ts`, validate and normalize arguments in `ToolRouter` before manager dispatch, and give each runtime provider a normalized capability matrix. Keep all existing `bp_debug_*` names and compact success payloads while making their shapes explicit.

**Tech Stack:** TypeScript 5.9, Node.js 22 strip-types, existing MCP/HTTP/CLI control plane, built-in `node:assert/strict`, `fast-check`, IDEA Bridge fixtures.

## Global Constraints

- Keep Node.js `>=22.6` and ESM/NodeNext TypeScript settings.
- Do not add a JSON Schema dependency; validate only the schema keywords BreakPilot publishes and test every supported keyword.
- Preserve all current public `bp_debug_*` names.
- Preserve current top-level compact payloads; do not restore `ok`, `data`, or `auditId` envelopes.
- Unsupported provider behavior must be represented by capabilities and `UNSUPPORTED_CAPABILITY`, never a fabricated success.
- Use Conventional Commits in the form `<type>(<scope>): <summary>`.
- Do not stage unrelated user changes.

---

## File Structure

- Create `src/control/schemaFragments.ts`: reusable input/output JSON-schema fragments.
- Create `src/control/toolOutputSchemas.ts`: exact output schemas keyed by tool name.
- Create `src/control/ToolInputValidator.ts`: supported-keyword validation and default application.
- Create `src/types/capabilities.ts`: normalized provider capability types and defaults.
- Modify `src/control/toolDefinitions.ts`: compose exact input/output schemas without root-level ambiguous `anyOf`.
- Modify `src/control/ToolRouter.ts`: validate/normalize before dispatch and inject dynamic language enum.
- Modify `src/types/control.ts`: concrete JSON schema and validation result types.
- Modify `src/types/sessions.ts`: require normalized provider capabilities.
- Modify `src/runtime/providers/DapRuntimeProvider.ts`: publish DAP capability matrix.
- Modify `src/runtime/providers/IdeRuntimeProvider.ts`: derive capability matrix from Bridge capabilities.
- Modify `src/sessions/DebugSessionManager.ts`: return capabilities from start/status and honor diagnostic detail where specified.
- Create `test/tool-output-schema.property.test.ts`: every tool has non-generic output schema.
- Create `test/tool-input-validation.test.ts`: validation/default/range/discriminator coverage.
- Create `test/provider-capabilities.test.ts`: DAP and IDEA normalization coverage.
- Create `test/fixtures/differential/hello-controller.json`: sanitized observed IDEA/BreakPilot baseline.
- Create `test/differential-debug-contract.test.ts`: compare normalized semantic evidence.
- Modify `test/debugger-mcp-contracts.test.ts`: replace old generic-schema assumptions.
- Modify `test/hub-transports.test.ts`: assert transport-level validation shape.
- Modify `docs/mcp-tools.md` and `docs/mcp-tools.zh-CN.md`: exact success/error and capability documentation.
- Modify `docs/idea-mcp-vs-breakpilot-debugger.zh-CN.md`: replace outdated capability statements.

## Interfaces Established By This Plan

```ts
export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  additionalProperties?: boolean | JsonSchema;
  default?: unknown;
  description?: string;
};

export interface ToolValidationResult {
  value: Record<string, unknown>;
  errors: Array<{ path: string; keyword: string; message: string }>;
}

export type CapabilityLevel = "native" | "fallback" | "unsupported";

export interface RuntimeProviderCapabilities {
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

### Task 1: Freeze The Typed Contract Expectations

**Files:**
- Create: `test/tool-output-schema.property.test.ts`
- Modify: `test/debugger-mcp-contracts.test.ts`

**Interfaces:**
- Consumes: current `toolDefinitions` array.
- Produces: failing assertions that every public tool has a concrete output and an unambiguous input discriminator.

- [ ] **Step 1: Add the failing output-schema test**

Create `test/tool-output-schema.property.test.ts`:

```ts
import assert from "node:assert/strict";
import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import type { AnyRecord } from "../src/types/json.ts";

assert.equal(toolDefinitions.length, 15);

for (const tool of toolDefinitions) {
  const output = tool.outputSchema as AnyRecord;
  assert.equal(output.type, "object", `${tool.name} output must be an object`);
  assert.notEqual(output.additionalProperties, true, `${tool.name} must not expose a generic output`);
  assert.ok(output.oneOf || output.properties, `${tool.name} must describe success fields`);
  const serialized = JSON.stringify(output);
  assert.match(serialized, /error/, `${tool.name} must describe structured errors`);
}

const breakpoint = toolDefinitions.find((tool) => tool.name === "bp_debug_set_breakpoint");
assert.ok(breakpoint);
const input = breakpoint.inputSchema as AnyRecord;
assert.ok(Array.isArray(input.oneOf), "breakpoint target modes must be explicit oneOf schemas");
for (const branch of input.oneOf as AnyRecord[]) {
  assert.ok(branch.properties, "each target branch must carry its own properties");
  assert.equal(branch.additionalProperties, false);
}

console.log("tool output schema property tests ok");
```

- [ ] **Step 2: Run the new test and verify red**

Run:

```bash
node --experimental-strip-types test/tool-output-schema.property.test.ts
```

Expected: FAIL because current outputs use `additionalProperties: true`.

- [ ] **Step 3: Extend the existing contract test with capability expectations**

Add assertions to `test/debugger-mcp-contracts.test.ts`:

```ts
const statusOutput = tool("bp_debug_status").outputSchema as AnyRecord;
assert.match(JSON.stringify(statusOutput), /capabilities/);

const startOutput = tool("bp_debug_start").outputSchema as AnyRecord;
assert.match(JSON.stringify(startOutput), /capabilities/);
```

- [ ] **Step 4: Run the focused tests and preserve the failures**

Run:

```bash
node --experimental-strip-types test/debugger-mcp-contracts.test.ts
node --experimental-strip-types test/tool-output-schema.property.test.ts
```

Expected: contract test fails on missing capability output and output-schema test fails on generic outputs.

- [ ] **Step 5: Commit the red tests**

```bash
git add test/debugger-mcp-contracts.test.ts test/tool-output-schema.property.test.ts
git commit -m "test(control): require typed debugger contracts"
```

### Task 2: Define Reusable And Per-Tool Schemas

**Files:**
- Create: `src/control/schemaFragments.ts`
- Create: `src/control/toolOutputSchemas.ts`
- Modify: `src/control/toolDefinitions.ts`
- Modify: `src/types/control.ts`
- Test: `test/tool-output-schema.property.test.ts`
- Test: `test/debugger-mcp-contracts.test.ts`

**Interfaces:**
- Consumes: `JsonSchema` and existing tool names.
- Produces: `commonSchemas`, `successOrErrorSchema(success)`, and `toolOutputSchemas: Record<string, JsonSchema>`.

- [ ] **Step 1: Add JSON Schema types**

Add to `src/types/control.ts`:

```ts
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  additionalProperties?: boolean | JsonSchema;
  default?: unknown;
  description?: string;
}

export interface ToolValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

export interface ToolValidationResult {
  value: AnyRecord;
  errors: ToolValidationIssue[];
}
```

Change `ToolDefinition.inputSchema` and `outputSchema` to `JsonSchema`.

- [ ] **Step 2: Create reusable schema fragments**

Create `src/control/schemaFragments.ts` exporting:

```ts
import type { JsonSchema } from "../types/control.ts";

export const errorSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    details: { type: "object", additionalProperties: true }
  },
  required: ["code", "message"]
};

export const warningsSchema: JsonSchema = {
  type: "array",
  items: { type: "string" }
};

export const capabilityLevelSchema: JsonSchema = {
  type: "string",
  enum: ["native", "fallback", "unsupported"]
};

export const providerCapabilitiesSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pause: capabilityLevelSchema,
    stepping: capabilityLevelSchema,
    runToLine: capabilityLevelSchema,
    variableReferences: { type: "string", enum: ["native", "snapshot", "unsupported"] },
    setValue: { type: "string", enum: ["native", "evaluateAssignment", "unsupported"] },
    breakpointUpdate: capabilityLevelSchema,
    conditionalBreakpoints: capabilityLevelSchema,
    hitConditionalBreakpoints: capabilityLevelSchema,
    tracepoints: capabilityLevelSchema,
    eventDrain: capabilityLevelSchema
  },
  required: [
    "pause", "stepping", "runToLine", "variableReferences", "setValue",
    "breakpointUpdate", "conditionalBreakpoints", "hitConditionalBreakpoints",
    "tracepoints", "eventDrain"
  ]
};

export function successOrErrorSchema(success: JsonSchema): JsonSchema {
  return {
    type: "object",
    oneOf: [
      success,
      {
        type: "object",
        additionalProperties: false,
        properties: { error: errorSchema, warnings: warningsSchema },
        required: ["error"]
      }
    ]
  };
}
```

Also define reusable schemas for position, frame, variable node, scope,
breakpoint, session summary, and pagination metadata using the exact compact
fields currently returned by `DebugSessionManager`.

The success schemas must expose these exact root fields:

| Tool | Success fields |
|---|---|
| `bp_debug_start` | `sessionId`, `language`, `mode`, `state`, `ideSessionId?`, `startMode`, `providerKind`, `capabilities`, `warnings?` |
| `bp_debug_run_configurations` | `filePath?`, `configurations?`, `runPoints?`, `warnings?` |
| `bp_debug_status` | `activeSessionId`, `sessions`, `ideConnected`, `ideSessions`, `warnings?` |
| `bp_debug_control` | `status`, `reason?`, `position?`, `frame?`, `variables?`, `events?`, `alreadyStopped?`, `warnings?` |
| `bp_debug_run_to_line` | `status`, `position?`, `frame?`, `variables?`, `temporaryBreakpointId?`, `cleanedUp?`, `message?`, `warnings?` |
| `bp_debug_threads` | `threads`, `offset`, `totalCount`, `warnings?` |
| `bp_debug_call_stack` | `threadId`, `frames`, `offset`, `totalFrames`, `partial?`, `warnings?` |
| `bp_debug_frame` | `threadId`, `frame`, `variables`, `warnings?` |
| `bp_debug_value` | `name?`, `value?`, `path?`, `type?`, `ref?`, `items?`, `result?`, `warnings?` |
| `bp_debug_set_value` | `path`, `oldValue`, `newValue?`, `applied?`, `result?`, `warnings?` |
| `bp_debug_eval` | `expression`, `value?`, `type?`, `result?`, `warnings?` |
| `bp_debug_context` | `status`, `position`, `frames`, `variables`, `warnings?` |
| `bp_debug_set_breakpoint` | compact breakpoint fields, `lineText?`, `warnings?` |
| `bp_debug_list_breakpoints` | `breakpoints`, `totalCount`, `enabledCount?`, `source?`, `warnings?` |
| `bp_debug_remove_breakpoint` | `breakpointId?`, `removed`, `protected?`, `message?`, `warnings?` |

- [ ] **Step 3: Add exact output schemas**

Create `src/control/toolOutputSchemas.ts`. Export one schema for every public
tool and a keyed registry:

```ts
export const toolOutputSchemas: Record<string, JsonSchema> = {
  bp_debug_start: successOrErrorSchema(startSuccessSchema),
  bp_debug_run_configurations: successOrErrorSchema(runConfigurationsSuccessSchema),
  bp_debug_status: successOrErrorSchema(statusSuccessSchema),
  bp_debug_control: successOrErrorSchema(controlSuccessSchema),
  bp_debug_run_to_line: successOrErrorSchema(runToLineSuccessSchema),
  bp_debug_threads: successOrErrorSchema(threadsSuccessSchema),
  bp_debug_call_stack: successOrErrorSchema(callStackSuccessSchema),
  bp_debug_frame: successOrErrorSchema(frameSuccessSchema),
  bp_debug_value: successOrErrorSchema(valueSuccessSchema),
  bp_debug_set_value: successOrErrorSchema(setValueSuccessSchema),
  bp_debug_eval: successOrErrorSchema(evalSuccessSchema),
  bp_debug_context: successOrErrorSchema(contextSuccessSchema),
  bp_debug_set_breakpoint: successOrErrorSchema(setBreakpointSuccessSchema),
  bp_debug_list_breakpoints: successOrErrorSchema(listBreakpointsSuccessSchema),
  bp_debug_remove_breakpoint: successOrErrorSchema(removeBreakpointSuccessSchema)
};
```

Each success schema must set `type:"object"`, `additionalProperties:false`, and
list all fields currently returned. Fields whose provider shape is not yet
normalized may use a typed object with `additionalProperties:true` only at the
specific provider payload field, never at the tool root.

- [ ] **Step 4: Replace ambiguous breakpoint input schema**

In `toolDefinitions.ts`, define shared breakpoint properties once and create
two complete branches:

```ts
const breakpointLocationInput: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { ...breakpointCommonProperties, filePath, line },
  required: ["filePath", "line"]
};

const breakpointIdInput: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { ...breakpointCommonProperties, breakpointId },
  required: ["breakpointId"]
};
```

Set `bp_debug_set_breakpoint.inputSchema` to
`{ oneOf:[breakpointLocationInput,breakpointIdInput] }` and attach the exact
output from `toolOutputSchemas` to every definition.

Set `additionalProperties:false` on every public input object. Before doing so,
compare each CLI command mapper and contract fixture with its tool schema and
add every currently supported argument explicitly; strict validation must not
silently remove a supported CLI or MCP argument.

- [ ] **Step 5: Run focused tests and verify green**

```bash
node --experimental-strip-types test/debugger-mcp-contracts.test.ts
node --experimental-strip-types test/tool-output-schema.property.test.ts
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the schema implementation**

```bash
git add src/control/schemaFragments.ts src/control/toolOutputSchemas.ts src/control/toolDefinitions.ts src/types/control.ts test/debugger-mcp-contracts.test.ts test/tool-output-schema.property.test.ts
git commit -m "feat(control): publish typed debugger contracts"
```

### Task 3: Validate And Normalize Tool Inputs

**Files:**
- Create: `src/control/ToolInputValidator.ts`
- Create: `test/tool-input-validation.test.ts`
- Modify: `src/control/ToolRouter.ts`
- Modify: `src/utils/errors.ts`
- Modify: `test/hub-transports.test.ts`

**Interfaces:**
- Consumes: published `JsonSchema` from `ToolDefinition.inputSchema`.
- Produces: `validateToolInput(schema,args): ToolValidationResult` and router-level `INVALID_ARGUMENT` errors with issue arrays.

- [ ] **Step 1: Write failing validator tests**

Create `test/tool-input-validation.test.ts` with cases that assert:

```ts
const invalidLine = await router.callTool("bp_debug_run_to_line", {
  filePath: "src/Hello.java",
  line: 0
});
assert.equal(invalidLine.error?.code, "INVALID_ARGUMENT");
assert.deepEqual(invalidLine.error?.details?.issues, [{
  path: "$.line",
  keyword: "minimum",
  message: "must be >= 1"
}]);

const unknownField = await router.callTool("bp_debug_status", { typo: true });
assert.equal(unknownField.error?.code, "INVALID_ARGUMENT");

const ambiguousBreakpoint = await router.callTool("bp_debug_set_breakpoint", {
  breakpointId: "bp_1",
  filePath: "src/Hello.java",
  line: 12
});
assert.equal(ambiguousBreakpoint.error?.code, "INVALID_ARGUMENT");

const normalized = validateToolInput(controlSchema, { action: "wait" });
assert.equal(normalized.value.includeFrame, false);
assert.equal(normalized.value.detail, "compact");
```

- [ ] **Step 2: Verify the tests fail before implementation**

```bash
node --experimental-strip-types test/tool-input-validation.test.ts
```

Expected: FAIL because `ToolInputValidator.ts` does not exist.

- [ ] **Step 3: Implement the supported-keyword validator**

Create `src/control/ToolInputValidator.ts` with a recursive validator that:

- clones inputs without mutating callers;
- supports `type`, `properties`, `required`, `enum`, `oneOf`, `items`,
  `minimum`, `maximum`, `minItems`, `additionalProperties`, and `default`;
- applies defaults only to absent object properties;
- requires exactly one `oneOf` branch;
- returns stable JSONPath-like issue paths;
- never evaluates arbitrary schema code.

Export:

```ts
export function validateToolInput(schema: JsonSchema, input: AnyRecord): ToolValidationResult;
```

- [ ] **Step 4: Integrate validation in ToolRouter**

Build a definition map in the constructor. In `callTool`, validate before
handler dispatch and throw:

```ts
throw new BreakPilotError(
  ErrorCodes.INVALID_ARGUMENT,
  `Invalid arguments for ${name}.`,
  { issues: validation.errors }
);
```

Dispatch `validation.value`, not raw args. Keep unknown-tool behavior unchanged.

- [ ] **Step 5: Assert HTTP and MCP transport equivalence**

Extend `test/hub-transports.test.ts` so invalid line and unknown property calls
produce the same structured `INVALID_ARGUMENT` details over `/tools/call` and
MCP `/stream`.

- [ ] **Step 6: Run focused and equivalence tests**

```bash
node --experimental-strip-types test/tool-input-validation.test.ts
node --experimental-strip-types test/hub-transports.test.ts
node --experimental-strip-types test/commands.equivalence.property.test.ts
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit validation**

```bash
git add src/control/ToolInputValidator.ts src/control/ToolRouter.ts src/utils/errors.ts test/tool-input-validation.test.ts test/hub-transports.test.ts
git commit -m "feat(control): validate debugger tool inputs"
```

### Task 4: Add Provider Capability Truthfulness

**Files:**
- Create: `src/types/capabilities.ts`
- Create: `src/runtime/ProviderCapabilities.ts`
- Create: `test/provider-capabilities.test.ts`
- Modify: `src/types/sessions.ts`
- Modify: `src/runtime/providers/DapRuntimeProvider.ts`
- Modify: `src/runtime/providers/IdeRuntimeProvider.ts`
- Modify: `src/sessions/DebugSessionManager.ts`

**Interfaces:**
- Consumes: raw DAP capabilities or IDE Bridge capability records.
- Produces: `RuntimeProviderCapabilities` on every provider and in status/start responses.

- [ ] **Step 1: Write failing capability normalization tests**

Create `test/provider-capabilities.test.ts` asserting:

```ts
assert.deepEqual(dapProviderCapabilities({ supportsSetVariable: true }), {
  pause: "native",
  stepping: "native",
  runToLine: "unsupported",
  variableReferences: "native",
  setValue: "native",
  breakpointUpdate: "fallback",
  conditionalBreakpoints: "native",
  hitConditionalBreakpoints: "native",
  tracepoints: "fallback",
  eventDrain: "unsupported"
});

assert.deepEqual(ideProviderCapabilities({
  debugCommands: true,
  variableSnapshot: true,
  setVariable: true,
  runToLine: true,
  breakpointUpdate: false
}), {
  pause: "native",
  stepping: "native",
  runToLine: "native",
  variableReferences: "snapshot",
  setValue: "native",
  breakpointUpdate: "unsupported",
  conditionalBreakpoints: "unsupported",
  hitConditionalBreakpoints: "unsupported",
  tracepoints: "unsupported",
  eventDrain: "unsupported"
});
```

- [ ] **Step 2: Verify red**

```bash
node --experimental-strip-types test/provider-capabilities.test.ts
```

Expected: FAIL because the capability module does not exist.

- [ ] **Step 3: Implement capability types and normalizers**

Create `src/types/capabilities.ts` with the interfaces defined at the top of
this plan. Create `src/runtime/ProviderCapabilities.ts` with:

```ts
export function dapProviderCapabilities(raw: AnyRecord = {}): RuntimeProviderCapabilities;
export function ideProviderCapabilities(raw: AnyRecord = {}): RuntimeProviderCapabilities;
```

Use conservative defaults: an absent capability is `unsupported`, except DAP
core pause/step/variables operations that BreakPilot already requires from a
started DAP session.

- [ ] **Step 4: Publish capabilities from both providers**

Change `RuntimeDebugProvider.capabilities` to
`RuntimeProviderCapabilities`. Give `DapRuntimeProvider` a getter that combines
its stable baseline with `DapSession.capabilities`; give `IdeRuntimeProvider` a
matrix derived from the registered IDE session/client capabilities.

- [ ] **Step 5: Return capabilities from start and status**

Add `capabilities` to `#sessionSummary`. Include `providerKind` and
`capabilities` only in diagnostic detail for status lists, while `bp_debug_start`
always includes capabilities so the next call can be selected safely.

- [ ] **Step 6: Run tests**

```bash
node --experimental-strip-types test/provider-capabilities.test.ts
node --experimental-strip-types test/debugger-mcp-contracts.test.ts
node --experimental-strip-types test/ide-runtime-provider.test.ts
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit capabilities**

```bash
git add src/types/capabilities.ts src/runtime/ProviderCapabilities.ts src/types/sessions.ts src/runtime/providers/DapRuntimeProvider.ts src/runtime/providers/IdeRuntimeProvider.ts src/sessions/DebugSessionManager.ts test/provider-capabilities.test.ts test/debugger-mcp-contracts.test.ts
git commit -m "feat(runtime): expose provider capability matrix"
```

### Task 5: Add The Differential Evidence Fixture

**Files:**
- Create: `test/fixtures/differential/hello-controller.json`
- Create: `test/differential-debug-contract.test.ts`

**Interfaces:**
- Consumes: sanitized captured IDEA and BreakPilot results at the same Java stop.
- Produces: provider-independent semantic assertions used by future real E2E tests.

- [ ] **Step 1: Add the sanitized fixture**

Store only deterministic fields:

```json
{
  "source": {
    "fileSuffix": "src/main/java/com/example/demo/controller/HelloController.java",
    "line": 24
  },
  "expected": {
    "normalizedName": "Ada Lovelace",
    "score": "28",
    "balanced": "true",
    "multiPart": "true"
  },
  "idea": {
    "position": { "line": 24 },
    "framePresentation": "hello:24, HelloController (com.example.demo.controller)",
    "values": { "normalizedName": "Ada Lovelace", "analysis.score": "28" }
  },
  "breakpilot": {
    "position": { "line": 24 },
    "values": [
      { "path": ["normalizedName"], "value": "Ada Lovelace" },
      { "path": ["analysis", "score"], "value": "28" },
      { "path": ["analysis", "balanced"], "value": "true" },
      { "path": ["analysis", "multiPart"], "value": "true" }
    ]
  }
}
```

- [ ] **Step 2: Write the differential contract test**

Create `test/differential-debug-contract.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";

const fixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/differential/hello-controller.json", import.meta.url), "utf8")
) as {
  source: { fileSuffix: string; line: number };
  expected: Record<string, string>;
  idea: {
    position: { line: number };
    framePresentation: string;
    values: Record<string, string>;
  };
  breakpilot: {
    position: { line: number };
    values: Array<{ path: string[]; value: string }>;
  };
};

const breakpilotValues = Object.fromEntries(
  fixture.breakpilot.values.map((item) => [item.path.join("."), item.value])
);

assert.equal(fixture.idea.position.line, fixture.source.line);
assert.equal(fixture.breakpilot.position.line, fixture.source.line);
assert.match(fixture.idea.framePresentation, /hello:24/);
assert.match(fixture.source.fileSuffix, /HelloController\.java$/);
assert.equal(fixture.idea.values.normalizedName, fixture.expected.normalizedName);
assert.equal(breakpilotValues.normalizedName, fixture.expected.normalizedName);
assert.equal(fixture.idea.values["analysis.score"], fixture.expected.score);
assert.equal(breakpilotValues["analysis.score"], fixture.expected.score);
assert.equal(breakpilotValues["analysis.balanced"], fixture.expected.balanced);
assert.equal(breakpilotValues["analysis.multiPart"], fixture.expected.multiPart);

console.log("differential debugger contract tests ok");
```

Do not add volatile thread, frame, object, client, or session identifiers to the
fixture or assertions.

- [ ] **Step 3: Run the differential test**

```bash
node --experimental-strip-types test/differential-debug-contract.test.ts
```

Expected: PASS and print `differential debugger contract tests ok`.

- [ ] **Step 4: Commit the baseline**

```bash
git add test/fixtures/differential/hello-controller.json test/differential-debug-contract.test.ts
git commit -m "test(ide): add differential debugger baseline"
```

### Task 6: Update Documentation And Verify Phase 1

**Files:**
- Modify: `docs/mcp-tools.md`
- Modify: `docs/mcp-tools.zh-CN.md`
- Modify: `docs/idea-mcp-vs-breakpilot-debugger.zh-CN.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: the final Phase 1 schemas and capability matrix.
- Produces: accurate public docs and a repeatable root test script.

- [ ] **Step 1: Add a root test script**

Add to `package.json`:

```json
"test": "node --experimental-strip-types --test test/*.test.ts"
```

- [ ] **Step 2: Document exact contracts**

Update both MCP references with:

- the concrete success/error union;
- validation and defaults;
- session capability matrix;
- `detail` semantics;
- provider unsupported behavior;
- the exact breakpoint location/update modes.

Update the IDEA comparison document so it no longer claims that BreakPilot
lacks run-to-line, offset, set-value entry points, or native IDE breakpoint
listing. State the distinction as contract presence versus provider fidelity.

Add this compatibility statement verbatim to both MCP references:

```text
BreakPilot validates tool arguments before dispatch. Unknown fields, invalid
ranges, and ambiguous target modes return INVALID_ARGUMENT with issue details.
Successful payloads remain compact top-level objects. Each debug session reports
a provider capability matrix; callers must treat unsupported as authoritative.
```

- [ ] **Step 3: Run the full Phase 1 verification**

```bash
npm test
npm run typecheck
npm run check:runtime
npm --prefix breakpilot-vscode test
gradle -p breakpilot-idea compileKotlin
```

Expected:

- root test runner reports zero failures;
- TypeScript typecheck exits 0;
- runtime smoke prints `smoke ok`;
- VS Code TypeScript compilation exits 0;
- IntelliJ Kotlin compilation prints `BUILD SUCCESSFUL`.

- [ ] **Step 4: Inspect repository state before commit**

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only Phase 1 files are modified and no whitespace errors are reported.

- [ ] **Step 5: Commit documentation and verification entry point**

```bash
git add package.json docs/mcp-tools.md docs/mcp-tools.zh-CN.md docs/idea-mcp-vs-breakpilot-debugger.zh-CN.md
git commit -m "docs(mcp): document typed debugger contracts"
```

## Phase 1 Completion Gate

Do not begin the operation-state plan until all conditions hold:

- all 15 tools publish concrete output schemas;
- invalid arguments fail before manager execution;
- defaults are applied consistently over MCP, HTTP, and CLI;
- start/status expose truthful provider capabilities;
- the differential Java fixture passes;
- root, VS Code, and IntelliJ verification commands pass;
- the worktree contains no unrelated staged changes.
