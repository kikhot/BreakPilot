import assert from "node:assert/strict";
import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import { variableNodeSchema } from "../src/control/schemaFragments.ts";
import { toolOutputSchemas } from "../src/control/toolOutputSchemas.ts";
import type { AnyRecord } from "../src/types/json.ts";

assert.equal(toolDefinitions.length, 15);
assert.deepEqual(Object.keys(toolOutputSchemas).sort(), toolDefinitions.map((tool) => tool.name).sort());

const expectedSuccessFields: Record<string, string[]> = {
  bp_debug_start: ["sessionId", "language", "mode", "state", "ideSessionId", "startMode", "providerKind", "capabilities", "warnings"],
  bp_debug_run_configurations: ["filePath", "configurations", "runPoints", "warnings"],
  bp_debug_status: ["activeSessionId", "sessions", "ideConnected", "ideSessions", "warnings"],
  bp_debug_control: ["status", "reason", "position", "frame", "variables", "events", "alreadyStopped", "warnings"],
  bp_debug_run_to_line: ["status", "position", "frame", "variables", "temporaryBreakpointId", "cleanedUp", "message", "warnings"],
  bp_debug_threads: ["threads", "offset", "totalCount", "warnings"],
  bp_debug_call_stack: ["threadId", "frames", "offset", "totalFrames", "partial", "warnings"],
  bp_debug_frame: ["threadId", "frame", "variables", "warnings"],
  bp_debug_value: ["name", "value", "path", "type", "ref", "children", "items", "result", "warnings"],
  bp_debug_set_value: ["path", "oldValue", "newValue", "applied", "result", "warnings"],
  bp_debug_eval: ["expression", "value", "type", "result", "warnings"],
  bp_debug_context: ["status", "position", "frames", "variables", "warnings"],
  bp_debug_set_breakpoint: [
    "breakpointId", "filePath", "line", "verified", "condition", "hitCondition", "logMessage",
    "owner", "enabled", "temporary", "suspendPolicy", "isLogMessage", "isLogStack", "message", "lineText", "warnings"
  ],
  bp_debug_list_breakpoints: ["breakpoints", "totalCount", "enabledCount", "source", "warnings"],
  bp_debug_remove_breakpoint: ["breakpointId", "removed", "protected", "message", "warnings"]
};

const expectedRequiredFields: Record<string, string[]> = {
  bp_debug_start: ["sessionId", "language", "mode", "state", "startMode", "providerKind", "capabilities"],
  bp_debug_run_configurations: [],
  bp_debug_status: ["activeSessionId", "sessions", "ideConnected", "ideSessions"],
  bp_debug_control: ["status"],
  bp_debug_run_to_line: ["status"],
  bp_debug_threads: ["threads", "offset", "totalCount"],
  bp_debug_call_stack: ["threadId", "frames", "offset", "totalFrames"],
  bp_debug_frame: ["threadId", "frame", "variables"],
  bp_debug_value: [],
  bp_debug_set_value: ["path", "oldValue"],
  bp_debug_eval: ["expression"],
  bp_debug_context: ["status", "position", "frames", "variables"],
  bp_debug_set_breakpoint: ["breakpointId", "filePath", "line", "verified", "owner", "enabled", "temporary"],
  bp_debug_list_breakpoints: ["breakpoints", "totalCount"],
  bp_debug_remove_breakpoint: ["removed"]
};

const scalarValueSchema: AnyRecord = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" }
  ]
};

for (const tool of toolDefinitions) {
  const output = tool.outputSchema as AnyRecord;
  assert.equal(output.type, "object", `${tool.name} output must be an object`);
  assert.notEqual(output.additionalProperties, true, `${tool.name} must not expose a generic output`);
  assert.ok(output.oneOf || output.properties, `${tool.name} must describe success fields`);
  const serialized = JSON.stringify(output);
  assert.match(serialized, /error/, `${tool.name} must describe structured errors`);
  const success = output.oneOf[0] as AnyRecord;
  assert.equal(success.additionalProperties, false, `${tool.name} success must be closed`);
  assert.deepEqual(
    Object.keys(success.properties).sort(),
    expectedSuccessFields[tool.name]?.slice().sort(),
    `${tool.name} must publish its exact compact success fields`
  );
  assert.deepEqual(
    (success.required ?? []).slice().sort(),
    expectedRequiredFields[tool.name]?.slice().sort(),
    `${tool.name} must publish its exact required success fields`
  );

  const error = output.oneOf[1] as AnyRecord;
  assert.equal(error.type, "object", `${tool.name} error must be an object`);
  assert.equal(error.additionalProperties, false, `${tool.name} error must be closed`);
  assert.deepEqual(Object.keys(error.properties).sort(), ["error", "warnings"]);
  assert.deepEqual(error.required, ["error"]);
  assert.equal(error.properties.error.type, "object");
  assert.equal(error.properties.error.additionalProperties, false);
  assert.deepEqual(error.properties.error.required, ["code", "message"]);
  assert.deepEqual(Object.keys(error.properties.error.properties).sort(), ["code", "details", "message"]);
  assert.equal(error.properties.error.properties.code.type, "string");
  assert.equal(error.properties.error.properties.message.type, "string");
  assert.equal(error.properties.error.properties.details.type, "object");
  assert.equal(error.properties.error.properties.details.additionalProperties, true);
  assert.equal(error.properties.warnings.type, "array");
  assert.equal(error.properties.warnings.items.type, "string");
}

