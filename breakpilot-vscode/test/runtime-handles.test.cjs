const assert = require("node:assert/strict");
const test = require("node:test");

const { PauseScopedHandleRegistry } = require("../out/debugger/PauseScopedHandleRegistry.js");

test("VS Code opaque handles resolve only for their original session and epoch", () => {
  const handles = new PauseScopedHandleRegistry(2);
  const ref = handles.register({
    sessionId: "session-1",
    pauseEpoch: 3,
    dapVariablesReference: 19,
    parentVariablesReference: 7,
    name: "score"
  });
  assert.match(ref, /^bpref_[0-9a-f-]+$/);
  assert.equal(handles.resolve(ref, "session-1", 3)?.parentVariablesReference, 7);
  assert.equal(handles.resolve(ref, "session-1", 4), undefined);
  assert.equal(handles.resolve(ref, "session-2", 3), undefined);
  handles.invalidateSession("session-1");
  assert.equal(handles.resolve(ref, "session-1", 3), undefined);
});

test("VS Code handle registry evicts its oldest descriptor", () => {
  const handles = new PauseScopedHandleRegistry(2);
  const first = handles.register({ sessionId: "s", pauseEpoch: 1, dapVariablesReference: 1, name: "a" });
  handles.register({ sessionId: "s", pauseEpoch: 1, dapVariablesReference: 2, name: "b" });
  handles.register({ sessionId: "s", pauseEpoch: 1, dapVariablesReference: 3, name: "c" });
  assert.equal(handles.resolve(first, "s", 1), undefined);
});
