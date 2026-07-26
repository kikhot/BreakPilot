import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { DapSession } from "../src/dap/DapSession.ts";
import { IdeClientRegistry } from "../src/ide/IdeClientRegistry.ts";
import { IdeMessageTypes } from "../src/ide/IdeProtocol.ts";
import { dapProviderCapabilities } from "../src/runtime/ProviderCapabilities.ts";
import { DapRuntimeProvider } from "../src/runtime/providers/DapRuntimeProvider.ts";
import { IdeRuntimeProvider } from "../src/runtime/providers/IdeRuntimeProvider.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import type { AnyRecord } from "../src/types/json.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";

class AssociationFakeIdeBridge extends EventEmitter {
  registry = new IdeClientRegistry();
  traffic = 0;

  constructor(workspaceRoot: string) {
    super();
    this.registry.add({ writable: true } as any, {
      clientId: "ide-client-live",
      ide: "idea",
      workspaceRoot,
      capabilities: { variableSnapshot: true }
    });
    this.registry.upsertSession("ide-client-live", {
      type: IdeMessageTypes.IDE_SESSION_PAUSED,
      ideSessionId: "ide-session-live",
      workspaceRoot,
      state: "paused",
      active: true
    }, "paused");
  }

  sendToClient(): boolean {
    this.traffic += 1;
    return false;
  }
}

class PendingResponseIdeBridge extends EventEmitter {
  registry = new IdeClientRegistry();
  sent: Array<{ clientId: string; message: AnyRecord }> = [];

  constructor(workspaceRoot: string) {
    super();
    this.registry.add({ writable: true } as any, {
      clientId: "ide-client-pending",
      ide: "idea",
      workspaceRoot,
      capabilities: { variableSnapshot: true, visualBreakpoints: true }
    });
  }

  sendToClient(clientId: string, message: AnyRecord): boolean {
    if (!this.registry.get(clientId)) return false;
    this.sent.push({ clientId, message });
    return true;
  }
}

function pendingIdeResponseFixture() {
  const policy = loadPolicy("breakpilot.yaml");
  const bridge = new PendingResponseIdeBridge(policy.workspace.root);
  const manager = new DebugSessionManager({ policy, ideBridge: bridge as any });
  return { policy, bridge, manager };
}

async function flushBridgeListeners(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function realIdeAssociationFixture(overrides: { recordClientId?: string; recordIdeSessionId?: string } = {}) {
  const policy = loadPolicy("breakpilot.yaml");
  const bridge = new AssociationFakeIdeBridge(policy.workspace.root);
  const ideSession = bridge.registry.findSessionForClient("ide-client-live", "ide-session-live");
  assert.ok(ideSession);
  const provider = new IdeRuntimeProvider({
    sessionId: "ide-association-record",
    bridge: bridge as any,
    ideSession,
    workspaceRoot: policy.workspace.root
  });
  const manager = new DebugSessionManager({ policy, ideBridge: bridge as any });
  manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "ide",
    owner: "hybrid",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "ide",
    provider,
    ideClientId: overrides.recordClientId ?? provider.ideClientId,
    ideSessionId: overrides.recordIdeSessionId ?? provider.ideSessionId
  });
  return { manager, provider, bridge };
}

function addCustomProviderWithIdeMirrors(
  manager: DebugSessionManager,
  {
    sessionId,
    state = "paused",
    stopIdeSessionId = "provider-stop-session"
  }: {
    sessionId: string;
    state?: string;
    stopIdeSessionId?: string;
  }
) {
  const policy = loadPolicy("breakpilot.yaml");
  let traffic = 0;
  const provider = {
    kind: "dap",
    sessionId,
    language: "python",
    workspaceRoot: policy.workspace.root,
    capabilities: dapProviderCapabilities(),
    threadId: 7,
    async setBreakpoints() { return []; },
    async pause() { traffic += 1; return {}; },
    async waitForBreakpoint() {
      traffic += 1;
      return { reason: "breakpoint", threadId: 7, ideSessionId: stopIdeSessionId };
    },
    async getCallStack() {
      traffic += 1;
      return {
        threadId: 7,
        stackFrames: [],
        offset: 0,
        completeness: "unknown",
        partial: true,
        truncationReason: "provider"
      };
    },
    async getRuntimeSnapshot() {
      traffic += 1;
      return {
        sessionId,
        source: "dap",
        language: "python",
        threadId: 7,
        frameId: null,
        stackFrames: [],
        variables: {},
        limits: { maxDepth: 1, maxItems: 10, maxStringLength: 200 }
      };
    },
    async evaluate() { traffic += 1; return {}; },
    async continue() { traffic += 1; return {}; },
    async step() { traffic += 1; return {}; },
    async disconnect() { traffic += 1; return {}; }
  } as any;
  const record = manager.sessions.add({
    sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state,
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider,
    ideClientId: "ide-client-live",
    ideSessionId: "ide-session-live"
  });
  return { provider, record, traffic: () => traffic };
}

interface IdeRoutingFixture {
  manager: DebugSessionManager;
  sessionId: string;
  calls: {
    snapshots: AnyRecord[];
    inspections: AnyRecord[];
    evaluations: AnyRecord[];
    mutations: AnyRecord[];
    waits: number;
    stacks: number;
  };
  dapTraffic: () => number;
}

function createLiveIdeWithStaleDap(): IdeRoutingFixture {
  const policy = loadPolicy("breakpilot.yaml");
  const sessionId = "live-ide-with-stale-dap";
  let dapTraffic = 0;
  const staleDap = Object.create(DapSession.prototype) as DapSession;
  staleDap.sessionId = sessionId;
  staleDap.language = "python";
  staleDap.workspaceRoot = policy.workspace.root;
  staleDap.threadId = 7;
  staleDap.capabilities = {};
  staleDap.client = {
    async request(command: string) {
      dapTraffic += 1;
      if (command === "stackTrace") {
        return {
          stackFrames: [{ id: 71, name: "stale", line: 1, source: { path: "stale.py" } }],
          totalFrames: 1
        };
      }
      if (command === "scopes") return { scopes: [] };
      if (command === "variables") return { variables: [] };
      return {};
    }
  } as any;

  const calls = {
    snapshots: [] as AnyRecord[],
    inspections: [] as AnyRecord[],
    evaluations: [] as AnyRecord[],
    mutations: [] as AnyRecord[],
    waits: 0,
    stacks: 0
  };
  const snapshot = {
    sessionId,
    source: "ide",
    language: "python",
    threadId: "ide-thread",
    frameId: "ide-frame",
    stackFrames: [{ id: "ide-frame", name: "live", line: 12, source: { path: "live.py" } }],
    variables: {
      locals: {
        name: "locals",
        expensive: false,
        variables: {
          x: {
            name: "x",
            kind: "number",
            valuePreview: "41",
            value: 41,
            variablesReference: 0,
            truncated: false
          },
          parent: {
            name: "parent",
            kind: "object",
            valuePreview: "Parent@1",
            variablesReference: 7,
            truncated: false
          }
        }
      }
    },
    limits: { maxDepth: 2, maxItems: 20, maxStringLength: 2000 }
  } as const;
  const provider = {
    kind: "ide",
    sessionId,
    language: "python",
    workspaceRoot: policy.workspace.root,
    capabilities: {
      pause: "native",
      stepping: "native",
      runToLine: "unsupported",
      variableReferences: "snapshot",
      setValue: "native",
      breakpointUpdate: "unsupported",
      conditionalBreakpoints: "unsupported",
      hitConditionalBreakpoints: "unsupported",
      tracepoints: "unsupported",
      eventDrain: "unsupported"
    },
    threadId: "ide-thread",
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { calls.waits += 1; return { reason: "breakpoint" }; },
    async getCallStack(_threadId: unknown, request: AnyRecord) {
      calls.stacks += 1;
      return {
        threadId: "ide-thread",
        stackFrames: snapshot.stackFrames,
        offset: request.offset,
        completeness: "unknown",
        partial: true,
        truncationReason: "provider"
      };
    },
    async getRuntimeSnapshot(args: AnyRecord) {
      calls.snapshots.push(args);
      return snapshot;
    },
    async inspectVariable(args: AnyRecord) {
      calls.inspections.push(args);
      return { source: "ide", variablesReference: args.variablesReference };
    },
    async setVariable(args: AnyRecord) {
      calls.mutations.push(args);
      return { applied: true, detail: "ide" };
    },
    async evaluate(_expression: string, options: AnyRecord) {
      calls.evaluations.push(options);
      return { value: { valuePreview: "41", type: "int" } };
    },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { return {}; }
  } as any;
  const manager = new DebugSessionManager({ policy });
  manager.sessions.add({
    sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "ide",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider,
    dap: staleDap
  });
  return { manager, sessionId, calls, dapTraffic: () => dapTraffic };
}

const liveIdeRoutingCases: Array<{
  name: string;
  run: (fixture: IdeRoutingFixture) => Promise<void>;
}> = [
  {
    name: "frame inspection",
    run: async ({ manager, sessionId, calls }) => {
      const result = await manager.bpDebugFrame({ sessionId, frameId: "ide-frame" });
      assert.equal((result.frame as AnyRecord).id, "ide-frame");
      assert.equal(calls.snapshots[0]?.frameId, "ide-frame");
    }
  },
  {
    name: "direct reference inspection",
    run: async ({ manager, sessionId, calls }) => {
      const result = await manager.bpDebugValue({ sessionId, ref: "ide-variable" });
      assert.deepEqual(result.result, { source: "ide", variablesReference: "ide-variable" });
      assert.equal(calls.inspections[0]?.variablesReference, "ide-variable");
    }
  },
  {
    name: "frame-index evaluation",
    run: async ({ manager, sessionId, calls }) => {
      const result = await manager.bpDebugEval({ sessionId, expression: "x", frameIndex: 1 });
      assert.equal(result.value, "41");
      assert.equal(calls.evaluations.length, 1);
      assert.equal(calls.evaluations[0]?.frameId, undefined);
    }
  },
  {
    name: "path mutation",
    run: async ({ manager, sessionId, calls }) => {
      const result = await manager.bpDebugSetValue({ sessionId, path: ["x"], newValue: "42" });
      assert.equal(result.applied, true);
      assert.equal(calls.mutations[0]?.name, "x");
      assert.equal(calls.mutations[0]?.parentRef, undefined);
    }
  },
  {
    name: "debug context",
    run: async ({ manager, sessionId, calls }) => {
      const result = await manager.bpDebugContext({ sessionId, frameId: "ide-frame" });
      assert.equal(result.position && (result.position as AnyRecord).line, 12);
      assert.equal(calls.waits, 1);
      assert.equal(calls.stacks, 1);
      assert.equal(calls.snapshots[0]?.frameId, "ide-frame");
    }
  },
  {
    name: "lazy path lookup",
    run: async ({ manager, sessionId, calls }) => {
      await assert.rejects(
        manager.bpDebugValue({ sessionId, path: ["parent", "missing"] }),
        (error: Error & { code?: string }) => error.code === "INVALID_ARGUMENT"
      );
      assert.equal(calls.snapshots.length, 1);
    }
  }
];

