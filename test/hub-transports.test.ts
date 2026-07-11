import assert from "node:assert/strict";

import { BreakPilotHub } from "../src/hub/HubServer.ts";

const hub = new BreakPilotHub({ port: 0, idleTimeoutMs: 0 });
const handle = await hub.start();

try {
  const init = await fetch(`${handle.url}/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  });
  assert.equal(init.status, 200);
  const sessionId = init.headers.get("mcp-session-id");
  assert.ok(sessionId, "stream initialize should return mcp-session-id");
  const initBody = await init.json() as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } };
  assert.equal(initBody.result?.protocolVersion, "2025-11-25");
  assert.equal(initBody.result?.serverInfo?.name, "breakpilot-debugger");

  const list = await fetch(`${handle.url}/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  });
  assert.equal(list.status, 200);
  const listBody = await list.json() as { result?: { tools?: { name: string }[] } };
  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "bp_debug_start"));
  assert.equal(listBody.result?.tools?.some((tool) => tool.name === "debug_launch"), false);

  const call = await fetch(`${handle.url}/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "bp_debug_status", arguments: {} }
    })
  });
  assert.equal(call.status, 200);
  const callBody = await call.json() as {
    result?: {
      content?: { type: string; text: string }[];
      structuredContent?: { sessions?: unknown[] };
      isError?: boolean;
    };
  };
  assert.deepEqual(callBody.result?.structuredContent?.sessions, []);
  assert.equal("ok" in (callBody.result?.structuredContent ?? {}), false);
  assert.equal("data" in (callBody.result?.structuredContent ?? {}), false);
  assert.equal(callBody.result?.content?.[0]?.text, "ok");
  assert.equal(callBody.result?.isError, false);

  const expectedInvalidLineError = {
    code: "INVALID_ARGUMENT",
    message: "Invalid arguments for bp_debug_run_to_line.",
    details: {
      issues: [{
        path: "$.line",
        keyword: "minimum",
        message: "must be >= 1"
      }]
    }
  };

  const httpErrorCall = await fetch(`${handle.url}/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bp_debug_run_to_line", arguments: { filePath: "src/Hello.java", line: 0 } })
  });
  assert.equal(httpErrorCall.status, 400);
  const httpErrorBody = await httpErrorCall.json() as { error?: unknown };
  assert.deepEqual(httpErrorBody.error, expectedInvalidLineError);

  const streamErrorCall = await fetch(`${handle.url}/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "bp_debug_run_to_line", arguments: { filePath: "src/Hello.java", line: 0 } }
    })
  });
  assert.equal(streamErrorCall.status, 200);
  const streamErrorBody = await streamErrorCall.json() as {
    result?: {
      content?: { type: string; text: string }[];
      structuredContent?: { error?: unknown };
      isError?: boolean;
    };
  };
  assert.equal(streamErrorBody.result?.isError, true);
  assert.equal(streamErrorBody.result?.content?.[0]?.text, expectedInvalidLineError.message);
  assert.deepEqual(streamErrorBody.result?.structuredContent?.error, expectedInvalidLineError);

  const expectedUnknownPropertyError = {
    code: "INVALID_ARGUMENT",
    message: "Invalid arguments for bp_debug_status.",
    details: {
      issues: [{
        path: "$.typo",
        keyword: "additionalProperties",
        message: "is not allowed"
      }]
    }
  };
  const httpUnknownPropertyCall = await fetch(`${handle.url}/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bp_debug_status", arguments: { typo: true } })
  });
  assert.equal(httpUnknownPropertyCall.status, 400);
  const httpUnknownPropertyBody = await httpUnknownPropertyCall.json() as { error?: unknown };
  assert.deepEqual(httpUnknownPropertyBody.error, expectedUnknownPropertyError);

  const streamUnknownPropertyCall = await fetch(`${handle.url}/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "bp_debug_status", arguments: { typo: true } }
    })
  });
  assert.equal(streamUnknownPropertyCall.status, 200);
  const streamUnknownPropertyBody = await streamUnknownPropertyCall.json() as {
    result?: {
      content?: { type: string; text: string }[];
      structuredContent?: { error?: unknown };
      isError?: boolean;
    };
  };
  assert.equal(streamUnknownPropertyBody.result?.isError, true);
  assert.equal(streamUnknownPropertyBody.result?.content?.[0]?.text, expectedUnknownPropertyError.message);
  assert.deepEqual(streamUnknownPropertyBody.result?.structuredContent?.error, expectedUnknownPropertyError);

  const sse = await fetch(`${handle.url}/sse`);
  assert.equal(sse.status, 200);
  const reader = sse.body?.getReader();
  assert.ok(reader, "SSE response should expose a body reader");
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  assert.match(text, /event: endpoint/);
  assert.match(text, /\/message\?sessionId=/);
  await reader.cancel();

  hub.projects.registerProject("/tmp/breakpilot-project-a");
  hub.projects.registerProject("/tmp/breakpilot-project-b");
  const ambiguous = await hub.callTool("bp_debug_context", {});
  assert.equal(ambiguous.error?.code, "PROJECT_AMBIGUOUS");
} finally {
  await handle.close();
}

console.log("hub transport tests ok");
