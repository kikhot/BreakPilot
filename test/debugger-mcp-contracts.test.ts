import assert from "node:assert/strict";
import path from "node:path";

import { ToolRouter } from "../src/control/ToolRouter.ts";
import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import { dapProviderCapabilities, ideProviderCapabilities } from "../src/runtime/ProviderCapabilities.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import type { AnyRecord } from "../src/types/json.ts";
import type { RuntimeDebugProvider } from "../src/types/sessions.ts";
import { ErrorCodes } from "../src/utils/errors.ts";

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
  "column",
  "threadId",
  "timeout",
  "includeFrame",
  "detail"
]);
const breakpointInput = tool("bp_debug_set_breakpoint").inputSchema as AnyRecord;
assert.equal(breakpointInput.type, "object");
assert.ok(Array.isArray(breakpointInput.oneOf));
assert.equal(breakpointInput.oneOf.length, 5);
const breakpointLocationInput = breakpointInput.oneOf[0] as AnyRecord;
const breakpointPatchByIdInput = breakpointInput.oneOf[1] as AnyRecord;
const breakpointPatchWithinSourceInput = breakpointInput.oneOf[2] as AnyRecord;
const breakpointPatchAcrossSourceInput = breakpointInput.oneOf[3] as AnyRecord;
const breakpointPatchAcrossSourceAliasInput = breakpointInput.oneOf[4] as AnyRecord;
assert.deepEqual(breakpointLocationInput.required, ["line"]);
assert.deepEqual(breakpointLocationInput.oneOf, [
  { required: ["filePath"] },
  { required: ["file"] }
]);
assert.equal(breakpointLocationInput.additionalProperties, false);
assert.equal("breakpointId" in breakpointLocationInput.properties, false);
assert.ok("column" in breakpointLocationInput.properties);

assert.equal(breakpointLocationInput.properties.enabled.default, true);
assert.equal(breakpointLocationInput.properties.owner.default, "agent");
assert.equal(breakpointLocationInput.properties.temporary.default, false);

const breakpointOutput = tool("bp_debug_set_breakpoint").outputSchema as AnyRecord;
const breakpointSuccessOutput = breakpointOutput.oneOf?.[0] as AnyRecord;
assert.equal(breakpointSuccessOutput.type, "object");
assert.ok(Array.isArray(breakpointSuccessOutput.oneOf), "breakpoint success must distinguish create from update");
assert.equal(breakpointSuccessOutput.oneOf.length, 2);
const breakpointCreateOutput = breakpointSuccessOutput.oneOf[0] as AnyRecord;
const breakpointUpdateOutput = breakpointSuccessOutput.oneOf[1] as AnyRecord;
assert.equal(breakpointCreateOutput.additionalProperties, false);
assert.equal(breakpointUpdateOutput.additionalProperties, false);
assert.ok("lineText" in breakpointCreateOutput.properties);
assert.equal("lineText" in breakpointUpdateOutput.properties, false);
for (const field of ["operation", "previous", "current", "changedFields"]) {
  assert.ok(field in breakpointUpdateOutput.properties, `update success must expose ${field}`);
  assert.ok(breakpointUpdateOutput.required.includes(field), `update success must require ${field}`);
}
assert.ok("rollbackApplied" in breakpointUpdateOutput.properties);
assert.ok("column" in breakpointUpdateOutput.properties);
assert.deepEqual(
  breakpointUpdateOutput.properties.changedFields.items.enum,
  ["filePath", "line", "column", "condition", "hitCondition", "logMessage", "enabled"]
);
for (const field of ["previous", "current"]) {
  const view = breakpointUpdateOutput.properties[field] as AnyRecord;
  assert.equal(view.additionalProperties, false, `${field} must be a closed public breakpoint view`);
  assert.ok("column" in view.properties, `${field} must preserve source columns`);
}

const breakpointPatchInputs = [
  breakpointPatchByIdInput,
  breakpointPatchWithinSourceInput,
  breakpointPatchAcrossSourceInput,
  breakpointPatchAcrossSourceAliasInput
];
assert.deepEqual(breakpointPatchByIdInput.required, ["breakpointId"]);
assert.deepEqual(breakpointPatchWithinSourceInput.required, ["breakpointId", "line"]);
assert.deepEqual(breakpointPatchAcrossSourceInput.required, ["breakpointId", "filePath", "line"]);
assert.deepEqual(breakpointPatchAcrossSourceAliasInput.required, ["breakpointId", "file", "line"]);
assert.equal("line" in breakpointPatchByIdInput.properties, false);
assert.equal("filePath" in breakpointPatchWithinSourceInput.properties, false);
assert.equal("file" in breakpointPatchWithinSourceInput.properties, false);
assert.equal("file" in breakpointPatchAcrossSourceInput.properties, false);
assert.equal("filePath" in breakpointPatchAcrossSourceAliasInput.properties, false);