for (const testCase of liveIdeRoutingCases) {
  test(`live IDE routing ignores stale DAP state for ${testCase.name}`, async () => {
    const fixture = createLiveIdeWithStaleDap();
    await testCase.run(fixture);
    assert.equal(fixture.dapTraffic(), 0);
  });
}

test("a DapRuntimeProvider supplies its live DAP session without a record mirror", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const dap = Object.create(DapSession.prototype) as DapSession;
  dap.sessionId = "canonical-dap-provider";
  dap.language = "python";
  dap.workspaceRoot = policy.workspace.root;
  dap.threadId = 7;
  dap.capabilities = {};
  dap.onRuntimeEvent = undefined as any;
  dap.variables = async () => [
    { name: "x", value: "41", type: "int", variablesReference: 0 }
  ];
  const provider = new DapRuntimeProvider(dap);
  const manager = new DebugSessionManager({ policy });
  manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "ide",
    provider
  });

  const result = await manager.bpDebugValue({ sessionId: provider.sessionId, ref: 7 });

  assert.deepEqual((result.items as AnyRecord[]).map((item) => item.name), ["x"]);
  assert.equal(result.result, undefined);
});

function mismatchedDapProviderFixture(): {
  manager: DebugSessionManager;
  recordSessionId: string;
  dapTraffic: () => number;
} {
  const policy = loadPolicy("breakpilot.yaml");
  const recordSessionId = "record-a";
  let dapTraffic = 0;
  const dap = Object.create(DapSession.prototype) as DapSession;
  dap.sessionId = "provider-b";
  dap.language = "python";
  dap.workspaceRoot = policy.workspace.root;
  dap.threadId = 7;
  dap.capabilities = {};
  dap.onRuntimeEvent = undefined as any;
  dap.waitForBreakpoint = async () => {
    dapTraffic += 1;
    return { sessionId: dap.sessionId, reason: "breakpoint", threadId: 7 };
  };
  dap.stackTrace = async () => {
    dapTraffic += 1;
    return {
      threadId: 7,
      stackFrames: [{ id: 101, name: "foreign", line: 1, source: { path: "foreign.py" } }],
      totalFrames: 1
    };
  };
  dap.scopes = async () => {
    dapTraffic += 1;
    return [{ name: "Locals", variablesReference: 1, expensive: false }];
  };
  dap.variables = async (variablesReference: number) => {
    dapTraffic += 1;
    if (variablesReference === 1) {
      return [{ name: "parent", value: "Parent@1", type: "Parent", variablesReference: 2 }];
    }
    if (variablesReference === 2) {
      return [{ name: "child", value: "42", type: "int", variablesReference: 0 }];
    }
    return [{ name: "x", value: "42", type: "int", variablesReference: 0 }];
  };
  dap.evaluate = async () => {
    dapTraffic += 1;
    return { value: { valuePreview: "42", type: "int" } };
  };
  const provider = new DapRuntimeProvider(dap);
  const manager = new DebugSessionManager({ policy });
  manager.sessions.add({
    sessionId: recordSessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider,
    dap
  });
  return { manager, recordSessionId, dapTraffic: () => dapTraffic };
}

const crossSessionDapRoutes: Array<{
  name: string;
  invoke: (fixture: ReturnType<typeof mismatchedDapProviderFixture>) => Promise<unknown>;
}> = [
  {
    name: "frame",
    invoke: ({ manager, recordSessionId }) => manager.bpDebugFrame({ sessionId: recordSessionId, frameId: 101 })
  },
  {
    name: "direct reference value",
    invoke: ({ manager, recordSessionId }) => manager.bpDebugValue({ sessionId: recordSessionId, ref: 7 })
  },
  {
    name: "path value",
    invoke: ({ manager, recordSessionId }) => manager.bpDebugValue({ sessionId: recordSessionId, path: ["parent", "child"] })
  },
  {
    name: "frame-index evaluation",
    invoke: ({ manager, recordSessionId }) => manager.bpDebugEval({
      sessionId: recordSessionId,
      expression: "x",
      frameIndex: 0
    })
  },
  {
    name: "context",
    invoke: ({ manager, recordSessionId }) => manager.bpDebugContext({ sessionId: recordSessionId, timeout: 1 })
  }
];

for (const route of crossSessionDapRoutes) {
  test(`a mismatched DAP record rejects ${route.name} before foreign provider traffic`, async () => {
    const fixture = mismatchedDapProviderFixture();

    await assert.rejects(
      route.invoke(fixture),
      (error: Error & { code?: string; details?: AnyRecord }) =>
        error.code === "TOOL_FAILED" &&
        error.details?.sessionId === fixture.recordSessionId &&
        error.details?.providerSessionId === "provider-b" &&
        error.details?.dapSessionId === "provider-b"
    );
    assert.equal(fixture.dapTraffic(), 0);
  });
}

test("context preserves an explicit unknown session selection error", async () => {
  const manager = new DebugSessionManager({ policy: loadPolicy("breakpilot.yaml") });

  await assert.rejects(
    manager.bpDebugContext({ sessionId: "missing-session", timeout: 1 }),
    (error: Error & { code?: string }) => error.code === "SESSION_NOT_FOUND"
  );
});

test("a custom DAP provider cannot route through an unrelated DAP mirror", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  let mirrorTraffic = 0;
  let providerTraffic = 0;
  const unrelatedDap = Object.create(DapSession.prototype) as DapSession;
  unrelatedDap.sessionId = "unrelated-dap";
  unrelatedDap.language = "python";
  unrelatedDap.workspaceRoot = policy.workspace.root;
  unrelatedDap.threadId = 7;
  unrelatedDap.capabilities = {};
  unrelatedDap.client = {
    async request() { mirrorTraffic += 1; return { variables: [] }; }
  } as any;
  const provider = {
    kind: "dap",
    sessionId: "custom-live-dap",
    language: "python",
    workspaceRoot: policy.workspace.root,
    capabilities: dapProviderCapabilities(),
    threadId: 7,
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { return {}; },
    async getRuntimeSnapshot() { throw new Error("not used"); },
    async inspectVariable(args: AnyRecord) {
      providerTraffic += 1;
      return { source: "custom", variablesReference: args.variablesReference };
    },
    async evaluate() { return {}; },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { return {}; }
  } as any;
  const manager = new DebugSessionManager({ policy });
  manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider,
    dap: unrelatedDap
  });

  const result = await manager.bpDebugValue({ sessionId: provider.sessionId, ref: 7 });

  assert.deepEqual(result.result, { source: "custom", variablesReference: 7 });
  assert.equal(providerTraffic, 1);
  assert.equal(mirrorTraffic, 0);
});

for (const mismatch of [
  { name: "client", recordClientId: "ide-client-stale", recordIdeSessionId: "ide-session-live" },
  { name: "session", recordClientId: "ide-client-live", recordIdeSessionId: "ide-session-stale" }
]) {
  test(`a real IDE provider rejects a mismatched record ${mismatch.name} identity before bridge traffic`, async () => {
    const { manager, provider, bridge } = realIdeAssociationFixture(mismatch);

    await assert.rejects(
      manager.bpDebugFrame({ sessionId: provider.sessionId, frameId: "frame-1" }),
      (error: Error & { code?: string; details?: AnyRecord }) =>
        error.code === ErrorCodes.TOOL_FAILED &&
        error.details?.sessionId === provider.sessionId &&
        error.details?.recordIdeClientId === undefined &&
        error.details?.recordIdeSessionId === undefined &&
        error.details?.providerIdeClientId === undefined &&
        error.details?.providerIdeSessionId === undefined
    );
    assert.equal(bridge.traffic, 0);
  });
}

for (const invalidTuple of [
  { name: "empty client", member: "client" as const, value: "" },
  { name: "blank client", member: "client" as const, value: " \t " },
  { name: "empty session", member: "session" as const, value: "" },
  { name: "blank session", member: "session" as const, value: " \t " }
]) {
  test(`a real IDE provider rejects an equal ${invalidTuple.name} identity before bridge traffic`, async () => {
    const { manager, provider, bridge } = realIdeAssociationFixture();
    const record = manager.sessions.get(provider.sessionId);
    if (invalidTuple.member === "client") {
      provider.ideClientId = invalidTuple.value;
      record.ideClientId = invalidTuple.value;
    } else {
      provider.ideSessionId = invalidTuple.value;
      record.ideSessionId = invalidTuple.value;
    }

    const status = await manager.bpDebugStatus();
    assert.deepEqual(status.sessions, []);
    await assert.rejects(
      manager.bpDebugEval({ sessionId: provider.sessionId, expression: "x" }),
      (error: Error & { code?: string }) => error.code === ErrorCodes.TOOL_FAILED
    );
    assert.equal(bridge.traffic, 0);
  });
}

function foreignIdeBridgeFixture() {
  const policy = loadPolicy("breakpilot.yaml");
  const providerBridge = new AssociationFakeIdeBridge(policy.workspace.root);
  const managerBridge = new AssociationFakeIdeBridge(policy.workspace.root);
  const ideSession = providerBridge.registry.findSessionForClient("ide-client-live", "ide-session-live");
  assert.ok(ideSession);
  const provider = new IdeRuntimeProvider({
    sessionId: "foreign-bridge-provider",
    bridge: providerBridge as any,
    ideSession,
    workspaceRoot: policy.workspace.root
  });
  const manager = new DebugSessionManager({ policy, ideBridge: managerBridge as any });
  const record = manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "ide",
    owner: "hybrid",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "ide",
    provider,
    ideClientId: provider.ideClientId,
    ideSessionId: provider.ideSessionId
  });
  return { manager, provider, providerBridge, managerBridge, record };
}

