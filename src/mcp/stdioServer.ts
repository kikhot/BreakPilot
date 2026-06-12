import type { ControlGateway } from "../control/ControlGateway.ts";
import type { AnyRecord } from "../types/json.ts";
import { stableJson } from "../utils/json.ts";

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: AnyRecord;
}

function writeJsonRpc(id: JsonRpcMessage["id"], result?: unknown, error?: AnyRecord): void {
  const response: AnyRecord = {
    jsonrpc: "2.0",
    id
  };
  if (error) response.error = error;
  else response.result = result;
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function handleJsonRpc(gateway: ControlGateway, message: JsonRpcMessage): Promise<AnyRecord> {
  if (message.method === "initialize") {
    return {
      protocolVersion: "2025-03-26",
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: "breakpilot-debugger",
        version: "0.1.0"
      }
    };
  }
  if (message.method === "tools/list") {
    return { tools: await gateway.listTools() };
  }
  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params ?? {};
    const result = await gateway.callTool(name, args ?? {});
    return {
      content: [
        {
          type: "text",
          text: stableJson(result, true)
        }
      ],
      isError: result.ok === false
    };
  }
  if (message.method === "ping") return {};
  throw new Error(`Unsupported JSON-RPC method: ${message.method}`);
}

export function startStdio(gateway: ControlGateway): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        const typedError = error as Error;
        writeJsonRpc(null, null, { code: -32700, message: typedError.message });
        continue;
      }
      if (!message.id && message.method?.startsWith("notifications/")) continue;
      handleJsonRpc(gateway, message)
        .then((result) => writeJsonRpc(message.id, result))
        .catch((error: unknown) => {
          const typedError = error as Error;
          writeJsonRpc(message.id, null, { code: -32603, message: typedError.message });
        });
    }
  });
}
