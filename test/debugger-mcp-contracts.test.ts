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
  const inputSchema = tool(name).inputSchema as AnyRecord;
  if (name === "bp_debug_control" && Array.isArray(inputSchema.oneOf)) {
    const ordinary = inputSchema.oneOf.find(
      (branch: AnyRecord) => !branch.properties?.action?.enum?.includes("drainEvents")
    ) as AnyRecord | undefined;
    return (ordinary?.properties ?? {}) as AnyRecord;
  }
  return (inputSchema.properties ?? {}) as AnyRecord;
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
assert.deepEqual((runToLine.inputSchema as AnyRecord).required, ["line"]);
assert.deepEqual((runToLine.inputSchema as AnyRecord).oneOf, [
  { required: ["filePath"] },
  { required: ["file"] }
]);
assert.equal(properties("bp_debug_run_to_line").line.minimum, 1);
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
const breakpointInput = tool("bp_debug_set_breakpoint").inputSchema as AnyRecord;
assert.ok(Array.isArray(breakpointInput.oneOf));
assert.equal(breakpointInput.oneOf.length, 2);
const breakpointLocationInput = breakpointInput.oneOf[0] as AnyRecord;
const breakpointIdInput = breakpointInput.oneOf[1] as AnyRecord;
assert.deepEqual(breakpointLocationInput.required, ["line"]);
assert.deepEqual(breakpointLocationInput.oneOf, [
  { required: ["filePath"] },
  { required: ["file"] }
]);
assert.deepEqual(breakpointIdInput.required, ["breakpointId"]);
assert.equal(breakpointLocationInput.additionalProperties, false);
assert.equal(breakpointIdInput.additionalProperties, false);
assert.equal("breakpointId" in breakpointLocationInput.properties, false);
assert.equal("filePath" in breakpointIdInput.properties, false);
assert.equal("line" in breakpointIdInput.properties, false);
assert.equal("column" in breakpointIdInput.properties, false);
assert.ok("column" in breakpointLocationInput.properties);

const breakpointSharedProperties = [
  "projectPath",
  "workspace",
  "sessionId",
  "clientId",
  "ide",
  "enabled",
  "temporary",
  "suspendPolicy",
  "isLogMessage",
  "isLogStack",
  "owner",
  "requireVerified",
  "detail"
];
for (const branch of [breakpointLocationInput, breakpointIdInput]) {
  for (const field of breakpointSharedProperties) {
    assert.ok(field in branch.properties, `breakpoint branch should expose ${field}`);
  }
  for (const nullableField of ["condition", "hitCondition", "logMessage"]) {
    assert.deepEqual(branch.properties[nullableField].oneOf, [
      { type: "string" },
      { type: "null" }
    ]);
  }
}

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

const control = tool("bp_debug_control");
const controlInput = control.inputSchema as AnyRecord;
assert.equal(controlInput.type, "object");
assert.ok(Array.isArray(controlInput.oneOf), "bp_debug_control should separate drain events from ordinary actions");
const drainBranch = (controlInput.oneOf as AnyRecord[]).find(
  (branch) => branch.properties?.action?.enum?.includes("drainEvents")
);
assert.deepEqual(drainBranch?.properties?.cursor?.type, "integer");
assert.deepEqual(drainBranch?.properties?.cursor?.minimum, 0);
assert.deepEqual(drainBranch?.properties?.limit?.maximum, 256);
const serializedControlOutput = JSON.stringify(control.outputSchema);
for (const field of ["items", "nextCursor", "oldestCursor", "overflowed", "droppedCount"]) {
  assert.match(serializedControlOutput, new RegExp(field));
}

assertHasProperties("bp_debug_context", [
  "detail"
]);

for (const definition of toolDefinitions) {
  if (definition.name === "bp_debug_set_breakpoint" || definition.name === "bp_debug_control") continue;
  assert.equal(
    (definition.inputSchema as AnyRecord).additionalProperties,
    false,
    `${definition.name} input should reject undeclared arguments`
  );
}

