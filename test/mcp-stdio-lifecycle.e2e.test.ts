import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeManifest } from "../src/hub/BridgeManifest.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

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
      "  enabled: true",
      "  bridge:",
      "    host: 127.0.0.1",
      "    port: 27891"
    ].join("\n")
  );
  return { root, policyPath };
}

function bridgeFile(root: string): string {
  return path.join(root, ".breakpilot", "bridge.json");
}

function spawnMcp(policyPath: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--experimental-strip-types", cliEntry, "mcp", "serve", "--policy", policyPath], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function runCli(args: string[], timeoutMs = 10000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cliEntry, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not terminate within ${timeoutMs}ms for args: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

async function waitFor<T>(read: () => T | null | undefined, message: string, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
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

function readManifest(root: string): BridgeManifest | null {
  try {
    return JSON.parse(fs.readFileSync(bridgeFile(root), "utf8")) as BridgeManifest;
  } catch {
    return null;
  }
}

async function assertBridgeStatus(manifest: BridgeManifest): Promise<void> {
  assert.ok(manifest.bridgeUrl, "manifest should include bridgeUrl");
  const statusUrl = manifest.bridgeUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const response = await fetch(`${statusUrl}/status`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { instanceId?: string; lifecycle?: string };
  assert.equal(payload.instanceId, manifest.instanceId);
  assert.equal(payload.lifecycle, "stdio");
}

{
  const { root, policyPath } = makeWorkspace();
  const child = spawnMcp(policyPath);
  try {
    const manifest = await waitFor(() => readManifest(root), "MCP did not write bridge manifest.");
    assert.equal(manifest.owner, "mcp");
    assert.equal(manifest.lifecycle, "stdio");
    assert.equal(manifest.workspaceRoot, root);
    assert.equal(manifest.controlUrl, undefined);
    assert.equal(manifest.controlToken, undefined);
    await assertBridgeStatus(manifest);

    const status = await runCli(["daemon", "status", "--policy", policyPath]);
    assert.equal(status.code, 1);
    assert.match(status.stdout, /stdio MCP instance/);

    child.stdin.end();
    await waitForExit(child);
    await waitFor(() => (!fs.existsSync(bridgeFile(root)) ? true : null), "MCP did not remove bridge manifest.");
  } finally {
    child.kill("SIGKILL");
  }
}

{
  const { root, policyPath } = makeWorkspace();
  const first = spawnMcp(policyPath);
  let second: ChildProcessWithoutNullStreams | null = null;
  try {
    const firstManifest = await waitFor(() => readManifest(root), "First MCP did not write bridge manifest.");
    second = spawnMcp(policyPath);
    const secondManifest = await waitFor(() => {
      const manifest = readManifest(root);
      return manifest && manifest.instanceId !== firstManifest.instanceId ? manifest : null;
    }, "Second MCP did not replace bridge manifest.");

    first.stdin.end();
    await waitForExit(first);
    const afterFirstExit = await waitFor(() => readManifest(root), "Old MCP removed new bridge manifest.");
    assert.equal(afterFirstExit.instanceId, secondManifest.instanceId);

    second.stdin.end();
    await waitForExit(second);
    await waitFor(() => (!fs.existsSync(bridgeFile(root)) ? true : null), "Second MCP did not remove bridge manifest.");
  } finally {
    first.kill("SIGKILL");
    second?.kill("SIGKILL");
  }
}

console.log("mcp stdio lifecycle e2e ok");
