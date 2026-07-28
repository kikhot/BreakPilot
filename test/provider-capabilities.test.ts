import assert from "node:assert/strict";
import fs from "node:fs";
import type { Socket } from "node:net";

import { ToolRouter } from "../src/control/ToolRouter.ts";
import { DapRuntimeProvider } from "../src/runtime/providers/DapRuntimeProvider.ts";
import { IdeRuntimeProvider } from "../src/runtime/providers/IdeRuntimeProvider.ts";
import {
  dapProviderCapabilities,
  ideProviderCapabilities
} from "../src/runtime/ProviderCapabilities.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import { IdeBridgeServer } from "../src/ide/IdeBridgeServer.ts";
import { IdeMessageTypes } from "../src/ide/IdeProtocol.ts";
import type { DapSession } from "../src/dap/DapSession.ts";
import type { AnyRecord } from "../src/types/json.ts";
import type { RuntimeDebugProvider } from "../src/types/sessions.ts";

const dapFallback = {
  pause: "native",
  stepping: "native",
  runToLine: "unsupported",
  variableReferences: "native",
  setValue: "unsupported",
  breakpointUpdate: "fallback",
  conditionalBreakpoints: "unsupported",
  hitConditionalBreakpoints: "unsupported",
  tracepoints: "unsupported",
  eventDrain: "unsupported"
};

assert.deepEqual(dapProviderCapabilities(), dapFallback);
assert.deepEqual(dapProviderCapabilities({ supportsSetVariable: true }), {
  ...dapFallback,
  setValue: "native"
});
assert.deepEqual(dapProviderCapabilities({
  supportsSetVariable: true,
  supportsConditionalBreakpoints: true,
  supportsHitConditionalBreakpoints: true,
  supportsLogPoints: true
}), {
  ...dapFallback,
  setValue: "native",
  conditionalBreakpoints: "native",
  hitConditionalBreakpoints: "native",
  tracepoints: "native"
});
assert.equal(
  dapProviderCapabilities({ supportsBreakpointUpdate: true }).breakpointUpdate,
  "fallback",
  "DAP source-list reconciliation must be available without a raw adapter update flag"
);
assert.equal(
  dapProviderCapabilities({ supportsGotoTargetsRequest: true }).runToLine,
  "unsupported",
  "a raw DAP flag alone cannot prove the provider has causal Task-4 primitives"
);
assert.equal(
  dapProviderCapabilities({ supportsGotoTargetsRequest: true }, { nativeRunToLineAvailable: true }).runToLine,
  "native",
  "native run-to-line requires explicit live provider evidence"
);
assert.equal(
  dapProviderCapabilities({}, { nativeRunToLineAvailable: true }).runToLine,
  "unsupported",
  "live primitive evidence cannot compensate for an adapter that did not advertise gotoTargets"
);
assert.equal(
  dapProviderCapabilities({}, { nativeRunToLineAvailable: false, fallbackRunToLineAvailable: true }).runToLine,
  "fallback",
  "a manager-wired temporary-breakpoint transaction is the only fallback capability source"
);

