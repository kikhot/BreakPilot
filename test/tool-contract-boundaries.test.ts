import assert from "node:assert/strict";
import test from "node:test";

import { ToolRouter } from "../src/control/ToolRouter.ts";
import { validateToolInput } from "../src/control/ToolInputValidator.ts";
import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import type { RuntimeProviderCapabilities } from "../src/types/capabilities.ts";
import type { JsonSchema } from "../src/types/control.ts";
import type { AnyRecord } from "../src/types/json.ts";
import type { RuntimeDebugProvider } from "../src/types/sessions.ts";
import { ErrorCodes } from "../src/utils/errors.ts";

const MAX_OFFSET = 1_000_000;
const MAX_LIMIT = 1_000;
const MAX_FRAME_INDEX = 100_000;
const MAX_STRING_LENGTH = 1_000_000;
const MAX_SOURCE_POSITION = 2_147_483_647;

function definition(name: string) {
  const found = toolDefinitions.find((candidate) => candidate.name === name);
  assert.ok(found, `expected ${name}`);
  return found;
}

function propertySchemas(schema: JsonSchema, property: string): JsonSchema[] {
  const found: JsonSchema[] = [];
  if (schema.properties?.[property]) found.push(schema.properties[property]);
  for (const branch of schema.oneOf ?? []) found.push(...propertySchemas(branch, property));
  return found;
}

function assertIntegerBoundary(
  tool: string,
  property: string,
  minimum: number,
  maximum: number
): void {
  const schemas = propertySchemas(definition(tool).inputSchema, property);
  assert.ok(schemas.length > 0, `${tool}.${property} must be published`);
  for (const schema of schemas) {
    assert.equal(schema.type, "integer", `${tool}.${property} must be integer`);
    assert.equal(schema.minimum, minimum, `${tool}.${property} minimum`);
    assert.equal(schema.maximum, maximum, `${tool}.${property} maximum`);
  }
}

function assertNullableIntegerBoundary(
  tool: string,
  property: string,
  minimum: number,
  maximum: number
): void {
  const schemas = propertySchemas(definition(tool).inputSchema, property);
  assert.ok(schemas.length > 0, `${tool}.${property} must be published`);
  for (const schema of schemas) {
    if (schema.type === "integer") {
      assert.equal(schema.minimum, minimum, `${tool}.${property} minimum`);
      assert.equal(schema.maximum, maximum, `${tool}.${property} maximum`);
      continue;
    }
    assert.deepEqual(schema.oneOf, [
      { type: "integer", minimum, maximum },
      { type: "null" }
    ], `${tool}.${property} must be nullable only in patch branches`);
  }
}

const fullCapabilities: RuntimeProviderCapabilities = {
  pause: "native",
  stepping: "native",
  runToLine: "native",
  variableReferences: "native",
  setValue: "native",
  breakpointUpdate: "unsupported",
  conditionalBreakpoints: "native",
  hitConditionalBreakpoints: "native",
  tracepoints: "native",
  eventDrain: "native"
};

test("live language enums apply equally to language and lang without mutating static schemas", async () => {
  const manager = new DebugSessionManager({ policy: loadPolicy("breakpilot.yaml") });
  const dynamicLanguage = "contract-boundary-language";
  manager.adapters.register(new LanguageAdapter({
    language: dynamicLanguage,
    adapterId: dynamicLanguage,
    envCommandName: "BREAKPILOT_CONTRACT_BOUNDARY_ADAPTER"
  }));
  let dispatches = 0;
  manager.bpDebugStart = async () => {
    dispatches += 1;
    return {
      sessionId: "dynamic",
      language: dynamicLanguage,
      mode: "headless",
      state: "running",
      startMode: "launch",
      providerKind: "dap",
      capabilities: fullCapabilities
    };
  };
  const router = new ToolRouter(manager);
  const advertisedStart = router.listTools().find((tool) => tool.name === "bp_debug_start");
  assert.ok(advertisedStart);
  const properties = advertisedStart.inputSchema.properties as Record<string, JsonSchema>;
  assert.deepEqual(properties.lang?.enum, properties.language?.enum);
  assert.ok(properties.lang?.enum?.includes(dynamicLanguage));

  const accepted = await router.callTool("bp_debug_start", { lang: dynamicLanguage });
  const rejected = await router.callTool("bp_debug_start", { lang: "not-registered" });
  assert.equal(accepted.error, undefined);
  assert.equal(rejected.error?.code, ErrorCodes.INVALID_ARGUMENT);
  assert.equal(dispatches, 1);

  const staticProperties = definition("bp_debug_start").inputSchema.properties as Record<string, JsonSchema>;
  assert.equal(staticProperties.language?.enum, undefined);
  assert.equal(staticProperties.lang?.enum, undefined);
});