test("a real IDE provider owned by another bridge is hidden and unroutable", async () => {
  const { manager, provider, providerBridge, managerBridge } = foreignIdeBridgeFixture();

  const status = await manager.bpDebugStatus();
  assert.deepEqual(status.sessions, []);
  await assert.rejects(
    manager.bpDebugEval({ sessionId: provider.sessionId, expression: "x" }),
    (error: Error & { code?: string }) => error.code === ErrorCodes.TOOL_FAILED
  );
  assert.equal(providerBridge.traffic, 0);
  assert.equal(managerBridge.traffic, 0);
});

test("lifecycle events cannot mutate or clean a real IDE provider owned by another bridge", async () => {
  const { manager, providerBridge, managerBridge, record } = foreignIdeBridgeFixture();

  emitIdeLifecycle(managerBridge, IdeMessageTypes.IDE_SESSION_RESUMED);
  emitIdeLifecycle(managerBridge, IdeMessageTypes.IDE_SESSION_TERMINATED);
  await awaitLifecycleCleanup();

  assert.equal(record.state, "paused");
  assert.equal(manager.sessions.maybeGet(record.sessionId), record);
  assert.equal(providerBridge.traffic, 0);
  assert.equal(managerBridge.traffic, 0);
});

test("a real IDE provider without current bridge registry evidence is hidden and unroutable", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  bridge.registry.remove(provider.ideClientId);

  const status = await manager.bpDebugStatus();
  assert.deepEqual(status.sessions, []);
  await assert.rejects(
    manager.bpDebugEval({ sessionId: provider.sessionId, expression: "x" }),
    (error: Error & { code?: string }) => error.code === ErrorCodes.TOOL_FAILED
  );
  assert.equal(bridge.traffic, 0);
});

test("lifecycle events cannot mutate a real IDE provider without current registry evidence", () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);
  bridge.registry.remove(provider.ideClientId);

  emitIdeLifecycle(bridge, IdeMessageTypes.IDE_SESSION_RESUMED);

  assert.equal(record.state, "paused");
  assert.equal(bridge.traffic, 0);
});

test("IDE adoption ignores a live custom provider with stale matching IDE mirrors", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const bridge = new AssociationFakeIdeBridge(policy.workspace.root);
  const manager = new DebugSessionManager({ policy, ideBridge: bridge as any });
  const stale = addCustomProviderWithIdeMirrors(manager, { sessionId: "stale-custom-adoption" });

  const started = await manager.bpDebugStart({
    mode: "ide",
    clientId: "ide-client-live",
    ideSessionId: "ide-session-live"
  });

  assert.notEqual(started.sessionId, stale.record.sessionId);
  assert.ok(manager.sessions.get(String(started.sessionId)).provider instanceof IdeRuntimeProvider);
  assert.equal(manager.sessions.maybeGet(stale.record.sessionId), stale.record);
  assert.equal(stale.record.provider, stale.provider);
  assert.equal(stale.record.ideClientId, "ide-client-live");
  assert.equal(stale.record.ideSessionId, "ide-session-live");
  assert.equal(stale.traffic(), 0);
});

test("context adoption ignores a terminal custom provider with stale matching IDE mirrors", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const bridge = new AssociationFakeIdeBridge(policy.workspace.root);
  const manager = new DebugSessionManager({ policy, ideBridge: bridge as any });
  const stale = addCustomProviderWithIdeMirrors(manager, {
    sessionId: "stale-terminal-context-adoption",
    state: "terminated"
  });

  await manager.bpDebugContext({ timeout: 1 });

  const adopted = [...manager.sessions.sessions.values()].find(
    (session) => session.provider instanceof IdeRuntimeProvider
  );
  assert.ok(adopted);
  assert.notEqual(adopted.sessionId, stale.record.sessionId);
  assert.equal(manager.sessions.maybeGet(stale.record.sessionId), stale.record);
  assert.equal(stale.traffic(), 0);
});

test("custom provider stop evidence ignores stale record IDE mirrors", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const manager = new DebugSessionManager({ policy });
  const fixture = addCustomProviderWithIdeMirrors(manager, {
    sessionId: "custom-stop-evidence",
    stopIdeSessionId: "provider-stop-session"
  });

  const result = await manager.bpDebugControl({
    sessionId: fixture.record.sessionId,
    action: "pause"
  });

  assert.equal(result.status, "paused");
  assert.equal(result.reason, "breakpoint");
  assert.equal(fixture.traffic(), 2);
});

test("custom provider correlation errors do not emit stale record IDE mirrors", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const manager = new DebugSessionManager({ policy });
  const fixture = addCustomProviderWithIdeMirrors(manager, {
    sessionId: "custom-stop-correlation-error"
  });
  fixture.provider.waitForBreakpoint = async () => {
    return { ideSessionId: "provider-stop-session" };
  };

  await assert.rejects(
    manager.bpDebugControl({ sessionId: fixture.record.sessionId, action: "pause" }),
    (error: Error & { code?: string; details?: AnyRecord }) =>
      error.code === ErrorCodes.TOOL_FAILED &&
      error.details?.ideSessionId === undefined &&
      error.details?.reportedIdeSessionId === "provider-stop-session"
  );
});

test("a live custom provider summary never emits stale IDE compatibility mirrors", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const manager = new DebugSessionManager({ policy });
  const fixture = addCustomProviderWithIdeMirrors(manager, { sessionId: "custom-summary" });

  const status = await manager.bpDebugStatus({ detail: "diagnostic" });
  const summary = (status.sessions as AnyRecord[])[0];

  assert.equal(summary?.sessionId, fixture.record.sessionId);
  assert.equal(summary?.providerKind, "dap");
  assert.equal(summary?.ideSessionId, undefined);
});

test("disconnect cannot clean a live registered IDE client or its project breakpoints", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);
  let disconnects = 0;
  let disposals = 0;
  provider.disconnect = async () => { disconnects += 1; return {}; };
  (provider as any).disposeRuntimeEvents = () => { disposals += 1; };
  manager.breakpoints.addProject({
    id: "live-client-project-breakpoint",
    workspaceRoot: provider.workspaceRoot,
    clientId: provider.ideClientId,
    ide: "idea",
    ideSessionId: provider.ideSessionId,
    file: `${provider.workspaceRoot}/live-client.py`,
    line: 7
  });

  bridge.emit("disconnect", { clientId: provider.ideClientId });
  await awaitLifecycleCleanup();

  assert.equal(manager.sessions.maybeGet(record.sessionId), record);
  assert.equal(record.state, "paused");
  assert.equal(disconnects, 0);
  assert.equal(disposals, 0);
  assert.equal(bridge.traffic, 0);
  assert.deepEqual(
    manager.breakpoints.listProject({ clientId: provider.ideClientId }).map((breakpoint) => breakpoint.id),
    ["live-client-project-breakpoint"]
  );
});

test("bridge disconnect removes only the structurally associated IDE record without traffic", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const stale = addCustomProviderWithIdeMirrors(manager, { sessionId: "disconnect-custom-mirror" });
  manager.breakpoints.addProject({
    id: "disconnected-client-project-breakpoint",
    workspaceRoot: provider.workspaceRoot,
    clientId: provider.ideClientId,
    ide: "idea",
    ideSessionId: provider.ideSessionId,
    file: `${provider.workspaceRoot}/disconnected-client.py`,
    line: 9
  });
  bridge.registry.remove("ide-client-live");

  bridge.emit("disconnect", { clientId: "ide-client-live" });
  await awaitLifecycleCleanup();

  assert.equal(manager.sessions.maybeGet(provider.sessionId), undefined);
  assert.equal(manager.sessions.maybeGet(stale.record.sessionId), stale.record);
  assert.equal(bridge.traffic, 0);
  assert.equal(stale.traffic(), 0);
  assert.deepEqual(manager.breakpoints.listProject({ clientId: "ide-client-live" }), []);
});

test("implicit selection with only association-invalid records fails safely before traffic", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  provider.ideClientId = "provider-client-corrupt";
  provider.ideSessionId = "provider-session-corrupt";

  await assert.rejects(
    manager.bpDebugEval({ expression: "x" }),
    (error: Error & { code?: string; details?: AnyRecord }) => {
      assert.equal(error.code, ErrorCodes.TOOL_FAILED);
      assert.equal(JSON.stringify(error.details).includes("ide-session-live"), false);
      return true;
    }
  );
  assert.equal(bridge.traffic, 0);
});

test("malformed IDE lifecycle and disconnect envelopes are harmless no-ops", () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);

  for (const payload of [null, undefined, {}, { clientId: "ide-client-live" }, { message: null }]) {
    assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_SESSION_RESUMED, payload));
    assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_SESSION_TERMINATED, payload));
  }
  for (const payload of [null, undefined, {}, { clientId: "" }, { clientId: " \t " }, { message: null }]) {
    assert.doesNotThrow(() => bridge.emit("disconnect", payload));
  }

  assert.equal(record.state, "paused");
  assert.equal(manager.sessions.maybeGet(record.sessionId), record);
  assert.equal(bridge.traffic, 0);
});

