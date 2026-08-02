import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import type { Socket } from "node:net";
import test from "node:test";

import { ToolRouter } from "../src/control/ToolRouter.ts";
import { validateToolOutput } from "../src/control/ToolInputValidator.ts";
import { toolOutputSchemas } from "../src/control/toolOutputSchemas.ts";
import type { DapSession } from "../src/dap/DapSession.ts";
import { IdeClientRegistry } from "../src/ide/IdeClientRegistry.ts";
import { IdeMessageTypes } from "../src/ide/IdeProtocol.ts";
import { RuntimeEventBuffer } from "../src/runtime/RuntimeEventBuffer.ts";
import { DapRuntimeProvider } from "../src/runtime/providers/DapRuntimeProvider.ts";
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
    async getCallStack(_threadId, request) {
      return {
        threadId: 7,
        stackFrames: [{ id: 11, name: "main", line: 1, source: { path: sourceFile } }],
        offset: request.offset,
        totalFrames: 1,
        completeness: "complete",
        partial: false
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
    { tool: "bp_debug_value", args: { handle: "v1" } },
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

test("DAP event drain capability requires a live subscribed event source", () => {
  let live = false;
  let subscribed = false;
  const dap = {
    sessionId: "dap_event_caps",
    language: "java",
    workspaceRoot,
    capabilities: {},
    threadId: null,
    onRuntimeEvent() {
      subscribed = true;
      return () => {
        subscribed = false;
      };
    },
    hasRuntimeEventSource() {
      return live;
    }
  } as unknown as DapSession;
  const provider = new DapRuntimeProvider(dap, new RuntimeEventBuffer(dap.sessionId));

  assert.equal(subscribed, true);
  assert.equal(provider.capabilities.eventDrain, "unsupported");
  live = true;
  assert.equal(provider.capabilities.eventDrain, "native");
  provider.disposeRuntimeEvents();
  assert.equal(subscribed, false);
  assert.equal(provider.capabilities.eventDrain, "unsupported");

  const withoutEventSource = new DapRuntimeProvider({
    sessionId: "dap_without_events",
    language: "java",
    workspaceRoot,
    capabilities: {},
    threadId: null
  } as unknown as DapSession);
  assert.equal(withoutEventSource.capabilities.eventDrain, "unsupported");
});

test("manager event seams remain session-local without enabling IDE event drain", async () => {
  const { router, manager } = sessionRouter(unsupportedCapabilities);
  manager.appendRuntimeEvent("operation_caps", { kind: "continued", threadId: 7 });

  assert.deepEqual(
    manager.readRuntimeEvents("operation_caps", { cursor: 0 }).items.map((event) => event.kind),
    ["continued"]
  );
  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents"
  });
  assert.equal(response.error?.code, ErrorCodes.UNSUPPORTED_CAPABILITY);
});

test("public event drain forwards replay arguments and rebuilds legacy projections", async () => {
  const { router, manager } = sessionRouter({
    ...unsupportedCapabilities,
    eventDrain: "native"
  });
  const provider = manager.sessions.get("operation_caps").provider;
  let received: unknown = undefined;
  provider.drainEvents = async (args) => {
    received = args;
    return {
      items: [
        {
          sequence: 4,
          timestamp: "2026-07-25T00:00:00.000Z",
          kind: "breakpointError",
          sessionId: "operation_caps",
          message: "unverified"
        },
        {
          sequence: 5,
          timestamp: "2026-07-25T00:00:01.000Z",
          kind: "tracepoint",
          sessionId: "operation_caps",
          message: "trace"
        }
      ],
      cursor: 3,
      nextCursor: 5,
      oldestCursor: 4,
      hasMore: false,
      overflowed: false,
      droppedCount: 0,
      supportedKinds: [],
      breakpointErrors: [],
      tracepoints: []
    };
  };

  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents",
    cursor: 3,
    limit: 2
  });

  assert.deepEqual(received, { cursor: 3, limit: 2 });
  const items = (response.events as AnyRecord).items as AnyRecord[];
  assert.deepEqual(items.filter((event) => event.kind === "breakpointError").map((event) => event.sequence), [4]);
  assert.deepEqual(items.filter((event) => event.kind === "tracepoint").map((event) => event.sequence), [5]);
});

