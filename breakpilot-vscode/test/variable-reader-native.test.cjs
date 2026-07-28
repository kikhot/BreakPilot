const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "vscode") return { debug: { activeStackItem: undefined } };
  return originalLoad.call(this, request, parent, isMain);
};
const { VariableReader } = require("../out/debugger/VariableReader.js");
Module._load = originalLoad;

function fixture(name = "text", overrides = {}) {
  let value = "initial";
  let applied = false;
  let failReadback = false;
  const session = {
    type: "java",
    async customRequest(command, args) {
      if (command === "stackTrace") return { stackFrames: [{ id: 11, name: "frame", line: 2, source: { path: "/workspace/Sample.java" } }] };
      if (command === "scopes") return { scopes: overrides.scopes ?? [{ name: "Locals", variablesReference: 10 }] };
      if (command === "variables") {
        if (applied && failReadback) throw new Error("readback unavailable");
        return {
          variables: typeof overrides.variables === "function"
            ? overrides.variables(args)
            : overrides.variables ?? [{ name, value, type: "String", variablesReference: 0 }]
        };
      }
      if (command === "setVariable") {
        applied = true;
        value = args.value;
        return { value };
      }
      throw new Error(`unexpected command ${command}`);
    }
  };
  const tracker = {
    onEpochChanged: () => ({ dispose() {} }),
    sessionId: () => "session",
    pauseEpoch: () => 3,
    find: () => session,
    sessionInfo: () => ({ threadId: 1 })
  };
  return {
    reader: new VariableReader({ send() {} }, tracker),
    session,
    failReadback() { failReadback = true; }
  };
}

test("primitive children receive native mutation handles and accept empty values", async () => {
  const { reader, session } = fixture();
  const snapshot = await reader.currentSnapshot(session, { threadId: 1, __pauseEpoch: 3 });
  const variable = snapshot.variables.locals.variables.text;
  assert.match(variable.ref, /^bpref_/);
  assert.equal(variable.modifiable, true);

  const mutation = await reader.setVariable("session", undefined, "", {}, variable.ref);
  assert.equal(mutation.result.applied, true);
  assert.equal(mutation.result.verified, true);
  assert.equal(mutation.result.newValue, "");
});

test("post-dispatch readback failures remain applied but unverified", async () => {
  const { reader, session, failReadback } = fixture();
  const snapshot = await reader.currentSnapshot(session, { threadId: 1, __pauseEpoch: 3 });
  const ref = snapshot.variables.locals.variables.text.ref;
  failReadback();

  const mutation = await reader.setVariable("session", undefined, "changed", {}, ref);
  assert.equal(mutation.result.applied, true);
  assert.equal(mutation.result.verified, false);
  assert.match(mutation.result.verificationError, /readback unavailable/);
});

test("redacted primitive values do not receive mutation handles", async () => {
  const { reader, session } = fixture("accessToken");
  const snapshot = await reader.currentSnapshot(session, {
    threadId: 1,
    __pauseEpoch: 3,
    redactPatterns: ["Token"]
  });
  const variable = snapshot.variables.locals.variables.accessToken;
  assert.equal(variable.valuePreview, "[redacted]");
  assert.equal(variable.ref, 0);
});

test("local scope and child limits are reported as partial", async () => {
  const { reader, session } = fixture("text", {
    scopes: [
      { name: "Locals", variablesReference: 10 },
      { name: "Arguments", variablesReference: 20 }
    ],
    variables: [
      { name: "first", value: "1", variablesReference: 0 },
      { name: "second", value: "2", variablesReference: 0 }
    ]
  });
  const snapshot = await reader.currentSnapshot(session, { threadId: 1, maxItems: 1, __pauseEpoch: 3 });
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.variables.locals.truncated, true);
  assert.deepEqual(Object.keys(snapshot.variables.locals.variables), ["first"]);
});

test("nested child limits mark the owning object as truncated", async () => {
  const { reader, session } = fixture("text", {
    variables(args) {
      if (args.variablesReference === 10) {
        return [{ name: "obj", value: "Object", variablesReference: 20 }];
      }
      return [
        { name: "first", value: "1", variablesReference: 0 },
        { name: "second", value: "2", variablesReference: 0 }
      ];
    }
  });
  const snapshot = await reader.currentSnapshot(session, {
    threadId: 1,
    maxItems: 1,
    maxDepth: 2,
    objectFields: "deep",
    __pauseEpoch: 3
  });
  const object = snapshot.variables.locals.variables.obj;
  assert.equal(snapshot.partial, true);
  assert.equal(object.truncated, true);
  assert.deepEqual(Object.keys(object.value), ["first"]);
});