test("accessor-backed and proxy IDE envelopes are harmless no-ops", () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);
  let disposals = 0;
  (provider as any).disposeRuntimeEvents = () => { disposals += 1; };
  manager.breakpoints.addProject({
    id: "malformed-envelope-project-breakpoint",
    workspaceRoot: provider.workspaceRoot,
    clientId: provider.ideClientId,
    ide: "idea",
    ideSessionId: provider.ideSessionId,
    file: `${provider.workspaceRoot}/malformed-envelope.py`,
    line: 11
  });
  const outerMessageAccessor = {};
  Object.defineProperty(outerMessageAccessor, "message", {
    enumerable: true,
    get() { throw new Error("outer message getter must not run"); }
  });
  const outerClientAccessor = {
    message: { type: IdeMessageTypes.IDE_SESSION_TERMINATED, ideSessionId: provider.ideSessionId }
  };
  Object.defineProperty(outerClientAccessor, "clientId", {
    enumerable: true,
    get() { throw new Error("outer client getter must not run"); }
  });
  const nestedMessage = { type: IdeMessageTypes.IDE_SESSION_TERMINATED } as AnyRecord;
  Object.defineProperty(nestedMessage, "ideSessionId", {
    enumerable: true,
    get() { throw new Error("nested session getter must not run"); }
  });
  const nestedAccessor = { clientId: provider.ideClientId, message: nestedMessage };
  const throwingProxy = new Proxy({}, {
    get() { throw new Error("proxy getter must not run"); },
    ownKeys() { throw new Error("proxy keys must fail closed"); }
  });

  for (const payload of [outerMessageAccessor, outerClientAccessor, nestedAccessor, throwingProxy]) {
    assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_SESSION_TERMINATED, payload));
  }
  for (const payload of [outerClientAccessor, throwingProxy]) {
    assert.doesNotThrow(() => bridge.emit("disconnect", payload));
  }

  assert.equal(manager.sessions.maybeGet(record.sessionId), record);
  assert.equal(record.state, "paused");
  assert.equal(disposals, 0);
  assert.equal(bridge.traffic, 0);
  assert.deepEqual(
    manager.breakpoints.listProject({ clientId: provider.ideClientId }).map((breakpoint) => breakpoint.id),
    ["malformed-envelope-project-breakpoint"]
  );
});

test("revoked outer proxies are harmless for every IDE lifecycle event", () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);
  let disposals = 0;
  (provider as any).disposeRuntimeEvents = () => { disposals += 1; };
  manager.breakpoints.addProject({
    id: "revoked-lifecycle-project-breakpoint",
    workspaceRoot: provider.workspaceRoot,
    clientId: provider.ideClientId,
    ide: "idea",
    ideSessionId: provider.ideSessionId,
    file: `${provider.workspaceRoot}/revoked-lifecycle.py`,
    line: 13
  });
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();

  for (const type of [
    IdeMessageTypes.IDE_SESSION_PAUSED,
    IdeMessageTypes.IDE_BREAKPOINT_HIT,
    IdeMessageTypes.IDE_SESSION_STOPPED,
    IdeMessageTypes.IDE_SESSION_RESUMED,
    IdeMessageTypes.IDE_SESSION_TERMINATED
  ]) {
    assert.doesNotThrow(() => bridge.emit(type, revocable.proxy));
  }

  assert.equal(manager.sessions.maybeGet(record.sessionId), record);
  assert.equal(record.state, "paused");
  assert.equal(disposals, 0);
  assert.equal(bridge.traffic, 0);
  assert.deepEqual(
    manager.breakpoints.listProject({ clientId: provider.ideClientId }).map((breakpoint) => breakpoint.id),
    ["revoked-lifecycle-project-breakpoint"]
  );
});

test("a revoked nested IDE message proxy is a harmless lifecycle no-op", () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();

  assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_SESSION_TERMINATED, {
    clientId: provider.ideClientId,
    message: revocable.proxy
  }));

  assert.equal(manager.sessions.maybeGet(record.sessionId), record);
  assert.equal(record.state, "paused");
  assert.equal(bridge.traffic, 0);
});

test("a revoked outer disconnect proxy cannot clear project breakpoints or clean IDE state", () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);
  let disposals = 0;
  (provider as any).disposeRuntimeEvents = () => { disposals += 1; };
  manager.breakpoints.addProject({
    id: "revoked-disconnect-project-breakpoint",
    workspaceRoot: provider.workspaceRoot,
    clientId: provider.ideClientId,
    ide: "idea",
    ideSessionId: provider.ideSessionId,
    file: `${provider.workspaceRoot}/revoked-disconnect.py`,
    line: 17
  });
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();

  assert.doesNotThrow(() => bridge.emit("disconnect", revocable.proxy));

  assert.equal(manager.sessions.maybeGet(record.sessionId), record);
  assert.equal(record.state, "paused");
  assert.equal(disposals, 0);
  assert.equal(bridge.traffic, 0);
  assert.deepEqual(
    manager.breakpoints.listProject({ clientId: provider.ideClientId }).map((breakpoint) => breakpoint.id),
    ["revoked-disconnect-project-breakpoint"]
  );
});

test("a revoked nested IDE command error is ignored until an ordinary correlated response arrives", async () => {
  const { policy, bridge, manager } = pendingIdeResponseFixture();
  const pending = manager.bpDebugStart({ mode: "ide", runConfigName: "Snapshot App", timeout: 1_000 });
  const outbound = bridge.sent.at(-1);
  assert.ok(outbound);
  const requestId = outbound.message.requestId;
  assert.equal(typeof requestId, "string");
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });

  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  try {
    assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_COMMAND_RESULT, {
      clientId: outbound.clientId,
      message: {
        type: IdeMessageTypes.IDE_COMMAND_RESULT,
        requestId,
        error: revocable.proxy
      }
    }));
    await flushBridgeListeners();
    assert.equal(settled, false);
    assert.equal(manager.sessions.sessions.size, 0);
  } finally {
    bridge.registry.upsertSession(outbound.clientId, {
      type: IdeMessageTypes.IDE_SESSION_STARTED,
      ideSessionId: "deep-safe-start-session",
      workspaceRoot: policy.workspace.root,
      active: true
    }, "paused");
    bridge.emit(IdeMessageTypes.IDE_COMMAND_RESULT, {
      clientId: outbound.clientId,
      message: {
        type: IdeMessageTypes.IDE_COMMAND_RESULT,
        requestId,
        ideSessionId: "deep-safe-start-session"
      }
    });
  }

  const started = await pending;
  assert.equal(started.ideSessionId, "deep-safe-start-session");
  assert.equal(manager.sessions.sessions.size, 1);
});

test("a revoked scalar IDE session id is ignored before start-wait registry lookup", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);
  const sent: AnyRecord[] = [];
  (bridge as any).sendToClient = (_clientId: string, message: AnyRecord): boolean => {
    sent.push(message);
    return true;
  };
  const pending = manager.bpDebugStart({ mode: "ide", runConfigName: "Snapshot App", timeout: 1_000 });
  const outbound = sent.at(-1);
  assert.ok(outbound);
  const requestId = outbound.requestId;
  assert.equal(typeof requestId, "string");
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });

  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  try {
    assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_COMMAND_RESULT, {
      clientId: provider.ideClientId,
      message: {
        type: IdeMessageTypes.IDE_COMMAND_RESULT,
        requestId,
        ideSessionId: revocable.proxy
      }
    }));
    await flushBridgeListeners();
    assert.equal(settled, false);
    assert.equal(manager.sessions.maybeGet(record.sessionId), record);
    assert.equal(record.state, "paused");
  } finally {
    bridge.emit(IdeMessageTypes.IDE_COMMAND_RESULT, {
      clientId: provider.ideClientId,
      message: {
        type: IdeMessageTypes.IDE_COMMAND_RESULT,
        requestId,
        ideSessionId: provider.ideSessionId
      }
    });
  }

  const started = await pending;
  assert.equal(started.sessionId, record.sessionId);
  assert.equal(record.state, "paused");
});

test("a revoked nested project breakpoint response cannot throw, mutate, or settle", async () => {
  const { policy, bridge, manager } = pendingIdeResponseFixture();
  const pending = manager.bpDebugSetBreakpoint({
    clientId: "ide-client-pending",
    filePath: `${policy.workspace.root}/src/sessions/DebugSessionManager.ts`,
    line: 31
  });
  const outbound = bridge.sent.at(-1);
  assert.ok(outbound);
  const requestId = outbound.message.requestId;
  const breakpoint = outbound.message.breakpoint as AnyRecord;
  assert.equal(typeof requestId, "string");
  assert.equal(typeof breakpoint?.id, "string");
  const before = manager.breakpoints.findProject(String(breakpoint.id));
  assert.ok(before);
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });

  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  try {
    assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_BREAKPOINT_ADDED, {
      clientId: outbound.clientId,
      message: {
        type: IdeMessageTypes.IDE_BREAKPOINT_ADDED,
        requestId: "unrelated-request",
        breakpoint: revocable.proxy
      }
    }));
    await flushBridgeListeners();
    assert.equal(settled, false);
    const afterRejected = manager.breakpoints.findProject(String(breakpoint.id));
    assert.equal(afterRejected?.line, before.line);
    assert.equal(afterRejected?.verified, before.verified);
  } finally {
    bridge.emit(IdeMessageTypes.IDE_BREAKPOINT_ADDED, {
      clientId: outbound.clientId,
      message: {
        type: IdeMessageTypes.IDE_BREAKPOINT_ADDED,
        requestId,
        breakpointId: breakpoint.id,
        breakpoint: {
          id: breakpoint.id,
          verified: true,
          line: 31
        }
      }
    });
  }

  const created = await pending;
  assert.equal(created.verified, true);
  assert.equal(manager.breakpoints.findProject(String(breakpoint.id))?.verified, true);
});

