import assert from "node:assert/strict";
import test from "node:test";

import { validateToolInput, validateToolOutput } from "../src/control/ToolInputValidator.ts";
import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import { DapSession } from "../src/dap/DapSession.ts";
import { VariableSerializer } from "../src/inspection/VariableSerializer.ts";
import { DapRuntimeProvider } from "../src/runtime/providers/DapRuntimeProvider.ts";
import { dapProviderCapabilities } from "../src/runtime/ProviderCapabilities.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import type { JsonSchema } from "../src/types/control.ts";
import type { AnyRecord } from "../src/types/json.ts";

function definition(name: string) {
  const found = toolDefinitions.find((candidate) => candidate.name === name);
  assert.ok(found, `expected ${name} to be defined`);
  return found;
}

function dapManagerForFrameGuard(
  sessionId: string,
  onTraffic: () => void,
  options: {
    includeDapMirror?: boolean;
    recordProviderKind?: string;
    supportsSetValue?: boolean;
  } = {}
): DebugSessionManager {
  const policy = loadPolicy("breakpilot.yaml");
  const dap = Object.create(DapSession.prototype) as DapSession;
  dap.sessionId = sessionId;
  dap.language = "python";
  dap.workspaceRoot = policy.workspace.root;
  dap.threadId = 7;
  dap.capabilities = {};
  dap.client = {
    async request() {
      onTraffic();
      return { variables: [] };
    }
  } as any;
  const provider = {
    kind: "dap",
    sessionId,
    language: dap.language,
    workspaceRoot: dap.workspaceRoot,
    capabilities: dapProviderCapabilities({ supportsSetVariable: options.supportsSetValue === true }),
    threadId: dap.threadId,
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { onTraffic(); return {}; },
    async getCallStack() {
      onTraffic();
      return {
        threadId: 7,
        stackFrames: [],
        offset: 0,
        completeness: "unknown",
        partial: true
      };
    },
    async getRuntimeSnapshot() { onTraffic(); throw new Error("unexpected provider traffic"); },
    async inspectVariable() { onTraffic(); return {}; },
    async setVariable() { onTraffic(); return {}; },
    async evaluate() { onTraffic(); return {}; },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { return {}; }
  } as any;
  const manager = new DebugSessionManager({ policy });
  manager.sessions.add({
    sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: options.recordProviderKind ?? provider.kind,
    provider,
    ...(options.includeDapMirror === false ? {} : { dap })
  });
  return manager;
}

test("set-value accepts exactly one closed path or short-handle target", () => {
  const schema = definition("bp_debug_set_value").inputSchema;
  for (const accepted of [
    { path: ["x"], newValue: "42" },
    { handle: "v1", newValue: "42" }
  ]) {
    assert.deepEqual(validateToolInput(schema, accepted).errors, [], JSON.stringify(accepted));
  }

  for (const rejected of [
    { newValue: "42" },
    { path: [], newValue: "42" },
    { path: ["x"], handle: "v1", newValue: "42" },
    { ref: "bpref_opaque", newValue: "42" },
    { handle: "v1", newValue: "42", unknown: true }
  ]) {
    assert.notDeepEqual(validateToolInput(schema, rejected).errors, [], JSON.stringify(rejected));
  }
});

test("value accepts paths and short handles while rejecting provider references", () => {
  const schema = definition("bp_debug_value").inputSchema;
  for (const accepted of [
    { path: ["x"] },
    { handle: "v1" }
  ]) {
    assert.deepEqual(validateToolInput(schema, accepted).errors, [], JSON.stringify(accepted));
  }
  for (const rejected of [{ ref: 7 }, { variablesReference: "bpref_opaque" }]) {
    assert.notDeepEqual(validateToolInput(schema, rejected).errors, [], JSON.stringify(rejected));
  }
});

