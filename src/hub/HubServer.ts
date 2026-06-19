import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";

import { IdeBridgeServer } from "../ide/IdeBridgeServer.ts";
import { IdeMessageTypes } from "../ide/IdeProtocol.ts";
import type { ToolDefinition, ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";
import { fail, ok } from "../utils/errors.ts";
import { McpSessionRegistry, type McpSessionRecord } from "./McpSessionRegistry.ts";
import { ProjectRuntimeRegistry } from "./ProjectRuntimeRegistry.ts";

export const DEFAULT_HUB_HOST = "127.0.0.1";
export const DEFAULT_HUB_PORT = 57987;
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const MCP_PROTOCOL_VERSION = "2025-11-25";

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: AnyRecord;
}

function toolCallResult(result: ToolResponse): AnyRecord {
  const isError = Boolean(result.error);
  return {
    content: [{ type: "text", text: isError ? result.error?.message ?? "error" : "ok" }],
    structuredContent: result,
    isError
  };
}

export interface HubServerOptions {
  host?: string;
  port?: number | string;
  defaultProjectPath?: string;
  idleTimeoutMs?: number;
  onIdle?: () => void | Promise<void>;
}

export interface HubServerHandle {
  server: Server;
  host: string;
  port: number;
  url: string;
  bridgeUrl: string;
  close(): Promise<void>;
}

export class BreakPilotHub {
  host: string;
  port: number;
  idleTimeoutMs: number;
  onIdle?: () => void | Promise<void>;
  ideBridge: IdeBridgeServer;
  projects: ProjectRuntimeRegistry;
  mcpSessions: McpSessionRegistry;
  server: Server | null;
  idleTimer: NodeJS.Timeout | null;