test("cyclic and bounded bridge payloads are ignored while ordinary nested JSON remains usable", async () => {
  const { bridge, manager } = pendingIdeResponseFixture();
  const pending = [
    manager.bpDebugRunConfigurations({ clientId: "ide-client-pending" }),
    manager.bpDebugRunConfigurations({ clientId: "ide-client-pending" }),
    manager.bpDebugRunConfigurations({ clientId: "ide-client-pending" }),
    manager.bpDebugRunConfigurations({ clientId: "ide-client-pending" })
  ];
  const outbound = bridge.sent.slice(-4);
  assert.equal(outbound.length, 4);
  const requestIds = outbound.map((request) => request.message.requestId);
  assert.ok(requestIds.every((requestId) => typeof requestId === "string"));
  const settled = [false, false, false, false];
  for (const [index, request] of pending.entries()) {
    void request.then(() => { settled[index] = true; }, () => { settled[index] = true; });
  }

  const cyclic: AnyRecord = {};
  cyclic.self = cyclic;
  let tooDeep: AnyRecord = { leaf: true };
  for (let index = 0; index < 16; index += 1) tooDeep = { child: tooDeep };
  const tooManyKeys = Object.fromEntries(
    Array.from({ length: 192 }, (_, index) => [`key-${index}`, index])
  ) as AnyRecord;
  let wideProxyDescriptorReads = 0;
  const wideProxy = new Proxy({}, {
    ownKeys: () => Array.from({ length: 1024 }, (_, index) => `key-${index}`),
    getOwnPropertyDescriptor: (_target, key) => {
      wideProxyDescriptorReads += 1;
      return typeof key === "string"
        ? { value: key, enumerable: true, configurable: true, writable: true }
        : undefined;
    }
  });

  const hostilePayloads = [cyclic, tooDeep, tooManyKeys, wideProxy];
  try {
    for (const [index, result] of hostilePayloads.entries()) {
      assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_RUN_CONFIGURATIONS_SNAPSHOT, {
        clientId: outbound[index]!.clientId,
        message: {
          type: IdeMessageTypes.IDE_RUN_CONFIGURATIONS_SNAPSHOT,
          requestId: requestIds[index],
          result
        }
      }));
    }
    await flushBridgeListeners();
    assert.deepEqual(settled, [false, false, false, false]);
    assert.equal(wideProxyDescriptorReads, 0);
  } finally {
    for (const [index, request] of outbound.entries()) {
      bridge.emit(IdeMessageTypes.IDE_RUN_CONFIGURATIONS_SNAPSHOT, {
        clientId: request.clientId,
        message: {
          type: IdeMessageTypes.IDE_RUN_CONFIGURATIONS_SNAPSHOT,
          requestId: requestIds[index],
          result: {
            configurations: [{
              name: `Nested configuration ${index}`,
              options: { modes: ["safe", { retry: false }] }
            }],
            runPoints: [{ line: 9 + index, metadata: { tags: ["nested", "json"] } }]
          }
        }
      });
    }
  }

  const responses = await Promise.all(pending);
  for (const [index, response] of responses.entries()) {
    const configuration = (response.configurations as AnyRecord[])[0];
    assert.equal(configuration?.name, `Nested configuration ${index}`);
    const options = configuration?.options as AnyRecord;
    const runPoint = (response.runPoints as AnyRecord[])[0];
    assert.ok(runPoint);
    assert.equal(Object.getPrototypeOf(options), Object.prototype);
    assert.equal((options.modes as AnyRecord[])[1]?.retry, false);
    assert.equal(Object.getPrototypeOf(runPoint), Object.prototype);
    assert.equal(Object.getPrototypeOf(runPoint.metadata), Object.prototype);
    assert.equal((runPoint.metadata as AnyRecord).tags?.[1], "json");
  }
});

test("plain object and array IDE start IDs are ignored before registry lookup", async () => {
  const { policy, bridge, manager } = pendingIdeResponseFixture();
  const originalFindSession = bridge.registry.findSession;
  let registryLookups = 0;
  (bridge.registry as any).findSession = (...args: unknown[]) => {
    registryLookups += 1;
    return originalFindSession.call(bridge.registry, ...args as [string | undefined, string | undefined]);
  };
  const pending = manager.bpDebugStart({ mode: "ide", runConfigName: "Scalar App", timeout: 1_000 });
  const outbound = bridge.sent.at(-1);
  assert.ok(outbound);
  const requestId = outbound.message.requestId;
  assert.equal(typeof requestId, "string");
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });

  try {
    for (const ideSessionId of [{}, []]) {
      assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_COMMAND_RESULT, {
        clientId: outbound.clientId,
        message: {
          type: IdeMessageTypes.IDE_COMMAND_RESULT,
          requestId,
          ideSessionId
        }
      }));
      await flushBridgeListeners();
      assert.equal(registryLookups, 0);
      assert.equal(settled, false);
    }
  } finally {
    (bridge.registry as any).findSession = originalFindSession;
    bridge.registry.upsertSession(outbound.clientId, {
      type: IdeMessageTypes.IDE_SESSION_STARTED,
      ideSessionId: "scalar-safe-start-session",
      workspaceRoot: policy.workspace.root,
      active: true
    }, "paused");
    bridge.emit(IdeMessageTypes.IDE_COMMAND_RESULT, {
      clientId: outbound.clientId,
      message: {
        type: IdeMessageTypes.IDE_COMMAND_RESULT,
        requestId,
        ideSessionId: "scalar-safe-start-session"
      }
    });
  }

  const started = await pending;
  assert.equal(started.ideSessionId, "scalar-safe-start-session");
});

test("IDE start errors safely fall back for nested scalars and preserve normal strings", async () => {
  const { bridge, manager } = pendingIdeResponseFixture();
  const malformed = manager.bpDebugStart({ mode: "ide", runConfigName: "Scalar App", timeout: 1_000 });
  const malformedRequest = bridge.sent.at(-1);
  assert.ok(malformedRequest);
  const malformedRequestId = malformedRequest.message.requestId;

  assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_COMMAND_RESULT, {
    clientId: malformedRequest.clientId,
    message: {
      type: IdeMessageTypes.IDE_COMMAND_RESULT,
      requestId: malformedRequestId,
      error: { code: {}, message: [] }
    }
  }));
  await assert.rejects(malformed, (error: unknown) => {
    assert.ok(error instanceof BreakPilotError);
    return error.code === ErrorCodes.TOOL_FAILED && error.message === "IDE debug launch failed.";
  });

  const normal = manager.bpDebugStart({ mode: "ide", runConfigName: "Scalar App", timeout: 1_000 });
  const normalRequest = bridge.sent.at(-1);
  assert.ok(normalRequest);
  const normalRequestId = normalRequest.message.requestId;
  assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_COMMAND_RESULT, {
    clientId: normalRequest.clientId,
    message: {
      type: IdeMessageTypes.IDE_COMMAND_RESULT,
      requestId: normalRequestId,
      error: { code: "IDE_START_REJECTED", message: "IDE rejected the start request." }
    }
  }));
  await assert.rejects(normal, (error: unknown) => {
    assert.ok(error instanceof BreakPilotError);
    return error.code === "IDE_START_REJECTED" && error.message === "IDE rejected the start request.";
  });
});

test("run-configuration errors safely fall back for nested scalars and preserve normal strings", async () => {
  const { bridge, manager } = pendingIdeResponseFixture();
  const malformed = manager.bpDebugRunConfigurations({ clientId: "ide-client-pending" });
  const malformedRequest = bridge.sent.at(-1);
  assert.ok(malformedRequest);
  assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_RUN_CONFIGURATIONS_SNAPSHOT, {
    clientId: malformedRequest.clientId,
    message: {
      type: IdeMessageTypes.IDE_RUN_CONFIGURATIONS_SNAPSHOT,
      requestId: malformedRequest.message.requestId,
      error: { code: [], message: {} }
    }
  }));
  await assert.rejects(malformed, (error: unknown) => {
    assert.ok(error instanceof BreakPilotError);
    return error.code === ErrorCodes.TOOL_FAILED && error.message === "IDE failed to list run configurations.";
  });

  const normal = manager.bpDebugRunConfigurations({ clientId: "ide-client-pending" });
  const normalRequest = bridge.sent.at(-1);
  assert.ok(normalRequest);
  assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_RUN_CONFIGURATIONS_SNAPSHOT, {
    clientId: normalRequest.clientId,
    message: {
      type: IdeMessageTypes.IDE_RUN_CONFIGURATIONS_SNAPSHOT,
      requestId: normalRequest.message.requestId,
      error: { code: "IDE_RUN_CONFIGS_REJECTED", message: "IDE rejected run configurations." }
    }
  }));
  await assert.rejects(normal, (error: unknown) => {
    assert.ok(error instanceof BreakPilotError);
    return error.code === "IDE_RUN_CONFIGS_REJECTED" && error.message === "IDE rejected run configurations.";
  });
});

test("project breakpoint errors safely fall back for nested scalars and preserve normal strings", async () => {
  const { policy, bridge, manager } = pendingIdeResponseFixture();
  const args = {
    clientId: "ide-client-pending",
    filePath: `${policy.workspace.root}/src/sessions/DebugSessionManager.ts`,
    line: 43
  };
  const malformed = manager.bpDebugSetBreakpoint(args);
  const malformedRequest = bridge.sent.at(-1);
  assert.ok(malformedRequest);
  assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_BREAKPOINT_ADDED, {
    clientId: malformedRequest.clientId,
    message: {
      type: IdeMessageTypes.IDE_BREAKPOINT_ADDED,
      requestId: malformedRequest.message.requestId,
      error: { code: {}, message: [] }
    }
  }));
  await assert.rejects(malformed, (error: unknown) => {
    assert.ok(error instanceof BreakPilotError);
    return error.code === ErrorCodes.BREAKPOINT_NOT_VERIFIED && error.message === "IDE failed to set breakpoint.";
  });
  assert.deepEqual(manager.breakpoints.listProject({ clientId: "ide-client-pending" }), []);

  const normal = manager.bpDebugSetBreakpoint({ ...args, line: 44 });
  const normalRequest = bridge.sent.at(-1);
  assert.ok(normalRequest);
  assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_BREAKPOINT_ADDED, {
    clientId: normalRequest.clientId,
    message: {
      type: IdeMessageTypes.IDE_BREAKPOINT_ADDED,
      requestId: normalRequest.message.requestId,
      error: { code: "IDE_BREAKPOINT_REJECTED", message: "IDE rejected the breakpoint." }
    }
  }));
  await assert.rejects(normal, (error: unknown) => {
    assert.ok(error instanceof BreakPilotError);
    return error.code === "IDE_BREAKPOINT_REJECTED" && error.message === "IDE rejected the breakpoint.";
  });
  assert.deepEqual(manager.breakpoints.listProject({ clientId: "ide-client-pending" }), []);
});

test("decoded lifecycle events ignore non-string IDE session IDs before identity matching", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);

  for (const ideSessionId of [{}, []]) {
    assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_SESSION_TERMINATED, {
      clientId: provider.ideClientId,
      message: {
        type: IdeMessageTypes.IDE_SESSION_TERMINATED,
        ideSessionId
      }
    }));
  }
  await awaitLifecycleCleanup();

  assert.equal(manager.sessions.maybeGet(record.sessionId), record);
  assert.equal(record.state, "paused");
});