test("public event drain normalizes legacy positions before output validation", async () => {
  const { router, manager } = sessionRouter({
    ...unsupportedCapabilities,
    eventDrain: "native"
  });
  const provider = manager.sessions.get("operation_caps").provider;
  provider.drainEvents = async (args) => manager.readRuntimeEvents("operation_caps", args);
  manager.appendRuntimeEvent("operation_caps", {
    kind: "stopped",
    position: { file: "Foo.java", line: 20, column: 8 }
  });
  manager.appendRuntimeEvent("operation_caps", {
    kind: "output",
    position: { column: 9 }
  });

  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents",
    cursor: 0,
    limit: 2
  });

  assert.equal(response.error, undefined);
  const items = (response.events as AnyRecord).items as AnyRecord[];
  assert.deepEqual(items[0]?.at, { filePath: "Foo.java", line: 20 });
  assert.equal("column" in (items[0]?.at ?? {}), false);
  assert.equal("at" in (items[1] ?? {}), false);
  const outputSchema = toolOutputSchemas.bp_debug_control;
  assert.ok(outputSchema);
  assert.deepEqual(validateToolOutput(outputSchema, response).errors, []);
});

test("public event drain falls back to a valid legacy file when filePath is malformed", async () => {
  const { router, manager } = sessionRouter({
    ...unsupportedCapabilities,
    eventDrain: "native"
  });
  const provider = manager.sessions.get("operation_caps").provider;
  provider.drainEvents = async (args) => manager.readRuntimeEvents("operation_caps", args);
  manager.appendRuntimeEvent("operation_caps", {
    kind: "stopped",
    position: { filePath: {}, file: "Foo.java", line: 20 }
  });

  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents",
    cursor: 0,
    limit: 1
  });

  assert.equal(response.error, undefined);
  assert.deepEqual((response.events as AnyRecord).items[0]?.at, {
    filePath: "Foo.java",
    line: 20
  });
  const outputSchema = toolOutputSchemas.bp_debug_control;
  assert.ok(outputSchema);
  assert.deepEqual(validateToolOutput(outputSchema, response).errors, []);
});

test("hostile position proxies do not throw, leak, or create event sequence holes", async () => {
  const { router, manager } = sessionRouter({
    ...unsupportedCapabilities,
    eventDrain: "native"
  });
  const provider = manager.sessions.get("operation_caps").provider;
  provider.drainEvents = async (args) => manager.readRuntimeEvents("operation_caps", args);
  const hostilePosition = new Proxy({}, {
    getOwnPropertyDescriptor() {
      throw new Error("hostile position");
    }
  });

  assert.doesNotThrow(() => manager.appendRuntimeEvent("operation_caps", {
    kind: "stopped",
    position: hostilePosition
  }));
  manager.appendRuntimeEvent("operation_caps", { kind: "continued" });

  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents",
    cursor: 0,
    limit: 2
  });

  assert.equal(response.error, undefined);
  const items = (response.events as AnyRecord).items as AnyRecord[];
  assert.deepEqual(items.map((item) => item.sequence), [1, 2]);
  assert.equal("position" in (items[0] ?? {}), false);
});

test("revoked position proxies do not throw, leak, or create event sequence holes", async () => {
  const { router, manager } = sessionRouter({
    ...unsupportedCapabilities,
    eventDrain: "native"
  });
  const provider = manager.sessions.get("operation_caps").provider;
  provider.drainEvents = async (args) => manager.readRuntimeEvents("operation_caps", args);
  const { proxy: revokedPosition, revoke } = Proxy.revocable({}, {});
  revoke();

  assert.doesNotThrow(() => manager.appendRuntimeEvent("operation_caps", {
    kind: "stopped",
    position: revokedPosition
  }));
  manager.appendRuntimeEvent("operation_caps", { kind: "continued" });

  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents",
    cursor: 0,
    limit: 2
  });

  assert.equal(response.error, undefined);
  const items = (response.events as AnyRecord).items as AnyRecord[];
  assert.deepEqual(items.map((item) => item.sequence), [1, 2]);
  assert.equal("position" in (items[0] ?? {}), false);
  const outputSchema = toolOutputSchemas.bp_debug_control;
  assert.ok(outputSchema);
  assert.deepEqual(validateToolOutput(outputSchema, response).errors, []);
});

