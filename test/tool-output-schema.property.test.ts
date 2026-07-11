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
