import assert from "node:assert/strict";
import test from "node:test";

import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DapRuntimeProvider } from "../src/runtime/providers/DapRuntimeProvider.ts";
import { IdeRuntimeProvider } from "../src/runtime/providers/IdeRuntimeProvider.ts";
import { DapSession } from "../src/dap/DapSession.ts";
import type { AnyRecord } from "../src/types/json.ts";
import type { DapStackFrame } from "../src/types/dap.ts";
import type { RuntimeDebugProvider, RuntimeStackRequest, RuntimeStackResult } from "../src/types/sessions.ts";

const capabilities = {
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
} as const;

function managerWithStack(
  getCallStack: (threadId: string | number | null | undefined, request: RuntimeStackRequest) => Promise<RuntimeStackResult>
): DebugSessionManager {
  const manager = new DebugSessionManager({ policy: loadPolicy("breakpilot.yaml") });
  const provider: RuntimeDebugProvider = {
    kind: "ide",
    sessionId: "stack-contract",
    language: "python",
    workspaceRoot: loadPolicy("breakpilot.yaml").workspace.root,
    capabilities,
    threadId: "opaque-thread",
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { return {}; },
    getCallStack,
    async getRuntimeSnapshot() {
      throw new Error("not used");
    },
    async evaluate() { return {}; },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { return {}; }
  };
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
  return manager;
}

test("manager preserves a trusted partial provider page without slicing it again", async () => {
  let received: RuntimeStackRequest | undefined;
  const manager = managerWithStack(async (threadId, request) => {
    received = request;
    return {
      threadId: threadId ?? null,
      stackFrames: [
        { id: "frame-2", name: "two", line: 12, source: { path: "two.py" } },
        { id: "frame-3", name: "three", line: 13, source: { path: "three.py" } }
      ],
      offset: 2,
      totalFrames: 10,
      completeness: "partial",
      nextOffset: 4,
      partial: true
    };
  });

  const page = await manager.bpDebugCallStack({ sessionId: "stack-contract", offset: 2, limit: 2 });

  assert.deepEqual(received, { offset: 2, limit: 2 });
  assert.deepEqual(
    (page.frames as AnyRecord[]).map((frame) => ((frame.at as AnyRecord).function)),
    ["two", "three"]
  );
  assert.equal(page.nextOffset, 4);
  assert.equal("completeness" in page, false);
});

test("manager preserves complete and unknown provider pagination facts", async () => {
  const completeManager = managerWithStack(async (threadId, request) => ({
    threadId: threadId ?? null,
    stackFrames: [{ id: "frame-final", name: "final", line: 14, source: { path: "final.py" } }],
    offset: request.offset,
    totalFrames: 3,
    completeness: "complete",
    partial: false
  }));
  const complete = await completeManager.bpDebugCallStack({ sessionId: "stack-contract", offset: 2, limit: 2 });
  assert.equal("incomplete" in complete, false);
  assert.equal(complete.nextOffset, undefined);

  const unknownManager = managerWithStack(async (threadId, request) => ({
    threadId: threadId ?? null,
    stackFrames: [{ id: "frame-only", name: "only", line: 1, source: { path: "only.py" } }],
    offset: request.offset,
    completeness: "unknown",
    partial: true,
    truncationReason: "provider"
  }));
  const unknown = await unknownManager.bpDebugCallStack({ sessionId: "stack-contract", offset: 0, limit: 20 });
  assert.deepEqual(unknown.incomplete, ["stack"]);
  assert.equal(unknown.nextOffset, undefined, "missing totals must never fabricate a cursor");
});

test("manager does not overwrite provider completeness when a known-total page is truncated", async () => {
  const manager = managerWithStack(async (threadId, request) => ({
    threadId: threadId ?? null,
    stackFrames: [
      { id: "frame-2", name: "two", line: 12, source: { path: "two.py" } },
      { id: "frame-3", name: "three", line: 13, source: { path: "three.py" } }
    ],
    offset: request.offset,
    totalFrames: 4,
    completeness: "partial",
    partial: true,
    nextOffset: 4,
    truncationReason: "timeout"
  }));

  const page = await manager.bpDebugCallStack({ sessionId: "stack-contract", offset: 2, limit: 2 });

  assert.equal(page.nextOffset, 4);
  assert.equal("truncationReason" in page, false);
});

