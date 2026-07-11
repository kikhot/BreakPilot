import assert from "node:assert/strict";

import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import { ToolRouter } from "../src/control/ToolRouter.ts";
import { validateToolInput } from "../src/control/ToolInputValidator.ts";
import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import type { JsonSchema } from "../src/types/control.ts";
import type { AnyRecord } from "../src/types/json.ts";

function inputSchema(name: string): JsonSchema {
  const definition = toolDefinitions.find((candidate) => candidate.name === name);
  assert.ok(definition, `expected ${name} to be defined`);
  return definition.inputSchema;
}

const controlInput = { action: "wait", redactPatterns: ["token"] };
const normalizedControl = validateToolInput(inputSchema("bp_debug_control"), controlInput);
assert.deepEqual(normalizedControl.errors, []);
assert.notStrictEqual(normalizedControl.value, controlInput);
assert.notStrictEqual(normalizedControl.value.redactPatterns, controlInput.redactPatterns);
assert.deepEqual(controlInput, { action: "wait", redactPatterns: ["token"] });
assert.equal(normalizedControl.value.includeFrame, false);
assert.equal(normalizedControl.value.detail, "compact");

const explicitUndefined = { action: "wait", includeFrame: undefined };
const undefinedResult = validateToolInput(inputSchema("bp_debug_control"), explicitUndefined);
assert.equal(undefinedResult.value.includeFrame, undefined, "present undefined values must not receive defaults");
assert.ok(undefinedResult.errors.some((issue) => issue.path === "$.includeFrame" && issue.keyword === "type"));
assert.deepEqual(explicitUndefined, { action: "wait", includeFrame: undefined });

const typedSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    count: { type: "integer" },
    nothing: { type: "null" },
    options: { type: "object", additionalProperties: false }
  },
  required: ["count", "nothing", "options"]
};
assert.deepEqual(validateToolInput(typedSchema, { count: 2, nothing: null, options: {} }).errors, []);
assert.deepEqual(validateToolInput(typedSchema, { count: 2.5, nothing: null, options: {} }).errors, [{
  path: "$.count",
  keyword: "type",
  message: "must be integer"
}]);
assert.deepEqual(validateToolInput(typedSchema, { count: 2, nothing: {}, options: {} }).errors, [{
  path: "$.nothing",
  keyword: "type",
  message: "must be null"
}]);
assert.deepEqual(validateToolInput(typedSchema, { count: 2, nothing: null, options: [] }).errors, [{
  path: "$.options",
  keyword: "type",
  message: "must be object"
}]);
assert.deepEqual(validateToolInput(typedSchema, { count: 2, nothing: null }).errors, [{
  path: "$.options",
  keyword: "required",
  message: "is required"
}]);

const collectionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    depth: { type: "number", maximum: 8 },
    mode: { type: "string", enum: ["compact", "diagnostic"] },
    names: { type: "array", minItems: 2, items: { type: "string" } }
  },
  required: ["depth", "mode", "names"]
};
const invalidCollection = validateToolInput(collectionSchema, {
  depth: 9,
  mode: "verbose",
  names: ["ok", 3]
});
assert.deepEqual(invalidCollection.errors, [
  { path: "$.depth", keyword: "maximum", message: "must be <= 8" },
  { path: "$.mode", keyword: "enum", message: "must be one of [\"compact\",\"diagnostic\"]" },
  { path: "$.names[1]", keyword: "type", message: "must be string" }
]);
assert.deepEqual(validateToolInput(collectionSchema, {
  depth: 8,
  mode: "compact",
  names: ["only"]
}).errors, [{
  path: "$.names",
  keyword: "minItems",
  message: "must contain at least 2 items"
}]);

const extensionSchema: JsonSchema = {
  type: "object",
  properties: { fixed: { type: "string" } },
  additionalProperties: { oneOf: [{ type: "string" }, { type: "null" }] }
};
assert.deepEqual(validateToolInput(extensionSchema, {
  fixed: "known",
  alpha: "value",
  beta: null
}).errors, []);
assert.deepEqual(validateToolInput(extensionSchema, { fixed: "known", extra: 1 }).errors, [{
  path: "$.extra",
  keyword: "oneOf",
  message: "must match exactly one schema in oneOf"
}]);
assert.deepEqual(validateToolInput({ type: "object", additionalProperties: true }, {
  arbitrary: { nested: [1, true, null] }
}).errors, []);

const deterministicUnknowns = validateToolInput({
  type: "object",
  additionalProperties: false
}, { zebra: true, alpha: true });
assert.deepEqual(deterministicUnknowns.errors.map((candidate) => candidate.path), ["$.alpha", "$.zebra"]);

const nestedOneOfSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    payload: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string" },
        alphaOnly: { type: "boolean" },
        betaOnly: { type: "boolean" }
      },
      required: ["kind"],
      oneOf: [
        {
          properties: {
            kind: { enum: ["alpha"] },
            alphaOnly: { type: "boolean", default: true }
          }
        },
        {
          properties: {
            kind: { enum: ["beta"] },
            betaOnly: { type: "boolean", default: true }
          }
        }
      ]
    }
  },
  required: ["payload"]
};
const nestedOneOf = validateToolInput(nestedOneOfSchema, { payload: { kind: "alpha" } });
assert.deepEqual(nestedOneOf.errors, []);
assert.equal(nestedOneOf.value.payload.alphaOnly, true);
assert.equal("betaOnly" in nestedOneOf.value.payload, false, "unselected branch defaults must not leak");

const manager = new DebugSessionManager({ policy: loadPolicy() });
let runToLineCalls = 0;
let statusCalls = 0;
let breakpointCalls = 0;
let dispatchedRunToLine: AnyRecord | undefined;
manager.bpDebugRunToLine = async (args) => {
  runToLineCalls += 1;
  dispatchedRunToLine = args;
  return { status: "paused" };
};
manager.bpDebugStatus = async () => {
  statusCalls += 1;
  return { sessions: [] };
};
manager.bpDebugSetBreakpoint = async () => {
  breakpointCalls += 1;
  return { breakpointId: "bp_test" };
};
const router = new ToolRouter(manager);

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
assert.equal(runToLineCalls, 0, "invalid arguments must not invoke the manager");

const unknownField = await router.callTool("bp_debug_status", { typo: true });
assert.equal(unknownField.error?.code, "INVALID_ARGUMENT");
assert.deepEqual(unknownField.error?.details?.issues, [{
  path: "$.typo",
  keyword: "additionalProperties",
  message: "is not allowed"
}]);
assert.equal(statusCalls, 0, "unknown properties must be rejected before dispatch");

const ambiguousBreakpoint = await router.callTool("bp_debug_set_breakpoint", {
  breakpointId: "bp_1",
  filePath: "src/Hello.java",
  line: 12
});
assert.equal(ambiguousBreakpoint.error?.code, "INVALID_ARGUMENT");
assert.equal(breakpointCalls, 0);

const aliasInput = { file: "src/Hello.java", line: 12 };
const aliasOnly = await router.callTool("bp_debug_run_to_line", aliasInput);
assert.equal(aliasOnly.error, undefined);
assert.equal(runToLineCalls, 1);
assert.deepEqual(aliasInput, { file: "src/Hello.java", line: 12 }, "router validation must not mutate callers");
assert.notStrictEqual(dispatchedRunToLine, aliasInput);
assert.equal(dispatchedRunToLine?.file, "src/Hello.java");
assert.equal(dispatchedRunToLine?.includeFrame, false);
assert.equal(dispatchedRunToLine?.detail, "compact");

const ambiguousFile = await router.callTool("bp_debug_run_to_line", {
  file: "src/Alias.java",
  filePath: "src/Canonical.java",
  line: 12
});
assert.equal(ambiguousFile.error?.code, "INVALID_ARGUMENT");
assert.equal(runToLineCalls, 1, "ambiguous file selectors must not dispatch");

const unknownTool = await router.callTool("bp_debug_missing", { typo: true });
assert.equal(unknownTool.error?.code, "TOOL_FAILED");
assert.equal(unknownTool.error?.message, "Unknown tool: bp_debug_missing");

const dynamicManager = new DebugSessionManager({ policy: loadPolicy() });
let startCalls = 0;
let dispatchedStart: AnyRecord | undefined;
dynamicManager.bpDebugStart = async (args) => {
  startCalls += 1;
  dispatchedStart = args;
  return { sessionId: "sess_dynamic" };
};
const dynamicRouter = new ToolRouter(dynamicManager);
const dynamicLanguage = "task3dynamic";
dynamicManager.adapters.register(new LanguageAdapter({
  language: dynamicLanguage,
  adapterId: "task3-dynamic-adapter",
  envCommandName: "BREAKPILOT_TASK3_DYNAMIC_ADAPTER"
}));

const acceptedDynamicLanguage = await dynamicRouter.callTool("bp_debug_start", {
  language: dynamicLanguage
});
assert.equal(acceptedDynamicLanguage.error, undefined);
assert.equal(startCalls, 1);
assert.equal(dispatchedStart?.language, dynamicLanguage);
assert.equal(dispatchedStart?.mode, "launch");

const rejectedDynamicLanguage = await dynamicRouter.callTool("bp_debug_start", {
  language: "not-registered-after-router-construction"
});
assert.equal(rejectedDynamicLanguage.error?.code, "INVALID_ARGUMENT");
assert.equal(startCalls, 1, "unregistered dynamic languages must not dispatch");
assert.equal(
  toolDefinitions.find((definition) => definition.name === "bp_debug_start")?.inputSchema.properties?.language?.enum,
  undefined,
  "dynamic validation must not mutate static tool definitions"
);

console.log("tool input validation tests ok");
