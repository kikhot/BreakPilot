import assert from "node:assert/strict";

import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import { variableNodeSchema } from "../src/control/schemaFragments.ts";
import { toolOutputSchemas } from "../src/control/toolOutputSchemas.ts";
import type { AnyRecord } from "../src/types/json.ts";

assert.equal(toolDefinitions.length, 15);
assert.deepEqual(Object.keys(toolOutputSchemas).sort(), toolDefinitions.map((tool) => tool.name).sort());

const successFields: Record<string, string[]> = {
  bp_debug_start: ["sessionId", "state", "startMode", "target"],
  bp_debug_run_configurations: ["configurations", "runPoints"],
  bp_debug_status: ["activeSessionId", "sessions", "ideConnected"],
  bp_debug_control: [
    "state", "reason", "at", "pauseId", "arguments", "locals", "fields", "scopes",
    "incomplete", "events", "alreadyStopped"
  ],
  bp_debug_run_to_line: [
    "state", "reached", "target", "reason", "at", "pauseId", "arguments", "locals",
    "fields", "scopes", "incomplete", "message"
  ],
  bp_debug_threads: ["threads", "nextOffset"],
  bp_debug_call_stack: ["threadId", "frames", "pauseId", "nextOffset", "incomplete"],
  bp_debug_frame: ["frame", "arguments", "locals", "fields", "scopes", "pauseId", "incomplete"],
  bp_debug_value: ["value"],
  bp_debug_set_value: ["target", "oldValue", "newValue", "applied", "verified"],
  bp_debug_eval: ["expression", "value", "type", "handle"],
  bp_debug_context: [
    "state", "reason", "at", "pauseId", "arguments", "locals", "fields", "scopes",
    "incomplete", "stack"
  ],
  bp_debug_set_breakpoint: [
    "id", "at", "verified", "owner", "condition", "hitCondition", "logMessage", "enabled",
    "temporary", "suspendPolicy", "message", "operation", "changed", "lineText"
  ],
  bp_debug_list_breakpoints: ["breakpoints"],
  bp_debug_remove_breakpoint: ["id", "removed", "protected", "message"]
};

const requiredFields: Record<string, string[]> = {
  bp_debug_start: ["sessionId", "state", "startMode"],
  bp_debug_run_configurations: [],
  bp_debug_status: ["sessions", "ideConnected"],
  bp_debug_control: ["state"],
  bp_debug_run_to_line: ["state", "reached", "target"],
  bp_debug_threads: ["threads"],
  bp_debug_call_stack: ["threadId", "frames"],
  bp_debug_frame: ["frame"],
  bp_debug_value: ["value"],
  bp_debug_set_value: ["target", "oldValue", "newValue", "applied", "verified"],
  bp_debug_eval: ["expression", "value"],
  bp_debug_context: ["state"],
  bp_debug_set_breakpoint: ["id", "at", "verified", "owner"],
  bp_debug_list_breakpoints: ["breakpoints"],
  bp_debug_remove_breakpoint: ["removed"]
};

for (const tool of toolDefinitions) {
  const output = tool.outputSchema as AnyRecord;
  assert.equal(output.type, "object", `${tool.name} output must be an object`);
  assert.equal((output.oneOf as AnyRecord[]).length, 2, `${tool.name} must publish success and error branches`);

  const success = (output.oneOf as AnyRecord[])[0] as AnyRecord;
  assert.equal(success.additionalProperties, false, `${tool.name} compact output must be closed`);
  const properties = success.properties as AnyRecord;
  assert.deepEqual(
    Object.keys(properties).sort(),
    [...successFields[tool.name]!, "diagnostics", "warnings"].sort(),
    `${tool.name} compact fields drifted`
  );
  assert.deepEqual((success.required ?? []).slice().sort(), requiredFields[tool.name]!.slice().sort());
  assert.equal((properties.diagnostics as AnyRecord).type, "object");
  assert.equal((properties.warnings as AnyRecord).type, "array");

  const error = (output.oneOf as AnyRecord[])[1] as AnyRecord;
  assert.equal(error.additionalProperties, false, `${tool.name} error envelope must be closed`);
  assert.deepEqual(error.required, ["error"]);
  assert.deepEqual(
    ((error.properties as AnyRecord).error as AnyRecord).required,
    ["code", "message", "retrySafe", "actionMayHaveApplied"]
  );
}

const valueSchema = variableNodeSchema as AnyRecord;
assert.equal(valueSchema.$ref, "#/$defs/agentValue");
const valueDefinition = (valueSchema.$defs as AnyRecord).agentValue as AnyRecord;
assert.equal(((valueDefinition.properties as AnyRecord).children as AnyRecord).items.$ref, "#/$defs/agentValue");
assert.equal(JSON.stringify(variableNodeSchema).match(/"children"/g)?.length, 1);

const serialized = JSON.stringify(toolDefinitions);
for (const forbidden of ["providerKind", "variablesReference", "JavaStackFrame", '"details"']) {
  assert.equal(serialized.includes(forbidden), false, `public schemas leak ${forbidden}`);
}

console.log("tool output schema property tests ok");
