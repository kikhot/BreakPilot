import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

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

function captureValidationErrors(schema: JsonSchema, input: unknown): unknown {
  try {
    return validateToolInput(schema, input).errors;
  } catch (error) {
    return { threw: error instanceof Error ? error.name : typeof error };
  }
}

const closedObjectSchema: JsonSchema = { type: "object", additionalProperties: false };
const jsonCompatibleObjectIssue = {
  path: "$",
  keyword: "type",
  message: "must be a JSON-compatible object"
};

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
assert.deepEqual(undefinedResult.errors, [jsonCompatibleObjectIssue]);
assert.deepEqual(explicitUndefined, { action: "wait", includeFrame: undefined });

const nonCloneableInputs: Array<{ label: string; value: unknown }> = [
  { label: "function", value: function nonJsonInput() {} },
  { label: "symbol", value: Symbol("non-json-input") },
  { label: "proxy", value: new Proxy({}, {}) },
  {
    label: "hostile proxy",
    value: new Proxy({}, {
      ownKeys() {
        throw new Error("hostile ownKeys trap");
      }
    })
  }
];
assert.deepEqual(
  nonCloneableInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(closedObjectSchema, value)
  })),
  nonCloneableInputs.map(({ label }) => ({ label, errors: [jsonCompatibleObjectIssue] }))
);

class CustomPrototypeInput {}

const exoticObjectInputs: Array<{ label: string; value: unknown }> = [
  { label: "Date", value: new Date(0) },
  { label: "Map", value: new Map() },
  { label: "Set", value: new Set() },
  { label: "RegExp", value: /non-json-input/ },
  { label: "custom prototype", value: new CustomPrototypeInput() }
];
assert.deepEqual(
  exoticObjectInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(closedObjectSchema, value)
  })),
  exoticObjectInputs.map(({ label }) => ({
    label,
    errors: [{ path: "$", keyword: "type", message: "must be object" }]
  }))
);

const nestedObjectSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    payload: { type: "object", additionalProperties: false }
  },
  required: ["payload"]
};
assert.deepEqual(
  exoticObjectInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(nestedObjectSchema, { payload: value })
  })),
  exoticObjectInputs.map(({ label }) => ({
    label,
    errors: [{ path: "$.payload", keyword: "type", message: "must be object" }]
  }))
);

const objectEnumSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    choice: { enum: [{}] }
  },
  required: ["choice"]
};
assert.deepEqual(
  exoticObjectInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(objectEnumSchema, { choice: value })
  })),
  exoticObjectInputs.map(({ label }) => ({
    label,
    errors: [{ path: "$.choice", keyword: "enum", message: "must be one of [{}]" }]
  }))
);

const nullPrototypeEnumValue = Object.assign(Object.create(null) as AnyRecord, { kind: "record" });
assert.deepEqual(validateToolInput({
  type: "object",
  properties: { choice: { enum: [nullPrototypeEnumValue] } }
}, { choice: { kind: "record" } }).errors, []);

assert.deepEqual(validateToolInput({
  type: "object",
  properties: { value: { type: "number", enum: [0] } }
}, { value: -0 }).errors, [], "JSON numeric enum equality must treat -0 and 0 as equal");

const structuralPrimitiveInputs: Array<{ label: string; value: unknown }> = [
  { label: "undefined", value: undefined },
  { label: "bigint", value: 1n },
  { label: "NaN", value: Number.NaN },
  { label: "positive infinity", value: Number.POSITIVE_INFINITY },
  { label: "negative infinity", value: Number.NEGATIVE_INFINITY }
];
const knownNumberPropertySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { value: { type: "number" } },
  required: ["value"]
};
assert.deepEqual(
  structuralPrimitiveInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(closedObjectSchema, value)
  })),
  structuralPrimitiveInputs.map(({ label }) => ({
    label,
    errors: [jsonCompatibleObjectIssue]
  }))
);
assert.deepEqual(
  structuralPrimitiveInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(knownNumberPropertySchema, { value })
  })),
  structuralPrimitiveInputs.map(({ label }) => ({
    label,
    errors: [jsonCompatibleObjectIssue]
  }))
);

