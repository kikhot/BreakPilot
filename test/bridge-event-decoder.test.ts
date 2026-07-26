import assert from "node:assert/strict";
import test from "node:test";
import { decodeBridgeEvent, safeBridgeDataRecord } from "../src/ide/BridgeEventDecoder.ts";

test("bridge decoder snapshots ordinary nested JSON without retaining input objects", () => {
  const source = { clientId: "client-a", message: { type: "snapshot", result: { values: [1, false, "ok"] } } };
  const decoded = decodeBridgeEvent(source);
  assert.ok(decoded);
  assert.equal(decoded.clientId, "client-a");
  assert.notEqual(decoded.message, source.message);
  assert.equal(Object.getPrototypeOf(decoded.message), null);
  assert.deepEqual(decoded.message.result.values, [1, false, "ok"]);
});

test("bridge decoder rejects accessors and revoked proxies without invoking user code", () => {
  let getterCalls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "message", {
    enumerable: true,
    get: () => { getterCalls += 1; return {}; }
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();

  assert.equal(decodeBridgeEvent(accessor), null);
  assert.equal(getterCalls, 0);
  assert.equal(safeBridgeDataRecord(revoked.proxy), null);
});

test("bridge decoder rejects cycles and budgets while safely copying shared DAG nodes", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const child = { value: 1 };
  const shared = { left: child, right: child };
  const wide = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key${index}`, index]));

  assert.equal(safeBridgeDataRecord(cyclic), null);
  const sharedSnapshot = safeBridgeDataRecord(shared);
  assert.ok(sharedSnapshot);
  assert.equal((sharedSnapshot.left as { value?: unknown }).value, 1);
  assert.equal((sharedSnapshot.right as { value?: unknown }).value, 1);
  assert.notEqual(sharedSnapshot.left, sharedSnapshot.right);
  assert.equal(safeBridgeDataRecord(wide), null);
});