test("successful set-value output requires exactly one target and truthful mutation facts", () => {
  const schema = definition("bp_debug_set_value").outputSchema as JsonSchema;
  const pathSuccess = {
    target: { path: ["x"] },
    oldValue: "41",
    newValue: "42",
    applied: true,
    verified: false,
  };
  const refSuccess = {
    target: { handle: "v1" },
    oldValue: "41",
    newValue: "42",
    applied: true,
    verified: false
  };
  assert.deepEqual(validateToolOutput(schema, pathSuccess).errors, []);
  assert.deepEqual(validateToolOutput(schema, refSuccess).errors, []);
  assert.notDeepEqual(validateToolOutput(schema, {
    oldValue: "41",
    newValue: "42",
    applied: true,
    verified: false,
  }).errors, []);
  assert.notDeepEqual(validateToolOutput(schema, { ...pathSuccess, unknown: true }).errors, []);
  const { verified: _verified, ...withoutVerified } = pathSuccess;
  assert.notDeepEqual(validateToolOutput(schema, withoutVerified).errors, []);
  const { oldValue: _oldValue, ...withoutOldValue } = pathSuccess;
  assert.notDeepEqual(validateToolOutput(schema, withoutOldValue).errors, []);
  const { newValue: _newValue, ...withoutNewValue } = pathSuccess;
  assert.notDeepEqual(validateToolOutput(schema, withoutNewValue).errors, []);
  assert.notDeepEqual(validateToolOutput(schema, { ...pathSuccess, mutationMode: "unsupported" }).errors, []);
});

test("DAP rejects an opaque string reference before adapter traffic", async () => {
  let requests = 0;
  const session = Object.create(DapSession.prototype) as DapSession;
  session.client = {
    async request() {
      requests += 1;
      return {};
    }
  } as any;

  await assert.rejects(
    session.variables("bpref_opaque"),
    (error: Error & { code?: string }) => error.code === "INVALID_ARGUMENT"
  );
  assert.equal(requests, 0);
});

test("serializer treats omitted DAP capabilities as no native mutation claim", async () => {
  const session = Object.create(DapSession.prototype) as DapSession;
  const serializer = new VariableSerializer(session, {
    maxDepth: 1,
    maxItems: 10,
    maxStringLength: 100,
    redactPatterns: []
  });

  const variable = await serializer.serializeVariable({
    name: "x",
    value: "41",
    type: "int",
    variablesReference: 0
  });

  assert.equal(variable.value, "41");
  assert.equal(variable.mutationMode, undefined);
});

test("DAP rejects an opaque frame id before evaluate adapter traffic", async () => {
  let requests = 0;
  const session = Object.create(DapSession.prototype) as DapSession;
  session.client = {
    async request() {
      requests += 1;
      return {};
    }
  } as any;

  await assert.rejects(
    session.evaluate("x", { frameId: "bpframe_opaque" }),
    (error: Error & { code?: string }) => error.code === "INVALID_ARGUMENT"
  );
  assert.equal(requests, 0);
});

test("bpDebugEval rejects opaque and non-positive DAP frame ids before adapter traffic", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  for (const frameId of ["bpframe_opaque", 0]) {
    let requests = 0;
    const dap = Object.create(DapSession.prototype) as DapSession;
    dap.sessionId = `dap-eval-${String(frameId)}`;
    dap.language = "python";
    dap.workspaceRoot = policy.workspace.root;
    dap.threadId = 7;
    dap.capabilities = {};
    dap.client = {
      async request() {
        requests += 1;
        return {};
      }
    } as any;
    const provider = {
      kind: "dap",
      sessionId: dap.sessionId,
      language: dap.language,
      workspaceRoot: dap.workspaceRoot,
      capabilities: dapProviderCapabilities(),
      threadId: dap.threadId,
      async setBreakpoints() { return []; },
      async waitForBreakpoint() { return {}; },
      async getRuntimeSnapshot() { throw new Error("not used"); },
      async evaluate(expression: string, options: AnyRecord) {
        return DapRuntimeProvider.prototype.evaluate.call({ dap }, expression, options);
      },
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
      providerKind: provider.kind,
      provider,
      dap
    });

    await assert.rejects(
      manager.bpDebugEval({ sessionId: provider.sessionId, expression: "x", frameId, frameIndex: 0 }),
      (error: Error & { code?: string }) => error.code === "INVALID_ARGUMENT"
    );
    assert.equal(requests, 0, String(frameId));
  }
});