test("value, set-value, and remove selectors reject missing, empty, and mixed targets before dispatch", async () => {
  const manager = new DebugSessionManager({ policy: loadPolicy("breakpilot.yaml") });
  const calls = { value: 0, setValue: 0, remove: 0 };
  manager.bpDebugValue = async () => {
    calls.value += 1;
    return { value: "ok" };
  };
  manager.bpDebugSetValue = async () => {
    calls.setValue += 1;
    return { path: ["answer"], oldValue: "42" };
  };
  manager.bpDebugRemoveBreakpoint = async () => {
    calls.remove += 1;
    return { removed: true };
  };
  const router = new ToolRouter(manager);

  for (const args of [
    { path: ["answer"] },
    { ref: 9 },
    { variablesReference: 9 }
  ]) {
    const response = await router.callTool("bp_debug_value", args);
    assert.equal(response.error, undefined, JSON.stringify(args));
  }
  assert.equal(calls.value, 3);

  const invalidValueTargets = [
    {},
    { path: [] },
    { ref: 0 },
    { variablesReference: 0 },
    { path: ["answer"], ref: 9 },
    { path: ["answer"], variablesReference: 9 },
    { ref: 9, variablesReference: 9 }
  ];
  const invalidValueResults = await Promise.all(
    invalidValueTargets.map((args) => router.callTool("bp_debug_value", args))
  );
  assert.ok(invalidValueResults.every((response) => response.error?.code === ErrorCodes.INVALID_ARGUMENT));
  assert.equal(calls.value, 3, "invalid value selectors must not dispatch");

  const emptySetPath = await router.callTool("bp_debug_set_value", { path: [], newValue: "43" });
  assert.equal(emptySetPath.error?.code, ErrorCodes.INVALID_ARGUMENT);
  assert.equal(calls.setValue, 0);
  const validSetPath = await router.callTool("bp_debug_set_value", {
    path: ["answer"],
    newValue: "43"
  });
  assert.equal(validSetPath.error, undefined);
  assert.equal(calls.setValue, 1);

  for (const args of [
    { breakpointId: "bp_1" },
    { filePath: "src/serve.ts", line: 1 },
    { file: "src/serve.ts", line: 1 }
  ]) {
    const response = await router.callTool("bp_debug_remove_breakpoint", args);
    assert.equal(response.error, undefined, JSON.stringify(args));
  }
  assert.equal(calls.remove, 3);

  const invalidRemoveTargets = [
    {},
    { filePath: "src/serve.ts" },
    { line: 1 },
    { breakpointId: "bp_1", filePath: "src/serve.ts" },
    { breakpointId: "bp_1", filePath: "src/serve.ts", line: 1 },
    { filePath: "src/a.ts", file: "src/b.ts", line: 1 }
  ];
  const invalidRemoveResults = await Promise.all(
    invalidRemoveTargets.map((args) => router.callTool("bp_debug_remove_breakpoint", args))
  );
  assert.ok(invalidRemoveResults.every((response) => response.error?.code === ErrorCodes.INVALID_ARGUMENT));
  assert.equal(calls.remove, 3, "invalid remove selectors must not dispatch");
});