test("IDE breakpoint snapshots normalize malformed IDs, skip invalid entries, and retain valid identities", async () => {
  const { policy, bridge, manager } = pendingIdeResponseFixture();
  manager.breakpoints.addProject({
    id: "unrelated-local-project-breakpoint",
    workspaceRoot: policy.workspace.root,
    clientId: "ide-client-pending",
    ide: "idea",
    file: `${policy.workspace.root}/unrelated-local.ts`,
    line: 7
  });
  const pending = manager.bpDebugListBreakpoints({ clientId: "ide-client-pending" });
  const outbound = bridge.sent.at(-1);
  assert.ok(outbound);
  assert.equal(outbound.message.type, IdeMessageTypes.AGENT_LIST_BREAKPOINTS);

  assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT, {
    clientId: outbound.clientId,
    message: {
      type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
      requestId: outbound.message.requestId,
      result: {
        breakpoints: [
          { id: {}, file: `${policy.workspace.root}/unsafe-id.ts`, line: 10 },
          null,
          [],
          "not-a-breakpoint",
          {
            id: {},
            breakpointId: [],
            ideBreakpointId: {},
            file: `${policy.workspace.root}/all-unsafe-ids.ts`,
            line: 14
          },
          {
            id: "verbatim-breakpoint-id",
            ideBreakpointId: "verbatim-ide-breakpoint-id",
            file: `${policy.workspace.root}/valid-id.ts`,
            line: 18
          },
          {
            ideBreakpointId: "ide-only-breakpoint-id",
            file: `${policy.workspace.root}/ide-only-id.ts`,
            line: 22
          }
        ]
      }
    }
  }));

  const response = await pending;
  assert.deepEqual(
    (response.breakpoints as AnyRecord[]).map((breakpoint) => breakpoint.breakpointId),
    [
      "ide-client-pending:ide_bp_0",
      "ide-client-pending:ide_bp_4",
      "verbatim-breakpoint-id",
      "ide-only-breakpoint-id"
    ]
  );
  assert.deepEqual(
    manager.breakpoints.listProject({ clientId: "ide-client-pending" }).map((breakpoint) => breakpoint.id),
    ["unrelated-local-project-breakpoint"]
  );
});

test("project breakpoint acknowledgements retain only scalar adapter breakpoint IDs", async () => {
  const { policy, bridge, manager } = pendingIdeResponseFixture();
  const cases: Array<{ adapterBreakpointId: unknown; expected: number | string | undefined }> = [
    { adapterBreakpointId: {}, expected: undefined },
    { adapterBreakpointId: [], expected: undefined },
    { adapterBreakpointId: "", expected: undefined },
    { adapterBreakpointId: 42, expected: 42 },
    { adapterBreakpointId: "adapter-breakpoint-id", expected: "adapter-breakpoint-id" }
  ];

  for (const [index, { adapterBreakpointId, expected }] of cases.entries()) {
    const pending = manager.bpDebugSetBreakpoint({
      clientId: "ide-client-pending",
      filePath: `${policy.workspace.root}/src/sessions/DebugSessionManager.ts`,
      line: 60 + index
    });
    const outbound = bridge.sent.at(-1);
    assert.ok(outbound);
    const breakpoint = outbound.message.breakpoint as AnyRecord;
    assert.equal(typeof breakpoint.id, "string");
    assert.doesNotThrow(() => bridge.emit(IdeMessageTypes.IDE_BREAKPOINT_ADDED, {
      clientId: outbound.clientId,
      message: {
        type: IdeMessageTypes.IDE_BREAKPOINT_ADDED,
        requestId: outbound.message.requestId,
        breakpoint: {
          id: breakpoint.id,
          verified: true,
          adapterBreakpointId
        }
      }
    }));
    await pending;
    assert.equal(
      manager.breakpoints.findProject(String(breakpoint.id))?.adapterBreakpointId,
      expected
    );
  }
});

test("adopted IDE session breakpoint snapshots normalize hostile entries and retain valid IDs", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const sent: AnyRecord[] = [];
  (bridge as any).sendToClient = (_clientId: string, message: AnyRecord) => { sent.push(message); return true; };
  const pending = manager.bpDebugListBreakpoints({ sessionId: provider.sessionId });
  const outbound = sent.at(-1)!;
  bridge.emit("message", {
    clientId: provider.ideClientId,
    message: {
      type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
      requestId: outbound.requestId,
      breakpoints: [
        null, [], "bad",
        { id: {}, breakpointId: [], ideBreakpointId: {}, file: "/workspace/Fallback.java", line: 8 },
        { id: "provider-valid-id", ideBreakpointId: "provider-valid-ide-id", file: "/workspace/Valid.java", line: 9 }
      ]
    }
  });
  const response = await pending;
  assert.deepEqual((response.breakpoints as AnyRecord[]).map((item) => item.breakpointId), ["ide_bp_3", "provider-valid-id"]);
});

test("adopted IDE provider ignores an accessor bridge envelope before a valid breakpoint response", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const sent: AnyRecord[] = [];
  (bridge as any).sendToClient = (_clientId: string, message: AnyRecord) => { sent.push(message); return true; };
  const pending = manager.bpDebugListBreakpoints({ sessionId: provider.sessionId });
  const outbound = sent.at(-1)!;
  const hostile: AnyRecord = { clientId: provider.ideClientId };
  Object.defineProperty(hostile, "message", {
    enumerable: true,
    get: () => { throw new Error("provider bridge envelope getter"); }
  });

  assert.doesNotThrow(() => bridge.emit("message", hostile));
  const hostileMessage: AnyRecord = {
    type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
    requestId: outbound.requestId
  };
  Object.defineProperty(hostileMessage, "result", {
    enumerable: true,
    get: () => { throw new Error("provider nested result getter"); }
  });
  assert.doesNotThrow(() => bridge.emit("message", {
    clientId: provider.ideClientId,
    message: hostileMessage
  }));
  bridge.emit("message", {
    clientId: provider.ideClientId,
    message: {
      type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
      requestId: outbound.requestId,
      breakpoints: [{ id: "later-valid-breakpoint", file: "/workspace/Later.java", line: 12 }]
    }
  });

  const response = await pending;
  assert.deepEqual((response.breakpoints as AnyRecord[]).map((item) => item.breakpointId), ["later-valid-breakpoint"]);
});

test("adopted IDE session set breakpoint never returns NaN from hostile adapter IDs", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const sent: AnyRecord[] = [];
  (bridge as any).sendToClient = (_clientId: string, message: AnyRecord) => { sent.push(message); return true; };
  for (const [index, adapterBreakpointId] of [{}, [], "", "not-a-number", 37].entries()) {
    const breakpoint = {
      id: `provider-set-${index}`,
      sessionId: provider.sessionId,
      file: `${provider.workspaceRoot}/Set.java`,
      line: 20 + index,
      owner: "agent",
      verified: true,
      createdAt: new Date(0).toISOString()
    };
    const pending = provider.setBreakpoints(breakpoint.file, [breakpoint]);
    const outbound = sent.at(-1)!;
    bridge.emit("message", { clientId: provider.ideClientId, message: {
      type: IdeMessageTypes.IDE_BREAKPOINT_ADDED,
      requestId: outbound.requestId,
      breakpointId: breakpoint.id,
      breakpoint: { id: breakpoint.id, adapterBreakpointId, verified: true, line: 20 + index }
    }});
    const [response] = await pending;
    assert.equal(Number.isNaN(response?.id ?? 0), false);
  }
});

test("adopted IDE session requireVerified rejects non-boolean verified acknowledgements", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const sent: AnyRecord[] = [];
  (bridge as any).sendToClient = (_clientId: string, message: AnyRecord) => { sent.push(message); return true; };
  const pending = manager.bpDebugSetBreakpoint({
    sessionId: provider.sessionId,
    filePath: `${provider.workspaceRoot}/Verified.java`,
    line: 27,
    requireVerified: true
  });
  const outbound = sent.at(-1)!;
  const breakpoint = outbound.breakpoint as AnyRecord;
  bridge.emit("message", {
    clientId: provider.ideClientId,
    message: {
      type: IdeMessageTypes.IDE_BREAKPOINT_ADDED,
      requestId: outbound.requestId,
      breakpointId: breakpoint.id,
      breakpoint: { id: breakpoint.id, verified: "false", line: 27 }
    }
  });

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof BreakPilotError);
    return error.code === ErrorCodes.BREAKPOINT_NOT_VERIFIED;
  });
  assert.equal(
    manager.breakpoints.list(provider.sessionId).find((stored) => stored.id === breakpoint.id)?.verified,
    false
  );
});

test("project set breakpoint rejects blank IDE IDs and retains nonblank IDs", async () => {
  const { policy, bridge, manager } = pendingIdeResponseFixture();
  for (const [index, ideBreakpointId] of ["", "nonblank-ide-breakpoint"].entries()) {
    const pending = manager.bpDebugSetBreakpoint({ clientId: "ide-client-pending", filePath: `${policy.workspace.root}/src/sessions/DebugSessionManager.ts`, line: 90 + index });
    const outbound = bridge.sent.at(-1)!;
    const breakpoint = outbound.message.breakpoint as AnyRecord;
    bridge.emit(IdeMessageTypes.IDE_BREAKPOINT_ADDED, { clientId: outbound.clientId, message: {
      type: IdeMessageTypes.IDE_BREAKPOINT_ADDED, requestId: outbound.message.requestId,
      breakpoint: { id: breakpoint.id, ideBreakpointId, verified: true }
    }});
    await pending;
    assert.equal(manager.breakpoints.findProject(String(breakpoint.id))?.ideBreakpointId, ideBreakpointId || undefined);
  }
});

test("project requireVerified rejects non-boolean verified acknowledgements", async () => {
  const { policy, bridge, manager } = pendingIdeResponseFixture();
  const pending = manager.bpDebugSetBreakpoint({
    clientId: "ide-client-pending",
    filePath: `${policy.workspace.root}/src/sessions/DebugSessionManager.ts`,
    line: 96,
    requireVerified: true
  });
  const outbound = bridge.sent.at(-1)!;
  const breakpoint = outbound.message.breakpoint as AnyRecord;
  bridge.emit(IdeMessageTypes.IDE_BREAKPOINT_ADDED, {
    clientId: outbound.clientId,
    message: {
      type: IdeMessageTypes.IDE_BREAKPOINT_ADDED,
      requestId: outbound.message.requestId,
      breakpoint: { id: breakpoint.id, verified: "false", line: 96 }
    }
  });

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof BreakPilotError);
    return error.code === ErrorCodes.BREAKPOINT_NOT_VERIFIED;
  });
  assert.equal(manager.breakpoints.findProject(String(breakpoint.id)), undefined);
});

