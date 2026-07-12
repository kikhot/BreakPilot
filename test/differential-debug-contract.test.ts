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

const breakpilotValues = Object.fromEntries(
  fixture.breakpilot.values.map((item) => [item.path.join("."), item.value])
);

assert.equal(fixture.idea.position.line, fixture.source.line);
assert.equal(fixture.breakpilot.position.line, fixture.source.line);
assert.match(fixture.idea.framePresentation, /hello:24/);
assert.match(fixture.source.fileSuffix, /HelloController\.java$/);
assert.equal(fixture.idea.values.normalizedName, fixture.expected.normalizedName);
assert.equal(breakpilotValues.normalizedName, fixture.expected.normalizedName);
assert.equal(fixture.idea.values["analysis.score"], fixture.expected.score);
assert.equal(breakpilotValues["analysis.score"], fixture.expected.score);
assert.equal(breakpilotValues["analysis.balanced"], fixture.expected.balanced);
assert.equal(breakpilotValues["analysis.multiPart"], fixture.expected.multiPart);

console.log("differential debugger contract tests ok");
