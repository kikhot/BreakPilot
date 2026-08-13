import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { DEFAULT_HUB_HOST, DEFAULT_HUB_PORT } from "../src/hub/HubServer.ts";

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

interface StdoutCollector {
  lines: string[];
  waitForResponse(id: number, timeoutMs?: number): Promise<Record<string, unknown>>;
}

function collectStdout(child: ChildProcessWithoutNullStreams): StdoutCollector {
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
    for (const wake of waiters) wake();
  });

  return {
    lines,
    waitForResponse(id, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const inspect = (): void => {
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const frame = JSON.parse(line) as Record<string, unknown>;
              if (frame.id === id) {
                cleanup();
                resolve(frame);
                return;
              }
            } catch {
              // Stdout cleanliness is asserted after process exit.
            }
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for MCP response id ${id}.`));
        }, timeoutMs);
        const cleanup = (): void => {
          clearTimeout(timer);
          waiters.delete(inspect);
        };
        waiters.add(inspect);
        inspect();
      });
    }
  };
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

async function isHubRunning(): Promise<boolean> {
  try {
    const response = await fetch(`http://${DEFAULT_HUB_HOST}:${DEFAULT_HUB_PORT}/status`, {
      signal: AbortSignal.timeout(1_000)
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function assertOwnedHubClosed(wasRunning: boolean): Promise<void> {
  if (!wasRunning) assert.equal(await isHubRunning(), false);
}

async function runRawLegacyLifecycle(): Promise<void> {
  const hubWasRunning = await isHubRunning();
  const { root, policyPath } = makeWorkspace();
  const child = spawnMcp(policyPath);
  const stdout = collectStdout(child);
  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "raw-legacy-cli-test", version: "1.0.0" }
      }
    })}\n`);
    const initialize = await stdout.waitForResponse(1) as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } };
    assert.equal(initialize.result?.protocolVersion, "2025-11-25");
    assert.equal(initialize.result?.serverInfo?.name, "breakpilot-debugger");

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const tools = await stdout.waitForResponse(2) as { result?: { tools?: { name: string }[] } };
    assert.ok(tools.result?.tools?.some((tool) => tool.name === "bp_debug_start"));
    assert.equal(tools.result?.tools?.some((tool) => tool.name === "debug_launch"), false);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "bp_debug_status", arguments: { projectPath: root } }
    })}\n`);
    const call = await stdout.waitForResponse(3) as {
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
    const errorCall = await stdout.waitForResponse(4) as {
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
    assert.equal(await waitForExit(child), 0);
    await assertOwnedHubClosed(hubWasRunning);

    const frames = stdout.lines.filter((line) => line.trim()).map((line) => JSON.parse(line) as {
      jsonrpc?: string;
      id?: unknown;
    });
    assert.deepEqual(frames.map(({ id }) => id), [1, 2, 3, 4]);
    assert.ok(frames.every(({ jsonrpc }) => jsonrpc === "2.0"));
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runModernSdkLifecycle(): Promise<void> {
  const hubWasRunning = await isHubRunning();
  const { root, policyPath } = makeWorkspace();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", cliEntry, "mcp", "serve", "--policy", policyPath],
    cwd: repoRoot,
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const client = new Client(
    { name: "modern-cli-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: 2_000, maxRetries: 0 } } }
  );
  try {
    await client.connect(transport);
    assert.ok(transport.pid, `SDK did not retain the formal CLI process.${stderr ? ` stderr: ${stderr}` : ""}`);
    assert.equal(client.getProtocolEra(), "modern");
    assert.ok((await client.listTools()).tools.some(({ name }) => name === "bp_debug_start"));
    const result = await client.callTool({
      name: "bp_debug_status",
      arguments: { projectPath: root }
    });
    assert.equal(result.isError, false);
    assert.deepEqual((result.structuredContent as { sessions?: unknown[] }).sessions, []);
  } finally {
    await client.close().catch(() => undefined);
    await assertOwnedHubClosed(hubWasRunning);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await runRawLegacyLifecycle();
await runModernSdkLifecycle();

console.log("mcp stdio lifecycle e2e ok");