test("breakpoint patch branches preserve explicit clears and never inherit create defaults", async () => {
  const manager = new DebugSessionManager({ policy: loadPolicy("breakpilot.yaml") });
  const capturedArgs: AnyRecord[] = [];
  manager.bpDebugSetBreakpoint = async (args) => {
    capturedArgs.push(structuredClone(args ?? {}));
    return {
      breakpointId: "bp_1",
      filePath: "src/serve.ts",
      line: 17,
      verified: true,
      owner: "agent",
      enabled: true,
      temporary: false
    };
  };
  const router = new ToolRouter(manager);

  const update = await router.callTool("bp_debug_set_breakpoint", {
    breakpointId: "bp_1",
    condition: null
  });
  assert.equal(update.error, undefined);
  assert.equal(capturedArgs[0]?.condition, null);
  assert.equal("enabled" in (capturedArgs[0] ?? {}), false, "update branch receives no create default");
  assert.equal("owner" in (capturedArgs[0] ?? {}), false, "owner is not silently reassigned");
  assert.equal("temporary" in (capturedArgs[0] ?? {}), false, "update branch receives no create-only default");

  const sameSourceMove = await router.callTool("bp_debug_set_breakpoint", {
    breakpointId: "bp_1",
    line: 17
  });
  const filePathRelocation = await router.callTool("bp_debug_set_breakpoint", {
    breakpointId: "bp_1",
    filePath: "src/relocated.ts",
    line: 18
  });
  const aliasRelocation = await router.callTool("bp_debug_set_breakpoint", {
    breakpointId: "bp_1",
    file: "src/legacy.ts",
    line: 19
  });
  assert.equal(sameSourceMove.error, undefined);
  assert.equal(filePathRelocation.error, undefined);
  assert.equal(aliasRelocation.error, undefined);
  assert.equal(capturedArgs[1]?.line, 17);
  assert.deepEqual(capturedArgs[2], { breakpointId: "bp_1", filePath: "src/relocated.ts", line: 18 });
  assert.deepEqual(capturedArgs[3], { breakpointId: "bp_1", file: "src/legacy.ts", line: 19 });

  const created = await router.callTool("bp_debug_set_breakpoint", {
    filePath: "src/create.ts",
    line: 20
  });
  assert.equal(created.error, undefined);
  assert.equal(capturedArgs[4]?.enabled, true);
  assert.equal(capturedArgs[4]?.owner, "agent");
  assert.equal(capturedArgs[4]?.temporary, false);
});

