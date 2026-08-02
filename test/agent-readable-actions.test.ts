import assert from "node:assert/strict";
import test from "node:test";

import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import { SessionOwner, SessionState } from "../src/sessions/SessionOwner.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { ideProviderCapabilities } from "../src/runtime/ProviderCapabilities.ts";
import type { RuntimeDebugProvider, DebugSessionRecord } from "../src/types/sessions.ts";
import { ErrorCodes } from "../src/utils/errors.ts";

function fixture(): { manager: DebugSessionManager; record: DebugSessionRecord } {
  const policy = loadPolicy();
  const manager = new DebugSessionManager({ policy });
  let pauseEpoch = 1;
  const sourcePath = `${policy.workspace.root}/src/Hello.java`;
  const snapshot = () => ({
    sessionId: "actions",
    source: "ide" as const,
    language: "idea" as const,
    threadId: 1,
    frameId: 10,
    threads: [{ id: 1, name: "main", isCurrent: true }],
    partial: false,
    stackFrames: [{ id: 10, name: "hello", line: 21, source: { path: sourcePath } }],
    variables: {
      locals: {
        name: "Locals",
        category: "locals",
        expensive: false,
        variables: {
          count: {
            name: "count",
            kind: "number",
            valuePreview: "1",
            value: "1",
            variablesReference: "idea-count-uuid",
            pauseEpoch,
            modifiable: true,
            mutationMode: "native",
            truncated: false
          }
        }
      }
    },
    availableCategories: ["locals"],
    availableScopes: ["Locals"],
    limits: { maxDepth: 0, maxItems: 10, maxStringLength: 200 }
  });
  const provider: RuntimeDebugProvider = {
    kind: "ide",
    sessionId: "actions",
    language: "idea",
    workspaceRoot: policy.workspace.root,
    capabilities: ideProviderCapabilities({
      debugCommands: true,
      variableSnapshot: true,
      variableHandles: true,
      nativeSetVariable: true,
      runToLine: true,
      eventStream: true,
      breakpointUpdate: true
    }),
    threadId: 1,
    async setBreakpoints(_filePath, breakpoints) {
      return breakpoints.map((breakpoint, index) => ({ id: index + 100, verified: true, line: breakpoint.line }));
    },
    async removeBreakpoint() {
      return { removed: true };
    },
    async waitForBreakpoint() {
      return {
        sessionId: "actions",
        reason: "step",
        threadId: 1,
        pauseEpoch,
        topFrame: snapshot().stackFrames[0]
      };
    },
    async getRuntimeSnapshot() {
      return snapshot() as any;
    },
    async getCallStack() {
      return {
        threadId: 1,
        stackFrames: snapshot().stackFrames,
        offset: 0,
        totalFrames: 1,
        completeness: "complete",
        partial: false,
        pauseEpoch
      };
    },
    async listThreads() {
      return snapshot().threads;
    },
    async inspectVariable() {
      return { items: [] };
    },
    async setVariable(args) {
      return { oldValue: "1", newValue: args.newValue, applied: true, verified: true, mutationMode: "native" };
    },
    async evaluate() {
      return {
        value: {
          name: "result",
          kind: "number",
          valuePreview: "42",
          value: "42",
          variablesReference: 0,
          truncated: false
        }
      };
    },
    async pause() {
      pauseEpoch += 1;
      return {};
    },
    async continue() {
      return { continued: true };
    },
    async step() {
      pauseEpoch += 1;
      return { stepped: true };
    },
    async runToLine(args) {
      pauseEpoch += 1;
      return {
        status: "paused",
        targetReached: true,
        requestedPosition: { filePath: args.filePath, line: args.line },
        position: { filePath: args.filePath, line: args.line },
        cleanedUp: true
      };
    },
    async drainEvents() {
      return {
        items: [{
          sequence: 1,
          timestamp: new Date(0).toISOString(),
          kind: "output",
          sessionId: "actions",
          message: "ready"
        }],
        cursor: 0,
        nextCursor: 1,
        oldestCursor: 0,
        hasMore: false,
        overflowed: false,
        droppedCount: 0,
        supportedKinds: [],
        breakpointErrors: [],
        tracepoints: []
      };
    },
    async disconnect() {
      return { detached: true };
    }
  };
  const record: DebugSessionRecord = {
    sessionId: "actions",
    language: "idea",
    workspaceRoot: policy.workspace.root,
    mode: "ide",
    owner: SessionOwner.HYBRID,
    state: SessionState.PAUSED,
    createdAt: new Date().toISOString(),
    providerKind: "ide",
    provider
  };
  manager.sessions.add(record);
  return { manager, record };
}

test("mutation, evaluation, stepping, run-to-line, events, and breakpoints use compact semantics", async () => {
  const { manager, record } = fixture();
  const frame = await manager.bpDebugFrame({ sessionId: "actions" });
  const handle = ((frame.locals as Array<{ handle: string }>)[0]?.handle);
  assert.equal(handle, "v1");

  assert.deepEqual(await manager.bpDebugSetValue({ sessionId: "actions", handle, newValue: "2" }), {
    target: { handle: "v1" },
    oldValue: "1",
    newValue: "2",
    applied: true,
    verified: true
  });
  const expanded = await manager.bpDebugValue({ sessionId: "actions", handle });
  assert.equal((expanded.value as { name: string }).name, "count");
  assert.deepEqual(await manager.bpDebugEval({ sessionId: "actions", expression: "6 * 7" }), {
    expression: "6 * 7",
    value: 42
  });

  const stepped = await manager.bpDebugControl({ sessionId: "actions", action: "stepOver" });
  assert.equal(stepped.state, "paused");
  assert.equal(stepped.pauseId, 2);
  await assert.rejects(
    () => manager.bpDebugValue({ sessionId: "actions", handle }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === ErrorCodes.STALE_RUNTIME_HANDLE
  );

  const runToLine = await manager.bpDebugRunToLine({
    sessionId: "actions",
    filePath: "src/Hello.java",
    line: 21
  });
  assert.deepEqual(runToLine, {
    state: "paused",
    reached: true,
    target: { filePath: "src/Hello.java", line: 21 },
    reason: "runToLine",
    at: { filePath: "src/Hello.java", line: 21, function: "hello" },
    locals: [{ name: "count", value: 1, handle: "v3", mutable: true }],
    pauseId: 3
  });

  assert.deepEqual(await manager.bpDebugControl({ sessionId: "actions", action: "drainEvents" }), {
    state: "paused",
    events: { items: [{ sequence: 1, kind: "output", message: "ready" }], nextCursor: 1 }
  });

  const created = await manager.bpDebugSetBreakpoint({
    sessionId: "actions",
    filePath: "src/Hello.java",
    line: 21
  });
  const breakpoint = created as { id: string };
  assert.deepEqual(created, {
    id: breakpoint.id,
    at: { filePath: "src/Hello.java", line: 21 },
    verified: true,
    owner: "agent"
  });
  assert.deepEqual(await manager.bpDebugListBreakpoints({ sessionId: "actions" }), {
    breakpoints: [created]
  });
  assert.deepEqual(await manager.bpDebugRemoveBreakpoint({
    sessionId: "actions",
    breakpointId: breakpoint.id
  }), { id: breakpoint.id, removed: true });

  record.state = SessionState.PAUSED;
  assert.deepEqual(await manager.bpDebugControl({ sessionId: "actions", action: "resume" }), { state: "running" });
});
