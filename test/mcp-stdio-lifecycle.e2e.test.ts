import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

function makeWorkspace(): { root: string; policyPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "breakpilot-mcp-"));
  const policyPath = path.join(root, "breakpilot.yaml");
  fs.writeFileSync(
    policyPath,
    [
      "workspace:",
      `  root: ${root}`,
      "  allowOutsideWorkspace: false",
      "ide:",
      "  enabled: false"
    ].join("\n")
  );
  return { root, policyPath };
}

function spawnMcp(policyPath: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--experimental-strip-types", cliEntry, "mcp", "serve", "--policy", policyPath], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function waitForLine(child: ChildProcessWithoutNullStreams, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MCP stdout.${stderr ? ` stderr: ${stderr}` : ""}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      const line = buffer.slice(0, index);
      cleanup();
      resolve(line);
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onStderr);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 10000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("MCP process did not exit."));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const { root, policyPath } = makeWorkspace();
const child = spawnMcp(policyPath);
try {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  const initialize = JSON.parse(await waitForLine(child)) as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } };
  assert.equal(initialize.result?.protocolVersion, "2025-11-25");
  assert.equal(initialize.result?.serverInfo?.name, "breakpilot-debugger");

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const tools = JSON.parse(await waitForLine(child)) as { result?: { tools?: { name: string }[] } };
  assert.ok(tools.result?.tools?.some((tool) => tool.name === "bp_debug_start"));
  assert.equal(tools.result?.tools?.some((tool) => tool.name === "debug_launch"), false);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "bp_debug_status", arguments: { projectPath: root } }
  })}\n`);
  const call = JSON.parse(await waitForLine(child)) as {
    result?: {
      content?: { type: string; text: string }[];
      structuredContent?: { sessions?: unknown[] };
      isError?: boolean;
    };
  };
  assert.deepEqual(call.result?.structuredContent?.sessions, [], JSON.stringify(call));
  assert.equal("ok" in (call.result?.structuredContent ?? {}), false);
  assert.equal("data" in (call.result?.structuredContent ?? {}), false);
  assert.equal(call.result?.content?.[0]?.text, "No active debug sessions; IDE disconnected.");
  assert.equal(call.result?.isError, false);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "bp_debug_run_to_line", arguments: { projectPath: root, filePath: "src/Hello.java", line: 0 } }
  })}\n`);
  const errorCall = JSON.parse(await waitForLine(child)) as {
    result?: {
      content?: { type: string; text: string }[];
      structuredContent?: { error?: { message?: string } };
      isError?: boolean;
    };
  };
  assert.equal(errorCall.result?.isError, true);
  assert.ok(errorCall.result?.structuredContent?.error?.message);
  assert.equal(errorCall.result?.content?.[0]?.text, errorCall.result?.structuredContent?.error?.message);

  assert.equal(fs.existsSync(path.join(root, ".breakpilot", "bridge.json")), false);

  child.stdin.end();
  await waitForExit(child);
} finally {
  child.kill("SIGKILL");
}

console.log("mcp stdio lifecycle e2e ok");
