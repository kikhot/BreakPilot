import assert from "node:assert/strict";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { BreakPilotHub } from "../src/hub/HubServer.ts";
import { RuntimeEventBuffer } from "../src/runtime/RuntimeEventBuffer.ts";

const hub = new BreakPilotHub({ port: 0, idleTimeoutMs: 0 });
const handle = await hub.start();
const client = new Client({ name: "hub-transports-test", version: "1.0.0" });

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${handle.url}/stream`)));

  const list = await client.listTools();
  assert.ok(list.tools.some((tool) => tool.name === "bp_debug_start"));
  assert.equal(list.tools.some((tool) => tool.name === "debug_launch"), false);

  const call = await client.callTool({ name: "bp_debug_status", arguments: {} });
  assert.deepEqual((call.structuredContent as { sessions?: unknown[] }).sessions, []);
  assert.equal("ok" in (call.structuredContent as Record<string, unknown>), false);
  assert.equal("data" in (call.structuredContent as Record<string, unknown>), false);
  assert.equal(call.content[0]?.type, "text");
  assert.equal(call.content[0]?.type === "text" ? call.content[0].text : undefined, "No active debug sessions; IDE disconnected.");
  assert.equal(call.isError, false);

  const expectedInvalidLineError = {
    code: "INVALID_ARGUMENT",
    message: "Invalid arguments for bp_debug_run_to_line.",
    retrySafe: true,
    actionMayHaveApplied: false
  };

  const httpErrorCall = await fetch(`${handle.url}/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bp_debug_run_to_line", arguments: { filePath: "src/Hello.java", line: 0 } })
  });
  assert.equal(httpErrorCall.status, 400);
  const httpErrorBody = await httpErrorCall.json() as { error?: unknown };
  assert.deepEqual(httpErrorBody.error, expectedInvalidLineError);

  const streamErrorCall = await client.callTool({
    name: "bp_debug_run_to_line",
    arguments: { filePath: "src/Hello.java", line: 0 }
  });
  assert.equal(streamErrorCall.isError, true);
  assert.equal(
    streamErrorCall.content[0]?.type === "text" ? streamErrorCall.content[0].text : undefined,
    expectedInvalidLineError.message
  );
  assert.deepEqual(
    (streamErrorCall.structuredContent as { error?: unknown }).error,
    expectedInvalidLineError
  );

  const expectedUnknownPropertyError = {
    code: "INVALID_ARGUMENT",
    message: "Invalid arguments for bp_debug_status.",
    retrySafe: true,
    actionMayHaveApplied: false
  };
  const httpUnknownPropertyCall = await fetch(`${handle.url}/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bp_debug_status", arguments: { typo: true } })
  });
  assert.equal(httpUnknownPropertyCall.status, 400);
  const httpUnknownPropertyBody = await httpUnknownPropertyCall.json() as { error?: unknown };
  assert.deepEqual(httpUnknownPropertyBody.error, expectedUnknownPropertyError);

  const streamUnknownPropertyCall = await client.callTool({
    name: "bp_debug_status",
    arguments: { typo: true }
  });
  assert.equal(streamUnknownPropertyCall.isError, true);
  assert.equal(
    streamUnknownPropertyCall.content[0]?.type === "text"
      ? streamUnknownPropertyCall.content[0].text
      : undefined,
    expectedUnknownPropertyError.message
  );
  assert.deepEqual(
    (streamUnknownPropertyCall.structuredContent as { error?: unknown }).error,
    expectedUnknownPropertyError
  );

  hub.projects.getOrCreate().manager.bpDebugStatus = async () => ({
    sessions: "invalid",
    ideConnected: false
  });
  const expectedOutputContractError = {
    code: "OUTPUT_CONTRACT_VIOLATION",
    message: "Debugger tool returned a result that violates its published contract.",
    retrySafe: true,
    actionMayHaveApplied: false
  };

  const httpMalformedOutputCall = await fetch(`${handle.url}/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bp_debug_status", arguments: {} })
  });
  assert.equal(httpMalformedOutputCall.status, 500);
  const httpMalformedOutputBody = await httpMalformedOutputCall.json() as { error?: unknown };
  assert.deepEqual(httpMalformedOutputBody.error, expectedOutputContractError);

  const streamMalformedOutputCall = await client.callTool({ name: "bp_debug_status", arguments: {} });
  assert.equal(streamMalformedOutputCall.isError, true);
  assert.equal(
    streamMalformedOutputCall.content[0]?.type === "text"
      ? streamMalformedOutputCall.content[0].text
      : undefined,
    expectedOutputContractError.message
  );
  assert.deepEqual(
    (streamMalformedOutputCall.structuredContent as { error?: unknown }).error,
    expectedOutputContractError
  );

  hub.projects.getOrCreate().manager.bpDebugControl = async () => ({
    state: "paused",
    events: {
      items: [{
        sequence: 7,
        kind: "breakpoint",
        message: "retained"
      }],
      nextCursor: 7,
      dropped: 6
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
    events?: { dropped?: number; items?: { sequence?: number }[] };
    error?: { code?: string };
  };
  assert.equal(overflowDrainBody.error?.code, undefined);
  assert.equal(overflowDrainBody.events?.dropped, 6);
  assert.deepEqual(overflowDrainBody.events?.items, [{
    sequence: 7,
    kind: "breakpoint",
    message: "retained"
  }]);

  const sse = await fetch(`${handle.url}/sse`);
  assert.equal(sse.status, 404);
  assert.equal((await fetch(`${handle.url}/message`, { method: "POST" })).status, 404);

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
      kind: "dap",
      sessionId: "sess-archived",
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
      kind: "dap",
      sessionId: "sess-archived",
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
  await client.close();
  await handle.close();
}

console.log("hub transport tests ok");