test("manager derives partialness from known-total provider completeness", async () => {
  const contradictoryComplete = managerWithStack(async (threadId, request) => ({
    threadId: threadId ?? null,
    stackFrames: [{ id: "frame-final", name: "final", line: 14, source: { path: "final.py" } }],
    offset: request.offset,
    totalFrames: 1,
    completeness: "complete",
    partial: true
  }));
  const complete = await contradictoryComplete.bpDebugCallStack({
    sessionId: "stack-contract",
    offset: 0,
    limit: 20
  });
  assert.equal("incomplete" in complete, false);

  const contradictoryPartial = managerWithStack(async (threadId, request) => ({
    threadId: threadId ?? null,
    stackFrames: [{ id: "frame-0", name: "top", line: 1, source: { path: "top.py" } }],
    offset: request.offset,
    totalFrames: 2,
    completeness: "partial",
    partial: false,
    nextOffset: 1,
    truncationReason: "timeout"
  }));
  const partial = await contradictoryPartial.bpDebugCallStack({
    sessionId: "stack-contract",
    offset: 0,
    limit: 1
  });
  assert.equal(partial.nextOffset, 1);
  assert.equal("truncationReason" in partial, false);
});

test("legacy IDE snapshot fallback never fabricates stack completeness or a total", async () => {
  const bridge = {
    registry: {
      findSession() {
        return { pauseEpoch: 9 };
      }
    }
  } as any;
  const provider = new IdeRuntimeProvider({
    sessionId: "legacy-ide-stack",
    bridge,
    ideSession: {
      ideSessionId: "ide-legacy",
      clientId: "client-legacy",
      state: "paused",
      negotiatedDebuggerFeatures: {
        breakpointUpdate: false,
        eventStream: false,
        stackPagination: false,
      variableHandles: false,
      nativeSetVariable: false,
      causalDebugStart: false
      },
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    },
    workspaceRoot: "/workspace"
  });
  provider.getRuntimeSnapshot = async () => ({
    sessionId: provider.sessionId,
    source: "ide",
    language: "python",
    threadId: 1,
    frameId: 11,
    partial: false,
    stackFrames: [{ id: 11, name: "top", line: 1, source: { path: "/workspace/main.py" } }],
    variables: {},
    limits: { maxDepth: 0, maxItems: 1, maxStringLength: 200 }
  });

  const stack = await provider.getCallStack(1, { offset: 0, limit: 20 });

  assert.equal(stack.totalFrames, undefined);
  assert.equal(stack.completeness, "unknown");
  assert.equal(stack.partial, true);
  assert.equal(stack.truncationReason, "provider");
  assert.equal(stack.pauseEpoch, undefined);
});

test("DAP stack pagination forwards offset as startFrame", async () => {
  let request: AnyRecord | undefined;
  const session = Object.create(DapSession.prototype) as DapSession;
  session.threadId = 7;
  session.client = {
    async request(command: string, args: AnyRecord) {
      assert.equal(command, "stackTrace");
      request = args;
      return { stackFrames: [], totalFrames: 10 };
    }
  } as any;

  await session.stackTrace(7, 2, 4);

  assert.deepEqual(request, { threadId: 7, startFrame: 4, levels: 2 });
});

test("DAP full-stack requests omit pagination fields", async () => {
  let request: AnyRecord | undefined;
  const session = Object.create(DapSession.prototype) as DapSession;
  session.threadId = 7;
  session.client = {
    async request(command: string, args: AnyRecord) {
      assert.equal(command, "stackTrace");
      request = args;
      return { stackFrames: [], totalFrames: 0 };
    }
  } as any;

  await session.stackTraceFull(7);

  assert.deepEqual(request, { threadId: 7 });
});

function stackFrames(count: number): DapStackFrame[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `frame-${index + 1}`,
    line: index + 1,
    source: { path: "main.py" }
  }));
}

function dapProviderWithStackResponses(
  supportsDelayedStackTraceLoading: boolean,
  responseFor: (request: AnyRecord) => { stackFrames: DapStackFrame[]; totalFrames?: number }
): { provider: DapRuntimeProvider; requests: AnyRecord[] } {
  const dap = Object.create(DapSession.prototype) as DapSession;
  dap.sessionId = "dap-stack-bounds";
  dap.language = "python";
  dap.workspaceRoot = "/workspace";
  dap.threadId = 7;
  dap.capabilities = { supportsDelayedStackTraceLoading };
  dap.onRuntimeEvent = undefined as any;
  const requests: AnyRecord[] = [];
  dap.client = {
    async request(command: string, args: AnyRecord) {
      assert.equal(command, "stackTrace");
      requests.push(args);
      return responseFor(args);
    }
  } as any;
  return { provider: new DapRuntimeProvider(dap), requests };
}

test("trusted delayed-loading DAP pages retain an intermediate cursor", async () => {
  const fixture = dapProviderWithStackResponses(true, () => ({
    stackFrames: stackFrames(5).slice(2, 4),
    totalFrames: 5
  }));

  const stack = await fixture.provider.getCallStack(7, { offset: 2, limit: 2 });

  assert.deepEqual(fixture.requests, [{ threadId: 7, startFrame: 2, levels: 2 }]);
  assert.deepEqual(stack.stackFrames.map((frame) => frame.id), [3, 4]);
  assert.equal(stack.completeness, "partial");
  assert.equal(stack.partial, true);
  assert.equal(stack.nextOffset, 4);
  assert.equal(stack.truncationReason, "limit");
});

