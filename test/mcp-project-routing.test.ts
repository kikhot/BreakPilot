import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import { BreakPilotHub, type HubServerHandle } from "../src/hub/HubServer.ts";
import type { RuntimeContext } from "../src/runtime/createRuntime.ts";
import type { ToolDefinition, ToolResponse } from "../src/types/control.ts";
import type { AnyRecord } from "../src/types/json.ts";
import type { DebugSessionRecord, RuntimeDebugProvider } from "../src/types/sessions.ts";

interface ProjectFixture {
  hub: BreakPilotHub;
  handle: HubServerHandle;
  projectA: string;
  projectB: string;
  runtimeA: RuntimeContext;
  runtimeB: RuntimeContext;
  statusArgsA: AnyRecord[];
  statusArgsB: AnyRecord[];
}

async function withProjectFixture(run: (fixture: ProjectFixture) => Promise<void>): Promise<void> {
  const projectA = mkdtempSync(path.join(tmpdir(), "breakpilot-routing-a-"));
  const projectB = mkdtempSync(path.join(tmpdir(), "breakpilot-routing-b-"));
  const hub = new BreakPilotHub({ port: 0, idleTimeoutMs: 0, defaultProjectPath: projectA });
  const runtimeA = hub.projects.getOrCreate(projectA);
  const runtimeB = hub.projects.getOrCreate(projectB);
  const statusArgsA: AnyRecord[] = [];
  const statusArgsB: AnyRecord[] = [];

  runtimeA.manager.bpDebugStatus = async (args) => {
    statusArgsA.push(structuredClone(args ?? {}));
    return { sessions: [], ideConnected: false, warnings: ["project-a"] };
  };
  runtimeB.manager.bpDebugStatus = async (args) => {
    statusArgsB.push(structuredClone(args ?? {}));
    return { sessions: [], ideConnected: false, warnings: ["project-b"] };
  };

  const handle = await hub.start();
  try {
    await run({
      hub,
      handle,
      projectA,
      projectB,
      runtimeA,
      runtimeB,
      statusArgsA,
      statusArgsB
    });
  } finally {
    await handle.close();
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  }
}

async function withModernClient<T>(
  url: string,
  headers: Record<string, string>,
  run: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client(
    { name: "project-routing-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: 2_000, maxRetries: 0 } } }
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers }
  }));
  try {
    assert.equal(client.getProtocolEra(), "modern");
    return await run(client);
  } finally {
    await client.close();
  }
}

async function callStatus(
  url: string,
  headers: Record<string, string> = {},
  args: AnyRecord = {}
): Promise<ToolResponse> {
  return await withModernClient(url, headers, async (client) => {
    const result = await client.callTool({ name: "bp_debug_status", arguments: args });
    return result.structuredContent as ToolResponse;
  });
}

async function listTools(
  url: string,
  headers: Record<string, string>
): Promise<ToolDefinition[]> {
  return await withModernClient(url, headers, async (client) => {
    return (await client.listTools()).tools as ToolDefinition[];
  });
}

function startLanguageEnum(tools: ToolDefinition[]): unknown[] | undefined {
  return tools.find(({ name }) => name === "bp_debug_start")?.inputSchema.properties?.language?.enum;
}

test("concurrent modern MCP calls keep request-local project headers isolated", async () => {
  await withProjectFixture(async ({ handle, projectA, projectB }) => {
    const [a, b] = await Promise.all([
      callStatus(`${handle.url}/mcp`, { "x-breakpilot-project": projectA }),
      callStatus(`${handle.url}/mcp`, { "x-breakpilot-project": projectB })
    ]);

    assert.deepEqual(a.warnings, ["project-a"]);
    assert.deepEqual(b.warnings, ["project-b"]);
  });
});

test("request headers win over query project hints", async () => {
  await withProjectFixture(async ({ handle, projectA, projectB }) => {
    const result = await callStatus(
      `${handle.url}/mcp?projectPath=${encodeURIComponent(projectA)}`,
      { "x-breakpilot-project": projectB }
    );

    assert.deepEqual(result.warnings, ["project-b"]);
  });
});

test("argument projectPath wins over request-local header and query hints", async () => {
  await withProjectFixture(async ({ handle, projectA, projectB }) => {
    const result = await callStatus(
      `${handle.url}/mcp?projectPath=${encodeURIComponent(projectB)}`,
      { "x-breakpilot-project": projectB },
      { projectPath: projectA }
    );

    assert.deepEqual(result.warnings, ["project-a"]);
  });
});

