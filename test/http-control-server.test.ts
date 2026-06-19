import assert from "node:assert/strict";

import { startHttp } from "../src/http/controlServer.ts";
import type { ToolRouter } from "../src/control/ToolRouter.ts";

const router = {
  listTools: () => [{ name: "ping", description: "test", inputSchema: { type: "object", properties: {} } }],
  callTool: async (name: string) => (
    name === "fail"
      ? { error: { code: "TEST_ERROR", message: "tool failed" } }
      : { pong: true }
  )
} as unknown as ToolRouter;

let server;
try {
  server = await startHttp(router, 0, "127.0.0.1", {
    controlToken: "secret",
    status: () => ({ server: "breakpilot", instanceId: "test" })
  });
} catch (error) {
  if ((error as { code?: string }).code === "EPERM") {
    console.log("http control server test skipped: sandbox disallows listen(0)");
    process.exit(0);
  }
  throw error;
}

try {
  assert.ok(server.port > 0, "startHttp should expose the actual bound port");

  const status = await fetch(`${server.url}/status`);
  assert.equal(status.status, 200);
  assert.equal(((await status.json()) as { server: string }).server, "breakpilot");

  const denied = await fetch(`${server.url}/tools/list`);
  assert.equal(denied.status, 401);

  const allowed = await fetch(`${server.url}/tools/list`, {
    headers: { authorization: "Bearer secret" }
  });
  assert.equal(allowed.status, 200);
  assert.equal(((await allowed.json()) as { tools: unknown[] }).tools.length, 1);

  const toolSuccess = await fetch(`${server.url}/tools/call`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json"
    },
    body: JSON.stringify({ name: "ping", arguments: {} })
  });
  assert.equal(toolSuccess.status, 200);
  assert.deepEqual(await toolSuccess.json(), { pong: true });

  const toolError = await fetch(`${server.url}/tools/call`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json"
    },
    body: JSON.stringify({ name: "fail", arguments: {} })
  });
  assert.equal(toolError.status, 400);
  const toolErrorBody = await toolError.json() as { error?: { code?: string; message?: string } };
  assert.equal(toolErrorBody.error?.code, "TEST_ERROR");
  assert.equal(toolErrorBody.error?.message, "tool failed");
} finally {
  await server.close();
}

console.log("http control server test ok");
