#!/usr/bin/env -S node --experimental-strip-types
import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AnyRecord, DebugMcpPolicy, ToolResponse } from "./types.ts";
import { loadPolicy } from "./security/PolicyLoader.ts";
import { DebugSessionManager } from "./sessions/DebugSessionManager.ts";
import { ToolRouter } from "./mcp/tools.ts";
import { IdeBridgeServer } from "./ide/IdeBridgeServer.ts";
import { stableJson } from "./utils/json.ts";
import { AuditLogger } from "./audit/AuditLogger.ts";

interface RuntimeOptions {
  policyPath?: string;
  enableIdeBridge?: boolean;
  ideBridgePort?: number | string;
}

interface RuntimeContext {
  policy: DebugMcpPolicy;
  manager: DebugSessionManager;
  router: ToolRouter;
  ideBridge: IdeBridgeServer | null;
}

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: AnyRecord;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function stringArg(args: Record<string, string | boolean>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
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

async function handleJsonRpc(router: ToolRouter, message: JsonRpcMessage): Promise<AnyRecord> {
  if (message.method === "initialize") {
    return {
      protocolVersion: "2025-03-26",
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: "breakpilot-debug-mcp",
        version: "0.1.0"
      }
    };
  }
  if (message.method === "tools/list") {
    return { tools: router.listTools() };
  }
  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params ?? {};
    const result = await router.callTool(name, args ?? {});
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

export function startStdio(router: ToolRouter): void {
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
      handleJsonRpc(router, message)
        .then((result) => writeJsonRpc(message.id, result))
        .catch((error: unknown) => {
          const typedError = error as Error;
          writeJsonRpc(message.id, null, { code: -32603, message: typedError.message });
        });
    }
  });
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function startHttp(router: ToolRouter, port: number | string, host = "127.0.0.1"): Server {
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "GET" && req.url === "/tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tools: router.listTools() }));
        return;
      }
      if (req.method === "GET" && req.url === "/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/tools/call") {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");
        const result: ToolResponse = await router.callTool(payload.name, payload.arguments ?? {});
        res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { message: "Not found" } }));
    } catch (error) {
      const typedError = error as Error;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { message: typedError.message } }));
    }
  });
  server.listen(Number(port), host);
  return server;
}

export function createRuntime(options: RuntimeOptions = {}): RuntimeContext {
  const policy = loadPolicy(options.policyPath);
  const audit = new AuditLogger(policy);
  let ideBridge: IdeBridgeServer | null = null;
  const bridgePort = options.ideBridgePort ?? policy.ide?.bridge?.port;
  if (options.enableIdeBridge && policy.ide?.enabled) {
    ideBridge = new IdeBridgeServer({
      host: policy.ide.bridge.host,
      port: bridgePort,
      audit
    });
    ideBridge.start();
  }
  const manager = new DebugSessionManager({ policy, ideBridge });
  const router = new ToolRouter(manager);
  return { policy, manager, router, ideBridge };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const enableIdeBridge = Boolean(args["ide-bridge-port"] || args["ide-bridge"]);
  const runtime = createRuntime({
    policyPath: stringArg(args, "policy"),
    enableIdeBridge,
    ideBridgePort: stringArg(args, "ide-bridge-port")
  });

  if (args["http-port"]) {
    const host = stringArg(args, "host") || "127.0.0.1";
    const port = stringArg(args, "http-port") || "27890";
    startHttp(runtime.router, port, host);
    process.stderr.write(
      `debug-mcp HTTP listening on ${host}:${port}\n`
    );
  }

  if (enableIdeBridge && runtime.ideBridge) {
    const bridge = runtime.ideBridge.status();
    process.stderr.write(`debug-mcp IDE bridge listening on ${bridge.host}:${bridge.port}\n`);
  }

  if (!args["http-port"] || args.stdio) {
    startStdio(runtime.router);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const typedError = error as Error;
    process.stderr.write(`${typedError.stack || typedError.message}\n`);
    process.exit(1);
  });
}