test("blank argument projectPath falls through to workspace and dispatches its canonical path", async () => {
  await withProjectFixture(async ({
    handle,
    projectA,
    projectB,
    statusArgsA,
    statusArgsB
  }) => {
    const result = await callStatus(
      `${handle.url}/mcp?projectPath=${encodeURIComponent(projectA)}`,
      { "x-breakpilot-project": projectA },
      { projectPath: "   ", workspace: projectB }
    );

    assert.deepEqual(result.warnings, ["project-b"]);
    assert.equal(statusArgsA.length, 0);
    assert.equal(statusArgsB.length, 1);
    assert.equal(statusArgsB[0]?.projectPath, path.resolve(projectB));
    assert.equal(statusArgsB[0]?.workspace, projectB);
  });
});

test("an invalid argument projectPath reaches schema validation instead of being replaced", async () => {
  await withProjectFixture(async ({ handle, projectB, statusArgsB }) => {
    const result = await withModernClient(`${handle.url}/mcp`, {}, async (client) => {
      return await client.callTool({
        name: "bp_debug_status",
        arguments: { projectPath: 42, workspace: projectB }
      });
    });
    const structured = result.structuredContent as ToolResponse;

    assert.equal(result.isError, true);
    assert.equal(structured.error?.code, "INVALID_ARGUMENT");
    assert.equal(statusArgsB.length, 0);
  });
});

test("a unique explicit debug session selects its project without a path selector", async () => {
  await withProjectFixture(async ({ handle, projectB, runtimeB }) => {
    const provider: RuntimeDebugProvider = {
      kind: "custom",
      sessionId: "session-project-b",
      language: "node",
      workspaceRoot: projectB,
      capabilities: {
        pause: "unsupported",
        stepping: "unsupported",
        runToLine: "unsupported",
        variableReferences: "unsupported",
        setValue: "unsupported",
        breakpointUpdate: "unsupported",
        conditionalBreakpoints: "unsupported",
        hitConditionalBreakpoints: "unsupported",
        tracepoints: "unsupported",
        eventDrain: "unsupported"
      },
      threadId: 22,
      async setBreakpoints() {
        return [];
      },
      async waitForBreakpoint() {
        throw new Error("not used by project routing test");
      },
      async getRuntimeSnapshot() {
        throw new Error("not used by project routing test");
      },
      async evaluate() {
        return {};
      },
      async continue() {
        return {};
      },
      async step() {
        return {};
      },
      async disconnect() {
        return {};
      },
      async listThreads() {
        return [{ id: 22, name: "project-b-thread" }];
      }
    };
    const session: DebugSessionRecord = {
      sessionId: "session-project-b",
      language: "node",
      workspaceRoot: projectB,
      mode: "headless",
      owner: "mcp",
      state: "paused",
      createdAt: new Date(0).toISOString(),
      providerKind: provider.kind,
      provider
    };
    runtimeB.manager.sessions.sessions.set(session.sessionId, session);

    const result = await withModernClient(`${handle.url}/mcp`, {}, async (client) => {
      return await client.callTool({
        name: "bp_debug_threads",
        arguments: { sessionId: "session-project-b" }
      });
    });

    assert.deepEqual(result.structuredContent, {
      threads: [{ id: 22, name: "project-b-thread", current: true }]
    });
  });
});

test("concurrent tools/list responses keep dynamic language schemas request-local", async () => {
  await withProjectFixture(async ({ handle, projectA, projectB, runtimeA, runtimeB }) => {
    runtimeA.manager.adapters.register(new LanguageAdapter({
      language: "project-a-language",
      adapterId: "project-a-language",
      envCommandName: "BREAKPILOT_PROJECT_A_ADAPTER"
    }));
    runtimeB.manager.adapters.register(new LanguageAdapter({
      language: "project-b-language",
      adapterId: "project-b-language",
      envCommandName: "BREAKPILOT_PROJECT_B_ADAPTER"
    }));

    const [a, b] = await Promise.all([
      listTools(`${handle.url}/mcp`, { "x-breakpilot-project": projectA }),
      listTools(`${handle.url}/mcp`, { "x-breakpilot-project": projectB })
    ]);

    assert.deepEqual(startLanguageEnum(a), [
      "python",
      "node",
      "typescript",
      "java",
      "project-a-language"
    ]);
    assert.deepEqual(startLanguageEnum(b), [
      "python",
      "node",
      "typescript",
      "java",
      "project-b-language"
    ]);
  });
});