const nonCloneableExoticInputs: Array<{ label: string; value: unknown }> = [
  { label: "WeakMap", value: new WeakMap() },
  { label: "WeakSet", value: new WeakSet() },
  { label: "Promise", value: Promise.resolve("non-json-input") }
];
assert.deepEqual(
  nonCloneableExoticInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(closedObjectSchema, value)
  })),
  nonCloneableExoticInputs.map(({ label }) => ({
    label,
    errors: [jsonCompatibleObjectIssue]
  }))
);
assert.deepEqual(
  nonCloneableExoticInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(nestedObjectSchema, { payload: value })
  })),
  nonCloneableExoticInputs.map(({ label }) => ({
    label,
    errors: [jsonCompatibleObjectIssue]
  }))
);

let containedAccessorReads = 0;
const containedAccessorValue: AnyRecord = {};
Object.defineProperty(containedAccessorValue, "unsafe", {
  get() {
    containedAccessorReads += 1;
    return "accessed";
  },
  enumerable: true,
  configurable: true
});
const cyclicMap = new Map<unknown, unknown>();
cyclicMap.set("self", cyclicMap);
const cloneSafeContainerInputs: Array<{ label: string; value: unknown }> = [
  { label: "Map bigint value", value: new Map([["value", 1n]]) },
  { label: "Map non-finite key", value: new Map([[Number.NaN, "value"]]) },
  { label: "Set undefined value", value: new Set([undefined]) },
  { label: "cyclic Map", value: cyclicMap }
];
const structurallyInvalidExoticInputs: Array<{ label: string; value: unknown }> = [
  { label: "Map function value", value: new Map([["value", () => undefined]]) },
  { label: "Map WeakMap value", value: new Map([["value", new WeakMap()]]) },
  { label: "Set symbol value", value: new Set([Symbol("non-cloneable")]) },
  { label: "Map accessor value", value: new Map([["value", containedAccessorValue]]) }
];
assert.deepEqual(
  structurallyInvalidExoticInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(closedObjectSchema, value)
  })),
  structurallyInvalidExoticInputs.map(({ label }) => ({
    label,
    errors: [jsonCompatibleObjectIssue]
  }))
);
assert.deepEqual(
  structurallyInvalidExoticInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(nestedObjectSchema, { payload: value })
  })),
  structurallyInvalidExoticInputs.map(({ label }) => ({
    label,
    errors: [jsonCompatibleObjectIssue]
  }))
);
assert.equal(containedAccessorReads, 0, "Map value accessors must not be invoked");
assert.deepEqual(
  cloneSafeContainerInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(closedObjectSchema, value)
  })),
  cloneSafeContainerInputs.map(({ label }) => ({
    label,
    errors: [{ path: "$", keyword: "type", message: "must be object" }]
  }))
);
assert.deepEqual(
  cloneSafeContainerInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(nestedObjectSchema, { payload: value })
  })),
  cloneSafeContainerInputs.map(({ label }) => ({
    label,
    errors: [{ path: "$.payload", keyword: "type", message: "must be object" }]
  }))
);