test("public quantity schemas are bounded integers and invalid values never dispatch", async () => {
  for (const tool of ["bp_debug_threads", "bp_debug_call_stack"]) {
    assertIntegerBoundary(tool, "offset", 0, MAX_OFFSET);
    assertIntegerBoundary(tool, "limit", 1, MAX_LIMIT);
  }
  for (const tool of [
    "bp_debug_frame",
    "bp_debug_value",
    "bp_debug_set_value",
    "bp_debug_context"
  ]) {
    assertIntegerBoundary(tool, "limit", 1, MAX_LIMIT);
    assertIntegerBoundary(tool, "maxItems", 1, MAX_LIMIT);
    assertIntegerBoundary(tool, "maxString", 1, MAX_STRING_LENGTH);
    assertIntegerBoundary(tool, "maxStringLength", 1, MAX_STRING_LENGTH);
  }
  const controlLimitSchemas = propertySchemas(definition("bp_debug_control").inputSchema, "limit");
  assert.deepEqual(
    controlLimitSchemas.map((schema) => schema.maximum).sort((left, right) => Number(left) - Number(right)),
    [256, MAX_LIMIT],
    "bp_debug_control should bound drain pages to 256 while retaining ordinary action compatibility"
  );
  for (const tool of ["bp_debug_frame", "bp_debug_value", "bp_debug_set_value", "bp_debug_eval", "bp_debug_context"]) {
    assertIntegerBoundary(tool, "frameIndex", 0, MAX_FRAME_INDEX);
  }
  assertIntegerBoundary("bp_debug_value", "start", 0, MAX_OFFSET);
  assertIntegerBoundary("bp_debug_value", "count", 1, MAX_LIMIT);
  assertIntegerBoundary("bp_debug_set_breakpoint", "line", 1, MAX_SOURCE_POSITION);
  assertNullableIntegerBoundary("bp_debug_set_breakpoint", "column", 1, MAX_SOURCE_POSITION);
  assertIntegerBoundary("bp_debug_remove_breakpoint", "line", 1, MAX_SOURCE_POSITION);

  const manager = new DebugSessionManager({ policy: loadPolicy("breakpilot.yaml") });
  let dispatches = 0;
  const rejectDispatch = async () => {
    dispatches += 1;
    return {};
  };
  manager.bpDebugStart = rejectDispatch;
  manager.bpDebugControl = rejectDispatch;
  manager.bpDebugRunToLine = rejectDispatch;
  manager.bpDebugThreads = rejectDispatch;
  manager.bpDebugCallStack = rejectDispatch;
  manager.bpDebugFrame = rejectDispatch;
  manager.bpDebugValue = rejectDispatch;
  manager.bpDebugSetValue = rejectDispatch;
  manager.bpDebugEval = rejectDispatch;
  manager.bpDebugContext = rejectDispatch;
  manager.bpDebugSetBreakpoint = rejectDispatch;
  manager.bpDebugRemoveBreakpoint = rejectDispatch;
  const router = new ToolRouter(manager);

  const invalidCases: Array<{ tool: string; args: AnyRecord }> = [
    { tool: "bp_debug_threads", args: { offset: -1 } },
    { tool: "bp_debug_threads", args: { limit: 1.5 } },
    { tool: "bp_debug_threads", args: { limit: MAX_LIMIT + 1 } },
    { tool: "bp_debug_call_stack", args: { offset: MAX_OFFSET + 1 } },
    { tool: "bp_debug_call_stack", args: { limit: 0 } },
    { tool: "bp_debug_frame", args: { frameIndex: -1 } },
    { tool: "bp_debug_frame", args: { limit: 2.5 } },
    { tool: "bp_debug_frame", args: { maxItems: MAX_LIMIT + 1 } },
    { tool: "bp_debug_frame", args: { maxStringLength: MAX_STRING_LENGTH + 1 } },
    { tool: "bp_debug_value", args: { ref: 1, start: -1 } },
    { tool: "bp_debug_value", args: { ref: 1, count: 1.5 } },
    { tool: "bp_debug_value", args: { ref: 1, count: MAX_LIMIT + 1 } },
    { tool: "bp_debug_value", args: { ref: 1, frameIndex: MAX_FRAME_INDEX + 1 } },
    { tool: "bp_debug_value", args: { ref: 1, maxString: 0 } },
    { tool: "bp_debug_set_value", args: { path: ["x"], newValue: "1", limit: 0 } },
    { tool: "bp_debug_set_value", args: { path: ["x"], newValue: "1", maxString: 1.5 } },
    { tool: "bp_debug_eval", args: { expression: "x", frameIndex: -1 } },
    { tool: "bp_debug_context", args: { limit: MAX_LIMIT + 1 } },
    { tool: "bp_debug_control", args: { action: "wait", maxItems: -1 } },
    { tool: "bp_debug_start", args: { filePath: "src/serve.ts", line: 1.5 } },
    { tool: "bp_debug_run_to_line", args: { filePath: "src/serve.ts", line: MAX_SOURCE_POSITION + 1 } },
    { tool: "bp_debug_set_breakpoint", args: { filePath: "src/serve.ts", line: 1.5 } },
    { tool: "bp_debug_set_breakpoint", args: { filePath: "src/serve.ts", line: 1, column: 0 } },
    { tool: "bp_debug_set_breakpoint", args: { filePath: "src/serve.ts", line: 1, column: MAX_SOURCE_POSITION + 1 } },
    { tool: "bp_debug_remove_breakpoint", args: { filePath: "src/serve.ts", line: -1 } },
    { tool: "bp_debug_remove_breakpoint", args: { filePath: "src/serve.ts", line: 1.5 } },
    { tool: "bp_debug_remove_breakpoint", args: { filePath: "src/serve.ts", line: MAX_SOURCE_POSITION + 1 } }
  ];
  const responses = await Promise.all(
    invalidCases.map(({ tool, args }) => router.callTool(tool, args))
  );
  assert.ok(responses.every((response) => response.error?.code === ErrorCodes.INVALID_ARGUMENT));
  assert.equal(dispatches, 0);
});

