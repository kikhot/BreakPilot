import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";

import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler, type NodeMcpRequestHandler } from "@modelcontextprotocol/node";

import { createBreakPilotMcpServer } from "../mcp/serverFactory.ts";
import { IdeBridgeServer } from "../ide/IdeBridgeServer.ts";
import { IdeMessageTypes } from "../ide/IdeProtocol.ts";
import type { ToolDefinition, ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";
import { ok, toolResponseHttpStatus } from "../utils/errors.ts";
import { HubControlGateway } from "./HubControlGateway.ts";
import { ProjectRuntimeRegistry } from "./ProjectRuntimeRegistry.ts";

export const DEFAULT_HUB_HOST = "127.0.0.1";
export const DEFAULT_HUB_PORT = 57987;
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

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
  activeMcpRequests: number;
  server: Server | null;
  idleTimer: NodeJS.Timeout | null;
  private readonly mcpHandler: McpHttpHandler;
  private readonly mcpNodeHandler: NodeMcpRequestHandler;

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
    this.activeMcpRequests = 0;
    this.mcpHandler = requireModernProtocolVersionHeader(createMcpHandler(
      ({ requestInfo }) => createBreakPilotMcpServer(
        new HubControlGateway(this.projects, projectHintFromRequest(requestInfo))
      ),
      { legacy: "stateless", responseMode: "auto" }
    ));
    this.mcpNodeHandler = toNodeHandler(this.mcpHandler);
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
    await this.mcpHandler.close().catch(() => undefined);
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
    return new HubControlGateway(this.projects).listTools();
  }

  async callTool(name: string, args: AnyRecord = {}): Promise<ToolResponse> {
    try {
      return await new HubControlGateway(this.projects).callTool(name, args);
    } finally {
      this.#scheduleIdleCheck();
    }
  }

  status(): AnyRecord {
    return {
      server: "breakpilot-hub",
      host: this.host,
      port: this.port,
      mcpUrl: `http://${this.host}:${this.port}/mcp`,
      streamUrl: `http://${this.host}:${this.port}/stream`,
      mcpTransport: "stateless",
      mcpProtocolVersions: {
        modern: "2026-07-28",
        legacy: { min: "2024-10-07", max: "2025-11-25", mode: "stateless" }
      },
      activeMcpRequests: this.activeMcpRequests,
      bridgeUrl: `ws://${this.host}:${this.port}/bridge`,
      projects: this.projects.listProjects(),
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
        sendJson(res, toolResponseHttpStatus(result), result);
        return;
      }
      if (pathname === "/mcp" || pathname === "/stream") {
        await this.mcpNodeHandler(req, res);
        return;
      }
      sendJson(res, 404, { error: { message: "Not found" } });
    } catch (error) {
      const typedError = error as Error;
      sendJson(res, 500, { error: { message: typedError.message } });
    }
  }

  #pathname(req: IncomingMessage): string {
    return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`).pathname;
  }

  #scheduleIdleCheck(): void {
    if (!this.onIdle || this.idleTimeoutMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const hasIde = this.ideBridge.registry.list().length > 0;
      const hasDebug = this.projects.hasActiveDebugSessions();
      if (!hasIde && !hasDebug) void Promise.resolve(this.onIdle?.());
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

function projectHintFromRequest(request?: Request): string | undefined {
  const fromHeader = request?.headers.get("x-breakpilot-project")?.trim();
  if (fromHeader) return fromHeader;
  const fromQuery = request ? new URL(request.url).searchParams.get("projectPath")?.trim() : undefined;
  return fromQuery || undefined;
}

function requireModernProtocolVersionHeader(handler: McpHttpHandler): McpHttpHandler {
  return {
    ...handler,
    fetch: async (request, options) => {
      const rejection = await missingModernProtocolVersionResponse(request, options?.parsedBody);
      return rejection ?? handler.fetch(request, options);
    }
  };
}

async function missingModernProtocolVersionResponse(
  request: Request,
  parsedBody?: unknown
): Promise<Response | undefined> {
  if (
    request.method.toUpperCase() !== "POST" ||
    request.headers.has("mcp-protocol-version") ||
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return undefined;
  }

  let body = parsedBody;
  if (body === undefined) {
    try {
      body = await request.clone().json();
    } catch {
      return undefined;
    }
  }
  if (!hasModernEnvelopeClaim(body)) return undefined;

  const message = body as { id?: unknown; params?: { _meta?: Record<string, unknown> } };
  const claimedVersion = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
  const bodyDescription = `the body envelope names protocol version ${String(claimedVersion)} but the required MCP-Protocol-Version header is absent`;
  return Response.json({
    jsonrpc: "2.0",
    error: {
      code: -32020,
      message: `Bad Request: the request headers and body disagree: ${bodyDescription}`,
      data: { mismatch: { header: "(missing)", body: bodyDescription } }
    },
    id
  }, { status: 400 });
}

function hasModernEnvelopeClaim(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  return Object.hasOwn(meta, "io.modelcontextprotocol/protocolVersion");
}