let crossRealmGetterReads = 0;
const crossRealmGetterValue: AnyRecord = {};
Object.defineProperty(crossRealmGetterValue, "unsafe", {
  get() {
    crossRealmGetterReads += 1;
    return "accessed";
  },
  enumerable: true,
  configurable: true
});
const unsafeCrossRealmMap = runInNewContext("new Map()") as Map<unknown, unknown>;
const unsafeCrossRealmSet = runInNewContext("new Set()") as Set<unknown>;
Map.prototype.set.call(unsafeCrossRealmMap, "value", crossRealmGetterValue);
Set.prototype.add.call(unsafeCrossRealmSet, crossRealmGetterValue);
const unsafeCrossRealmContainers = [
  { label: "cross-realm Map accessor value", value: unsafeCrossRealmMap },
  { label: "cross-realm Set accessor value", value: unsafeCrossRealmSet }
];
const safeCrossRealmContainers = [
  {
    label: "safe cross-realm Map",
    value: runInNewContext("new Map([['key', 'value']])") as Map<unknown, unknown>
  },
  {
    label: "safe cross-realm Set",
    value: runInNewContext("new Set(['value'])") as Set<unknown>
  }
];
const forgedContainerPrototypes = [
  { label: "forged Map prototype", value: Object.create(Map.prototype) as unknown },
  { label: "forged Set prototype", value: Object.create(Set.prototype) as unknown }
];
const realmBoundaryActual = {
  unsafe: unsafeCrossRealmContainers.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(closedObjectSchema, value)
  })),
  safeRoot: safeCrossRealmContainers.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(closedObjectSchema, value)
  })),
  safeNested: safeCrossRealmContainers.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(nestedObjectSchema, { payload: value })
  })),
  safeEnum: safeCrossRealmContainers.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(objectEnumSchema, { choice: value })
  })),
  forgedRoot: forgedContainerPrototypes.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(closedObjectSchema, value)
  })),
  forgedNested: forgedContainerPrototypes.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(nestedObjectSchema, { payload: value })
  })),
  forgedEnum: forgedContainerPrototypes.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors(objectEnumSchema, { choice: value })
  })),
  getterReads: crossRealmGetterReads
};
assert.deepEqual(realmBoundaryActual, {
  unsafe: unsafeCrossRealmContainers.map(({ label }) => ({
    label,
    errors: [jsonCompatibleObjectIssue]
  })),
  safeRoot: safeCrossRealmContainers.map(({ label }) => ({
    label,
    errors: [{ path: "$", keyword: "type", message: "must be object" }]
  })),
  safeNested: safeCrossRealmContainers.map(({ label }) => ({
    label,
    errors: [{ path: "$.payload", keyword: "type", message: "must be object" }]
  })),
  safeEnum: safeCrossRealmContainers.map(({ label }) => ({
    label,
    errors: [{ path: "$.choice", keyword: "enum", message: "must be one of [{}]" }]
  })),
  forgedRoot: forgedContainerPrototypes.map(({ label }) => ({
    label,
    errors: [{ path: "$", keyword: "type", message: "must be object" }]
  })),
  forgedNested: forgedContainerPrototypes.map(({ label }) => ({
    label,
    errors: [{ path: "$.payload", keyword: "type", message: "must be object" }]
  })),
  forgedEnum: forgedContainerPrototypes.map(({ label }) => ({
    label,
    errors: [{ path: "$.choice", keyword: "enum", message: "must be one of [{}]" }]
  })),
  getterReads: 0
});

let accessorReads = 0;
const accessorInput: AnyRecord = {};
Object.defineProperty(accessorInput, "value", {
  get() {
    accessorReads += 1;
    return "accessed";
  },
  enumerable: true,
  configurable: true
});
const nonEnumerableInput: AnyRecord = {};
Object.defineProperty(nonEnumerableInput, "value", {
  value: "hidden",
  writable: true,
  enumerable: false,
  configurable: true
});
const symbolKeyedInput: AnyRecord = {};
Object.defineProperty(symbolKeyedInput, Symbol("symbol-key"), {
  value: "hidden",
  writable: true,
  enumerable: true,
  configurable: true
});
const sparseArray = new Array(1);
const extraKeyArray: unknown[] & { extra?: string } = [];
extraKeyArray.extra = "not-an-index";
const cyclicInput: AnyRecord = {};
cyclicInput.self = cyclicInput;
let exoticAccessorReads = 0;
const exoticAccessorInput = new Date(0);
Object.defineProperty(exoticAccessorInput, "unsafe", {
  get() {
    exoticAccessorReads += 1;
    return "accessed";
  },
  enumerable: true,
  configurable: true
});

