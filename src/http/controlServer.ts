import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ToolRouter } from "../control/ToolRouter.ts";
import type { ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";
import type { ClientLeaseManager } from "./ClientLeaseManager.ts";

export interface ControlServerOptions {
  controlToken?: string;
  status?: () => AnyRecord | Promise<AnyRecord>;
  onShutdown?: () => void | Promise<void>;
  clients?: ClientLeaseManager;
}

export interface ControlServerHandle {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
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

function isAuthorized(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

export async function startHttp(
  router: ToolRouter,
  port: number | string,
  host = "127.0.0.1",
  options: ControlServerOptions = {}
): Promise<ControlServerHandle> {
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "GET" && req.url === "/tools/list") {
        if (!isAuthorized(req, options.controlToken)) {
          sendJson(res, 401, { ok: false, error: { message: "Unauthorized" } });
          return;
        }
        sendJson(res, 200, { tools: router.listTools() });
        return;
      }
      if (req.method === "GET" && req.url === "/status") {
        sendJson(res, 200, options.status ? await options.status() : { ok: true });
        return;
      }
      if (req.method === "POST" && req.url === "/tools/call") {
        if (!isAuthorized(req, options.controlToken)) {
          sendJson(res, 401, { ok: false, error: { message: "Unauthorized" } });
          return;
        }
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");
        const result: ToolResponse = await router.callTool(payload.name, payload.arguments ?? {});
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      if (req.method === "POST" && req.url === "/clients/acquire") {
        if (!isAuthorized(req, options.controlToken)) {
          sendJson(res, 401, { ok: false, error: { message: "Unauthorized" } });
          return;
        }
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");
        sendJson(res, 200, options.clients?.acquire(payload) ?? { ok: true, activeClients: 0 });
        return;
      }
      if (req.method === "POST" && req.url === "/clients/heartbeat") {
        if (!isAuthorized(req, options.controlToken)) {
          sendJson(res, 401, { ok: false, error: { message: "Unauthorized" } });
          return;
        }
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");
        const result = options.clients?.heartbeat(payload) ?? { ok: true, activeClients: 0 };
        sendJson(res, result.ok === false ? 404 : 200, result);
        return;
      }
      if (req.method === "POST" && req.url === "/clients/release") {
        if (!isAuthorized(req, options.controlToken)) {
          sendJson(res, 401, { ok: false, error: { message: "Unauthorized" } });
          return;
        }
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");
        sendJson(res, 200, options.clients?.release(payload) ?? { ok: true, activeClients: 0 });
        return;
      }
      if (req.method === "POST" && req.url === "/shutdown") {
        if (!isAuthorized(req, options.controlToken)) {
          sendJson(res, 401, { ok: false, error: { message: "Unauthorized" } });
          return;
        }
        sendJson(res, 200, { ok: true });
        setImmediate(() => {
          void Promise.resolve(options.onShutdown?.()).finally(() => server.close());
        });
        return;
      }
      sendJson(res, 404, { ok: false, error: { message: "Not found" } });
    } catch (error) {
      const typedError = error as Error;
      sendJson(res, 500, { ok: false, error: { message: typedError.message } });
    }
  });
  const actualPort = await listen(server, Number(port), host);
  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      try {
        server.close();
      } catch {
        // Best effort cleanup after a listen failure.
      }
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