  constructor(options: HubServerOptions = {}) {
    this.host = options.host ?? DEFAULT_HUB_HOST;
    this.port = Number(options.port ?? DEFAULT_HUB_PORT);
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.onIdle = options.onIdle;
    this.ideBridge = new IdeBridgeServer({
      host: this.host,
      port: this.port,
      workspaceRoot: undefined,
      lifecycle: "hub"
    });
    this.projects = new ProjectRuntimeRegistry({
      defaultProjectPath: options.defaultProjectPath,
      ideBridge: this.ideBridge
    });
    this.mcpSessions = new McpSessionRegistry();
    this.server = null;
    this.idleTimer = null;
    this.ideBridge.on(IdeMessageTypes.IDE_REGISTER, ({ message }: { message: AnyRecord }) => {
      this.projects.registerProject(message.workspaceRoot, {
        projectName: message.projectName ?? message.name
      });
      this.#scheduleIdleCheck();
    });
    this.ideBridge.on("disconnect", () => this.#scheduleIdleCheck());
  }

  async start(): Promise<HubServerHandle> {
    this.server = http.createServer((req, res) => {
      void this.#handleRequest(req, res);
    });
    this.server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
      const pathname = this.#pathname(req);
      if (pathname === "/bridge") {
        this.ideBridge.handleUpgrade(req, socket);
        return;
      }
      socket.destroy();
    });
    this.port = await listen(this.server, this.port, this.host);
    this.#scheduleIdleCheck();
    return {
      server: this.server,
      host: this.host,
      port: this.port,
      url: `http://${this.host}:${this.port}`,
      bridgeUrl: `ws://${this.host}:${this.port}/bridge`,
      close: () => this.close()
    };
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const session of this.mcpSessions.list()) this.mcpSessions.remove(session.sessionId);
    this.ideBridge.stop();
    await this.projects.cleanupAll("hub_shutdown").catch(() => undefined);
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }).catch(() => undefined);
  }

  listTools(): ToolDefinition[] {
    return this.projects.getOrCreate().router.listTools();
  }

  async callTool(name: string, args: AnyRecord = {}, mcpSession?: McpSessionRecord): Promise<ToolResponse> {
    try {
      const runtime = this.projects.resolveRuntime(args, mcpSession?.projectPath);
      const routedArgs = args.projectPath ? args : { ...args, projectPath: runtime.policy.workspace.root };
      return await runtime.router.callTool(name, routedArgs);
    } catch (error) {
      return fail(error, "hub");
    } finally {
      this.#scheduleIdleCheck();
    }
  }

  status(): AnyRecord {
    return {
      server: "breakpilot-hub",
      host: this.host,
      port: this.port,
      streamUrl: `http://${this.host}:${this.port}/stream`,
      sseUrl: `http://${this.host}:${this.port}/sse`,
      bridgeUrl: `ws://${this.host}:${this.port}/bridge`,
      projects: this.projects.listProjects(),
      mcpSessions: this.mcpSessions.list(),
      ideBridge: this.ideBridge.status()
    };
  }

  async #handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const pathname = this.#pathname(req);
      if (req.method === "GET" && pathname === "/status") {
        sendJson(res, 200, this.status());
        return;
      }
      if (req.method === "POST" && pathname === "/shutdown") {
        sendJson(res, 200, { shutdown: true });
        setImmediate(() => {
          void this.close();
        });
        return;
      }
      if (req.method === "GET" && pathname === "/tools/list") {
        sendJson(res, 200, { tools: this.listTools() });
        return;
      }
      if (req.method === "POST" && pathname === "/tools/call") {
        const payload = JSON.parse((await readRequestBody(req)) || "{}") as AnyRecord;
        const result = await this.callTool(String(payload.name), (payload.arguments as AnyRecord | undefined) ?? {});
        sendJson(res, result.error ? 400 : 200, result);
        return;
      }
      if (pathname === "/stream") {
        await this.#handleStream(req, res);
        return;
      }
      if (pathname === "/sse" && req.method === "GET") {
        this.#openLegacySse(req, res);
        return;
      }
      if (pathname === "/message" && req.method === "POST") {
        await this.#handleLegacyMessage(req, res);
        return;
      }
      sendJson(res, 404, { error: { message: "Not found" } });
    } catch (error) {
      const typedError = error as Error;
      sendJson(res, 500, { error: { message: typedError.message } });
    }
  }

  async #handleStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = header(req, "mcp-session-id");
    if (req.method === "GET") {
      const session = this.mcpSessions.require(sessionId);
      this.#openSseResponse(res, session);
      return;
    }
    if (req.method === "DELETE") {
      this.mcpSessions.remove(sessionId);
      sendJson(res, 200, { closed: true });
      this.#scheduleIdleCheck();
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: { message: "Method not allowed" } });
      return;
    }
    const message = JSON.parse((await readRequestBody(req)) || "{}") as JsonRpcMessage;
    let session = this.mcpSessions.get(sessionId);
    if (!session) {
      if (message.method !== "initialize") {
        sendJson(res, 400, { error: "Missing mcp-session-id." });
        return;
      }
      session = this.mcpSessions.create("stream", this.#projectPathFromRequest(req));
    }
    const response = await this.#handleJsonRpc(message, session);
    res.writeHead(response ? 200 : 202, {
      "content-type": "application/json",
      "mcp-session-id": session.sessionId,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION
    });
    res.end(response ? JSON.stringify(response) : "{}");
  }

  #openLegacySse(req: IncomingMessage, res: ServerResponse): void {
    const session = this.mcpSessions.create("sse", this.#projectPathFromRequest(req));
    this.#openSseResponse(res, session);
    writeSse(res, "endpoint", `/message?sessionId=${encodeURIComponent(session.sessionId)}`);
  }

  async #handleLegacyMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const session = this.mcpSessions.require(url.searchParams.get("sessionId") ?? undefined);
    const message = JSON.parse((await readRequestBody(req)) || "{}") as JsonRpcMessage;
    const response = await this.#handleJsonRpc(message, session);
    if (response && session.response && !session.response.destroyed) {
      writeSse(session.response, "message", JSON.stringify(response));
    }
    sendJson(res, 202, { accepted: true });
  }

  #openSseResponse(res: ServerResponse, session: McpSessionRecord): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "mcp-session-id": session.sessionId,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION
    });
    this.mcpSessions.setResponse(session.sessionId, res);
    const heartbeat = setInterval(() => {
      if (res.destroyed) {
        clearInterval(heartbeat);
        return;
      }
      res.write(": keepalive\n\n");
    }, 15000);
    res.on("close", () => {
      clearInterval(heartbeat);
      this.mcpSessions.remove(session.sessionId);
      this.#scheduleIdleCheck();
    });
  }

  async #handleJsonRpc(message: JsonRpcMessage, session: McpSessionRecord): Promise<AnyRecord | null> {
    if (!message.id && message.method?.startsWith("notifications/")) return null;
    try {
      const result = await this.#jsonRpcResult(message, session);
      return { jsonrpc: "2.0", id: message.id ?? null, result };
    } catch (error) {
      const typedError = error as Error;
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: -32603, message: typedError.message }
      };
    }
  }

  async #jsonRpcResult(message: JsonRpcMessage, session: McpSessionRecord): Promise<AnyRecord> {
    if (message.method === "initialize") {
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "breakpilot-debugger", version: "0.1.0" }
      };
    }
    if (message.method === "tools/list") return { tools: this.listTools() };
    if (message.method === "tools/call") {
      const { name, arguments: args } = message.params ?? {};
      const result = await this.callTool(String(name), (args as AnyRecord | undefined) ?? {}, session);
      return toolCallResult(result);
    }
    if (message.method === "ping") return {};
    throw new Error(`Unsupported JSON-RPC method: ${String(message.method)}`);
  }

  #projectPathFromRequest(req: IncomingMessage): string | undefined {
    const headerValue = header(req, "x-breakpilot-project");
    if (headerValue) return headerValue;
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    return url.searchParams.get("projectPath") ?? undefined;
  }

  #pathname(req: IncomingMessage): string {
    return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`).pathname;
  }

  #scheduleIdleCheck(): void {
    if (!this.onIdle || this.idleTimeoutMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.mcpSessions.pruneIdle(Date.now(), this.idleTimeoutMs);
      const hasMcp = this.mcpSessions.activeCount() > 0;
      const hasIde = this.ideBridge.registry.list().length > 0;
      const hasDebug = this.projects.hasActiveDebugSessions();
      if (!hasMcp && !hasIde && !hasDebug) void Promise.resolve(this.onIdle?.());
      else this.#scheduleIdleCheck();
    }, this.idleTimeoutMs);
  }
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function writeSse(res: ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${data}\n\n`);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startHub(options: HubServerOptions = {}): Promise<HubServerHandle> {
  const hub = new BreakPilotHub(options);
  return hub.start();
}
