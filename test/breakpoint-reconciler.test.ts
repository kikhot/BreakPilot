import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { BreakpointManager } from "../src/sessions/BreakpointManager.ts";
import { BreakpointReconciler } from "../src/sessions/BreakpointReconciler.ts";
import type { DapBreakpoint } from "../src/types/dap.ts";
import type { BreakpointRecord, DebugSessionRecord } from "../src/types/sessions.ts";

const workspaceRoot = path.resolve("/tmp/breakpilot-breakpoint-reconciler");
const sourceA = path.join(workspaceRoot, "a.ts");
const sourceZ = path.join(workspaceRoot, "z.ts");

type SetBreakpoints = (filePath: string, breakpoints: BreakpointRecord[]) => Promise<DapBreakpoint[]>;

function sessionWith(setBreakpoints: SetBreakpoints, sessionId = "session-reconciler"): DebugSessionRecord {
  return {
    sessionId,
    language: "javascript",
    workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: "2026-07-25T00:00:00.000Z",
    providerKind: "dap",
    provider: {
      setBreakpoints,
      sessionId,
      kind: "dap"
    }
  } as unknown as DebugSessionRecord;
}

function addBreakpoint(
  manager: BreakpointManager,
  sessionId: string,
  input: Partial<BreakpointRecord> & Pick<BreakpointRecord, "id" | "file" | "line">
): BreakpointRecord {
  return manager.add(sessionId, {
    id: input.id,
    file: input.file,
    line: input.line,
    column: input.column,
    condition: input.condition,
    hitCondition: input.hitCondition,
    logMessage: input.logMessage,
    enabled: input.enabled,
    owner: input.owner
  });
}

function dapReplies(breakpoints: BreakpointRecord[], verified = true): DapBreakpoint[] {
  return breakpoints.map((breakpoint, index) => ({
    id: index + 100,
    verified,
    line: breakpoint.line,
    column: breakpoint.column,
    message: `adapter:${breakpoint.id}`
  }));
}

async function assertRejectsWithCode<T>(code: string, action: () => Promise<T>): Promise<Extract<unknown, { code: string; details: unknown }>> {
  try {
    await action();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
    return error as Extract<unknown, { code: string; details: unknown }>;
  }
  assert.fail(`Expected ${code}`);
}

test("reconciles an agent line move without dropping user breakpoints", async () => {
  const manager = new BreakpointManager();
  const session = sessionWith(async (filePath, records) => {
    assert.equal(filePath, sourceA);
    assert.deepEqual(records.map((record) => record.id), ["agent-a", "user-b"]);
    records[0]!.line = 999;
    return dapReplies([
      { ...records[0]!, line: 22 },
      records[1]!
    ]);
  });
  const reconciler = new BreakpointReconciler(manager);
  addBreakpoint(manager, session.sessionId, { id: "agent-a", file: sourceA, line: 10, owner: "agent" });
  addBreakpoint(manager, session.sessionId, { id: "user-b", file: sourceA, line: 14, owner: "user" });
  const previous = manager.get(session.sessionId, "agent-a");
  if (!previous) assert.fail("expected agent breakpoint");

  const result = await reconciler.update(session, { breakpointId: "agent-a", line: 22 });

  assert.deepEqual(result.previous, previous);
  assert.deepEqual(result.current, {
    ...previous,
    line: 22,
    verified: true,
    adapterBreakpointId: 100,
    message: "adapter:agent-a"
  });
  assert.equal(result.operation, "relocated");
  assert.deepEqual(result.changedFields, ["line"]);
  assert.equal(result.verified, true);
  assert.equal(manager.get(session.sessionId, "agent-a")?.line, 22, "provider argument mutation must not leak into desired state");
  assert.equal(manager.get(session.sessionId, "user-b")?.line, 14);
});

test("enforces user-breakpoint ownership without changing stored ownership", async () => {
  const manager = new BreakpointManager();
  const session = sessionWith(async (_filePath, records) => dapReplies(records));
  const reconciler = new BreakpointReconciler(manager);
  addBreakpoint(manager, session.sessionId, { id: "user-b", file: sourceA, line: 14, owner: "user" });

  await assertRejectsWithCode("POLICY_VIOLATION", () => reconciler.update(session, {
    breakpointId: "user-b",
    line: 15
  }));
  assert.equal(manager.get(session.sessionId, "user-b")?.line, 14);

  const result = await reconciler.update(session, {
    breakpointId: "user-b",
    line: 15,
    owner: "all"
  });
  assert.equal(result.current.owner, "user");
  assert.equal(manager.get(session.sessionId, "user-b")?.owner, "user");
});

