import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("VS Code breakpoint snapshots keep enabled separate from verified", () => {
  const source = fs.readFileSync(
    path.join(root, "breakpilot-vscode", "src", "debugger", "BreakpointSync.ts"),
    "utf8"
  );
  assert.match(source, /enabled:\s*breakpoint\.enabled/);
  assert.match(source, /verified:\s*true/);
  assert.doesNotMatch(source, /verified:\s*breakpoint\.enabled/);
});

test("IDE breakpoint remove handlers send their explicit removal result", () => {
  const vscodeSource = fs.readFileSync(
    path.join(root, "breakpilot-vscode", "src", "debugger", "BreakpointSync.ts"),
    "utf8"
  );
  const ideaSource = fs.readFileSync(
    path.join(root, "breakpilot-idea", "src", "main", "kotlin", "debugger", "BreakpointSync.kt"),
    "utf8"
  );
  assert.match(vscodeSource, /let removed = false;/);
  assert.match(vscodeSource, /breakpointId:\s*agentId,\s*removed/);
  assert.match(vscodeSource, /if \(entry\)[\s\S]*removed = true;/);
  assert.match(ideaSource, /removed\s*=\s*removed/);
});