test("trusted delayed-loading DAP terminal pages are complete", async () => {
  const fixture = dapProviderWithStackResponses(true, () => ({
    stackFrames: stackFrames(5).slice(4),
    totalFrames: 5
  }));

  const stack = await fixture.provider.getCallStack(7, { offset: 4, limit: 2 });

  assert.deepEqual(fixture.requests, [{ threadId: 7, startFrame: 4, levels: 2 }]);
  assert.deepEqual(stack.stackFrames.map((frame) => frame.id), [5]);
  assert.equal(stack.completeness, "complete");
  assert.equal(stack.partial, false);
  assert.equal(stack.nextOffset, undefined);
  assert.equal(stack.truncationReason, undefined);
});

test("non-delayed DAP uses a full-stack request before slicing Java-like frames", async () => {
  const fixture = dapProviderWithStackResponses(false, () => ({
    stackFrames: stackFrames(10),
    totalFrames: 10
  }));

  const stack = await fixture.provider.getCallStack(7, { offset: 8, limit: 2 });

  assert.deepEqual(fixture.requests, [{ threadId: 7 }]);
  assert.deepEqual(stack.stackFrames.map((frame) => frame.id), [9, 10]);
  assert.equal(stack.completeness, "complete");
  assert.equal(stack.partial, false);
  assert.equal(stack.nextOffset, undefined);
  assert.equal(stack.truncationReason, undefined);
});

test("incomplete non-delayed full stacks remain partial without a cursor", async () => {
  const fixture = dapProviderWithStackResponses(false, () => ({
    stackFrames: stackFrames(5),
    totalFrames: 10
  }));

  const stack = await fixture.provider.getCallStack(7, { offset: 2, limit: 2 });

  assert.deepEqual(fixture.requests, [{ threadId: 7 }]);
  assert.deepEqual(stack.stackFrames.map((frame) => frame.id), [3, 4]);
  assert.equal(stack.completeness, "partial");
  assert.equal(stack.partial, true);
  assert.equal(stack.nextOffset, undefined);
  assert.equal(stack.truncationReason, "provider");
});

test("DAP pages without a total remain unknown and cursorless", async () => {
  const fixture = dapProviderWithStackResponses(true, () => ({
    stackFrames: stackFrames(2)
  }));

  const stack = await fixture.provider.getCallStack(7, { offset: 0, limit: 2 });

  assert.deepEqual(fixture.requests, [{ threadId: 7, startFrame: 0, levels: 2 }]);
  assert.deepEqual(stack.stackFrames.map((frame) => frame.id), [1, 2]);
  assert.equal(stack.completeness, "unknown");
  assert.equal(stack.partial, true);
  assert.equal(stack.nextOffset, undefined);
  assert.equal(stack.truncationReason, "provider");
});

test("DAP pages never expose a non-advancing cursor", async () => {
  const fixture = dapProviderWithStackResponses(true, () => ({
    stackFrames: [],
    totalFrames: 10
  }));

  const stack = await fixture.provider.getCallStack(7, { offset: 0, limit: 0 });

  assert.deepEqual(fixture.requests, [{ threadId: 7, startFrame: 0, levels: 0 }]);
  assert.equal(stack.completeness, "partial");
  assert.equal(stack.partial, true);
  assert.equal(stack.nextOffset, undefined);
  assert.equal(stack.truncationReason, "provider");
});

for (const invalidPage of [
  { name: "short", frames: stackFrames(1), totalFrames: 10 },
  { name: "overlong", frames: stackFrames(3), totalFrames: 10 },
  { name: "inconsistent with the reported total", frames: stackFrames(2), totalFrames: 3 }
]) {
  test(`invalid delayed-loading DAP ${invalidPage.name} pages never advertise a cursor`, async () => {
    const fixture = dapProviderWithStackResponses(true, () => ({
      stackFrames: invalidPage.frames,
      totalFrames: invalidPage.totalFrames
    }));

    const stack = await fixture.provider.getCallStack(7, { offset: 2, limit: 2 });

    assert.deepEqual(fixture.requests, [{ threadId: 7, startFrame: 2, levels: 2 }]);
    assert.deepEqual(stack.stackFrames.map((frame) => frame.id), invalidPage.frames.slice(0, 2).map((frame) => frame.id));
    assert.equal(stack.completeness, "partial");
    assert.equal(stack.partial, true);
    assert.equal(stack.nextOffset, undefined);
    assert.equal(stack.truncationReason, "provider");
  });
}