test("relocates across sources using sorted complete source replacements", async () => {
  const manager = new BreakpointManager();
  const calls: Array<{ filePath: string; ids: string[] }> = [];
  const session = sessionWith(async (filePath, records) => {
    calls.push({ filePath, ids: records.map((record) => record.id) });
    return dapReplies(records);
  });
  const reconciler = new BreakpointReconciler(manager);
  addBreakpoint(manager, session.sessionId, { id: "agent-z", file: sourceZ, line: 10, owner: "agent" });
  addBreakpoint(manager, session.sessionId, { id: "agent-old", file: sourceZ, line: 12, owner: "agent" });
  addBreakpoint(manager, session.sessionId, { id: "user-new", file: sourceA, line: 20, owner: "user" });

  const result = await reconciler.update(session, {
    breakpointId: "agent-z",
    filePath: sourceA,
    line: 30
  });

  assert.equal(result.operation, "relocated");
  assert.deepEqual(result.changedFields, ["filePath", "line"]);
  assert.deepEqual(calls, [
    { filePath: sourceA, ids: ["user-new", "agent-z"] },
    { filePath: sourceZ, ids: ["agent-old"] }
  ], "provider calls expose the source lock/replacement order");
  assert.deepEqual(manager.listSource(session.sessionId, sourceA).map((record) => record.id), ["user-new", "agent-z"]);
  assert.deepEqual(manager.listSource(session.sessionId, sourceZ).map((record) => record.id), ["agent-old"]);
});

test("serializes same-source updates before snapshotting their complete source list", async () => {
  const manager = new BreakpointManager();
  const calls: Array<Array<[string, number]>> = [];
  let releaseFirst!: () => void;
  const firstReplacement = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let callCount = 0;
  const session = sessionWith(async (_filePath, records) => {
    callCount += 1;
    calls.push(records.map((record) => [record.id, record.line]));
    if (callCount === 1) {
      firstStarted();
      await firstReplacement;
    }
    return dapReplies(records);
  });
  const firstReconciler = new BreakpointReconciler(manager);
  const secondReconciler = new BreakpointReconciler(manager);
  addBreakpoint(manager, session.sessionId, { id: "agent-a", file: sourceA, line: 10, owner: "agent" });
  addBreakpoint(manager, session.sessionId, { id: "agent-b", file: sourceA, line: 20, owner: "agent" });

  const first = firstReconciler.update(session, { breakpointId: "agent-a", line: 11 });
  await firstStartedPromise;
  const second = secondReconciler.update(session, { breakpointId: "agent-b", line: 21 });
  await Promise.resolve();
  assert.equal(callCount, 1, "the second provider replacement must wait for the first source lock");
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(calls, [
    [["agent-a", 11], ["agent-b", 20]],
    [["agent-a", 11], ["agent-b", 21]]
  ]);
  assert.equal(manager.get(session.sessionId, "agent-a")?.line, 11);
  assert.equal(manager.get(session.sessionId, "agent-b")?.line, 21);
});

test("proves recovery after a provider replacement failure without leaking provider payload", async () => {
  const manager = new BreakpointManager();
  let calls = 0;
  const session = sessionWith(async (_filePath, records) => {
    calls += 1;
    if (calls === 1) {
      const failure = new Error("do not expose this provider message") as Error & { code?: string; payload?: unknown };
      failure.code = "ADAPTER_LOST";
      failure.payload = { secret: "provider payload" };
      throw failure;
    }
    return dapReplies(records);
  });
  const reconciler = new BreakpointReconciler(manager);
  addBreakpoint(manager, session.sessionId, { id: "agent-a", file: sourceA, line: 10, owner: "agent" });
  addBreakpoint(manager, session.sessionId, { id: "user-b", file: sourceA, line: 14, owner: "user" });

  const error = await assertRejectsWithCode("BREAKPOINT_UPDATE_FAILED", () => reconciler.update(session, {
    breakpointId: "agent-a",
    line: 22
  }));

  assert.deepEqual((error as { details: unknown }).details, {
    outcome: "restored",
    retrySafe: true,
    rollbackApplied: true,
    affectedIds: ["agent-a", "user-b"],
    recommendedAction: "Retry the breakpoint update after confirming the debugger is responsive.",
    causeCode: "ADAPTER_LOST"
  });
  assert.equal(String((error as Error).message).includes("do not expose"), false);
  assert.deepEqual(manager.listSource(session.sessionId, sourceA).map((record) => [record.id, record.line]), [
    ["agent-a", 10],
    ["user-b", 14]
  ]);
  assert.equal(calls, 2, "the complete original source list must be restored");
});

