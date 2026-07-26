import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { DapSession } from "../src/dap/DapSession.ts";
import type { DapClient } from "../src/dap/DapClient.ts";
import type { DapGotoTargetsResponse, StoppedEvent } from "../src/types/dap.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";
import type { AnyRecord } from "../src/types/json.ts";

type RecordedRequest = { command: string; arguments: AnyRecord };
type DeferredResponse = { promise: Promise<AnyRecord>; resolve: (value: AnyRecord) => void };

class FakeDapClient extends EventEmitter {
  started = false;
  closed = false;
  requests: RecordedRequest[] = [];
  responses = new Map<string, AnyRecord>();
  deferredResponses = new Map<string, DeferredResponse>();

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  async request(command: string, arguments_: AnyRecord = {}): Promise<AnyRecord> {
    this.requests.push({ command, arguments: structuredClone(arguments_) });
    const deferred = this.deferredResponses.get(command);
    if (deferred) return deferred.promise;
    return structuredClone(this.responses.get(command) ?? {});
  }

  deferResponse(command: string): (value?: AnyRecord) => void {
    let resolve!: (value: AnyRecord) => void;
    const promise = new Promise<AnyRecord>((done) => {
      resolve = done;
    });
    this.deferredResponses.set(command, { promise, resolve });
    return (value: AnyRecord = {}) => {
      this.deferredResponses.delete(command);
      resolve(value);
    };
  }

  emitStopped(body: StoppedEvent): void {
    assert.equal(this.started, true, "DAP session must start its client before events are emitted");
    this.emit("stopped", body);
  }

  emitTerminated(body: AnyRecord = {}): void {
    this.emit("terminated", body);
  }

  emitExited(body: AnyRecord = {}): void {
    this.emit("exited", body);
  }
}

function createSession(): { client: FakeDapClient; session: DapSession } {
  const client = new FakeDapClient();
  const session = new DapSession({
    sessionId: "dap_boundaries",
    language: "java",
    client: client as unknown as DapClient,
    workspaceRoot: "/workspace"
  });
  session.startClient();
  return { client, session };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BreakPilotError);
    assert.equal(error.code, code);
    return true;
  });
}

test("fresh stop waits ignore stale stops and preserve ordinary FIFO delivery", async () => {
  const { client, session } = createSession();
  client.emitStopped({ reason: "breakpoint", threadId: 1 });
  const boundary = session.captureStopBoundary();
  const fresh = session.waitForStopOrTerminationAfter(boundary, 100);

  client.emitStopped({ reason: "step", threadId: 2 });

  const observed = await fresh;
  assert.equal("terminated" in observed, false);
  assert.equal((observed as StoppedEvent).threadId, 2);
  assert.equal((await session.waitForBreakpoint(100)).threadId, 1, "fresh observation must not consume the stale FIFO stop");
  assert.equal((await session.waitForBreakpoint(100)).threadId, 2, "fresh observation must not consume the later FIFO stop either");
});

test("one fresh stop can satisfy an ordinary pending waiter without reordering FIFO", async () => {
  const { client, session } = createSession();
  const boundary = session.captureStopBoundary();
  const ordinary = session.waitForBreakpoint(100);
  const fresh = session.waitForStopOrTerminationAfter(boundary, 100);

  client.emitStopped({ reason: "step", threadId: 7 });

  assert.equal((await ordinary).threadId, 7);
  const observed = await fresh;
  assert.equal("terminated" in observed, false);
  assert.equal((observed as StoppedEvent).threadId, 7);
  assert.deepEqual(session.stoppedQueue, []);
});

test("a stop observed after capture but before fresh waiter registration remains observable", async () => {
  const { client, session } = createSession();
  const boundary = session.captureStopBoundary();

  client.emitStopped({ reason: "step", threadId: 8 });

  const observed = await session.waitForStopOrTerminationAfter(boundary, 100);
  assert.equal("terminated" in observed, false);
  assert.equal((observed as StoppedEvent).threadId, 8);
  assert.equal((await session.waitForBreakpoint(100)).threadId, 8);
});

test("terminated and exited after a boundary resolve fresh waits without changing stopped FIFO", async () => {
  for (const terminal of ["terminated", "exited"] as const) {
    const { client, session } = createSession();
    client.emitStopped({ reason: "breakpoint", threadId: 3 });
    const boundary = session.captureStopBoundary();
    const fresh = session.waitForStopOrTerminationAfter(boundary, 100);

    if (terminal === "terminated") client.emitTerminated({ exitCode: 0 });
    else client.emitExited({ exitCode: 0 });

    assert.deepEqual(await fresh, { terminated: true });
    assert.equal((await session.waitForBreakpoint(100)).threadId, 3);
  }
});

test("terminated and exited events emitted after capture but before waiter registration remain causally observable", async () => {
  for (const terminal of ["terminated", "exited"] as const) {
    const { client, session } = createSession();
    const boundary = session.captureStopBoundary();

    if (terminal === "terminated") client.emitTerminated({ exitCode: 17 });
    else client.emitExited({ exitCode: 17 });

    assert.deepEqual(
      await session.waitForStopOrTerminationAfter(boundary, 100),
      { terminated: true },
      `${terminal} must remain observable when it arrives before fresh waiter registration`
    );
  }
});

test("fresh waits clean up on timeout and disposal", async () => {
  const { session } = createSession();
  const timeoutBoundary = session.captureStopBoundary();
  const timeout = session.waitForStopOrTerminationAfter(timeoutBoundary, 10);
  await expectCode(timeout, ErrorCodes.BREAKPOINT_TIMEOUT);
  assert.equal(session.freshStopWaiters.length, 0, "timed out fresh waiters must be removed");

  const disposalBoundary = session.captureStopBoundary();
  const pending = session.waitForStopOrTerminationAfter(disposalBoundary, 100);
  assert.equal(session.freshStopWaiters.length, 1);
  session.disposeClient();
  await expectCode(pending, ErrorCodes.TARGET_PROCESS_EXITED);
  assert.equal(session.freshStopWaiters.length, 0, "disposed fresh waiters must be removed");
});

test("gotoTargets forwards exact DAP arguments and maps a missing list to an empty array", async () => {
  const { client, session } = createSession();
  const targets: DapGotoTargetsResponse = {
    targets: [{ id: 33, label: "line 9", line: 9, column: 4, endLine: 9, endColumn: 12 }]
  };
  client.responses.set("gotoTargets", targets);

  assert.deepEqual(await session.gotoTargets("/workspace/Foo.java", 9), targets.targets);
  assert.deepEqual(await session.gotoTargets("/workspace/Foo.java", 10, 4), targets.targets);
  client.responses.set("gotoTargets", {});
  assert.deepEqual(await session.gotoTargets("/workspace/Foo.java", 11), []);

  assert.deepEqual(client.requests, [
    { command: "gotoTargets", arguments: { source: { path: "/workspace/Foo.java" }, line: 9 } },
    { command: "gotoTargets", arguments: { source: { path: "/workspace/Foo.java" }, line: 10, column: 4 } },
    { command: "gotoTargets", arguments: { source: { path: "/workspace/Foo.java" }, line: 11 } }
  ]);
});

test("goto sends the exact DAP command after request success", async () => {
  const { client, session } = createSession();
  const release = client.deferResponse("goto");
  let settled = false;

  const pending = session.goto(2, 33).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, "goto must not resolve before its DAP request succeeds");
  release();
  await pending;

  assert.deepEqual(client.requests, [
    { command: "goto", arguments: { threadId: 2, targetId: 33 } }
  ]);
});