const wholeGraphInvalidInputs: Array<{ label: string; value: unknown }> = [
  { label: "undefined property", value: { value: undefined } },
  { label: "function property", value: { value() {} } },
  { label: "symbol property", value: { value: Symbol("nested") } },
  { label: "bigint property", value: { value: 1n } },
  { label: "NaN property", value: { value: Number.NaN } },
  { label: "infinite property", value: { value: Number.POSITIVE_INFINITY } },
  { label: "symbol-keyed property", value: symbolKeyedInput },
  { label: "accessor property", value: accessorInput },
  { label: "non-enumerable property", value: nonEnumerableInput },
  { label: "sparse array", value: { value: sparseArray } },
  { label: "extra-key array", value: { value: extraKeyArray } },
  { label: "exotic accessor property", value: exoticAccessorInput },
  { label: "cycle", value: cyclicInput }
];
assert.deepEqual(
  wholeGraphInvalidInputs.map(({ label, value }) => ({
    label,
    errors: captureValidationErrors({ type: "object", additionalProperties: true }, value)
  })),
  wholeGraphInvalidInputs.map(({ label }) => ({
    label,
    errors: [jsonCompatibleObjectIssue]
  }))
);
assert.equal(accessorReads, 0, "JSON compatibility checks must not invoke accessors");
assert.equal(exoticAccessorReads, 0, "exotic compatibility checks must not invoke accessors");

const sharedNode = { label: "shared" };
const sharedInput = { left: sharedNode, right: sharedNode };
const sharedResult = validateToolInput({
  type: "object",
  additionalProperties: false,
  properties: {
    left: {
      type: "object",
      additionalProperties: false,
      properties: { label: { type: "string" } },
      required: ["label"]
    },
    right: {
      type: "object",
      additionalProperties: false,
      properties: { label: { type: "string" } },
      required: ["label"]
    }
  },
  required: ["left", "right"]
}, sharedInput);
assert.deepEqual(sharedResult.errors, []);
assert.notStrictEqual(sharedResult.value.left, sharedNode);
assert.strictEqual(
  sharedResult.value.left,
  sharedResult.value.right,
  "shared acyclic references must not be mistaken for cycles"
);

