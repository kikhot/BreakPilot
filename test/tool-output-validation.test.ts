import assert from "node:assert/strict";
import { validateToolInput, validateToolOutput } from "../src/control/ToolInputValidator.ts";
import type { JsonSchema } from "../src/types/control.ts";

const schema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { required: { type: "string" }, optional: { type: "string", default: "added" } },
  required: ["required"]
};
const candidate = { required: "present" };
assert.deepEqual(validateToolInput(schema, candidate).value, { required: "present", optional: "added" });
const output = validateToolOutput(schema, candidate);
assert.equal(output.value, candidate, "output validation returns the original object");
assert.deepEqual(candidate, { required: "present" }, "output validation never applies defaults");
assert.deepEqual(output.errors, []);
assert.equal(validateToolOutput(schema, {}).errors[0]?.path, "$.required");
assert.equal(validateToolOutput(schema, { required: "ok", extra: true }).errors[0]?.keyword, "additionalProperties");

const jsonCompatibleObjectIssue = {
  path: "$",
  keyword: "type",
  message: "must be a JSON-compatible object"
};
const permissiveSchema: JsonSchema = { type: "object", additionalProperties: true };
let accessorReads = 0;
const accessorOutput = {};
Object.defineProperty(accessorOutput, "unsafe", {
  get() {
    accessorReads += 1;
    return "accessed";
  },
  enumerable: true,
  configurable: true
});
const cyclicOutput: { self?: unknown } = {};
cyclicOutput.self = cyclicOutput;
const nonJsonOutputs = [
  { value: { undefined: undefined } },
  { value: { bigint: 1n } },
  { value: { function() {} } },
  { value: { symbol: Symbol("output") } },
  { value: { nonFinite: Number.NaN } },
  { value: accessorOutput },
  { value: cyclicOutput },
  { value: new Map() },
  { value: new Set() },
  { value: new Date(0) }
];
assert.deepEqual(
  nonJsonOutputs.map(({ value }) => validateToolOutput(permissiveSchema, value).errors),
  nonJsonOutputs.map(() => [jsonCompatibleObjectIssue])
);
assert.equal(accessorReads, 0, "output validation must not invoke accessors");
console.log("tool output validation tests ok");
