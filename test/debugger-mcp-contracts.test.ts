import assert from "node:assert/strict";

import { ToolRouter } from "../src/control/ToolRouter.ts";
import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import type { AnyRecord } from "../src/types/json.ts";

function tool(name: string): AnyRecord {
  const found = toolDefinitions.find((candidate) => candidate.name === name);
  assert.ok(found, `expected ${name} to exist`);
  return found as unknown as AnyRecord;
}

function properties(name: string): AnyRecord {
  return ((tool(name).inputSchema as AnyRecord).properties ?? {}) as AnyRecord;
}

function propertyNames(name: string): string[] {
  return Object.keys(properties(name)).sort();
}

function assertHasProperties(name: string, expected: string[]): void {
  const names = propertyNames(name);
  for (const field of expected) {
    assert.ok(names.includes(field), `${name} should expose ${field}`);
  }
}

const runToLine = tool("bp_debug_run_to_line");
assert.equal(runToLine.description, "Run the selected debug session to a source line.");
assert.deepEqual((runToLine.inputSchema as AnyRecord).required, ["filePath", "line"]);
assertHasProperties("bp_debug_run_to_line", [
  "projectPath",
  "sessionId",
  "filePath",
  "line",
  "threadId",
  "timeout",
  "includeFrame",
  "detail"
]);

assertHasProperties("bp_debug_set_breakpoint", [
  "breakpointId",
  "enabled",
  "temporary",
  "suspendPolicy",
  "isLogMessage",
  "isLogStack",
  "owner",
  "detail"
]);

assertHasProperties("bp_debug_list_breakpoints", [
  "owner",
  "includeDisabled",
  "detail"
]);

assertHasProperties("bp_debug_remove_breakpoint", [
  "owner"
]);

assertHasProperties("bp_debug_threads", [
  "offset",
  "detail"
]);

assertHasProperties("bp_debug_call_stack", [
  "offset",
  "detail"
]);

assertHasProperties("bp_debug_set_value", [
  "detail"
]);

assertHasProperties("bp_debug_control", [
  "detail"
]);

assertHasProperties("bp_debug_context", [
  "detail"
]);

const manager = new DebugSessionManager({ policy: loadPolicy() });
const router = new ToolRouter(manager);
const listed = router.listTools().map((candidate) => candidate.name);
assert.ok(listed.includes("bp_debug_run_to_line"), "ToolRouter should advertise bp_debug_run_to_line");

const response = await router.callTool("bp_debug_run_to_line", {
  filePath: "src/Hello.java",
  line: 12
});
assert.equal(response.error?.code, "UNSUPPORTED_CAPABILITY");
assert.match(
  response.error?.message ?? "",
  /runtime implementation is not available/i
);

console.log("debugger mcp contract tests ok");
