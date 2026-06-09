import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ToolRouter } from "../control/ToolRouter.ts";
import type { ToolResponse } from "../types/control.ts";

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
