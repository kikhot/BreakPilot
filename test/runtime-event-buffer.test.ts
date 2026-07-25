import assert from "node:assert/strict";
import { RuntimeEventBuffer } from "../src/runtime/RuntimeEventBuffer.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";

// Catches a loader default that diverges from the public 256-event retention policy.
assert.equal(loadPolicy(".missing-runtime-event-policy.yaml", {}).runtime.maxEventBuffer, 256);

// Catches a buffer that does not retain ordered events or advance its implicit reader.
const events = new RuntimeEventBuffer("debug-1", 2);
events.append({ kind: "continued" });
events.append({ kind: "stopped", threadId: 7 });
assert.deepEqual(events.read({ cursor: 0, limit: 1 }).items.map((item) => item.sequence), [1]);
assert.deepEqual(events.read({ cursor: 0, limit: 8 }).items.map((item) => item.kind), ["continued", "stopped"]);
assert.deepEqual(events.read().items.map((item) => item.sequence), [1, 2]);
assert.deepEqual(events.read().items, [], "default cursor advances atomically");
events.append({ kind: "output", message: "hello" });
const overflow = events.read({ cursor: 0, limit: 8 });
assert.equal(overflow.overflowed, true);
assert.equal(overflow.droppedCount, 1);
assert.equal(overflow.oldestCursor, 2);
assert.deepEqual(overflow.items.map((item) => item.sequence), [2, 3]);
assert.equal(overflow.items[0]?.sessionId, "debug-1");

// Catches an explicit replay cursor accidentally consuming the default reader state.
const replay = new RuntimeEventBuffer("debug-replay", 4);
replay.append({ kind: "continued" });
replay.append({ kind: "stopped", threadId: 7 });
assert.deepEqual(replay.read({ cursor: 0 }).items.map((item) => item.sequence), [1, 2]);
assert.deepEqual(replay.read().items.map((item) => item.sequence), [1, 2]);

// Catches session identity or sequencing leaking between buffers.
const firstSession = new RuntimeEventBuffer("debug-a", 2);
const secondSession = new RuntimeEventBuffer("debug-b", 2);
firstSession.append({ kind: "output", message: "first" });
secondSession.append({ kind: "output", message: "second" });
assert.deepEqual(firstSession.read({ cursor: 0 }).items.map((item) => [item.sequence, item.sessionId]), [[1, "debug-a"]]);
assert.deepEqual(secondSession.read({ cursor: 0 }).items.map((item) => [item.sequence, item.sessionId]), [[1, "debug-b"]]);

// Catches limits that can suppress all events or exceed the bounded page contract.
const limits = new RuntimeEventBuffer("debug-limits", 3);
limits.append({ kind: "continued" });
limits.append({ kind: "thread", threadId: 2 });
limits.append({ kind: "terminated" });
assert.deepEqual(limits.read({ cursor: 0, limit: 0 }).items.map((item) => item.sequence), [1]);
assert.deepEqual(limits.read({ cursor: 0, limit: -10 }).items.map((item) => item.sequence), [1]);
assert.deepEqual(limits.read({ cursor: 0, limit: 999 }).items.map((item) => item.sequence), [1, 2, 3]);

// Catches a default retention limit other than 256 or a read limit that expands retained history.
const defaultCapacity = new RuntimeEventBuffer("debug-capacity");
for (let sequence = 1; sequence <= 257; sequence += 1) {
  defaultCapacity.append({ kind: "output", message: String(sequence) });
}
const cappedHistory = defaultCapacity.read({ cursor: 0, limit: 999 });
assert.equal(cappedHistory.oldestCursor, 2);
assert.equal(cappedHistory.droppedCount, 1);
assert.equal(cappedHistory.items.length, 256);

// Catches the buffer retaining raw top-level payloads instead of normalized event data.
const normalized = new RuntimeEventBuffer("debug-normalized", 2);
normalized.append({
  kind: "breakpointError",
  message: "unverified",
  data: { breakpoint: "bp-1", nested: { retry: false }, callback: () => "ignored" },
  ignored: { arbitrary: true }
});
normalized.append({ kind: "tracepoint", message: "trace" });
const normalizedPage = normalized.read({ cursor: 0 });
assert.deepEqual(normalizedPage.breakpointErrors.map((event) => event.message), ["unverified"]);
assert.deepEqual(normalizedPage.tracepoints.map((event) => event.message), ["trace"]);
assert.deepEqual(normalizedPage.items[0]?.data, { breakpoint: "bp-1", nested: { retry: false } });
assert.equal("ignored" in (normalizedPage.items[0] ?? {}), false);

console.log("runtime event buffer tests ok");
