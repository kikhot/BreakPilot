import assert from "node:assert/strict";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import {
  closeMcpResources,
  createMcpCleanupCoordinator
} from "../src/cli/commands/mcp.ts";
import type { ControlGateway } from "../src/control/ControlGateway.ts";
import { startStdio } from "../src/mcp/stdioServer.ts";
import type { ToolDefinition, ToolResponse } from "../src/types/control.ts";

const statusTool: ToolDefinition = {
  name: "bp_debug_status",
  description: "Return fixture debugger status.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string" },
      detail: {
        oneOf: [
          { type: "string", enum: ["summary", "full"] },
          { $ref: "#/$defs/detailLevel" }
        ]
      }
    },
    $defs: {
      detailLevel: { type: "integer", minimum: 1 }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: "object",
    properties: {
      sessions: { type: "array", items: {} },
      ideConnected: { type: "boolean" },
      warnings: { type: "array", items: { type: "string" } }
    },
    required: ["sessions", "ideConnected", "warnings"]
  }
};

const statusResult: ToolResponse = {
  sessions: [],
  ideConnected: false,
  warnings: ["stdio-fixture"]
};

function fixtureGateway(): ControlGateway {
  return {
    listTools: () => [statusTool],
    callTool: async (name) => {
      assert.equal(name, "bp_debug_status");
      return structuredClone(statusResult);
    }
  };
}

async function exerciseStdio(modern: boolean): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = startStdio(fixtureGateway(), { transport: serverTransport });
  const client = new Client(
    { name: modern ? "stdio-modern-test" : "stdio-legacy-test", version: "1.0.0" },
    modern
      ? { versionNegotiation: { mode: "auto", probe: { timeoutMs: 2_000, maxRetries: 0 } } }
      : undefined
  );

  try {
    assert.equal(typeof server?.close, "function", "startStdio must return its SDK server handle");
    await client.connect(clientTransport);
    assert.equal(client.getProtocolEra(), modern ? "modern" : "legacy");
    const listed = await client.listTools();
    assert.deepEqual(listed.tools, [statusTool]);

    const result = await client.callTool({
      name: "bp_debug_status",
      arguments: { projectPath: "/tmp/stdio-project" }
    });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, statusResult);
  } finally {
    if (server) await server.close();
    else process.stdin.pause();
    await client.close();
  }
}

test("stdio serves a legacy SDK client with exact schemas and structured results", async () => {
  await exerciseStdio(false);
});

test("stdio auto-negotiates the modern era with the same tool contract", async () => {
  await exerciseStdio(true);
});

test("CLI resource cleanup closes stdio before an owned Hub", async () => {
  const closed: string[] = [];
  await closeMcpResources(
    { close: async () => { closed.push("stdio"); } },
    { owned: true, handle: { close: async () => { closed.push("hub"); } } }
  );
  assert.deepEqual(closed, ["stdio", "hub"]);
});

test("CLI resource cleanup continues to an owned Hub after stdio close rejects", async () => {
  const closed: string[] = [];
  await closeMcpResources(
    {
      close: async () => {
        closed.push("stdio");
        throw new Error("stdio close failed");
      }
    },
    { owned: true, handle: { close: async () => { closed.push("hub"); } } }
  );
  assert.deepEqual(closed, ["stdio", "hub"]);
});

test("CLI cleanup races reuse one drain and exit only after it settles", async () => {
  let releaseCleanup: (() => void) | undefined;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const cleanupReasons: string[] = [];
  const exitCodes: number[] = [];
  const coordinator = createMcpCleanupCoordinator(
    async (reason) => {
      cleanupReasons.push(reason);
      await cleanupGate;
    },
    (code) => { exitCodes.push(code); }
  );

  const first = coordinator.cleanupAndExit(130, "sigint");
  const second = coordinator.cleanupAndExit(0, "stdio_end");
  assert.strictEqual(second, first);
  assert.deepEqual(cleanupReasons, ["sigint"]);
  assert.deepEqual(exitCodes, []);

  releaseCleanup?.();
  await Promise.all([first, second]);
  assert.deepEqual(cleanupReasons, ["sigint"]);
  assert.deepEqual(exitCodes, [130]);
});
