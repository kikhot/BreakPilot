import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBridgeEvent,
  decodeBridgeEventDetailed,
  safeBridgeDataRecord
} from "../src/ide/BridgeEventDecoder.ts";

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

test("bridge decoder accepts a bounded variable page beyond the strict cumulative key budget", () => {
  const items = Array.from({ length: 12 }, (_, index) => ({
    name: `field${index}`,
    kind: "primitive",
    valuePreview: String(index),
    variablesReference: `bpref_${index}`,
    truncated: false,
    ref: `bpref_${index}`,
    pauseEpoch: 7,
    modifiable: false,
    mutationMode: null,
    type: "int",
    value: String(index)
  }));
  const source = {
    clientId: "client-a",
    message: {
      type: "ide_variables_snapshot",
      requestId: "request-a",
      result: { items }
    }
  };

  assert.equal(safeBridgeDataRecord(source.message), null);
  const decoded = decodeBridgeEvent(source);

  assert.ok(decoded);
  const decodedItems = (decoded.message.result as { items: Array<Record<string, unknown>> }).items;
  assert.equal(decodedItems.length, 12);
  assert.equal(decodedItems[11]?.name, "field11");
  assert.notEqual(decoded.message, source.message);
  assert.notEqual(decodedItems, items);
  assert.notEqual(decodedItems[0], items[0]);
  assert.equal(Object.getPrototypeOf(decodedItems[0]), null);
});

test("bridge decoder retains safe correlation when a response exceeds its payload budget", () => {
  const oversizedResult = Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => [`field${index}`, index])
  );

  const decoded = decodeBridgeEventDetailed({
    clientId: "client-a",
    message: {
      type: "ide_variables_snapshot",
      requestId: "request-a",
      sessionId: "session-a",
      ideSessionId: "ide-session-a",
      originRequestId: "request-a",
      pauseEpoch: 7,
      result: oversizedResult
    }
  });

  assert.deepEqual(decoded, {
    kind: "rejected",
    code: "BRIDGE_PAYLOAD_LIMIT",
    clientId: "client-a",
    correlation: {
      type: "ide_variables_snapshot",
      requestId: "request-a",
      sessionId: "session-a",
      ideSessionId: "ide-session-a",
      originRequestId: "request-a",
      pauseEpoch: 7
    }
  });
});