function assertStrictVariableNodes(schema: AnyRecord, depth = 0): number {
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false, `variable node depth ${depth} must be closed`);
  const children = schema.properties.children as AnyRecord | undefined;
  if (!children) return depth;
  assert.equal(children.type, "array");
  return assertStrictVariableNodes(children.items as AnyRecord, depth + 1);
}

assert.equal(assertStrictVariableNodes(variableNodeSchema as AnyRecord), 8);

const allowedOpenOutputPaths = new Set<string>([
  ...toolDefinitions.map((tool) => `${tool.name}.error.details`),
  "bp_debug_run_configurations.success.configurations[]",
  "bp_debug_run_configurations.success.runPoints[]",
  "bp_debug_control.success.events.breakpointErrors[]",
  "bp_debug_control.success.events.tracepoints[]",
  "bp_debug_run_to_line.success.frame",
  "bp_debug_run_to_line.success.variables[]",
  "bp_debug_value.success.result",
  "bp_debug_set_value.success.result",
  "bp_debug_eval.success.result"
]);

function collectOpenObjects(schema: AnyRecord, path: string, found: string[]): void {
  if (Object.keys(schema).length === 0) found.push(path);
  if (schema.additionalProperties === true) found.push(path);
  for (const [name, property] of Object.entries((schema.properties ?? {}) as AnyRecord)) {
    collectOpenObjects(property as AnyRecord, `${path}.${name}`, found);
  }
  if (schema.items) collectOpenObjects(schema.items as AnyRecord, `${path}[]`, found);
  for (const branch of (schema.oneOf ?? []) as AnyRecord[]) {
    collectOpenObjects(branch, path, found);
  }
}

const openOutputPaths: string[] = [];
for (const tool of toolDefinitions) {
  const output = tool.outputSchema as AnyRecord;
  collectOpenObjects(output.oneOf[0] as AnyRecord, `${tool.name}.success`, openOutputPaths);
  collectOpenObjects(output.oneOf[1] as AnyRecord, tool.name, openOutputPaths);
}
assert.deepEqual(new Set(openOutputPaths), allowedOpenOutputPaths);

const setValueOutput = toolOutputSchemas.bp_debug_set_value;
const evalOutput = toolOutputSchemas.bp_debug_eval;
assert.ok(setValueOutput);
assert.ok(evalOutput);
const setValueProperties = (setValueOutput.oneOf?.[0]?.properties ?? {}) as AnyRecord;
const evalProperties = (evalOutput.oneOf?.[0]?.properties ?? {}) as AnyRecord;
assert.deepEqual(setValueProperties.oldValue, scalarValueSchema);
assert.deepEqual(setValueProperties.newValue, { type: "string" });
assert.deepEqual(evalProperties.value, scalarValueSchema);

const listBreakpointsOutput = toolOutputSchemas.bp_debug_list_breakpoints;
assert.ok(listBreakpointsOutput);
const breakpointOutput = listBreakpointsOutput.oneOf?.[0] as AnyRecord;
assert.equal(breakpointOutput.properties.breakpoints.items.properties.line.minimum, undefined);

const breakpoint = toolDefinitions.find((tool) => tool.name === "bp_debug_set_breakpoint");
assert.ok(breakpoint);
const input = breakpoint.inputSchema as AnyRecord;
assert.ok(Array.isArray(input.oneOf), "breakpoint target modes must be explicit oneOf schemas");
for (const branch of input.oneOf as AnyRecord[]) {
  assert.ok(branch.properties, "each target branch must carry its own properties");
  assert.equal(branch.additionalProperties, false);
}

console.log("tool output schema property tests ok");
