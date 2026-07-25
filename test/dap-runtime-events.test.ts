import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { DapClient } from "../src/dap/DapClient.ts";
import { DapSession } from "../src/dap/DapSession.ts";
import { RuntimeEventBuffer } from "../src/runtime/RuntimeEventBuffer.ts";
import { DapRuntimeProvider } from "../src/runtime/providers/DapRuntimeProvider.ts";
import type { DapEventMessage } from "../src/types/dap.ts";
import type { AnyRecord } from "../src/types/json.ts";

class FakeDapClient extends EventEmitter {
  #started = false;
  #sequence = 1;

  start(): void {
    this.#started = true;
  }

  publish(event: string, body: AnyRecord = {}): void {
    assert.equal(this.#started, true, "the DAP client must be started before publishing events");
    const message: DapEventMessage = {
      seq: this.#sequence,
      type: "event",
      event,
      body
    };
    this.#sequence += 1;
    this.emit("event", message);
    this.emit(event, body);
  }

  close(): void {
    this.#started = false;
  }
}

function createDapSession(sessionId: string): { client: FakeDapClient; dap: DapSession } {
  const client = new FakeDapClient();
  const dap = new DapSession({
    sessionId,
    language: "java",
    client: client as unknown as DapClient,
    workspaceRoot: "/workspace"
  });
  return { client, dap };
}

test("DAP events are normalized in order without retaining raw adapter payloads", async () => {
  const { client, dap } = createDapSession("dap_events");
  const events = new RuntimeEventBuffer("dap_events", 8);
  const provider = new DapRuntimeProvider(dap, events);

  assert.equal(provider.capabilities.eventDrain, "unsupported", "an unwired DAP client is not a live source");
  dap.startClient();
  assert.equal(provider.capabilities.eventDrain, "native");

  client.publish("continued", {
    threadId: 2,
    allThreadsContinued: true,
    variables: [{ name: "token", value: "secret" }]
  });
  client.publish("stopped", {
    reason: "breakpoint",
    description: "paused",
    threadId: 2,
    allThreadsStopped: true,
    hitBreakpointIds: [7, { raw: "drop" }],
    stackFrames: [{ name: "private" }]
  });
  client.publish("output", {
    category: "stdout",
    output: "ready\n",
    sourceReference: 5,
    source: { path: "/private/source.ts", sourceReference: 99 },
    scopes: [{ name: "locals" }]
  });
  client.publish("thread", {
    reason: "started",
    threadId: 3,
    threadName: "worker",
    variables: [{ value: "drop" }]
  });
  client.publish("process", {
    name: "private-program-name",
    systemProcessId: 44,
    nested: { raw: "drop" }
  });
  client.publish("terminated", {
    restart: false,
    exitCode: 0,
    result: "drop"
  });
  client.publish("module", {
    module: { id: "private", path: "/private/module" }
  });

  const page = await provider.drainEvents({ cursor: 0, limit: 8 });
  assert.deepEqual(page.items.map((event) => event.kind), [
    "continued",
    "stopped",
    "output",
    "thread",
    "process",
    "terminated"
  ]);
  assert.equal(page.items[0]?.threadId, 2);
  assert.equal(page.items[0]?.data, undefined);
  assert.equal(page.items[1]?.threadId, 2);
  assert.deepEqual(page.items[1]?.data, {
    reason: "breakpoint",
    description: "paused",
    allThreadsStopped: true,
    hitBreakpointIds: [7]
  });
  assert.deepEqual(page.items[2], {
    sequence: 3,
    timestamp: page.items[2]?.timestamp,
    kind: "output",
    sessionId: "dap_events",
    message: "ready\n",
    category: "stdout",
    data: { sourceReference: 5 }
  });
  assert.equal(page.items[3]?.threadId, 3);
  assert.deepEqual(page.items[3]?.data, { reason: "started", threadName: "worker" });
  assert.deepEqual(page.items[4]?.data, { processId: 44 });
  assert.deepEqual(page.items[5]?.data, { exitCode: 0, restart: false });
  assert.doesNotMatch(JSON.stringify(page), /token|secret|stackFrames|private|scopes|nested|result|systemProcessId/);
});

test("observing and draining a stop preserves queued and pending breakpoint waiters", async () => {
  const { client, dap } = createDapSession("dap_stops");
  const observedThreadIds: unknown[] = [];
  const deliveryOrder: string[] = [];
  dap.onRuntimeEvent((event) => {
    if (event.event !== "stopped" || !event.body) return;
    deliveryOrder.push("runtime");
    observedThreadIds.push(event.body.threadId);
    event.body.threadId = 99;
    throw new Error("observer failure must be isolated");
  });
  const provider = new DapRuntimeProvider(dap, new RuntimeEventBuffer("dap_stops", 8));
  dap.on("stopped", () => deliveryOrder.push("stopped"));
  dap.startClient();

  client.publish("stopped", { reason: "breakpoint", threadId: 2 });
  const queuedPage = await provider.drainEvents({ cursor: 0, limit: 8 });
  assert.equal(queuedPage.items[0]?.threadId, 2, "listeners receive isolated event copies");
  assert.equal((await provider.waitForBreakpoint(100)).threadId, 2, "drain does not consume a queued stop");
  assert.deepEqual(deliveryOrder, ["runtime", "stopped"], "observers run before stopped delivery");

  const pendingStop = provider.waitForBreakpoint(100);
  client.publish("stopped", { reason: "step", threadId: 3 });
  const pendingPage = await provider.drainEvents({ cursor: queuedPage.nextCursor, limit: 8 });
  assert.equal(pendingPage.items[0]?.threadId, 3);
  assert.equal((await pendingStop).threadId, 3, "observation does not block a pending stop waiter");
  assert.deepEqual(observedThreadIds, [2, 3]);
  assert.deepEqual(deliveryOrder, ["runtime", "stopped", "runtime", "stopped"]);
});

test("provider event draining preserves buffer cursor, replay, and overflow semantics", async () => {
  const { client, dap } = createDapSession("dap_overflow");
  const provider = new DapRuntimeProvider(dap, new RuntimeEventBuffer("dap_overflow", 2));
  dap.startClient();

  client.publish("continued", { threadId: 1 });
  client.publish("output", { category: "console", output: "two" });
  client.publish("thread", { reason: "started", threadId: 2 });

  const overflow = await provider.drainEvents({ cursor: 0, limit: 8 });
  assert.equal(overflow.overflowed, true);
  assert.equal(overflow.droppedCount, 1);
  assert.equal(overflow.oldestCursor, 2);
  assert.deepEqual(overflow.items.map((event) => [event.sequence, event.kind]), [
    [2, "output"],
    [3, "thread"]
  ]);

  const replay = await provider.drainEvents({ cursor: 1, limit: 1 });
  assert.deepEqual(replay.items.map((event) => event.sequence), [2]);
  assert.equal(replay.hasMore, true);
  assert.deepEqual((await provider.drainEvents()).items.map((event) => event.sequence), [2, 3]);
  assert.deepEqual((await provider.drainEvents()).items, []);
});