test("bpDebugFrame rejects a non-positive DAP frame id before adapter traffic", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  let requests = 0;
  const dap = Object.create(DapSession.prototype) as DapSession;
  dap.sessionId = "dap-frame-zero";
  dap.language = "python";
  dap.workspaceRoot = policy.workspace.root;
  dap.threadId = 7;
  dap.capabilities = {};
  dap.client = {
    async request() {
      requests += 1;
      return {};
    }
  } as any;
  const provider = {
    kind: "dap",
    sessionId: dap.sessionId,
    language: dap.language,
    workspaceRoot: dap.workspaceRoot,
    capabilities: dapProviderCapabilities(),
    threadId: dap.threadId,
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { return {}; },
    async getRuntimeSnapshot() { throw new Error("not used"); },
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
    providerKind: provider.kind,
    provider,
    dap
  });

  await assert.rejects(
    manager.bpDebugFrame({ sessionId: provider.sessionId, frameId: 0 }),
    (error: Error & { code?: string }) => error.code === "INVALID_ARGUMENT"
  );
  assert.equal(requests, 0);
});

test("bpDebugValue rejects invalid DAP frame ids before direct reference traffic", async () => {
  for (const frameId of [0, "bpframe_opaque"]) {
    let traffic = 0;
    const sessionId = `dap-value-frame-${String(frameId)}`;
    const manager = dapManagerForFrameGuard(sessionId, () => { traffic += 1; });

    await assert.rejects(
      manager.bpDebugValue({ sessionId, ref: 7, frameId }),
      (error: Error & { code?: string }) => error.code === "INVALID_ARGUMENT"
    );
    assert.equal(traffic, 0, String(frameId));
  }
});

test("bpDebugContext rejects invalid DAP frame ids before provider or adapter traffic", async () => {
  for (const frameId of [0, "bpframe_opaque"]) {
    let traffic = 0;
    const sessionId = `dap-context-frame-${String(frameId)}`;
    const manager = dapManagerForFrameGuard(sessionId, () => { traffic += 1; });

    await assert.rejects(
      manager.bpDebugContext({ sessionId, frameId }),
      (error: Error & { code?: string }) => error.code === "INVALID_ARGUMENT"
    );
    assert.equal(traffic, 0, String(frameId));
  }
});

test("bpDebugSetValue prioritizes invalid DAP frame ids before capability checks", async () => {
  for (const frameId of [0, "bpframe_opaque"]) {
    let traffic = 0;
    const sessionId = `dap-set-frame-${String(frameId)}`;
    const manager = dapManagerForFrameGuard(sessionId, () => { traffic += 1; });

    await assert.rejects(
      manager.bpDebugSetValue({
        sessionId,
        path: ["x"],
        newValue: "42",
        frameId
      }),
      (error: Error & { code?: string }) => error.code === "INVALID_ARGUMENT"
    );
    assert.equal(traffic, 0, String(frameId));
  }
});