test("revoked metadata proxies do not throw, leak, or create event sequence holes", async () => {
  const { router, manager } = sessionRouter({
    ...unsupportedCapabilities,
    eventDrain: "native"
  });
  const provider = manager.sessions.get("operation_caps").provider;
  provider.drainEvents = async (args) => manager.readRuntimeEvents("operation_caps", args);
  const { proxy: revokedData, revoke } = Proxy.revocable({}, {});
  revoke();

  assert.doesNotThrow(() => manager.appendRuntimeEvent("operation_caps", {
    kind: "stopped",
    data: revokedData
  }));
  manager.appendRuntimeEvent("operation_caps", { kind: "continued" });

  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents",
    cursor: 0,
    limit: 2
  });

  assert.equal(response.error, undefined);
  const items = (response.events as AnyRecord).items as AnyRecord[];
  assert.deepEqual(items.map((item) => item.sequence), [1, 2]);
  assert.equal("data" in (items[0] ?? {}), false);
  const outputSchema = toolOutputSchemas.bp_debug_control;
  assert.ok(outputSchema);
  assert.deepEqual(validateToolOutput(outputSchema, response).errors, []);
});

test("metadata descriptor traps do not throw, leak, or create event sequence holes", async () => {
  const { router, manager } = sessionRouter({
    ...unsupportedCapabilities,
    eventDrain: "native"
  });
  const provider = manager.sessions.get("operation_caps").provider;
  provider.drainEvents = async (args) => manager.readRuntimeEvents("operation_caps", args);
  const hostileData = new Proxy({}, {
    getOwnPropertyDescriptor() {
      throw new Error("hostile metadata");
    }
  });

  assert.doesNotThrow(() => manager.appendRuntimeEvent("operation_caps", {
    kind: "stopped",
    data: hostileData
  }));
  manager.appendRuntimeEvent("operation_caps", { kind: "continued" });

  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents",
    cursor: 0,
    limit: 2
  });

  assert.equal(response.error, undefined);
  const items = (response.events as AnyRecord).items as AnyRecord[];
  assert.deepEqual(items.map((item) => item.sequence), [1, 2]);
  assert.equal("data" in (items[0] ?? {}), false);
  const outputSchema = toolOutputSchemas.bp_debug_control;
  assert.ok(outputSchema);
  assert.deepEqual(validateToolOutput(outputSchema, response).errors, []);
});

test("metadata normalization skips accessors and retains allowlisted scalar data", async () => {
  const { router, manager } = sessionRouter({
    ...unsupportedCapabilities,
    eventDrain: "native"
  });
  const provider = manager.sessions.get("operation_caps").provider;
  provider.drainEvents = async (args) => manager.readRuntimeEvents("operation_caps", args);
  let getterCalls = 0;
  const data = {
    description: "paused",
    processId: 42,
    hitBreakpointIds: ["bp-1", 2, false, null, { secret: true }],
    areas: ["stacks", true],
    arbitrary: "drop",
    nested: { secret: true }
  };
  Object.defineProperty(data, "reason", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    }
  });

  manager.appendRuntimeEvent("operation_caps", { kind: "stopped", data });
  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents",
    cursor: 0,
    limit: 1
  });

  assert.equal(getterCalls, 0);
  assert.equal(response.error, undefined);
  const item = (response.events as AnyRecord).items[0] as AnyRecord;
  assert.deepEqual(item.data, {
    description: "paused",
    processId: 42,
    hitBreakpointIds: ["bp-1", 2, false, null],
    areas: ["stacks", true]
  });
  const outputSchema = toolOutputSchemas.bp_debug_control;
  assert.ok(outputSchema);
  assert.deepEqual(validateToolOutput(outputSchema, response).errors, []);
});

