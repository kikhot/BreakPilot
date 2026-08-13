import assert from "node:assert/strict";
import test from "node:test";

import { validateToolInput, validateToolOutput } from "../src/control/ToolInputValidator.ts";
import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import type { JsonSchema } from "../src/types/control.ts";
import type { AnyRecord } from "../src/types/json.ts";

const legacyAliases = new Set([
  "file",
  "timeoutMs",
  "maxDepth",
  "maxItems",
  "maxStringLength",
  "objectFields",
  "variablesReference",
  "lang",
  "start",
  "count",
  "ref"
]);

function collectPropertyNames(schema: unknown, names = new Set<string>(), seen = new Set<object>()): Set<string> {
  if (!schema || typeof schema !== "object" || seen.has(schema as object)) return names;
  seen.add(schema as object);
  const record = schema as AnyRecord;
  const properties = record.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, child] of Object.entries(properties as AnyRecord)) {
      names.add(name);
      collectPropertyNames(child, names, seen);
    }
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const branches = record[key];
    if (Array.isArray(branches)) branches.forEach((branch) => collectPropertyNames(branch, names, seen));
  }
  if (record.items) collectPropertyNames(record.items, names, seen);
  if (record.$defs && typeof record.$defs === "object") {
    Object.values(record.$defs as AnyRecord).forEach((child) => collectPropertyNames(child, names, seen));
  }
  return names;
}

test("published debugger schemas fit the 30KB agent context budget", () => {
  assert.equal(toolDefinitions.length, 15);
  const bytes = Buffer.byteLength(JSON.stringify(toolDefinitions));
  assert.ok(bytes <= 30_000, `tools/list schemas use ${bytes} bytes`);

  const serialized = JSON.stringify(toolDefinitions);
  assert.match(serialized, /"\$ref"/);
  assert.ok((serialized.match(/"children"/g) ?? []).length <= 4);
});
test("every tool exposes compact diagnostics without legacy MCP aliases", () => {
  for (const definition of toolDefinitions) {
    const names = collectPropertyNames(definition.inputSchema);
    assert.ok(names.has("detail"), `${definition.name} must accept detail`);
    for (const alias of legacyAliases) {
      assert.equal(names.has(alias), false, `${definition.name} still publishes ${alias}`);
    }
  }

  const value = toolDefinitions.find((tool) => tool.name === "bp_debug_value");
  assert.ok(value);
  assert.ok(collectPropertyNames(value.inputSchema).has("handle"));
});

test("frame and context default to depth zero with bounded compact previews", () => {
  for (const name of ["bp_debug_frame", "bp_debug_context"]) {
    const tool = toolDefinitions.find((candidate) => candidate.name === name);
    assert.ok(tool);
    assert.equal(tool.inputSchema.properties?.depth?.default, 0);
    assert.equal(tool.inputSchema.properties?.maxString?.default, 200);
  }
});

test("local JSON Schema references validate recursive public values", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      value: { $ref: "#/$defs/value" }
    },
    required: ["value"],
    $defs: {
      value: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          children: {
            type: "array",
            items: { $ref: "#/$defs/value" }
          }
        },
        required: ["name"]
      }
    }
  } as JsonSchema;

  const valid = { value: { name: "root", children: [{ name: "child" }] } };
  assert.deepEqual(validateToolInput(schema, valid).errors, []);
  assert.deepEqual(validateToolOutput(schema, valid).errors, []);

  const invalid = { value: { name: "root", children: [{ name: 3 }] } };
  assert.ok(validateToolInput(schema, invalid).errors.length > 0);
  assert.ok(validateToolOutput(schema, invalid).errors.length > 0);
});
