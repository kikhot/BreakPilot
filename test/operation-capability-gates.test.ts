import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import type { Socket } from "node:net";
import test from "node:test";

import { ToolRouter } from "../src/control/ToolRouter.ts";
import { IdeClientRegistry } from "../src/ide/IdeClientRegistry.ts";
import { IdeMessageTypes } from "../src/ide/IdeProtocol.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import type { RuntimeProviderCapabilities } from "../src/types/capabilities.ts";
import type { BridgeMessage } from "../src/types/ide.ts";
import type { AnyRecord } from "../src/types/json.ts";
import type { RuntimeDebugProvider } from "../src/types/sessions.ts";
import { ErrorCodes } from "../src/utils/errors.ts";

const policy = loadPolicy("breakpilot.yaml");
const workspaceRoot = path.resolve(policy.workspace.root);
const sourceFile = path.join(workspaceRoot, "src", "sessions", "DebugSessionManager.ts");

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

type ProviderCounters = {
  snapshot: number;
  inspect: number;
  setVariable: number;
  setBreakpoints: number;
  wait: number;
};

function sessionRouter(capabilities: RuntimeProviderCapabilities): {
  router: ToolRouter;
  manager: DebugSessionManager;
  counters: ProviderCounters;
} {
  const manager = new DebugSessionManager({ policy });
  const counters: ProviderCounters = {
    snapshot: 0,
    inspect: 0,
    setVariable: 0,
    setBreakpoints: 0,
    wait: 0
  };
  const provider: RuntimeDebugProvider = {
    kind: "ide",
    sessionId: "operation_caps",
    language: "java",
    workspaceRoot,
    capabilities,
    threadId: 7,
    async setBreakpoints(_filePath, breakpoints) {
      counters.setBreakpoints += 1;
      return breakpoints.map((breakpoint, index) => ({
        id: index + 1,
        verified: true,
        line: breakpoint.line,
        column: breakpoint.column
      }));
    },
    async waitForBreakpoint() {
      counters.wait += 1;
      return { sessionId: "operation_caps", reason: "breakpoint", threadId: 7 };
    },
    async getCallStack() {
      return {
        threadId: 7,
        stackFrames: [{ id: 11, name: "main", line: 1, source: { path: sourceFile } }],
        totalFrames: 1
      };
    },
    async getRuntimeSnapshot() {
      counters.snapshot += 1;
      return {
        sessionId: "operation_caps",
        source: "ide",
        language: "java",
        threadId: 7,
        frameId: 11,
        stackFrames: [{ id: 11, name: "main", line: 1, source: { path: sourceFile } }],
        variables: {
          locals: {
            name: "locals",
            expensive: false,
            variables: {
              answer: {
                name: "answer",
                kind: "primitive",
                value: "42",
                valuePreview: "42",
                variablesReference: 0,
                truncated: false
              }
            }
          }
        },
        limits: { maxDepth: 1, maxItems: 10, maxStringLength: 100 }
      };
    },
    async inspectVariable() {
      counters.inspect += 1;
      return { variablesReference: 9, variables: {} };
    },
    async setVariable() {
      counters.setVariable += 1;
      return { applied: true };
    },
    async evaluate() {
      return {};
    },
    async pause() {
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
  manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot,
    mode: "ide",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: provider.kind,
    provider
  });
  return { router: new ToolRouter(manager), manager, counters };
}

class CapabilityBridge extends EventEmitter {
  readonly registry = new IdeClientRegistry();
  readonly sent: BridgeMessage[] = [];

  constructor(capabilities: AnyRecord = {}) {
    super();
    this.registry.add({} as Socket, {
      clientId: "idea_operation_caps",
      ide: "idea",
      workspaceRoot,
      capabilities
    });
  }

  sendToClient(clientId: string | undefined, message: Partial<BridgeMessage>): boolean {
    if (clientId !== "idea_operation_caps") return false;
    const outbound = { ...message, clientId } as BridgeMessage;
    this.sent.push(outbound);
    if (message.type === IdeMessageTypes.AGENT_SET_BREAKPOINT) {
      queueMicrotask(() => {
        const breakpoint = message.breakpoint as AnyRecord;
        const response: BridgeMessage = {
          type: IdeMessageTypes.IDE_BREAKPOINT_ADDED,
          clientId,
          requestId: message.requestId,
          breakpointId: String(breakpoint.id),
          breakpoint: { ...breakpoint, verified: true }
        };
        this.emit(IdeMessageTypes.IDE_BREAKPOINT_ADDED, { clientId, message: response });
      });
    }
    return true;
  }
}

function projectRouter(capabilities: AnyRecord = {}): {
  router: ToolRouter;
  manager: DebugSessionManager;
  bridge: CapabilityBridge;
} {
  const bridge = new CapabilityBridge(capabilities);
  const manager = new DebugSessionManager({
    policy,
    ideBridge: bridge as unknown as ConstructorParameters<typeof DebugSessionManager>[0]["ideBridge"]
  });
  return { router: new ToolRouter(manager), manager, bridge };
}

