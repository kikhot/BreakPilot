import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

async function runNode(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("evidence CLI verifies an offline bundle", async () => {
  const fixture = path.resolve("test/fixtures/evidence/differential-v1");
  const result = await runNode(["src/evidence/differentialCli.ts", "verify", "--evidence-dir", fixture]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"outcome":"verified"/);
});

test("evidence E2E cannot report missing infrastructure as success", async () => {
  const missing = path.resolve(".breakpilot/missing-differential-config.json");
  const result = await runNode(["src/evidence/differentialCli.ts", "e2e", "--config", missing]);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /EVIDENCE_INFRASTRUCTURE_UNAVAILABLE/);
});