const nullPrototypeInput = Object.assign(Object.create(null) as AnyRecord, { label: "record" });
assert.deepEqual(validateToolInput({
  type: "object",
  additionalProperties: false,
  properties: { label: { type: "string" } },
  required: ["label"]
}, nullPrototypeInput).errors, []);

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
assert.deepEqual(validateToolInput(extensionSchema, {
  fixed: "known",
  extra: new Date(0)
}).errors, [{
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

const prototypeProperties: Record<string, JsonSchema> = {};
Object.defineProperty(prototypeProperties, "__proto__", {
  value: {
    type: "object",
    additionalProperties: false,
    properties: { safe: { type: "boolean" } },
    default: { safe: true }
  },
  writable: true,
  enumerable: true,
  configurable: true
});
const prototypeDefault = validateToolInput({
  type: "object",
  additionalProperties: false,
  properties: prototypeProperties
}, {});
assert.deepEqual(prototypeDefault.errors, []);
assert.equal(
  Object.getPrototypeOf(prototypeDefault.value),
  Object.prototype,
  "a __proto__ default must not change the normalized object's prototype"
);
assert.deepEqual(Object.getOwnPropertyDescriptor(prototypeDefault.value, "__proto__"), {
  value: { safe: true },
  writable: true,
  enumerable: true,
  configurable: true
});

const manager = new DebugSessionManager({ policy: loadPolicy() });
let runToLineCalls = 0;
let statusCalls = 0;
let breakpointCalls = 0;
const dispatchedBreakpoints: AnyRecord[] = [];
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
manager.bpDebugSetBreakpoint = async (args) => {
  breakpointCalls += 1;
  dispatchedBreakpoints.push(structuredClone(args ?? {}));
  return {
    breakpointId: "bp_test",
    filePath: "src/Hello.java",
    line: 12,
    verified: true,
    owner: "agent",
    enabled: true,
    temporary: false
  };
};
const router = new ToolRouter(manager);

const expectedStatusRootError = {
  code: "INVALID_ARGUMENT",
  message: "Invalid arguments for bp_debug_status.",
  details: { issues: [jsonCompatibleObjectIssue] }
};
const nonCloneableRouterResults = [];
for (const { label, value } of nonCloneableInputs) {
  const response = await router.callTool("bp_debug_status", value);
  nonCloneableRouterResults.push({ label, error: response.error });
}
assert.deepEqual(
  nonCloneableRouterResults,
  nonCloneableInputs.map(({ label }) => ({ label, error: expectedStatusRootError }))
);
assert.equal(statusCalls, 0, "non-cloneable arguments must not invoke the manager");

const nonCloneableExoticRouterResults = [];
for (const { label, value } of nonCloneableExoticInputs) {
  const response = await router.callTool("bp_debug_status", value);
  nonCloneableExoticRouterResults.push({ label, error: response.error });
}
assert.deepEqual(
  nonCloneableExoticRouterResults,
  nonCloneableExoticInputs.map(({ label }) => ({ label, error: expectedStatusRootError }))
);
assert.equal(statusCalls, 0, "non-cloneable exotic arguments must not invoke the manager");

const structurallyInvalidExoticRouterResults = [];
for (const { label, value } of structurallyInvalidExoticInputs) {
  const response = await router.callTool("bp_debug_status", value);
  structurallyInvalidExoticRouterResults.push({ label, error: response.error });
}
assert.deepEqual(
  structurallyInvalidExoticRouterResults,
  structurallyInvalidExoticInputs.map(({ label }) => ({ label, error: expectedStatusRootError }))
);
assert.equal(statusCalls, 0, "structurally invalid exotics must not invoke the manager");
assert.equal(containedAccessorReads, 0, "router validation must not invoke Map value accessors");

const expectedExoticRootError = {
  code: "INVALID_ARGUMENT",
  message: "Invalid arguments for bp_debug_status.",
  details: { issues: [{ path: "$", keyword: "type", message: "must be object" }] }
};
const exoticRootRouterResults = [];
for (const { label, value } of exoticObjectInputs) {
  const response = await router.callTool("bp_debug_status", value);
  exoticRootRouterResults.push({ label, error: response.error });
}
assert.deepEqual(
  exoticRootRouterResults,
  exoticObjectInputs.map(({ label }) => ({ label, error: expectedExoticRootError }))
);
assert.equal(statusCalls, 0, "exotic root objects must not invoke the manager");

const cloneSafeContainerRouterResults = [];
for (const { label, value } of cloneSafeContainerInputs) {
  const response = await router.callTool("bp_debug_status", value);
  cloneSafeContainerRouterResults.push({ label, error: response.error });
}
assert.deepEqual(
  cloneSafeContainerRouterResults,
  cloneSafeContainerInputs.map(({ label }) => ({ label, error: expectedExoticRootError }))
);
assert.equal(statusCalls, 0, "clone-safe exotic containers must not invoke the manager");

const cyclicRouterResult = await router.callTool("bp_debug_status", cyclicInput);
assert.deepEqual(cyclicRouterResult.error, expectedStatusRootError);
assert.equal(statusCalls, 0, "cyclic arguments must not invoke the manager");

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

const relocatedBreakpoint = await router.callTool("bp_debug_set_breakpoint", {
  breakpointId: "bp_1",
  filePath: "src/Hello.java",
  line: 12
});
assert.equal(relocatedBreakpoint.error, undefined);
assert.equal(breakpointCalls, 1);
assert.deepEqual(dispatchedBreakpoints[0], {
  breakpointId: "bp_1",
  filePath: "src/Hello.java",
  line: 12
});

const validPatchInputs = [
  { breakpointId: "bp_1" },
  { breakpointId: "bp_1", line: 13 },
  { breakpointId: "bp_1", file: "src/Legacy.java", line: 14 },
  { breakpointId: "bp_1", column: null, condition: null, hitCondition: null, logMessage: null },
  { breakpointId: "bp_1", enabled: false, owner: "all", requireVerified: true }
];
for (const patchInput of validPatchInputs) {
  const response = await router.callTool("bp_debug_set_breakpoint", patchInput);
  assert.equal(response.error, undefined, JSON.stringify(patchInput));
}
assert.equal(breakpointCalls, 1 + validPatchInputs.length);
assert.deepEqual(dispatchedBreakpoints[4], {
  breakpointId: "bp_1",
  column: null,
  condition: null,
  hitCondition: null,
  logMessage: null
});
assert.equal("enabled" in (dispatchedBreakpoints[1] ?? {}), false, "id-only patches must remain default-free");
assert.equal("owner" in (dispatchedBreakpoints[1] ?? {}), false, "id-only patches must remain default-free");

const invalidPatchInputs = [
  { breakpointId: "bp_1", filePath: "src/Relocated.java" },
  { breakpointId: "bp_1", file: "src/Legacy.java" },
  { breakpointId: "bp_1", filePath: "src/Canonical.java", file: "src/Legacy.java", line: 15 },
  { breakpointId: "bp_1", line: null },
  { breakpointId: "bp_1", enabled: null },
  { breakpointId: "bp_1", unknownPatchField: true },
  { breakpointId: "bp_1", temporary: true },
  { breakpointId: "bp_1", suspendPolicy: "ALL" }
];
for (const patchInput of invalidPatchInputs) {
  const response = await router.callTool("bp_debug_set_breakpoint", patchInput);
  assert.equal(response.error?.code, "INVALID_ARGUMENT", JSON.stringify(patchInput));
}
assert.equal(
  breakpointCalls,
  1 + validPatchInputs.length,
  "invalid breakpoint patch inputs must not dispatch"
);

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
  return {
    sessionId: "sess_dynamic",
    language: String(args?.language),
    mode: "headless",
    state: "running",
    startMode: "launch",
    providerKind: "dap",
    capabilities: {
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
    }
  };
};
const dynamicRouter = new ToolRouter(dynamicManager);
const dynamicLanguage = "task3dynamic";
dynamicManager.adapters.register(new LanguageAdapter({
  language: dynamicLanguage,
  adapterId: "task3-dynamic-adapter",
  envCommandName: "BREAKPILOT_TASK3_DYNAMIC_ADAPTER"
}));

const exoticNestedRouterResults = [];
for (const { label, value } of exoticObjectInputs) {
  const response = await dynamicRouter.callTool("bp_debug_start", {
    language: dynamicLanguage,
    env: value
  });
  exoticNestedRouterResults.push({ label, error: response.error });
}
const expectedExoticNestedError = {
  code: "INVALID_ARGUMENT",
  message: "Invalid arguments for bp_debug_start.",
  details: { issues: [{ path: "$.env", keyword: "type", message: "must be object" }] }
};
assert.deepEqual(
  exoticNestedRouterResults,
  exoticObjectInputs.map(({ label }) => ({ label, error: expectedExoticNestedError }))
);
assert.equal(startCalls, 0, "exotic nested objects must not invoke the manager");

const nonCloneableExoticNestedRouterResults = [];
for (const { label, value } of nonCloneableExoticInputs) {
  const response = await dynamicRouter.callTool("bp_debug_start", {
    language: dynamicLanguage,
    env: value
  });
  nonCloneableExoticNestedRouterResults.push({ label, error: response.error });
}
const expectedStartRootCompatibilityError = {
  code: "INVALID_ARGUMENT",
  message: "Invalid arguments for bp_debug_start.",
  details: { issues: [jsonCompatibleObjectIssue] }
};
assert.deepEqual(
  nonCloneableExoticNestedRouterResults,
  nonCloneableExoticInputs.map(({ label }) => ({
    label,
    error: expectedStartRootCompatibilityError
  }))
);
assert.equal(startCalls, 0, "nested non-cloneable exotics must not invoke the manager");

const nestedOneOfRouterResult = await dynamicRouter.callTool("bp_debug_start", {
  language: dynamicLanguage,
  env: { KEY: new Date(0) }
});
assert.deepEqual(nestedOneOfRouterResult.error, {
  code: "INVALID_ARGUMENT",
  message: "Invalid arguments for bp_debug_start.",
  details: {
    issues: [{
      path: "$.env.KEY",
      keyword: "oneOf",
      message: "must match exactly one schema in oneOf"
    }]
  }
});
assert.equal(startCalls, 0, "invalid nested oneOf values must not invoke the manager");

const acceptedDynamicLanguage = await dynamicRouter.callTool("bp_debug_start", {
  language: dynamicLanguage
});
assert.equal(acceptedDynamicLanguage.error, undefined);
assert.equal(startCalls, 1);
assert.equal(dispatchedStart?.language, dynamicLanguage);
assert.equal(dispatchedStart?.mode, undefined, "omitted routing mode must reach the manager unchanged");
assert.equal(dispatchedStart?.host, undefined, "omitted attach host must reach the manager unchanged");

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