test("hostile inner metadata values are omitted without discarding safe metadata", async () => {
  const { router, manager } = sessionRouter({
    ...unsupportedCapabilities,
    eventDrain: "native"
  });
  const provider = manager.sessions.get("operation_caps").provider;
  provider.drainEvents = async (args) => manager.readRuntimeEvents("operation_caps", args);
  const { proxy: revokedAreas, revoke } = Proxy.revocable([], {});
  revoke();

  assert.doesNotThrow(() => manager.appendRuntimeEvent("operation_caps", {
    kind: "stopped",
    data: { reason: "breakpoint", areas: revokedAreas }
  }));

  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents",
    cursor: 0,
    limit: 1
  });

  assert.equal(response.error, undefined);
  assert.deepEqual((response.events as AnyRecord).items[0]?.data, { reason: "breakpoint" });
});

test("metadata arrays retain scalar values without invoking proxy property getters", async () => {
  const { router, manager } = sessionRouter({
    ...unsupportedCapabilities,
    eventDrain: "native"
  });
  const provider = manager.sessions.get("operation_caps").provider;
  provider.drainEvents = async (args) => manager.readRuntimeEvents("operation_caps", args);
  let propertyReads = 0;
  const guardedAreas = new Proxy(["stacks", true, null, { secret: true }], {
    get() {
      propertyReads += 1;
      throw new Error("metadata array property read");
    }
  });

  assert.doesNotThrow(() => manager.appendRuntimeEvent("operation_caps", {
    kind: "invalidated",
    data: { areas: guardedAreas }
  }));

  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents",
    cursor: 0,
    limit: 1
  });

  assert.equal(propertyReads, 0);
  assert.equal(response.error, undefined);
  assert.deepEqual((response.events as AnyRecord).items[0]?.data, {
    areas: ["stacks", true, null]
  });
});

test("an early metadata descriptor trap omits only that key and retains later safe siblings", async () => {
  const { router, manager } = sessionRouter({
    ...unsupportedCapabilities,
    eventDrain: "native"
  });
  const provider = manager.sessions.get("operation_caps").provider;
  provider.drainEvents = async (args) => manager.readRuntimeEvents("operation_caps", args);
  let getterCalls = 0;
  const data = Object.defineProperty({ reason: "breakpoint", processId: 42 }, "description", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    }
  });
  const selectivelyHostileData = new Proxy(data, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "description") throw new Error("early metadata descriptor trap");
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
  });

  assert.doesNotThrow(() => manager.appendRuntimeEvent("operation_caps", {
    kind: "stopped",
    data: selectivelyHostileData
  }));
  manager.appendRuntimeEvent("operation_caps", { kind: "continued" });

  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents",
    cursor: 0,
    limit: 2
  });

  assert.equal(getterCalls, 0);
  assert.equal(response.error, undefined);
  const items = (response.events as AnyRecord).items as AnyRecord[];
  assert.deepEqual(items.map((item) => item.sequence), [1, 2]);
  assert.deepEqual(items[0]?.data, { reason: "breakpoint", processId: 42 });
  const outputSchema = toolOutputSchemas.bp_debug_control;
  assert.ok(outputSchema);
  assert.deepEqual(validateToolOutput(outputSchema, response).errors, []);
});

test("a late metadata descriptor trap retains every earlier safe sibling", async () => {
  const { router, manager } = sessionRouter({
    ...unsupportedCapabilities,
    eventDrain: "native"
  });
  const provider = manager.sessions.get("operation_caps").provider;
  provider.drainEvents = async (args) => manager.readRuntimeEvents("operation_caps", args);
  const data = {
    reason: "breakpoint",
    description: "paused",
    processId: 42,
    threadName: "main"
  };
  const selectivelyHostileData = new Proxy(data, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "areas") throw new Error("late metadata descriptor trap");
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
  });

  assert.doesNotThrow(() => manager.appendRuntimeEvent("operation_caps", {
    kind: "stopped",
    data: selectivelyHostileData
  }));

  const response = await router.callTool("bp_debug_control", {
    sessionId: "operation_caps",
    action: "drainEvents",
    cursor: 0,
    limit: 1
  });

  assert.equal(response.error, undefined);
  assert.deepEqual((response.events as AnyRecord).items[0]?.data, data);
  const outputSchema = toolOutputSchemas.bp_debug_control;
  assert.ok(outputSchema);
  assert.deepEqual(validateToolOutput(outputSchema, response).errors, []);
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