assertHasProperties("bp_debug_start", [
  "workspace",
  "lang",
  "owner",
  "adapterPort",
  "file",
  "timeout",
  "timeoutMs"
]);
assertHasProperties("bp_debug_run_configurations", ["workspace", "file"]);
assertHasProperties("bp_debug_status", ["workspace", "clientId", "detail"]);
assertHasProperties("bp_debug_control", [
  "workspace",
  "timeoutMs",
  "objectFields",
  "maxDepth",
  "maxItems",
  "maxStringLength",
  "redactPatterns"
]);
assertHasProperties("bp_debug_run_to_line", ["workspace", "file", "timeoutMs"]);
assertHasProperties("bp_debug_threads", ["workspace"]);
assertHasProperties("bp_debug_call_stack", ["workspace"]);
for (const name of ["bp_debug_frame", "bp_debug_value", "bp_debug_set_value"]) {
  assertHasProperties(name, [
    "workspace",
    "timeout",
    "timeoutMs",
    "objectFields",
    "maxDepth",
    "maxItems",
    "maxStringLength",
    "redactPatterns"
  ]);
}
assertHasProperties("bp_debug_value", ["variablesReference"]);
assertHasProperties("bp_debug_set_value", [
  "threadId",
  "frameId",
  "expand",
  "depth",
  "limit",
  "maxString"
]);
assertHasProperties("bp_debug_eval", ["workspace", "timeoutMs", "context"]);
assertHasProperties("bp_debug_context", [
  "workspace",
  "clientId",
  "ideSessionId",
  "frameIndex",
  "profile",
  "objectFields",
  "maxDepth",
  "maxItems",
  "maxStringLength",
  "timeoutMs",
  "threadId",
  "frameId",
  "maxString",
  "redactPatterns"
]);
assert.ok("file" in breakpointLocationInput.properties);
assertHasProperties("bp_debug_list_breakpoints", ["workspace", "file"]);
assertHasProperties("bp_debug_remove_breakpoint", ["workspace", "file"]);

for (const name of [
  "bp_debug_control",
  "bp_debug_frame",
  "bp_debug_value",
  "bp_debug_set_value",
  "bp_debug_context"
]) {
  for (const field of ["depth", "maxDepth"]) {
    const schema = properties(name)[field] as AnyRecord;
    assert.equal(schema.minimum, 0, `${name}.${field} should reject negative expansion depth`);
    assert.equal(schema.maximum, 8, `${name}.${field} should cap expansion depth`);
  }
}

const statusOutput = tool("bp_debug_status").outputSchema as AnyRecord;
assert.match(JSON.stringify(statusOutput), /capabilities/);

const startOutput = tool("bp_debug_start").outputSchema as AnyRecord;
assert.match(JSON.stringify(startOutput), /capabilities/);

const manager = new DebugSessionManager({ policy: loadPolicy() });
const router = new ToolRouter(manager);
const listed = router.listTools().map((candidate) => candidate.name);
assert.ok(listed.includes("bp_debug_run_to_line"), "ToolRouter should advertise bp_debug_run_to_line");
assert.ok(listed.includes("bp_debug_run_configurations"), "ToolRouter should advertise bp_debug_run_configurations");

assertHasProperties("bp_debug_run_configurations", [
  "projectPath",
  "clientId",
  "ide",
  "filePath",
  "detail"
]);

const response = await router.callTool("bp_debug_run_to_line", {
  filePath: "src/Hello.java",
  line: 12
});
assert.equal(response.error?.code, "SESSION_NOT_FOUND");

const invalidRunToLine = await router.callTool("bp_debug_run_to_line", {
  filePath: "src/Hello.java",
  line: 0
});
assert.equal(invalidRunToLine.error?.code, "INVALID_ARGUMENT");

