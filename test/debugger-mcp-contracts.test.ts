import assert from "node:assert/strict";
import path from "node:path";

import { ToolRouter } from "../src/control/ToolRouter.ts";
import { dapProviderCapabilities, ideProviderCapabilities } from "../src/runtime/ProviderCapabilities.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import type { AnyRecord } from "../src/types/json.ts";
import type { RuntimeDebugProvider } from "../src/types/sessions.ts";
import { ErrorCodes } from "../src/utils/errors.ts";

const manager = new DebugSessionManager({ policy: loadPolicy() });
const router = new ToolRouter(manager);
const listed = router.listTools().map((candidate) => candidate.name);
assert.ok(listed.includes("bp_debug_run_to_line"), "ToolRouter should advertise bp_debug_run_to_line");
assert.ok(listed.includes("bp_debug_run_configurations"), "ToolRouter should advertise bp_debug_run_configurations");

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
assert.equal(updateBreakpoint.error?.retrySafe, false);
assert.equal(updateBreakpoint.error?.actionMayHaveApplied, false);
assert.equal("details" in (updateBreakpoint.error ?? {}), false);
assert.equal(ideSetBreakpointCalls, 0, "IDE update refusal must not call setBreakpoints");

const filteredBreakpoints = await router.callTool("bp_debug_list_breakpoints", {
  sessionId: "sess_contract",
  owner: "agent",
  includeDisabled: false
});
assert.deepEqual(
  (filteredBreakpoints.breakpoints as AnyRecord[]).map((breakpoint) => breakpoint.id),
  ["ide_agent_enabled"]
);

const allBreakpoints = await router.callTool("bp_debug_list_breakpoints", {
  sessionId: "sess_contract",
  owner: "all",
  includeDisabled: true
});
assert.deepEqual(
  (allBreakpoints.breakpoints as AnyRecord[]).map((breakpoint) => breakpoint.id),
  ["ide_user_enabled", "ide_agent_enabled", "ide_agent_disabled"]
);

const enabledIdeBreakpoints = await router.callTool("bp_debug_list_breakpoints", {
  sessionId: "sess_contract",
  owner: "all",
  includeDisabled: false
});
assert.deepEqual(
  (enabledIdeBreakpoints.breakpoints as AnyRecord[]).map((breakpoint) => breakpoint.id),
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
    id: protectedDefaultRemove.id
  },
  { removed: false, protected: true, id: "bp_user_enabled" }
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
    id: protectedAgentRemove.id
  },
  { removed: false, protected: true, id: "bp_user_enabled" }
);

const allOwnerRemove = await router.callTool("bp_debug_remove_breakpoint", {
  sessionId: "sess_contract",
  breakpointId: "bp_user_enabled",
  owner: "all"
});
assert.deepEqual(
  {
    removed: allOwnerRemove.removed,
    id: allOwnerRemove.id
  },
  { removed: true, id: "bp_user_enabled" }
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
  (filteredProjectBreakpoints.breakpoints as AnyRecord[]).map((breakpoint) => breakpoint.id),
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
assert.equal(runToLineResult.state, "paused");
assert.equal(runToLineResult.reached, true);
assert.equal("cleanedUp" in runToLineResult, false);
assert.deepEqual(runToLineResult.target, {
  filePath: "src/Hello.java",
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
assert.deepEqual(setValueResult.target, { path: ["name"] });
assert.equal(setValueResult.oldValue, "Alan Turing");
assert.equal(setValueResult.newValue, "\"Katherine Johnson\"");
assert.equal(setValueResult.applied, true);
assert.equal(setValueResult.verified, false);
assert.equal("mutationMode" in setValueResult, false);

const threads = await router.callTool("bp_debug_threads", {
  sessionId: "sess_contract",
  offset: 1,
  limit: 2
});
assert.equal(listThreadsArgs, undefined);
assert.deepEqual((threads.threads as AnyRecord[]).map((thread) => thread.id), ["thread-b", "thread-c"]);
assert.equal(threads.nextOffset, 3);

const stack = await router.callTool("bp_debug_call_stack", {
  sessionId: "sess_contract",
  offset: 2,
  limit: 2
});
assert.deepEqual(callStackArgs, { offset: 2, limit: 2 });
assert.deepEqual((stack.frames as AnyRecord[]).map((frame) => frame.index), [2, 3]);
assert.equal(stack.nextOffset, 4);

await router.callTool("bp_debug_control", {
  sessionId: "sess_contract",
  action: "wait"
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
  assert.equal(userBreakpointWithAllOwner.owner, "user");
  assert.equal(updateManager.breakpoints.get(provider.sessionId, "dap_user")?.owner, "user");

  const moved = await updateRouter.callTool("bp_debug_set_breakpoint", {
    sessionId: provider.sessionId,
    breakpointId: "dap_agent",
    line: 44
  });
  assert.equal(moved.error, undefined);
  assert.equal(moved.operation, "relocated");
  assert.equal(moved.id, "dap_agent");
  assert.equal((moved.at as AnyRecord).line, 44);
  assert.equal((moved.at as AnyRecord).column, 3);
  assert.equal(moved.verified, true);
  assert.deepEqual(moved.changed, ["line"]);
  assert.equal(moved.message, "", "defined empty adapter messages must remain visible");
  assert.equal("previous" in moved, false);
  assert.equal("current" in moved, false);
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
  assert.deepEqual(cleared.changed, ["condition"]);
  assert.equal("condition" in cleared, false);
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
  assert.equal("operation" in created, false, "create output is already the compact breakpoint shape");
}

console.log("debugger mcp contract tests ok");
