import { Server, type CallToolResult, type ListToolsResult } from "@modelcontextprotocol/server";
import type { ControlGateway } from "../control/ControlGateway.ts";
import { summarizeToolResult } from "../control/ToolTextSummary.ts";
import type { ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";

export function toMcpToolCallResult(name: string, result: ToolResponse): CallToolResult {
  return {
    content: [{ type: "text", text: summarizeToolResult(name, result as AnyRecord) }],
    structuredContent: result,
    isError: Boolean(result.error)
  };
}

export function createBreakPilotMcpServer(gateway: ControlGateway): Server {
  const server = new Server(
    { name: "breakpilot-debugger", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({
    tools: (await gateway.listTools()) as ListToolsResult["tools"]
  }));
  server.setRequestHandler("tools/call", async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = (request.params.arguments as AnyRecord | undefined) ?? {};
    return toMcpToolCallResult(name, await gateway.callTool(name, args));
  });
  return server;
}
