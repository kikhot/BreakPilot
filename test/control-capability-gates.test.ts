import assert from "node:assert/strict";
import test from "node:test";

import { ToolRouter } from "../src/control/ToolRouter.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import type { RuntimeProviderCapabilities } from "../src/types/capabilities.ts";
import type { AnyRecord } from "../src/types/json.ts";
import type { RuntimeDebugProvider } from "../src/types/sessions.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";

const unsupportedCapabilities: RuntimeProviderCapabilities = {
  pause: "unsupported",
  stepping: "unsupported",
  runToLine: "unsupported",
  variableReferences: "unsupported",
  setValue: "unsupported",
  breakpointUpdate: "unsupported",
  conditionalBreakpoints: "unsupported",
  hitConditionalBreakpoints: "unsupported",
  tracepoints: "unsupported",
  eventDrain: "unsupported"
};

function controlRouter({
  capabilities,
  waitForBreakpoint,
  counters
}: {
  capabilities: RuntimeProviderCapabilities;
  waitForBreakpoint?: RuntimeDebugProvider["waitForBreakpoint"];
  counters: { pause: number; step: number; wait: number };
}): { router: ToolRouter; manager: DebugSessionManager } {
  const policy = loadPolicy("breakpilot.yaml");
  const manager = new DebugSessionManager({ policy });
  const provider: RuntimeDebugProvider = {
    kind: "dap",
    sessionId: "control_caps",
    language: "java",
    workspaceRoot: policy.workspace.root,
    capabilities,
    threadId: 17,
    async setBreakpoints() {
      return [];
    },
    async waitForBreakpoint(timeoutMs) {
      counters.wait += 1;
      if (waitForBreakpoint) return waitForBreakpoint(timeoutMs);
      return { sessionId: "control_caps", reason: "step", threadId: 17 };
    },
    async getRuntimeSnapshot() {
      return {
        sessionId: "control_caps",
        source: "headless",
        language: "java",
        threadId: 17,
        frameId: null,
        stackFrames: [],
        variables: {},
        limits: { maxDepth: 0, maxItems: 1, maxStringLength: 10 }
      };
    },
    async evaluate() {
      return {};
    },
    async pause() {
      counters.pause += 1;
      return {};
    },
    async continue() {
      return {};
    },
    async step() {
      counters.step += 1;
      return {};
    },
    async disconnect() {
      return {};
    }
  };
  manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "running",
    createdAt: new Date(0).toISOString(),
    providerKind: provider.kind,
    provider
  });
  return { router: new ToolRouter(manager), manager };
}

test("pause and every step action reject unsupported capabilities before provider calls", async () => {
  for (const action of ["pause", "stepOver", "stepInto", "stepOut"] as const) {
    const counters = { pause: 0, step: 0, wait: 0 };
    const { router } = controlRouter({ capabilities: unsupportedCapabilities, counters });

    const response = await router.callTool("bp_debug_control", {
      sessionId: "control_caps",
      action
    });

    assert.equal(response.error?.code, ErrorCodes.UNSUPPORTED_CAPABILITY, action);
    assert.deepEqual(counters, { pause: 0, step: 0, wait: 0 }, action);
  }
});

test("pause propagates stop timeout and does not fabricate paused state", async () => {
  const counters = { pause: 0, step: 0, wait: 0 };
  const { router, manager } = controlRouter({
    capabilities: { ...unsupportedCapabilities, pause: "native" },
    counters,
    waitForBreakpoint: async () => {
      throw new BreakPilotError(ErrorCodes.BREAKPOINT_TIMEOUT, "pause stop timed out");
    }
  });

  const response = await router.callTool("bp_debug_control", {
    sessionId: "control_caps",
    action: "pause",
    timeout: 1
  });

  assert.equal(response.error?.code, ErrorCodes.BREAKPOINT_TIMEOUT);
  assert.equal(manager.sessions.get("control_caps").state, "running");
  assert.deepEqual(counters, { pause: 1, step: 0, wait: 1 });
});

test("step propagates stop timeout and leaves the session running", async () => {
  const counters = { pause: 0, step: 0, wait: 0 };
  const { router, manager } = controlRouter({
    capabilities: { ...unsupportedCapabilities, stepping: "native" },
    counters,
    waitForBreakpoint: async () => {
      throw new BreakPilotError(ErrorCodes.BREAKPOINT_TIMEOUT, "step stop timed out");
    }
  });

  const response = await router.callTool("bp_debug_control", {
    sessionId: "control_caps",
    action: "stepOver",
    timeout: 1
  });

  assert.equal(response.error?.code, ErrorCodes.BREAKPOINT_TIMEOUT);
  assert.equal(manager.sessions.get("control_caps").state, "running");
  assert.deepEqual(counters, { pause: 0, step: 1, wait: 1 });
});

test("pause and step reject empty or mismatched stop evidence", async () => {
  for (const { action, stopped } of [
    { action: "pause", stopped: null },
    { action: "pause", stopped: {} },
    { action: "pause", stopped: { threadId: null } },
    { action: "stepOver", stopped: { topFrame: {}, stopped: {} } },
    { action: "stepOver", stopped: { sessionId: "another_session", reason: "step", threadId: 17 } }
  ] as const) {
    const counters = { pause: 0, step: 0, wait: 0 };
    const { router, manager } = controlRouter({
      capabilities: {
        ...unsupportedCapabilities,
        pause: "native",
        stepping: "native"
      },
      counters,
      waitForBreakpoint: async () => stopped as never
    });

    const response = await router.callTool("bp_debug_control", {
      sessionId: "control_caps",
      action
    });

    assert.equal(response.error?.code, ErrorCodes.TOOL_FAILED, `${action}: ${JSON.stringify(stopped)}`);
    assert.equal(manager.sessions.get("control_caps").state, "running");
  }
});

test("pause and step report paused only after a stop result", async () => {
  for (const action of ["pause", "stepOver"] as const) {
    const counters = { pause: 0, step: 0, wait: 0 };
    const { router, manager } = controlRouter({
      capabilities: {
        ...unsupportedCapabilities,
        pause: "native",
        stepping: "native"
      },
      counters
    });

    const response = await router.callTool("bp_debug_control", {
      sessionId: "control_caps",
      action
    }) as AnyRecord;

    assert.equal(response.error, undefined);
    assert.equal(response.state, "paused");
    assert.equal(manager.sessions.get("control_caps").state, "paused");
    assert.equal(counters.wait, 1);
  }
});