test("live IDE identity accepts opaque frame ids despite stale DAP metadata", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  let evaluatedFrameId: unknown;
  const provider = {
    kind: "ide",
    sessionId: "ide-opaque-frame",
    language: "python",
    workspaceRoot: policy.workspace.root,
    capabilities: {
      pause: "native",
      stepping: "native",
      runToLine: "unsupported",
      variableReferences: "snapshot",
      setValue: "unsupported",
      breakpointUpdate: "unsupported",
      conditionalBreakpoints: "unsupported",
      hitConditionalBreakpoints: "unsupported",
      tracepoints: "unsupported",
      eventDrain: "unsupported"
    },
    threadId: "thread-opaque",
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { return {}; },
    async getRuntimeSnapshot() { throw new Error("not used"); },
    async evaluate(_expression: string, options: AnyRecord) {
      evaluatedFrameId = options.frameId;
      return { value: { valuePreview: "41", type: "int" } };
    },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { return {}; }
  } as any;
  const manager = new DebugSessionManager({ policy });
  manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "ide",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider
  });

  const result = await manager.bpDebugEval({
    sessionId: provider.sessionId,
    expression: "x",
    frameId: "bpframe_opaque"
  });

  assert.equal(evaluatedFrameId, "bpframe_opaque");
  assert.equal(result.value, "41");
});

test("all public frame routes use live DAP identity without a session mirror", async () => {
  const routes: Array<{
    name: string;
    invoke: (
      manager: DebugSessionManager,
      sessionId: string,
      frameId: number | string
    ) => Promise<unknown>;
  }> = [
    {
      name: "frame",
      invoke: (manager, sessionId, frameId) => manager.bpDebugFrame({ sessionId, frameId })
    },
    {
      name: "value",
      invoke: (manager, sessionId, frameId) => manager.bpDebugValue({ sessionId, ref: 7, frameId })
    },
    {
      name: "set-value",
      invoke: (manager, sessionId, frameId) => manager.bpDebugSetValue({
        sessionId,
        path: ["x"],
        newValue: "42",
        frameId
      })
    },
    {
      name: "eval",
      invoke: (manager, sessionId, frameId) => manager.bpDebugEval({
        sessionId,
        expression: "x",
        frameId
      })
    },
    {
      name: "context",
      invoke: (manager, sessionId, frameId) => manager.bpDebugContext({ sessionId, frameId })
    }
  ];

  for (const route of routes) {
    for (const frameId of [0, "bpframe_opaque"]) {
      let traffic = 0;
      const sessionId = `dap-no-mirror-${route.name}-${String(frameId)}`;
      const manager = dapManagerForFrameGuard(sessionId, () => { traffic += 1; }, {
        includeDapMirror: false,
        recordProviderKind: "ide",
        supportsSetValue: true
      });

      await assert.rejects(
        route.invoke(manager, sessionId, frameId),
        (error: Error & { code?: string }) => error.code === "INVALID_ARGUMENT",
        `${route.name}:${String(frameId)}`
      );
      assert.equal(traffic, 0, `${route.name}:${String(frameId)}`);
    }
  }
});

test("path mutation preserves explicit provider verification", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const manager = new DebugSessionManager({ policy });
  let setArgs: AnyRecord | undefined;
  const provider = {
    kind: "ide",
    sessionId: "legacy-set",
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
    threadId: 1,
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { return {}; },
    async getRuntimeSnapshot() {
      return {
        sessionId: "legacy-set",
        source: "ide",
        language: "python",
        threadId: 1,
        frameId: 11,
        stackFrames: [{ id: 11, name: "top", line: 1, source: { path: "main.py" } }],
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
              }
            }
          }
        },
        limits: { maxDepth: 1, maxItems: 20, maxStringLength: 2000 }
      } as const;
    },
    async setVariable(args: AnyRecord) {
      setArgs = args;
      return { applied: true, verified: true, mutationMode: "native", detail: "accepted" };
    },
    async evaluate() { return {}; },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { return {}; }
  } as any;
  manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "ide",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: provider.kind,
    provider
  });

  const result = await manager.bpDebugSetValue({ sessionId: "legacy-set", path: ["x"], newValue: "42" });

  assert.deepEqual(setArgs?.path, ["x"]);
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.deepEqual(result.target, { path: ["x"] });
  assert.equal("mutationMode" in result, false);
  assert.equal("result" in result, false);
});
