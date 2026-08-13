import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createBreakPilotMcpServer } from "../src/mcp/serverFactory.ts";
import type { ControlGateway } from "../src/control/ControlGateway.ts";

test("the MCP adapter advertises exact schemas and delegates invalid tool arguments", async () => {
  const calls: unknown[] = [];
  const gateway: ControlGateway = {
    listTools: () => [{
      name: "fixture_tool",
      description: "fixture",
      inputSchema: {
        type: "object",
        properties: { mode: { oneOf: [{ type: "string", enum: ["a", "b"] }, { $ref: "#/$defs/mode" }] } },
        $defs: { mode: { type: "integer", minimum: 1 } },
        required: ["mode"],
        additionalProperties: false
      },
      outputSchema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] }
    }],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { error: { code: "INVALID_ARGUMENT", message: "fixture rejected", retrySafe: true, actionMayHaveApplied: false } };
    }
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createBreakPilotMcpServer(gateway);
  const client = new Client({ name: "factory-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools[0]?.inputSchema, (await gateway.listTools())[0]?.inputSchema);
    assert.deepEqual(listed.tools[0]?.outputSchema, (await gateway.listTools())[0]?.outputSchema);
    const result = await client.callTool({ name: "fixture_tool", arguments: { mode: false } });
    assert.deepEqual(calls, [{ name: "fixture_tool", args: { mode: false } }]);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      error: { code: "INVALID_ARGUMENT", message: "fixture rejected", retrySafe: true, actionMayHaveApplied: false }
    });
    assert.equal(result.content[0]?.type, "text");
  } finally {
    await client.close();
    await server.close();
  }
});