test("reports indeterminate state when restoration cannot be proven", async () => {
  const manager = new BreakpointManager();
  let calls = 0;
  const session = sessionWith(async () => {
    calls += 1;
    throw Object.assign(new Error(`failure ${calls}`), { code: "ADAPTER_LOST" });
  });
  const reconciler = new BreakpointReconciler(manager);
  addBreakpoint(manager, session.sessionId, { id: "user-b", file: sourceA, line: 14, owner: "user" });
  addBreakpoint(manager, session.sessionId, { id: "agent-a", file: sourceA, line: 10, owner: "agent" });

  const error = await assertRejectsWithCode("BREAKPOINT_ROLLBACK_FAILED", () => reconciler.update(session, {
    breakpointId: "agent-a",
    line: 22
  }));

  assert.equal((error as Error).message, "BreakPilot could not restore the previous breakpoint state.");
  assert.deepEqual((error as { details: unknown }).details, {
    outcome: "indeterminate",
    retrySafe: false,
    rollbackApplied: false,
    affectedIds: ["agent-a", "user-b"],
    recommendedAction: "Inspect the debugger breakpoint state, re-list breakpoints, and reconcile before retrying."
  });
  assert.deepEqual(manager.listSource(session.sessionId, sourceA).map((record) => [record.id, record.line]), [
    ["user-b", 14],
    ["agent-a", 10]
  ]);
});

test("clears only nullable patch fields and keeps unrelated breakpoint state", async () => {
  const manager = new BreakpointManager();
  const session = sessionWith(async (_filePath, records) => dapReplies(records, false));
  const reconciler = new BreakpointReconciler(manager);
  addBreakpoint(manager, session.sessionId, {
    id: "agent-a",
    file: sourceA,
    line: 10,
    column: 7,
    condition: "count > 0",
    hitCondition: "3",
    logMessage: "log it",
    enabled: false,
    owner: "agent"
  });

  const result = await reconciler.update(session, {
    breakpointId: "agent-a",
    column: null,
    condition: null
  });

  assert.equal(result.operation, "relocated");
  assert.deepEqual(result.changedFields, ["column", "condition"]);
  assert.equal(result.current.column, undefined);
  assert.equal(result.current.condition, undefined);
  assert.equal(result.current.hitCondition, "3");
  assert.equal(result.current.logMessage, "log it");
  assert.equal(result.current.enabled, false);
  assert.equal(result.verified, false, "unverified adapter evidence remains a valid result");
});

test("returns a truthful no-op without mutating provider state", async () => {
  const manager = new BreakpointManager();
  let providerCalls = 0;
  const session = sessionWith(async (_filePath, records) => {
    providerCalls += 1;
    return dapReplies(records);
  });
  const reconciler = new BreakpointReconciler(manager);
  addBreakpoint(manager, session.sessionId, { id: "agent-a", file: sourceA, line: 10, owner: "agent" });

  const result = await reconciler.update(session, { breakpointId: "agent-a" });

  assert.equal(result.operation, "updated");
  assert.deepEqual(result.changedFields, []);
  assert.equal(providerCalls, 0);
});

test("reports adapter-normalized positions as committed changes", async () => {
  const manager = new BreakpointManager();
  const session = sessionWith(async (_filePath, records) => [
    {
      id: 10,
      verified: true,
      line: 21,
      column: 4,
      message: `adapter:${records[0]!.id}`
    }
  ]);
  const reconciler = new BreakpointReconciler(manager);
  addBreakpoint(manager, session.sessionId, {
    id: "agent-a",
    file: sourceA,
    line: 10,
    column: 2,
    owner: "agent"
  });

  const result = await reconciler.update(session, {
    breakpointId: "agent-a",
    condition: "ready"
  });

  assert.equal(result.current.line, 21);
  assert.equal(result.current.column, 4);
  assert.equal(result.operation, "relocated");
  assert.deepEqual(result.changedFields, ["line", "column", "condition"]);
});

test("manager reads, replacement snapshots, and provider inputs are clone-safe", async () => {
  const manager = new BreakpointManager();
  const session = sessionWith(async (_filePath, records) => {
    records[0]!.line = 777;
    records[0]!.condition = "provider mutation";
    return dapReplies([{ ...records[0]!, line: 22, condition: "requested" }]);
  });
  const reconciler = new BreakpointReconciler(manager);
  addBreakpoint(manager, session.sessionId, {
    id: "agent-a",
    file: sourceA,
    line: 10,
    condition: "original",
    owner: "agent"
  });

  const read = manager.get(session.sessionId, "agent-a");
  if (!read) assert.fail("expected stored breakpoint");
  read.line = 666;
  read.condition = "consumer mutation";
  const listed = manager.listSource(session.sessionId, sourceA);
  listed[0]!.line = 555;

  const replacement = manager.listSource(session.sessionId, sourceA);
  replacement[0]!.line = 12;
  manager.replaceSource(session.sessionId, sourceA, replacement);
  replacement[0]!.line = 444;

  assert.equal(manager.get(session.sessionId, "agent-a")?.line, 12);
  await reconciler.update(session, { breakpointId: "agent-a", line: 22, condition: "requested" });
  const stored = manager.get(session.sessionId, "agent-a");
  assert.equal(stored?.line, 22);
  assert.equal(stored?.condition, "requested");
});