let listThreadsArgs: unknown = "not-called";
let callStackArgs: unknown = "not-called";
let snapshotThreadId: unknown = "not-called";
let runToLineArgs: unknown = "not-called";
let setVariableArgs: unknown = "not-called";
const threadIds = ["thread-a", "thread-b", "thread-c", "thread-d"];
manager.sessions.add({
  sessionId: "sess_contract",
  language: "python",
  workspaceRoot: loadPolicy().workspace.root,
  mode: "headless",
  owner: "mcp",
  state: "paused",
  createdAt: new Date().toISOString(),
  providerKind: "ide",
  provider: {
    kind: "ide",
    sessionId: "sess_contract",
    language: "python",
    workspaceRoot: loadPolicy().workspace.root,
    capabilities: {},
    threadId: "opaque-thread",
    async setBreakpoints() {
      return [];
    },
    async listBreakpoints() {
      return [
        {
          id: "ide_user_enabled",
          sessionId: "sess_contract",
          file: "src/IdeUser.java",
          line: 11,
          owner: "user",
          enabled: true,
          verified: true,
          createdAt: "2026-06-20T00:00:00.000Z"
        },
        {
          id: "ide_agent_enabled",
          sessionId: "sess_contract",
          file: "src/IdeAgent.java",
          line: 12,
          owner: "agent",
          enabled: true,
          verified: true,
          createdAt: "2026-06-20T00:00:00.000Z"
        },
        {
          id: "ide_agent_disabled",
          sessionId: "sess_contract",
          file: "src/IdeDisabled.java",
          line: 13,
          owner: "agent",
          enabled: false,
          verified: true,
          createdAt: "2026-06-20T00:00:00.000Z"
        }
      ];
    },
    async waitForBreakpoint() {
      return {
        sessionId: "sess_contract",
        reason: "breakpoint",
        threadId: "opaque-thread",
        topFrame: { id: 101, name: "pausedHere", line: 42, source: { path: "src/Hello.java" } }
      };
    },
    async listThreads(args?: AnyRecord) {
      listThreadsArgs = args;
      return threadIds.map((id) => ({ id, name: id, state: "paused", isCurrent: id === "thread-c", frameCount: 1 }));
    },
    async getCallStack(threadId?: string | number | null, args?: AnyRecord | number) {
      callStackArgs = args;
      const limit = typeof args === "number" ? args : Number(args?.limit ?? 20);
      return {
        threadId,
        stackFrames: Array.from({ length: limit }, (_, index) => ({
          id: index + 1,
          name: `frame${index}`,
          line: index + 10,
          source: { path: `src/F${index}.java` }
        })),
        totalFrames: 6
      };
    },
    async getRuntimeSnapshot(args: AnyRecord) {
      snapshotThreadId = args.threadId;
      return {
        sessionId: "sess_contract",
        source: "ide",
        language: "python",
        threadId: args.threadId,
        frameId: 101,
        stackFrames: [{ id: 101, name: "pausedHere", line: 42, source: { path: "src/Hello.java" } }],
        variables: {
          locals: {
            name: "locals",
            category: "locals",
            variables: {
              name: {
                name: "name",
                kind: "primitive",
                valuePreview: "Alan Turing",
                value: "Alan Turing",
                variablesReference: 0
              }
            }
          }
        },
        limits: { maxDepth: 1, maxItems: 10, maxStringLength: 2000 }
      };
    },
    async runToLine(args: AnyRecord) {
      runToLineArgs = args;
      return {
        status: "paused",
        position: { filePath: args.filePath, line: args.line },
        frame: { id: 202, source: { path: args.filePath }, line: args.line }
      };
    },
    async setVariable(args: AnyRecord) {
      setVariableArgs = args;
      return {
        path: args.path,
        oldValue: "Alan Turing",
        newValue: args.newValue,
        applied: true
      };
    },
    async evaluate() {
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
  }
} as any);

manager.breakpoints.add("sess_contract", {
  id: "bp_agent_enabled",
  file: "src/A.java",
  line: 10,
  owner: "agent",
  enabled: true
});
manager.breakpoints.add("sess_contract", {
  id: "bp_user_enabled",
  file: "src/B.java",
  line: 20,
  owner: "user",
  enabled: true
});
manager.breakpoints.add("sess_contract", {
  id: "bp_agent_disabled",
  file: "src/C.java",
  line: 30,
  owner: "agent",
  enabled: false
});

const updateBreakpoint = await router.callTool("bp_debug_set_breakpoint", {
  sessionId: "sess_contract",
  breakpointId: "bp_agent_enabled"
});
assert.equal(updateBreakpoint.error?.code, "UNSUPPORTED_CAPABILITY");
assert.match(updateBreakpoint.error?.message ?? "", /update\/relocate.*Phase 1/i);

const filteredBreakpoints = await router.callTool("bp_debug_list_breakpoints", {
  sessionId: "sess_contract",
  owner: "agent",
  includeDisabled: false
});
assert.deepEqual(
  (filteredBreakpoints.breakpoints as AnyRecord[]).map((breakpoint) => breakpoint.breakpointId),
  ["ide_agent_enabled"]
);

const allBreakpoints = await router.callTool("bp_debug_list_breakpoints", {
  sessionId: "sess_contract",
  owner: "all",
  includeDisabled: true
});
assert.deepEqual(
  (allBreakpoints.breakpoints as AnyRecord[]).map((breakpoint) => breakpoint.breakpointId),
  ["ide_user_enabled", "ide_agent_enabled", "ide_agent_disabled"]
);

const enabledIdeBreakpoints = await router.callTool("bp_debug_list_breakpoints", {
  sessionId: "sess_contract",
  owner: "all",
  includeDisabled: false
});
assert.deepEqual(
  (enabledIdeBreakpoints.breakpoints as AnyRecord[]).map((breakpoint) => breakpoint.breakpointId),
  ["ide_user_enabled", "ide_agent_enabled"]
);

const protectedDefaultRemove = await router.callTool("bp_debug_remove_breakpoint", {
  sessionId: "sess_contract",
  breakpointId: "bp_user_enabled"
});
assert.deepEqual(
  {
    removed: protectedDefaultRemove.removed,
    protected: protectedDefaultRemove.protected,
    breakpointId: protectedDefaultRemove.breakpointId
  },
  { removed: false, protected: true, breakpointId: "bp_user_enabled" }
);

const protectedAgentRemove = await router.callTool("bp_debug_remove_breakpoint", {
  sessionId: "sess_contract",
  breakpointId: "bp_user_enabled",
  owner: "agent"
});
assert.deepEqual(
  {
    removed: protectedAgentRemove.removed,
    protected: protectedAgentRemove.protected,
    breakpointId: protectedAgentRemove.breakpointId
  },
  { removed: false, protected: true, breakpointId: "bp_user_enabled" }
);

const allOwnerRemove = await router.callTool("bp_debug_remove_breakpoint", {
  sessionId: "sess_contract",
  breakpointId: "bp_user_enabled",
  owner: "all"
});
assert.deepEqual(
  {
    removed: allOwnerRemove.removed,
    breakpointId: allOwnerRemove.breakpointId
  },
  { removed: true, breakpointId: "bp_user_enabled" }
);

manager.breakpoints.addProject({
  id: "project_agent_enabled",
  workspaceRoot: loadPolicy().workspace.root,
  clientId: "client_contract",
  ide: "idea",
  file: "src/ProjectA.java",
  line: 10,
  owner: "agent",
  enabled: true
});
manager.breakpoints.addProject({
  id: "project_user_enabled",
  workspaceRoot: loadPolicy().workspace.root,
  clientId: "client_contract",
  ide: "idea",
  file: "src/ProjectB.java",
  line: 20,
  owner: "user",
  enabled: true
});
manager.breakpoints.addProject({
  id: "project_agent_disabled",
  workspaceRoot: loadPolicy().workspace.root,
  clientId: "client_contract",
  ide: "idea",
  file: "src/ProjectC.java",
  line: 30,
  owner: "agent",
  enabled: false
});
const filteredProjectBreakpoints = await router.callTool("bp_debug_list_breakpoints", {
  clientId: "client_contract",
  owner: "agent",
  includeDisabled: false
});
assert.deepEqual(
  (filteredProjectBreakpoints.breakpoints as AnyRecord[]).map((breakpoint) => breakpoint.breakpointId),
  ["project_agent_enabled"]
);

const runToLineResult = await router.callTool("bp_debug_run_to_line", {
  sessionId: "sess_contract",
  filePath: "src/Hello.java",
  line: 24,
  timeout: 1000
});
assert.deepEqual(runToLineArgs, {
  filePath: "src/Hello.java",
  line: 24,
  threadId: undefined,
  timeoutMs: 1000
});
assert.equal(runToLineResult.status, "paused");
assert.deepEqual(runToLineResult.position, { filePath: "src/Hello.java", line: 24 });

const setValueResult = await router.callTool("bp_debug_set_value", {
  sessionId: "sess_contract",
  path: ["name"],
  newValue: "\"Katherine Johnson\""
});
assert.deepEqual((setVariableArgs as AnyRecord).path, ["name"]);
assert.equal((setVariableArgs as AnyRecord).newValue, "\"Katherine Johnson\"");
assert.equal((setVariableArgs as AnyRecord).parentRef, undefined);
assert.equal((setVariableArgs as AnyRecord).name, "name");
assert.deepEqual(setValueResult.result, {
  path: ["name"],
  oldValue: "Alan Turing",
  newValue: "\"Katherine Johnson\"",
  applied: true
});

const threads = await router.callTool("bp_debug_threads", {
  sessionId: "sess_contract",
  offset: 1,
  limit: 2
});
assert.equal(listThreadsArgs, undefined);
assert.deepEqual((threads.threads as AnyRecord[]).map((thread) => thread.id), ["thread-b", "thread-c"]);
assert.equal(threads.offset, 1);
assert.equal(threads.totalCount, 4);

const stack = await router.callTool("bp_debug_call_stack", {
  sessionId: "sess_contract",
  offset: 2,
  limit: 2
});
assert.equal(callStackArgs, 4);
assert.deepEqual((stack.frames as AnyRecord[]).map((frame) => frame.index), [2, 3]);
assert.equal(stack.offset, 2);
assert.equal(stack.totalFrames, 6);

await router.callTool("bp_debug_control", {
  sessionId: "sess_contract",
  action: "wait",
  includeFrame: true
});
assert.equal(snapshotThreadId, "opaque-thread");

console.log("debugger mcp contract tests ok");