const ideUnsupported = {
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

assert.deepEqual(ideProviderCapabilities(), ideUnsupported);
assert.deepEqual(ideProviderCapabilities({
  debugCommands: true,
  variableSnapshot: true,
  setVariable: true,
  runToLine: true,
  breakpointUpdate: true
}), {
  ...ideUnsupported,
  pause: "native",
  stepping: "native",
  runToLine: "native",
  variableReferences: "snapshot",
  setValue: "native",
  breakpointUpdate: "fallback"
});
assert.deepEqual(ideProviderCapabilities({
  setVariable: true,
  setVariableMode: "evaluateAssignment",
  conditionalBreakpoints: true,
  hitConditionalBreakpoints: true,
  tracepoints: true,
  eventDrain: true
}), {
  ...ideUnsupported,
  setValue: "evaluateAssignment",
  conditionalBreakpoints: "native",
  hitConditionalBreakpoints: "native",
  tracepoints: "native"
});
assert.deepEqual(ideProviderCapabilities({
  runToLine: false,
  supportsRunToLine: true,
  setVariable: false,
  supportsSetVariable: true,
  conditionalBreakpoints: false,
  supportsConditionalBreakpoints: true,
  hitConditionalBreakpoints: false,
  supportsHitConditionalBreakpoints: true,
  tracepoints: false,
  supportsLogPoints: true
}), ideUnsupported, "canonical false flags must override legacy true aliases");
assert.notStrictEqual(dapProviderCapabilities(), dapProviderCapabilities());
assert.notStrictEqual(ideProviderCapabilities(), ideProviderCapabilities());
assert.deepEqual(Object.keys(dapProviderCapabilities()).sort(), Object.keys(ideProviderCapabilities()).sort());

const dap = {
  sessionId: "dap_caps",
  language: "java",
  workspaceRoot: "/workspace",
  capabilities: {},
  threadId: 7
} as unknown as DapSession;
const dapProvider = new DapRuntimeProvider(dap);
assert.deepEqual(dapProvider.capabilities, dapFallback);
dap.capabilities = { supportsSetVariable: true, supportsLogPoints: true };
assert.deepEqual(dapProvider.capabilities, {
  ...dapFallback,
  setValue: "native",
  tracepoints: "native"
});

const policy = loadPolicy("breakpilot.yaml");
const workspaceRoot = policy.workspace.root;
const bridge = new IdeBridgeServer({ workspaceRoot });
bridge.registry.add({} as Socket, {
  clientId: "idea_caps",
  ide: "idea",
  workspaceRoot,
  capabilities: {
    debugCommands: true,
    variableSnapshot: true,
    runToLine: true,
    setVariable: true,
    setVariableMode: "evaluateAssignment"
  }
});
bridge.registry.upsertSession("idea_caps", {
  type: IdeMessageTypes.IDE_SESSION_PAUSED,
  ideSessionId: "idea_caps_session",
  workspaceRoot,
  state: "paused",
  active: true
}, "paused");

const ideSession = bridge.registry.findSession("idea_caps_session", "idea_caps");
assert.ok(ideSession);
const ideProvider = new IdeRuntimeProvider({
  sessionId: "ide_caps",
  bridge,
  ideSession,
  workspaceRoot
});
assert.deepEqual(ideSession.capabilities, {}, "sessions must store only session-declared overrides");
assert.deepEqual(ideProvider.capabilities, {
  ...ideUnsupported,
  pause: "native",
  stepping: "native",
  runToLine: "native",
  variableReferences: "snapshot",
  setValue: "evaluateAssignment"
});
bridge.registry.update("idea_caps", {
  capabilities: {
    debugCommands: true,
    variableSnapshot: true,
    runToLine: false,
    setVariable: false
  }
});
assert.deepEqual(ideProvider.capabilities, {
  ...ideUnsupported,
  pause: "native",
  stepping: "native",
  variableReferences: "snapshot"
});

bridge.registry.update("idea_caps", {
  capabilities: {
    debugCommands: true,
    variableSnapshot: true,
    supportsRunToLine: true,
    supportsSetVariable: true
  }
});
bridge.registry.upsertSession("idea_caps", {
  type: IdeMessageTypes.IDE_SESSION_PAUSED,
  ideSessionId: "idea_caps_session",
  workspaceRoot,
  state: "paused",
  active: true,
  capabilities: { runToLine: false, setVariable: false }
}, "paused");
assert.equal(ideProvider.capabilities.runToLine, "unsupported");
assert.equal(ideProvider.capabilities.setValue, "unsupported");

// Restore the live client capabilities for manager status/start assertions.
bridge.registry.update("idea_caps", {
  capabilities: {
    debugCommands: true,
    variableSnapshot: true,
    runToLine: true,
    setVariable: true,
    setVariableMode: "evaluateAssignment"
  }
});
bridge.registry.upsertSession("idea_caps", {
  type: IdeMessageTypes.IDE_SESSION_PAUSED,
  ideSessionId: "idea_caps_session",
  workspaceRoot,
  state: "paused",
  active: true,
  capabilities: {}
}, "paused");
const manager = new DebugSessionManager({ policy, ideBridge: bridge });

const compactBeforeAdopt = await manager.bpDebugStatus({}) as AnyRecord;
assert.equal(compactBeforeAdopt.ideSessions.length, 1);
assert.equal("providerKind" in compactBeforeAdopt.ideSessions[0], false);
assert.equal("capabilities" in compactBeforeAdopt.ideSessions[0], false);

const diagnosticBeforeAdopt = await manager.bpDebugStatus({ detail: "diagnostic" }) as AnyRecord;
assert.equal(diagnosticBeforeAdopt.ideSessions[0].providerKind, "ide");
assert.equal(diagnosticBeforeAdopt.ideSessions[0].capabilities.setValue, "evaluateAssignment");
assert.equal(diagnosticBeforeAdopt.ideSessions[0].capabilities.runToLine, "native");

const started = await manager.bpDebugStart({
  mode: "ide",
  clientId: "idea_caps",
  ideSessionId: "idea_caps_session"
}) as AnyRecord;
assert.equal(started.providerKind, "ide");
assert.equal(started.capabilities.runToLine, "native");
assert.equal(started.capabilities.setValue, "evaluateAssignment");

const compactAfterAdopt = await manager.bpDebugStatus({}) as AnyRecord;
assert.equal("providerKind" in compactAfterAdopt.sessions[0], false);
assert.equal("capabilities" in compactAfterAdopt.sessions[0], false);
const diagnosticAfterAdopt = await manager.bpDebugStatus({ detail: "diagnostic" }) as AnyRecord;
assert.equal(diagnosticAfterAdopt.sessions[0].providerKind, "ide");
assert.deepEqual(diagnosticAfterAdopt.sessions[0].capabilities, started.capabilities);

let drainCalls = 0;
let runToLineCalls = 0;
let setVariableCalls = 0;
const unsupportedProvider = {
  kind: "dap",
  sessionId: "unsupported_caps",
  language: "java",
  workspaceRoot,
  capabilities: dapProviderCapabilities(),
  threadId: 1,
  setBreakpoints: async () => [],
  waitForBreakpoint: async () => ({ reason: "breakpoint", threadId: 1 }),
  getRuntimeSnapshot: async () => ({
    sessionId: "unsupported_caps",
    source: "headless" as const,
    language: "java",
    threadId: 1,
    frameId: null,
    stackFrames: [],
    variables: {},
    limits: { maxDepth: 1, maxItems: 1, maxStringLength: 100 }
  }),
  evaluate: async () => ({}),
  continue: async () => ({}),
  step: async () => ({}),
  disconnect: async () => ({}),
  drainEvents: async () => {
    drainCalls += 1;
    return { breakpointErrors: [], tracepoints: [] };
  },
  runToLine: async () => {
    runToLineCalls += 1;
    return {
      status: "paused" as const,
      targetReached: false,
      requestedPosition: { filePath: "src/Hello.java", line: 12 },
      cleanedUp: true
    };
  },
  setVariable: async () => {
    setVariableCalls += 1;
    return {};
  }
} as RuntimeDebugProvider;

const unsupportedManager = new DebugSessionManager({ policy });
unsupportedManager.sessions.add({
  sessionId: unsupportedProvider.sessionId,
  language: "java",
  workspaceRoot,
  mode: "headless",
  owner: "mcp",
  state: "paused",
  createdAt: new Date(0).toISOString(),
  providerKind: "dap",
  provider: unsupportedProvider
});
const router = new ToolRouter(unsupportedManager);

const drainResult = await router.callTool("bp_debug_control", {
  sessionId: unsupportedProvider.sessionId,
  action: "drainEvents"
});
assert.equal(drainResult.error?.code, "UNSUPPORTED_CAPABILITY");

const runResult = await router.callTool("bp_debug_run_to_line", {
  sessionId: unsupportedProvider.sessionId,
  filePath: "src/Hello.java",
  line: 12
});
assert.equal(runResult.error?.code, "UNSUPPORTED_CAPABILITY");

const setResult = await router.callTool("bp_debug_set_value", {
  sessionId: unsupportedProvider.sessionId,
  path: ["name"],
  newValue: "Ada"
});
assert.equal(setResult.error?.code, "UNSUPPORTED_CAPABILITY");
assert.deepEqual({ drainCalls, runToLineCalls, setVariableCalls }, {
  drainCalls: 0,
  runToLineCalls: 0,
  setVariableCalls: 0
});

const vscodeBridgeSource = fs.readFileSync(
  new URL("../breakpilot-vscode/src/bridge/BridgeClient.ts", import.meta.url),
  "utf8"
);
assert.match(vscodeBridgeSource, /setVariableMode:\s*"evaluateAssignment"/);
const ideaBridgeSource = fs.readFileSync(
  new URL("../breakpilot-idea/src/main/kotlin/bridge/BridgeClient.kt", import.meta.url),
  "utf8"
);
assert.match(ideaBridgeSource, /"setVariableMode"\s+to\s+"evaluateAssignment"/);

console.log("provider capability tests ok");