test("a concrete DAP thread response satisfies its advertised output schema", async () => {
  const manager = new DebugSessionManager({ policy: loadPolicy("breakpilot.yaml") });
  const provider: RuntimeDebugProvider = {
    kind: "dap",
    sessionId: "thread_contract",
    language: "java",
    workspaceRoot: manager.policy.workspace.root,
    capabilities: fullCapabilities,
    threadId: 7,
    async setBreakpoints() {
      return [];
    },
    async waitForBreakpoint() {
      return { sessionId: "thread_contract", reason: "breakpoint", threadId: 7 };
    },
    async listThreads() {
      return [{ id: 7, name: "main" }];
    },
    async getRuntimeSnapshot() {
      return {
        sessionId: "thread_contract",
        source: "headless",
        language: "java",
        threadId: 7,
        frameId: null,
        stackFrames: [],
        variables: {},
        limits: { maxDepth: 0, maxItems: 1, maxStringLength: 10 }
      };
    },
    async evaluate() {
      return {};
    },
    async pause() {
      return {};
    },
    async continue() {
      return {};
    },
    async step() {
      return {};
    },
    async disconnect() {
      return {};
    }
  };
  manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: provider.kind,
    provider
  });
  const response = await new ToolRouter(manager).callTool("bp_debug_threads", {
    sessionId: provider.sessionId
  });

  assert.equal((response.threads as AnyRecord[])[0]?.state, "paused");
  assert.deepEqual(validateToolInput(definition("bp_debug_threads").outputSchema!, response).errors, []);
});

test("direct manager variable inspection clamps limits and count to policy maxima", async () => {
  const manager = new DebugSessionManager({ policy: loadPolicy("breakpilot.yaml") });
  let snapshotLimits: AnyRecord | undefined;
  let inspectArgs: AnyRecord | undefined;
  let inspectLimits: AnyRecord | undefined;
  const provider: RuntimeDebugProvider = {
    kind: "ide",
    sessionId: "direct_limits",
    language: "java",
    workspaceRoot: manager.policy.workspace.root,
    capabilities: { ...fullCapabilities, variableReferences: "snapshot" },
    threadId: 1,
    async setBreakpoints() {
      return [];
    },
    async waitForBreakpoint() {
      return { sessionId: "direct_limits", threadId: 1 };
    },
    async getRuntimeSnapshot(_args, limits) {
      snapshotLimits = limits;
      return {
        sessionId: "direct_limits",
        source: "ide",
        language: "java",
        threadId: 1,
        frameId: null,
        stackFrames: [],
        variables: {},
        limits
      };
    },
    async inspectVariable(args, limits) {
      inspectArgs = args;
      inspectLimits = limits;
      return {};
    },
    async setVariable() {
      return {};
    },
    async evaluate() {
      return {};
    },
    async pause() {
      return {};
    },
    async continue() {
      return {};
    },
    async step() {
      return {};
    },
    async disconnect() {
      return {};
    }
  };
  manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "ide",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: provider.kind,
    provider
  });

  await manager.bpDebugFrame({
    sessionId: provider.sessionId,
    maxDepth: 99,
    maxItems: 99_999,
    maxStringLength: 99_999_999
  });
  await manager.bpDebugValue({
    sessionId: provider.sessionId,
    ref: 9,
    count: 99_999,
    maxItems: 99_999
  });

  assert.deepEqual(snapshotLimits, {
    maxDepth: manager.policy.variables.maxDepth,
    maxItems: manager.policy.variables.maxItems,
    maxStringLength: manager.policy.variables.maxStringLength,
    redactPatterns: manager.policy.variables.redactPatterns
  });
  assert.equal(inspectArgs?.count, manager.policy.variables.maxItems);
  assert.equal(inspectLimits?.maxItems, manager.policy.variables.maxItems);
});
