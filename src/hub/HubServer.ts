import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";

import {
  classifyInboundRequest,
  createMcpHandler,
  type McpHttpHandler
} from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
  type NodeMcpRequestHandler
} from "@modelcontextprotocol/node";

import type { ControlGateway } from "../control/ControlGateway.ts";
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
  private readonly validateHost = localhostHostValidation();
  private readonly validateOrigin = localhostOriginValidation();
  private readonly mcpDispatches = new Set<Promise<void>>();
  private readonly mcpToolCalls = new Set<Promise<ToolResponse>>();
  private closing = false;
  private closePromise: Promise<void> | null = null;

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
        this.#mcpGateway(projectHintFromRequest(requestInfo))
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
    this.host = loopbackBindHost(this.host);
    this.ideBridge.host = this.host;
    this.server = http.createServer((req, res) => {
      if (!this.validateHost(req, res) || !this.validateOrigin(req, res)) return;
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
      url: this.#url("http"),
      bridgeUrl: `${this.#url("ws")}/bridge`,
      close: () => this.close()
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.closePromise = this.#close();
    return this.closePromise;
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
      mcpUrl: `${this.#url("http")}/mcp`,
      streamUrl: `${this.#url("http")}/stream`,
      mcpTransport: "stateless",
      mcpProtocolVersions: {
        modern: "2026-07-28",
        legacy: { min: "2024-10-07", max: "2025-11-25", mode: "stateless" }
      },
      activeMcpRequests: this.activeMcpRequests,
      bridgeUrl: `${this.#url("ws")}/bridge`,
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
        if (this.closing) {
          sendJson(res, 503, { error: { message: "BreakPilot Hub is shutting down." } });
          return;
        }
        this.#beginMcpResponse(res);
        const dispatch = this.mcpNodeHandler(req, res);
        this.mcpDispatches.add(dispatch);
        void dispatch.then(
          () => this.#finishMcpDispatch(dispatch),
          () => this.#finishMcpDispatch(dispatch)
        );
        await dispatch;
        return;
      }
      sendJson(res, 404, { error: { message: "Not found" } });
    } catch (error) {
      const typedError = error as Error;
      sendJson(res, 500, { error: { message: typedError.message } });
    }
  }

  #pathname(req: IncomingMessage): string {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  }

  #scheduleIdleCheck(): void {
    if (this.closing || !this.onIdle || this.idleTimeoutMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const hasIde = this.ideBridge.registry.list().length > 0;
      const hasDebug = this.projects.hasActiveDebugSessions();
      const hasMcpWork =
        this.activeMcpRequests > 0 ||
        this.mcpDispatches.size > 0 ||
        this.mcpToolCalls.size > 0;
      if (!hasMcpWork && !hasIde && !hasDebug) void Promise.resolve(this.onIdle?.());
      else this.#scheduleIdleCheck();
    }, this.idleTimeoutMs);
  }

  #mcpGateway(requestProjectPath?: string): ControlGateway {
    const gateway = new HubControlGateway(this.projects, requestProjectPath);
    return {
      listTools: () => gateway.listTools(),
      callTool: (name, args) => {
        const call = gateway.callTool(name, args);
        this.mcpToolCalls.add(call);
        void call.then(
          () => this.#finishMcpToolCall(call),
          () => this.#finishMcpToolCall(call)
        );
        return call;
      }
    };
  }

  #beginMcpResponse(res: ServerResponse): void {
    this.activeMcpRequests += 1;
    this.#scheduleIdleCheck();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.activeMcpRequests = Math.max(0, this.activeMcpRequests - 1);
      this.#scheduleIdleCheck();
    };
    res.once("finish", finish);
    res.once("close", finish);
  }

  #finishMcpDispatch(dispatch: Promise<void>): void {
    this.mcpDispatches.delete(dispatch);
    this.#scheduleIdleCheck();
  }

  #finishMcpToolCall(call: Promise<ToolResponse>): void {
    this.mcpToolCalls.delete(call);
    this.#scheduleIdleCheck();
  }

  async #close(): Promise<void> {
    await this.mcpHandler.close().catch(() => undefined);
    do {
      await Promise.allSettled([...this.mcpDispatches]);
      await Promise.allSettled([...this.mcpToolCalls]);
    } while (this.mcpDispatches.size > 0 || this.mcpToolCalls.size > 0);

    const server = this.server;
    this.server = null;
    await closeNodeServer(server).catch(() => undefined);
    try {
      this.ideBridge.stop();
    } catch {
      // Continue through project cleanup even if the bridge fails to stop.
    }
    await this.projects.cleanupAll("hub_shutdown").catch(() => undefined);
  }

  #url(protocol: "http" | "ws"): string {
    return `${protocol}://${urlHost(this.host)}:${this.port}`;
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

function closeNodeServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function loopbackBindHost(host: string): string {
  if (host === "[::1]") return "::1";
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return host;
  throw new Error(
    `BreakPilot Hub requires an exact loopback binding (127.0.0.1, localhost, or ::1); received ${host}.`
  );
}

function urlHost(host: string): string {
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return unwrapped.includes(":") ? `[${unwrapped}]` : unwrapped;
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
  const classification = classifyInboundRequest({
    httpMethod: request.method,
    mcpMethodHeader: request.headers.get("mcp-method") ?? undefined,
    mcpNameHeader: request.headers.get("mcp-name") ?? undefined,
    body
  });
  if (
    classification.kind !== "modern" ||
    classification.messageKind !== "request" ||
    classification.classification.revision !== "2026-07-28"
  ) {
    return undefined;
  }

  const id = classification.message.id;
  const bodyDescription = "the body envelope names protocol version 2026-07-28 but the required MCP-Protocol-Version header is absent";
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
