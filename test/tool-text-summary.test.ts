import assert from "node:assert/strict";
import test from "node:test";

import { summarizeToolResult } from "../src/control/ToolTextSummary.ts";

test("MCP summaries are semantic, single-line, bounded, and do not copy JSON", () => {
  const result = {
    state: "paused",
    at: { filePath: "src/HelloController.java", line: 21 },
    locals: [{ name: "name", value: "Ada-Lovelace" }, { name: "count", value: 1 }],
    pauseId: 7
  };
  const summary = summarizeToolResult("bp_debug_control", result);
  assert.equal(summary, "Paused at src/HelloController.java:21 with 2 locals.");
  assert.equal(summary.includes(JSON.stringify(result)), false);
  assert.equal(summary.includes("\n"), false);
  assert.equal(summary.length <= 160, true);
});

test("generic and error summaries remain bounded", () => {
  assert.equal(
    summarizeToolResult("bp_debug_status", { sessions: [], ideConnected: true }),
    "IDE connected; no active debug sessions."
  );
  const error = summarizeToolResult("bp_debug_eval", {
    error: { code: "TOOL_FAILED", message: "x".repeat(400) }
  });
  assert.equal(error.length <= 160, true);
});
