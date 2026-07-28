const assert = require("node:assert/strict");
const test = require("node:test");

const { StackReader } = require("../out/debugger/StackReader.js");

test("VS Code stack reader preserves trusted DAP pagination evidence", async () => {
  const requests = [];
  const reader = new StackReader({
    async customRequest(command, args) {
      requests.push({ command, args });
      return { stackFrames: [{ id: 4 }, { id: 5 }], totalFrames: 8 };
    }
  });
  const page = await reader.read(2, 3, 2, 6);
  assert.deepEqual(requests, [{ command: "stackTrace", args: { threadId: 2, startFrame: 3, levels: 2 } }]);
  assert.equal(page.completeness, "partial");
  assert.equal(page.nextOffset, 5);
  assert.equal(page.totalFrames, 8);
  assert.equal(page.pauseEpoch, 6);
});

test("VS Code stack reader reports unknown without a trusted total", async () => {
  const reader = new StackReader({ async customRequest() { return { stackFrames: [{ id: 1 }] }; } });
  const page = await reader.read(2, 0, 2, 4);
  assert.equal(page.completeness, "unknown");
  assert.equal(page.nextOffset, undefined);
  assert.equal(page.totalFrames, undefined);
});