test("adopted IDE provider uses safe fallback text for malformed bridge errors", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const sent: AnyRecord[] = [];
  (bridge as any).sendToClient = (_clientId: string, message: AnyRecord) => { sent.push(message); return true; };
  const pending = manager.bpDebugListBreakpoints({ sessionId: provider.sessionId });
  const outbound = sent.at(-1)!;
  bridge.emit("message", {
    clientId: provider.ideClientId,
    message: {
      type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
      requestId: outbound.requestId,
      error: { code: {}, message: [] }
    }
  });

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof BreakPilotError);
    return error.code === ErrorCodes.TOOL_FAILED && error.message === "IDE bridge request failed.";
  });
});

test("adopted IDE breakpoint snapshots never truthify malformed boolean fields", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const sent: AnyRecord[] = [];
  (bridge as any).sendToClient = (_clientId: string, message: AnyRecord) => { sent.push(message); return true; };
  const pending = manager.bpDebugListBreakpoints({ sessionId: provider.sessionId });
  const outbound = sent.at(-1)!;
  bridge.emit("message", {
    clientId: provider.ideClientId,
    message: {
      type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
      requestId: outbound.requestId,
      breakpoints: [{
        id: "strict-boolean-breakpoint",
        file: "/workspace/StrictBoolean.java",
        line: 17,
        enabled: "false",
        temporary: {},
        isLogMessage: [],
        isLogStack: "true",
        verified: "false"
      }]
    }
  });

  const response = await pending;
  const [breakpoint] = response.breakpoints as AnyRecord[];
  assert.ok(breakpoint);
  assert.equal(breakpoint.enabled, false);
  assert.equal(breakpoint.temporary, false);
  assert.equal(breakpoint.isLogMessage, false);
  assert.equal(breakpoint.isLogStack, false);
  assert.equal(breakpoint.verified, false);
});

function duplicateIdeSessionBridge() {
  const policy = loadPolicy("breakpilot.yaml");
  const bridge = new AssociationFakeIdeBridge(policy.workspace.root);
  bridge.registry.add({ writable: true } as any, {
    clientId: "ide-client-second",
    ide: "vscode",
    workspaceRoot: policy.workspace.root,
    capabilities: { variableSnapshot: true }
  });
  bridge.registry.upsertSession("ide-client-second", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "ide-session-live",
    workspaceRoot: policy.workspace.root,
    state: "paused",
    active: true
  }, "paused");
  return { policy, bridge };
}

test("an explicit IDE session id shared by two clients is ambiguous without a client id", async () => {
  const { policy, bridge } = duplicateIdeSessionBridge();
  const manager = new DebugSessionManager({ policy, ideBridge: bridge as any });

  await assert.rejects(
    manager.bpDebugStart({ mode: "ide", ideSessionId: "ide-session-live" }),
    (error: Error & { code?: string; details?: AnyRecord }) => {
      assert.equal(error.code, ErrorCodes.IDE_SESSION_AMBIGUOUS);
      assert.deepEqual(
        (error.details?.sessions as AnyRecord[]).map((session) => session.clientId).sort(),
        ["ide-client-live", "ide-client-second"].sort()
      );
      return true;
    }
  );
  assert.equal(manager.sessions.sessions.size, 0);
  assert.equal(bridge.traffic, 0);
});

test("an explicit client id selects only its exact duplicate-named IDE session", async () => {
  const { policy, bridge } = duplicateIdeSessionBridge();
  const manager = new DebugSessionManager({ policy, ideBridge: bridge as any });

  const started = await manager.bpDebugStart({
    mode: "ide",
    clientId: "ide-client-second",
    ideSessionId: "ide-session-live"
  });
  const record = manager.sessions.get(String(started.sessionId));

  assert.ok(record.provider instanceof IdeRuntimeProvider);
  assert.equal(record.provider.ideClientId, "ide-client-second");
  assert.equal(record.provider.ideSessionId, "ide-session-live");
  assert.equal(manager.sessions.sessions.size, 1);
  assert.equal(bridge.traffic, 0);
});

test("IDE debug start correlates session identity from the trusted bridge envelope", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  class StartBridge extends EventEmitter {
    registry = new IdeClientRegistry();

    constructor() {
      super();
      this.registry.add({ writable: true } as any, {
        clientId: "ide-client-live",
        ide: "idea",
        workspaceRoot: policy.workspace.root,
        capabilities: { variableSnapshot: true }
      });
    }

    sendToClient(clientId: string, message: AnyRecord): boolean {
      if (message.type !== IdeMessageTypes.AGENT_START_DEBUG) return true;
      queueMicrotask(() => {
        this.registry.upsertSession(clientId, {
          type: IdeMessageTypes.IDE_SESSION_STARTED,
          ideSessionId: "trusted-envelope-session",
          workspaceRoot: policy.workspace.root,
          active: true
        }, "paused");
        this.emit(IdeMessageTypes.IDE_SESSION_STARTED, {
          clientId,
          message: {
            type: IdeMessageTypes.IDE_SESSION_STARTED,
            clientId: "spoofed-inner-client",
            ideSessionId: "trusted-envelope-session",
            requestId: message.requestId
          }
        });
      });
      return true;
    }
  }
  const bridge = new StartBridge();
  const manager = new DebugSessionManager({ policy, ideBridge: bridge as any });

  const started = await manager.bpDebugStart({
    mode: "ide",
    runConfigName: "App",
    timeout: 20
  });

  assert.equal(started.startMode, "ide");
  assert.equal(started.ideSessionId, "trusted-envelope-session");
  assert.ok(manager.sessions.get(String(started.sessionId)).provider instanceof IdeRuntimeProvider);
});

test("IDE adoption ignores a corrupted existing record instead of reporting already adopted", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);
  provider.ideClientId = "provider-client-corrupt";
  provider.ideSessionId = "provider-session-corrupt";

  const started = await manager.bpDebugStart({
    mode: "ide",
    clientId: record.ideClientId,
    ideSessionId: record.ideSessionId
  });

  assert.notEqual(started.sessionId, record.sessionId);
  assert.ok(manager.sessions.get(String(started.sessionId)).provider instanceof IdeRuntimeProvider);
  assert.equal(manager.sessions.maybeGet(record.sessionId), record);
  assert.equal(record.provider, provider);
  assert.equal(provider.ideClientId, "provider-client-corrupt");
  assert.equal(provider.ideSessionId, "provider-session-corrupt");
  assert.equal(bridge.traffic, 0);
});

test("breakpoint timeout recovery never borrows a stale DAP mirror", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const sessionId = "active-dap-stale-recovery-mirror";
  const source = `${policy.workspace.root}/recovery.py`;
  let activeThreads = 0;
  let staleThreads = 0;
  let staleStacks = 0;
  const activeDap = Object.create(DapSession.prototype) as DapSession;
  activeDap.sessionId = sessionId;
  activeDap.language = "python";
  activeDap.workspaceRoot = policy.workspace.root;
  activeDap.threadId = 7;
  activeDap.capabilities = {};
  activeDap.onRuntimeEvent = undefined as any;
  activeDap.waitForBreakpoint = async () => {
    throw new BreakPilotError(ErrorCodes.BREAKPOINT_TIMEOUT, "expected timeout");
  };
  activeDap.threads = async () => { activeThreads += 1; return []; };
  const staleDap = Object.create(DapSession.prototype) as DapSession;
  staleDap.sessionId = sessionId;
  staleDap.language = "python";
  staleDap.workspaceRoot = policy.workspace.root;
  staleDap.threadId = 9;
  staleDap.capabilities = {};
  staleDap.threads = async () => { staleThreads += 1; return [{ id: 9 }]; };
  staleDap.stackTrace = async () => {
    staleStacks += 1;
    return {
      threadId: 9,
      stackFrames: [{ id: 90, name: "stale", line: 12, source: { path: source } }],
      totalFrames: 1
    };
  };
  const provider = new DapRuntimeProvider(activeDap);
  const manager = new DebugSessionManager({ policy });
  manager.sessions.add({
    sessionId,
    language: "python",
    workspaceRoot: policy.workspace.root,
    mode: "headless",
    owner: "mcp",
    state: "running",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider,
    dap: staleDap
  });
  manager.breakpoints.add(sessionId, { id: "verified-local", file: source, line: 12 });
  manager.breakpoints.updateVerification(sessionId, source, [{ id: 1, verified: true, line: 12 }]);

  await assert.rejects(
    manager.bpDebugControl({ sessionId, action: "wait", timeout: 1 }),
    (error: Error & { code?: string }) => error.code === ErrorCodes.BREAKPOINT_TIMEOUT
  );
  assert.equal(activeThreads, 1);
  assert.equal(staleThreads, 0);
  assert.equal(staleStacks, 0);
});

test("disconnect cleanup never disposes a stale DAP mirror", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const sessionId = "active-dap-stale-cleanup-mirror";
  let activeDisconnects = 0;
  let activeDisposals = 0;
  let staleDisposals = 0;
  const activeDap = Object.create(DapSession.prototype) as DapSession;
  activeDap.sessionId = sessionId;
  activeDap.language = "python";
  activeDap.workspaceRoot = policy.workspace.root;
  activeDap.threadId = 7;
  activeDap.capabilities = {};
  activeDap.onRuntimeEvent = undefined as any;
  activeDap.disconnect = async () => { activeDisconnects += 1; return { acknowledged: true }; };
  activeDap.disposeClient = () => { activeDisposals += 1; };
  const staleDap = Object.create(DapSession.prototype) as DapSession;
  staleDap.sessionId = sessionId;
  staleDap.language = "python";
  staleDap.workspaceRoot = policy.workspace.root;
  staleDap.disposeClient = () => { staleDisposals += 1; };
  const provider = new DapRuntimeProvider(activeDap);
  const manager = new DebugSessionManager({ policy });
  manager.sessions.add({
    sessionId,
    language: "python",
    workspaceRoot: policy.workspace.root,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider,
    dap: staleDap
  });

  await manager.bpDebugControl({ sessionId, action: "disconnect" });

  assert.equal(activeDisconnects, 1);
  assert.equal(activeDisposals, 1);
  assert.equal(staleDisposals, 0);
});