test("frame, value, context, and set-value path resolution require variable references", async () => {
  const operations = [
    { tool: "bp_debug_frame", args: {} },
    { tool: "bp_debug_value", args: { path: ["answer"] } },
    { tool: "bp_debug_value", args: { ref: 9 } },
    { tool: "bp_debug_set_value", args: { path: ["answer"], newValue: "43" } },
    { tool: "bp_debug_context", args: {} }
  ];

  for (const operation of operations) {
    const { router, counters } = sessionRouter({
      ...unsupportedCapabilities,
      setValue: "native"
    });
    const response = await router.callTool(operation.tool, {
      sessionId: "operation_caps",
      ...operation.args
    });

    assert.equal(response.error?.code, ErrorCodes.UNSUPPORTED_CAPABILITY, operation.tool);
    assert.deepEqual(counters, {
      snapshot: 0,
      inspect: 0,
      setVariable: 0,
      setBreakpoints: 0,
      wait: 0
    }, operation.tool);
  }
});

const advancedCapabilityCases = [
  { field: "condition", value: "answer > 0", capability: "conditionalBreakpoints" },
  { field: "hitCondition", value: "2", capability: "hitConditionalBreakpoints" },
  { field: "logMessage", value: "answer={answer}", capability: "tracepoints" }
] as const;

test("session breakpoint advanced options are gated before local or provider mutation", async () => {
  for (const { field, value } of advancedCapabilityCases) {
    const { router, manager, counters } = sessionRouter(unsupportedCapabilities);
    const response = await router.callTool("bp_debug_set_breakpoint", {
      sessionId: "operation_caps",
      filePath: sourceFile,
      line: 1,
      [field]: value
    });

    assert.equal(response.error?.code, ErrorCodes.UNSUPPORTED_CAPABILITY, field);
    assert.equal(counters.setBreakpoints, 0, field);
    assert.equal(manager.breakpoints.list("operation_caps").length, 0, field);
  }
});

test("session breakpoint advanced options dispatch when their capability is native", async () => {
  for (const { field, value, capability } of advancedCapabilityCases) {
    const capabilities = { ...unsupportedCapabilities, [capability]: "native" } as RuntimeProviderCapabilities;
    const { router, manager, counters } = sessionRouter(capabilities);
    const response = await router.callTool("bp_debug_set_breakpoint", {
      sessionId: "operation_caps",
      filePath: sourceFile,
      line: 1,
      [field]: value
    });

    assert.equal(response.error, undefined, field);
    assert.equal(counters.setBreakpoints, 1, field);
    assert.equal(manager.breakpoints.list("operation_caps").length, 1, field);
  }
});

const unsupportedSemanticCases = [
  { field: "enabled", value: false },
  { field: "temporary", value: true },
  { field: "suspendPolicy", value: "ALL" },
  { field: "isLogMessage", value: true },
  { field: "isLogStack", value: true }
] as const;

test("unimplemented breakpoint semantics reject before session mutation", async () => {
  for (const { field, value } of unsupportedSemanticCases) {
    const { router, manager, counters } = sessionRouter({
      ...unsupportedCapabilities,
      conditionalBreakpoints: "native",
      hitConditionalBreakpoints: "native",
      tracepoints: "native"
    });
    const response = await router.callTool("bp_debug_set_breakpoint", {
      sessionId: "operation_caps",
      filePath: sourceFile,
      line: 1,
      [field]: value
    });

    assert.equal(response.error?.code, ErrorCodes.UNSUPPORTED_CAPABILITY, field);
    assert.equal(counters.setBreakpoints, 0, field);
    assert.equal(manager.breakpoints.list("operation_caps").length, 0, field);
  }
});

test("project breakpoint capabilities and unsupported semantics gate before bridge mutation", async () => {
  for (const { field, value } of [...advancedCapabilityCases, ...unsupportedSemanticCases]) {
    const { router, manager, bridge } = projectRouter();
    const response = await router.callTool("bp_debug_set_breakpoint", {
      clientId: "idea_operation_caps",
      filePath: sourceFile,
      line: 1,
      [field]: value
    });

    assert.equal(response.error?.code, ErrorCodes.UNSUPPORTED_CAPABILITY, field);
    assert.equal(bridge.sent.length, 0, field);
    assert.equal(manager.breakpoints.listProject({ workspaceRoot }).length, 0, field);
  }
});

test("project breakpoint advanced options dispatch when the live client supports them", async () => {
  for (const { field, value, capability } of advancedCapabilityCases) {
    const { router, manager, bridge } = projectRouter({ [capability]: true });
    const response = await router.callTool("bp_debug_set_breakpoint", {
      clientId: "idea_operation_caps",
      filePath: sourceFile,
      line: 1,
      [field]: value
    });

    assert.equal(response.error, undefined, field);
    assert.equal(bridge.sent.length, 1, field);
    assert.equal(manager.breakpoints.listProject({ workspaceRoot }).length, 1, field);
  }
});