const breakpointSharedProperties = [
  "projectPath",
  "workspace",
  "sessionId",
  "clientId",
  "ide",
  "enabled",
  "owner",
  "requireVerified"
];
for (const branch of breakpointPatchInputs) {
  assert.equal(branch.additionalProperties, false);
  for (const field of breakpointSharedProperties) {
    assert.ok(field in branch.properties, `breakpoint branch should expose ${field}`);
  }
  for (const nullableField of ["condition", "hitCondition", "logMessage"]) {
    assert.deepEqual(branch.properties[nullableField].oneOf, [
      { type: "string" },
      { type: "null" }
    ]);
  }
  assert.deepEqual(branch.properties.column.oneOf, [
    { type: "integer", minimum: 1, maximum: 2_147_483_647 },
    { type: "null" }
  ]);
  assert.deepEqual(branch.properties.owner.enum, ["agent", "user", "all"]);
  for (const field of ["enabled", "owner", "requireVerified"]) {
    assert.equal("default" in branch.properties[field], false, `patch ${field} must be default-free`);
  }
  for (const createOnlyField of ["temporary", "suspendPolicy", "isLogMessage", "isLogStack", "detail"]) {
    assert.equal(createOnlyField in branch.properties, false, `patch must not accept ${createOnlyField}`);
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
let ideSetBreakpointCalls = 0;
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
    capabilities: ideProviderCapabilities({
      debugCommands: true,
      variableSnapshot: true,
      setVariable: true,
      runToLine: true
    }),
    threadId: "opaque-thread",
    async setBreakpoints() {
      ideSetBreakpointCalls += 1;
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
    async getCallStack(threadId?: string | number | null, request: AnyRecord = { offset: 0, limit: 20 }) {
      callStackArgs = request;
      const offset = Number(request.offset ?? 0);
      const limit = Number(request.limit ?? 20);
      const nextOffset = Math.min(6, offset + limit);
      const partial = nextOffset < 6;
      return {
        threadId,
        stackFrames: Array.from({ length: limit }, (_, index) => ({
          id: offset + index + 1,
          name: `frame${offset + index}`,
          line: offset + index + 10,
          source: { path: `src/F${offset + index}.java` }
        })),
        offset,
        totalFrames: 6,
        completeness: partial ? "partial" : "complete",
        partial,
        ...(partial ? { nextOffset, truncationReason: "limit" } : {})
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
        targetReached: true,
        requestedPosition: { filePath: args.filePath, line: args.line },
        cleanedUp: true,
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
assert.match(updateBreakpoint.error?.message ?? "", /does not support breakpoint updates/i);
assert.deepEqual(updateBreakpoint.error?.details, {
  sessionId: "sess_contract",
  providerKind: "ide",
  capability: "breakpointUpdate"
});
assert.equal(ideSetBreakpointCalls, 0, "IDE update refusal must not call setBreakpoints");

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
  filePath: path.resolve(loadPolicy().workspace.root, "src/Hello.java"),
  line: 24,
  threadId: undefined,
  timeoutMs: 1000
});
assert.equal(runToLineResult.status, "paused");
assert.equal(runToLineResult.targetReached, true);
assert.equal(runToLineResult.cleanedUp, true);
assert.deepEqual(runToLineResult.requestedPosition, {
  filePath: path.resolve(loadPolicy().workspace.root, "src/Hello.java"),
  line: 24
});
assert.deepEqual(runToLineResult.position, {
  filePath: path.resolve(loadPolicy().workspace.root, "src/Hello.java"),
  line: 24
});

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
  newValue: "\"Katherine Johnson\""
});
assert.equal(setValueResult.applied, true);
assert.equal(setValueResult.verified, false);
assert.equal(setValueResult.mutationMode, "native");

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
assert.deepEqual(callStackArgs, { offset: 2, limit: 2 });
assert.deepEqual((stack.frames as AnyRecord[]).map((frame) => frame.index), [2, 3]);
assert.equal(stack.offset, 2);
assert.equal(stack.totalFrames, 6);
assert.equal(stack.completeness, "partial");
assert.equal(stack.partial, true);
assert.equal(stack.nextOffset, 4);

await router.callTool("bp_debug_control", {
  sessionId: "sess_contract",
  action: "wait",
  includeFrame: true
});
assert.equal(snapshotThreadId, "opaque-thread");

{
  const policy = loadPolicy("breakpilot.yaml");
  const workspaceRoot = path.resolve(policy.workspace.root);
  const sourceFile = path.join(workspaceRoot, "src", "sessions", "DebugSessionManager.ts");
  const providerCalls: Array<{ filePath: string; breakpoints: AnyRecord[] }> = [];
  let adapterVerified = true;
  const provider: RuntimeDebugProvider = {
    kind: "dap",
    sessionId: "dap_update_contract",
    language: "python",
    workspaceRoot,
    capabilities: dapProviderCapabilities({ supportsConditionalBreakpoints: true }),
    threadId: null,
    async setBreakpoints(filePath, breakpoints) {
      providerCalls.push({
        filePath,
        breakpoints: structuredClone(breakpoints) as unknown as AnyRecord[]
      });
      return breakpoints.map((breakpoint, index) => ({
        id: index + 1,
        verified: adapterVerified,
        line: breakpoint.line,
        column: breakpoint.column,
        ...(breakpoint.id === "dap_agent" ? { message: "" } : {})
      }));
    },
    async waitForBreakpoint() {
      return { sessionId: "dap_update_contract", reason: "breakpoint" };
    },
    async getRuntimeSnapshot() {
      return {
        sessionId: "dap_update_contract",
        source: "headless",
        language: "python",
        threadId: null,
        frameId: null,
        stackFrames: [],
        variables: {},
        limits: { maxDepth: 1, maxItems: 20, maxStringLength: 200 }
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
  };
  const updateManager = new DebugSessionManager({ policy });
  updateManager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider
  });
  updateManager.breakpoints.add(provider.sessionId, {
    id: "dap_agent",
    file: sourceFile,
    line: 10,
    column: 3,
    condition: "oldCondition",
    owner: "agent",
    enabled: true
  });
  updateManager.breakpoints.add(provider.sessionId, {
    id: "dap_user",
    file: sourceFile,
    line: 11,
    owner: "user",
    enabled: true
  });
  const updateRouter = new ToolRouter(updateManager);

  assert.equal(provider.capabilities.breakpointUpdate, "fallback");
  updateManager.sessions.get(provider.sessionId).owner = "ide";
  const ownerConflict = await updateRouter.callTool("bp_debug_set_breakpoint", {
    sessionId: provider.sessionId,
    breakpointId: "dap_agent",
    line: 12
  });
  assert.equal(ownerConflict.error?.code, ErrorCodes.SESSION_OWNER_CONFLICT);
  assert.equal(providerCalls.length, 0, "session ownership must gate reconciliation before provider mutation");
  updateManager.sessions.get(provider.sessionId).owner = "mcp";

  const protectedUserBreakpoint = await updateRouter.callTool("bp_debug_set_breakpoint", {
    sessionId: provider.sessionId,
    breakpointId: "dap_user",
    line: 12
  });
  assert.equal(protectedUserBreakpoint.error?.code, ErrorCodes.POLICY_VIOLATION);
  assert.equal(providerCalls.length, 0, "default agent owner must not update a user breakpoint");

  const userBreakpointWithAllOwner = await updateRouter.callTool("bp_debug_set_breakpoint", {
    sessionId: provider.sessionId,
    clientId: "incidental-ide-metadata",
    breakpointId: "dap_user",
    line: 12,
    owner: "all"
  });
  assert.equal(userBreakpointWithAllOwner.error, undefined);
  assert.equal((userBreakpointWithAllOwner.current as AnyRecord).owner, "user");
  assert.equal(updateManager.breakpoints.get(provider.sessionId, "dap_user")?.owner, "user");

  const moved = await updateRouter.callTool("bp_debug_set_breakpoint", {
    sessionId: provider.sessionId,
    breakpointId: "dap_agent",
    line: 44
  });
  assert.equal(moved.error, undefined);
  assert.equal(moved.operation, "relocated");
  assert.equal(moved.breakpointId, "dap_agent");
  assert.equal(moved.line, 44);
  assert.equal(moved.column, 3);
  assert.equal(moved.verified, true);
  assert.deepEqual(moved.changedFields, ["line"]);
  assert.equal((moved.previous as AnyRecord).line, 10);
  assert.equal((moved.current as AnyRecord).line, 44);
  assert.equal((moved.current as AnyRecord).message, "", "defined empty adapter messages must remain visible");
  (moved.previous as AnyRecord).line = 999;
  assert.equal((moved.current as AnyRecord).line, 44, "previous and current must be independent public snapshots");
  assert.deepEqual(providerCalls[1]?.breakpoints.map((breakpoint) => breakpoint.id), ["dap_agent", "dap_user"]);
  assert.equal(providerCalls[1]?.breakpoints.find((breakpoint) => breakpoint.id === "dap_agent")?.line, 44);

  const workspacePathChecks: string[] = [];
  const assertWorkspacePath = updateManager.security.assertWorkspacePath.bind(updateManager.security);
  updateManager.security.assertWorkspacePath = ((candidate: string) => {
    workspacePathChecks.push(candidate);
    return assertWorkspacePath(candidate);
  }) as typeof updateManager.security.assertWorkspacePath;

  const cleared = await updateRouter.callTool("bp_debug_set_breakpoint", {
    sessionId: provider.sessionId,
    breakpointId: "dap_agent",
    condition: null
  });
  assert.equal(cleared.error, undefined);
  assert.deepEqual(cleared.changedFields, ["condition"]);
  assert.equal("condition" in (cleared.current as AnyRecord), false);
  assert.deepEqual(workspacePathChecks, [], "non-relocation patches must not revalidate stored source paths");

  const rejectedPath = await updateRouter.callTool("bp_debug_set_breakpoint", {
    sessionId: provider.sessionId,
    breakpointId: "dap_agent",
    filePath: "../outside.java",
    line: 45
  });
  assert.equal(rejectedPath.error?.code, ErrorCodes.WORKSPACE_VIOLATION);
  assert.deepEqual(workspacePathChecks, ["../outside.java"]);
  assert.equal(updateManager.breakpoints.get(provider.sessionId, "dap_agent")?.file, sourceFile);
  assert.equal(providerCalls.length, 3, "rejected relocation must not reach the provider");

  const disabled = await updateRouter.callTool("bp_debug_set_breakpoint", {
    sessionId: provider.sessionId,
    breakpointId: "dap_agent",
    enabled: false
  });
  assert.equal(disabled.error?.code, ErrorCodes.UNSUPPORTED_CAPABILITY);
  assert.equal(updateManager.breakpoints.get(provider.sessionId, "dap_agent")?.enabled, true);
  assert.equal(providerCalls.length, 3, "unsupported semantics must not reach the provider");

  provider.capabilities = dapProviderCapabilities();
  const unsupportedCondition = await updateRouter.callTool("bp_debug_set_breakpoint", {
    sessionId: provider.sessionId,
    breakpointId: "dap_agent",
    condition: "nextCondition"
  });
  assert.equal(unsupportedCondition.error?.code, ErrorCodes.UNSUPPORTED_CAPABILITY);
  assert.equal(updateManager.breakpoints.get(provider.sessionId, "dap_agent")?.condition, undefined);
  assert.equal(providerCalls.length, 3, "unsupported advanced options must not reach the provider");

  adapterVerified = false;
  const unverified = await updateRouter.callTool("bp_debug_set_breakpoint", {
    sessionId: provider.sessionId,
    breakpointId: "dap_agent",
    line: 46,
    requireVerified: true
  });
  assert.equal(unverified.error?.code, ErrorCodes.BREAKPOINT_NOT_VERIFIED);
  assert.equal(updateManager.breakpoints.get(provider.sessionId, "dap_agent")?.line, 46);
  assert.equal(updateManager.breakpoints.get(provider.sessionId, "dap_agent")?.verified, false);

  const created = await updateRouter.callTool("bp_debug_set_breakpoint", {
    sessionId: provider.sessionId,
    filePath: sourceFile,
    line: 61
  });
  assert.equal(created.error, undefined);
  assert.equal("operation" in created, false, "create output must retain the flat compatibility shape");
}

console.log("debugger mcp contract tests ok");