test("cleanupAll does not disconnect a provider whose session identity is foreign", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  let disconnects = 0;
  const provider = {
    kind: "dap",
    sessionId: "foreign-provider-session",
    language: "python",
    workspaceRoot: policy.workspace.root,
    capabilities: dapProviderCapabilities(),
    threadId: 7,
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { return { reason: "breakpoint" }; },
    async getRuntimeSnapshot() { throw new Error("not used"); },
    async evaluate() { return {}; },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { disconnects += 1; return {}; }
  } as any;
  const manager = new DebugSessionManager({ policy });
  manager.sessions.add({
    sessionId: "local-record-session",
    language: "python",
    workspaceRoot: policy.workspace.root,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider
  });

  await manager.cleanupAll();

  assert.equal(disconnects, 0);
  assert.equal(manager.sessions.maybeGet("local-record-session"), undefined);
});

test("a custom DAP provider owns direct reference inspection even with a same-id DAP mirror", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const sessionId = "custom-provider-same-id-mirror";
  let providerInspections = 0;
  let mirrorVariables = 0;
  const mirror = Object.create(DapSession.prototype) as DapSession;
  mirror.sessionId = sessionId;
  mirror.language = "python";
  mirror.workspaceRoot = policy.workspace.root;
  mirror.threadId = 7;
  mirror.capabilities = {};
  mirror.variables = async () => { mirrorVariables += 1; return []; };
  const provider = {
    kind: "dap",
    sessionId,
    language: "python",
    workspaceRoot: policy.workspace.root,
    capabilities: dapProviderCapabilities(),
    threadId: 7,
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { return { reason: "breakpoint", threadId: 7 }; },
    async getRuntimeSnapshot() { throw new Error("not used"); },
    async inspectVariable(args: AnyRecord) {
      providerInspections += 1;
      return { source: "custom", variablesReference: args.variablesReference };
    },
    async evaluate() { return {}; },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { return {}; }
  } as any;
  const manager = new DebugSessionManager({ policy });
  manager.sessions.add({
    sessionId,
    language: "python",
    workspaceRoot: policy.workspace.root,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider,
    dap: mirror
  });

  const result = await manager.bpDebugValue({ sessionId, ref: 7 });

  assert.deepEqual(result.result, { source: "custom", variablesReference: 7 });
  assert.equal(providerInspections, 1);
  assert.equal(mirrorVariables, 0);
});

test("live DAP kind overrides a stale IDE compatibility kind for policy updates and diagnostics", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const sessionId = "live-dap-stale-kind";
  let evaluateTraffic = 0;
  let breakpointTraffic = 0;
  const dap = Object.create(DapSession.prototype) as DapSession;
  dap.sessionId = sessionId;
  dap.language = "python";
  dap.workspaceRoot = policy.workspace.root;
  dap.threadId = 7;
  dap.capabilities = {};
  dap.onRuntimeEvent = undefined as any;
  dap.evaluate = async () => { evaluateTraffic += 1; return {}; };
  dap.setBreakpoints = async (_filePath, breakpoints) => {
    breakpointTraffic += 1;
    return breakpoints.map((breakpoint, index) => ({
      id: index + 1,
      verified: true,
      line: breakpoint.line,
      column: breakpoint.column
    }));
  };
  const provider = new DapRuntimeProvider(dap);
  const manager = new DebugSessionManager({ policy });
  manager.sessions.add({
    sessionId,
    language: "python",
    workspaceRoot: policy.workspace.root,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "ide",
    provider,
    dap
  });
  const source = `${policy.workspace.root}/kind.py`;
  manager.breakpoints.add(sessionId, { id: "kind-breakpoint", file: source, line: 3 });
  manager.breakpoints.updateVerification(sessionId, source, [{ id: 1, verified: true, line: 3 }]);

  await assert.rejects(
    manager.bpDebugEval({ sessionId, expression: "danger()", mode: "unsafe", frameId: 1 }),
    (error: Error & { code?: string }) => error.code === ErrorCodes.EVALUATE_BLOCKED_BY_POLICY
  );
  assert.equal(evaluateTraffic, 0);

  const update = await manager.bpDebugSetBreakpoint({
    sessionId,
    breakpointId: "kind-breakpoint",
    line: 4
  });
  assert.equal(update.operation, "relocated");
  assert.equal(breakpointTraffic, 1);

  const status = await manager.bpDebugStatus({ detail: "diagnostic" });
  assert.equal((status.sessions as AnyRecord[])[0]?.providerKind, "dap");
});

function emitIdeLifecycle(
  bridge: AssociationFakeIdeBridge,
  type: string,
  clientId = "ide-client-live",
  ideSessionId = "ide-session-live"
): void {
  bridge.emit(type, {
    clientId,
    message: { type, ideSessionId }
  });
}

async function awaitLifecycleCleanup(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function liveDapWithIdeMirrorsFixture() {
  const policy = loadPolicy("breakpilot.yaml");
  const bridge = new AssociationFakeIdeBridge(policy.workspace.root);
  const sessionId = "live-dap-with-ide-lifecycle-mirrors";
  let disposals = 0;
  const dap = Object.create(DapSession.prototype) as DapSession;
  dap.sessionId = sessionId;
  dap.language = "python";
  dap.workspaceRoot = policy.workspace.root;
  dap.threadId = 7;
  dap.capabilities = {};
  dap.onRuntimeEvent = undefined as any;
  dap.disposeClient = () => { disposals += 1; };
  const provider = new DapRuntimeProvider(dap);
  const manager = new DebugSessionManager({ policy, ideBridge: bridge as any });
  const record = manager.sessions.add({
    sessionId,
    language: "python",
    workspaceRoot: policy.workspace.root,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider,
    dap,
    ideClientId: "ide-client-live",
    ideSessionId: "ide-session-live"
  });
  return { manager, bridge, record, disposals: () => disposals };
}

test("an IDE resumed event cannot mutate an associated live DAP record with matching mirrors", () => {
  const { bridge, record } = liveDapWithIdeMirrorsFixture();

  emitIdeLifecycle(bridge, IdeMessageTypes.IDE_SESSION_RESUMED);

  assert.equal(record.state, "paused");
});

test("an IDE terminated event cannot clean an associated live DAP record with matching mirrors", async () => {
  const { manager, bridge, record, disposals } = liveDapWithIdeMirrorsFixture();

  emitIdeLifecycle(bridge, IdeMessageTypes.IDE_SESSION_TERMINATED);
  await awaitLifecycleCleanup();

  assert.equal(manager.sessions.maybeGet(record.sessionId), record);
  assert.equal(record.state, "paused");
  assert.equal(disposals(), 0);
});

test("an IDE resumed event cannot mutate a real IDE provider with a corrupted record association", () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);
  provider.ideClientId = "provider-client-corrupt";
  provider.ideSessionId = "provider-session-corrupt";

  emitIdeLifecycle(bridge, IdeMessageTypes.IDE_SESSION_RESUMED);

  assert.equal(record.state, "paused");
  assert.equal(bridge.traffic, 0);
});

test("an IDE terminated event cannot clean a real IDE provider with a corrupted record association", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);
  provider.ideClientId = "provider-client-corrupt";
  provider.ideSessionId = "provider-session-corrupt";

  emitIdeLifecycle(bridge, IdeMessageTypes.IDE_SESSION_TERMINATED);
  await awaitLifecycleCleanup();

  assert.equal(manager.sessions.maybeGet(record.sessionId), record);
  assert.equal(record.state, "paused");
  assert.equal(bridge.traffic, 0);
});

test("status hides association-invalid records and selects a valid associated session", async () => {
  const { manager, provider } = realIdeAssociationFixture();
  const invalidRecord = manager.sessions.get(provider.sessionId);
  provider.ideClientId = "provider-client-corrupt";
  provider.ideSessionId = "provider-session-corrupt";
  const validProvider = {
    kind: "dap",
    sessionId: "status-valid-provider",
    language: "python",
    workspaceRoot: invalidRecord.workspaceRoot,
    capabilities: dapProviderCapabilities(),
    threadId: 7,
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { return { reason: "breakpoint", threadId: 7 }; },
    async getRuntimeSnapshot() { throw new Error("not used"); },
    async evaluate() { return {}; },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { return {}; }
  } as any;
  manager.sessions.add({
    sessionId: validProvider.sessionId,
    language: "python",
    workspaceRoot: invalidRecord.workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "ide",
    provider: validProvider
  });

  const status = await manager.bpDebugStatus({ detail: "diagnostic" });
  const sessions = status.sessions as AnyRecord[];

  assert.deepEqual(sessions.map((session) => session.sessionId), [validProvider.sessionId]);
  assert.equal(status.activeSessionId, validProvider.sessionId);
  assert.equal(sessions[0]?.providerKind, "dap");
});

test("a correctly associated IDE provider tracks matching resumed and terminated lifecycle events", async () => {
  const { manager, provider, bridge } = realIdeAssociationFixture();
  const record = manager.sessions.get(provider.sessionId);
  let evaluations = 0;
  provider.evaluate = async () => {
    evaluations += 1;
    return { value: { valuePreview: "41", type: "int" } };
  };

  const status = await manager.bpDebugStatus();
  assert.deepEqual((status.sessions as AnyRecord[]).map((session) => session.sessionId), [record.sessionId]);
  const evaluated = await manager.bpDebugEval({ sessionId: record.sessionId, expression: "x" });
  assert.equal(evaluated.value, "41");
  assert.equal(evaluations, 1);

  emitIdeLifecycle(bridge, IdeMessageTypes.IDE_SESSION_RESUMED);
  assert.equal(record.state, "running");

  bridge.registry.upsertSession("ide-client-live", {
    type: IdeMessageTypes.IDE_SESSION_TERMINATED,
    ideSessionId: "ide-session-live"
  }, "terminated");
  emitIdeLifecycle(bridge, IdeMessageTypes.IDE_SESSION_TERMINATED);
  await awaitLifecycleCleanup();

  assert.equal(record.state, "terminated");
  assert.equal(manager.sessions.maybeGet(record.sessionId), undefined);
});
