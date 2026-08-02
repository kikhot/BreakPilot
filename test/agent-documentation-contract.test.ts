import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { validateToolInput } from "../src/control/ToolInputValidator.ts";
import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import type { AnyRecord } from "../src/types/json.ts";

const definitionByName = new Map(toolDefinitions.map((definition) => [definition.name, definition]));
const agentGuides = [
  "agents/breakpilot-debugger.md",
  "skills/breakpilot-debugger/SKILL.md",
  "docs/mcp-tools.md",
  "docs/mcp-tools.zh-CN.md"
];

test("agent guide MCP examples conform to the published canonical inputs", () => {
  let examples = 0;
  for (const file of agentGuides) {
    const source = fs.readFileSync(file, "utf8");
    for (const line of source.split("\n")) {
      if (!line.startsWith('{"tool":"bp_debug_')) continue;
      examples += 1;
      const call = JSON.parse(line) as AnyRecord;
      const definition = definitionByName.get(String(call.tool));
      assert.ok(definition, `${file} references unknown tool ${String(call.tool)}`);
      const validation = validateToolInput(definition.inputSchema, call.arguments ?? {});
      assert.deepEqual(validation.errors, [], `${file}: ${line}`);
    }
  }
  assert.ok(examples >= 10, "agent guides must retain a task-complete debugger example");
});
