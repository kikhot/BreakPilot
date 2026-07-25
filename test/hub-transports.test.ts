import assert from "node:assert/strict";

import { BreakPilotHub } from "../src/hub/HubServer.ts";
import { RuntimeEventBuffer } from "../src/runtime/RuntimeEventBuffer.ts";

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

  hub.projects.getOrCreate().manager.bpDebugStatus = async () => ({
    activeSessionId: null,
    sessions: "invalid",
    ideConnected: false,
    ideSessions: []
  });
  const expectedOutputContractError = {
    code: "OUTPUT_CONTRACT_VIOLATION",
    message: "Debugger tool returned a result that violates its published contract.",
    details: {
      tool: "bp_debug_status",
      issues: [{ path: "$.sessions", keyword: "type" }],
      issueCount: 1,
      outcome: "failed",
      retrySafe: true
    }
  };

  const httpMalformedOutputCall = await fetch(`${handle.url}/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bp_debug_status", arguments: {} })
  });
  assert.equal(httpMalformedOutputCall.status, 500);
  const httpMalformedOutputBody = await httpMalformedOutputCall.json() as { error?: unknown };
  assert.deepEqual(httpMalformedOutputBody.error, expectedOutputContractError);

  const streamMalformedOutputCall = await fetch(`${handle.url}/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "bp_debug_status", arguments: {} }
    })
  });
  assert.equal(streamMalformedOutputCall.status, 200);
  const streamMalformedOutputBody = await streamMalformedOutputCall.json() as {
    result?: {
      content?: { type: string; text: string }[];
      structuredContent?: { error?: unknown };
      isError?: boolean;
    };
  };
  assert.equal(streamMalformedOutputBody.result?.isError, true);
  assert.equal(streamMalformedOutputBody.result?.content?.[0]?.text, expectedOutputContractError.message);
  assert.deepEqual(
    streamMalformedOutputBody.result?.structuredContent?.error,
    expectedOutputContractError
  );

  hub.projects.getOrCreate().manager.bpDebugControl = async () => ({
    status: "paused",
    events: {
      items: [{
        sequence: 7,
        timestamp: "2026-07-25T00:00:00.000Z",
        kind: "breakpoint",
        sessionId: "sess-overflow",
        message: "retained"
      }],
      cursor: 0,
      nextCursor: 7,
      oldestCursor: 7,
      hasMore: false,
      overflowed: true,
      droppedCount: 6,
      supportedKinds: ["breakpoint"],
      breakpointErrors: [],
      tracepoints: []
    }
  });
  const overflowDrainCall = await fetch(`${handle.url}/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "bp_debug_control",
      arguments: { action: "drainEvents", sessionId: "sess-overflow", cursor: 0, limit: 1 }
    })
  });
  assert.equal(overflowDrainCall.status, 200);
  const overflowDrainBody = await overflowDrainCall.json() as {
    events?: { overflowed?: boolean; items?: { sequence?: number }[] };
    error?: { code?: string };
  };
  assert.equal(overflowDrainBody.error?.code, undefined);
  assert.equal(overflowDrainBody.events?.overflowed, true);
  assert.deepEqual(overflowDrainBody.events?.items, [{
    sequence: 7,
    timestamp: "2026-07-25T00:00:00.000Z",
    kind: "breakpoint",
    sessionId: "sess-overflow",
    message: "retained"
  }]);

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

  const archivedRuntime = hub.projects.getOrCreate("/tmp/breakpilot-archived-events");
  const archivedEvents = new RuntimeEventBuffer("sess-archived");
  archivedEvents.append({ kind: "terminated", message: "retained" });
  archivedRuntime.manager.sessions.add({
    sessionId: "sess-archived",
    language: "java",
    workspaceRoot: archivedRuntime.policy.workspace.root,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider: {
      async disconnect() {
        return {};
      }
    } as never,
    runtimeEvents: archivedEvents
  });
  await archivedRuntime.manager.bpDebugControl({ sessionId: "sess-archived", action: "stop" });
  assert.equal(archivedRuntime.manager.sessions.maybeGet("sess-archived"), undefined);
  assert.equal(archivedRuntime.manager.hasArchivedRuntimeEvents("sess-archived"), true);
  const archivedDrain = await hub.callTool("bp_debug_control", {
    action: "drainEvents",
    sessionId: "sess-archived",
    cursor: 0,
    limit: 1
  });
  assert.equal(archivedDrain.error, undefined);
  assert.deepEqual((archivedDrain.events as { items?: { sequence?: number }[] }).items?.map((event) => event.sequence), [1]);

  const collidingRuntime = hub.projects.getOrCreate("/tmp/breakpilot-colliding-archive");
  const collidingEvents = new RuntimeEventBuffer("sess-archived");
  collidingEvents.append({ kind: "terminated", message: "retained elsewhere" });
  collidingRuntime.manager.sessions.add({
    sessionId: "sess-archived",
    language: "java",
    workspaceRoot: collidingRuntime.policy.workspace.root,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider: {
      async disconnect() {
        return {};
      }
    } as never,
    runtimeEvents: collidingEvents
  });
  await collidingRuntime.manager.bpDebugControl({ sessionId: "sess-archived", action: "stop" });
  const ambiguousArchivedDrain = await hub.callTool("bp_debug_control", {
    action: "drainEvents",
    sessionId: "sess-archived",
    cursor: 0,
    limit: 1
  });
  assert.equal(ambiguousArchivedDrain.error?.code, "SESSION_AMBIGUOUS");
} finally {
  await handle.close();
}

console.log("hub transport tests ok");
