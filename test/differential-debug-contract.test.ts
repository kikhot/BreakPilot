import assert from "node:assert/strict";
import fs from "node:fs";

const fixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/differential/hello-controller.json", import.meta.url), "utf8")
) as {
  source: { fileSuffix: string; line: number };
  expected: Record<string, string>;
  idea: {
    position: { line: number };
    framePresentation: string;
    values: Record<string, string>;
  };
  breakpilot: {
    position: { line: number };
    values: Array<{ path: string[]; value: string }>;
  };
};

const canonicalSource = {
  fileSuffix: "src/main/java/com/example/demo/controller/HelloController.java",
  line: 24
};
const canonicalExpected = {
  normalizedName: "Ada Lovelace",
  score: "28",
  balanced: "true",
  multiPart: "true"
};

assert.deepEqual(fixture.source, canonicalSource);
assert.deepEqual(fixture.expected, canonicalExpected);
assert.equal(
  fixture.idea.framePresentation,
  "hello:24, HelloController (com.example.demo.controller)"
);
assert.deepEqual(fixture.idea.values, {
  normalizedName: "Ada Lovelace",
  "analysis.score": "28"
});
assert.deepEqual(fixture.breakpilot.values, [
  { path: ["normalizedName"], value: "Ada Lovelace" },
  { path: ["analysis", "score"], value: "28" },
  { path: ["analysis", "balanced"], value: "true" },
  { path: ["analysis", "multiPart"], value: "true" }
]);
const breakpilotValues = Object.fromEntries(
  fixture.breakpilot.values.map((item) => [item.path.join("."), item.value])
);
assert.deepEqual(Object.keys(breakpilotValues).sort(), [
  "analysis.balanced",
  "analysis.multiPart",
  "analysis.score",
  "normalizedName"
]);

assert.equal(fixture.idea.position.line, fixture.source.line);
assert.equal(fixture.breakpilot.position.line, fixture.source.line);
const frameLine = Number(fixture.idea.framePresentation.match(/\bhello:(\d+)\b/)?.[1]);
assert.equal(frameLine, fixture.source.line);
assert.equal(fixture.idea.values.normalizedName, fixture.expected.normalizedName);
assert.equal(breakpilotValues.normalizedName, fixture.expected.normalizedName);
assert.equal(fixture.idea.values["analysis.score"], fixture.expected.score);
assert.equal(breakpilotValues["analysis.score"], fixture.expected.score);
assert.equal(breakpilotValues["analysis.balanced"], fixture.expected.balanced);
assert.equal(breakpilotValues["analysis.multiPart"], fixture.expected.multiPart);

const volatileKeys = new Set([
  "threadId",
  "frameId",
  "objectId",
  "clientId",
  "sessionId",
  "ideSessionId",
  "variablesReference"
]);
function assertSanitized(value: unknown, path = "$fixture"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSanitized(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.equal(volatileKeys.has(key), false, `${path}.${key} must not contain a volatile identity`);
    assertSanitized(child, `${path}.${key}`);
  }
}
assertSanitized(fixture);

console.log("differential debugger contract tests ok");
