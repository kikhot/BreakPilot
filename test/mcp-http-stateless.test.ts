import assert from "node:assert/strict";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { BreakPilotHub, type HubServerHandle } from "../src/hub/HubServer.ts";

interface JsonRpcResponse {
  error?: { code?: number };
  result?: { tools?: { name?: string }[] };
}

async function connectClient(url: string, modern: boolean): Promise<Client> {
  const client = new Client(
    { name: modern ? "modern-test" : "legacy-test", version: "1.0.0" },
    modern
      ? { versionNegotiation: { mode: "auto", probe: { timeoutMs: 2_000, maxRetries: 0 } } }
      : undefined
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function withHub(
  run: (hub: BreakPilotHub, handle: HubServerHandle) => Promise<void>
): Promise<void> {
  const hub = new BreakPilotHub({ port: 0, idleTimeoutMs: 0 });
  const handle = await hub.start();
  try {
    await run(hub, handle);
  } finally {
    await handle.close();
  }
}

function legacyRequest(method: string, params: Record<string, unknown> = {}, id?: number): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params })
  };
}

function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...headers
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "raw-modern-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    })
  };
}

async function assertJsonRpcError(response: Response, status: number, code: number): Promise<void> {
  assert.equal(response.status, status);
  const payload = await response.json() as JsonRpcResponse;
  assert.equal(payload.error?.code, code);
}

test("/mcp serves modern 2026-07-28 requests without an MCP session", async () => {
  await withHub(async (_hub, handle) => {
    const client = await connectClient(`${handle.url}/mcp`, true);
    try {
      assert.equal(client.getProtocolEra(), "modern");
      assert.ok((await client.listTools()).tools.some(({ name }) => name === "bp_debug_start"));
    } finally {
      await client.close();
    }
  });
});

test("/mcp and /stream serve 2025-era clients without an MCP session", async () => {
  await withHub(async (_hub, handle) => {
    for (const pathname of ["/mcp", "/stream"]) {
      const client = await connectClient(`${handle.url}${pathname}`, false);
      try {
        const result = await client.callTool({ name: "bp_debug_status", arguments: {} });
        assert.equal(result.isError, false);
        assert.deepEqual((result.structuredContent as { sessions?: unknown[] }).sessions, []);
      } finally {
        await client.close();
      }
    }
  });
});

test("legacy initialize is stateless on both MCP paths", async () => {
  await withHub(async (_hub, handle) => {
    for (const pathname of ["/mcp", "/stream"]) {
      const response = await fetch(`${handle.url}${pathname}`, legacyRequest("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "raw-legacy-test", version: "1.0.0" }
      }, 1));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("mcp-session-id"), null);
      await response.body?.cancel();
    }
  });
});

test("MCP paths reject session methods and non-JSON posts while removed routes return 404", async () => {
  await withHub(async (_hub, handle) => {
    assert.equal((await fetch(`${handle.url}/mcp`)).status, 405);
    assert.equal((await fetch(`${handle.url}/stream`, { method: "DELETE" })).status, 405);
    assert.equal((await fetch(`${handle.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}"
    })).status, 415);
    assert.equal((await fetch(`${handle.url}/sse`)).status, 404);
    assert.equal((await fetch(`${handle.url}/message`, { method: "POST" })).status, 404);
  });
});

test("legacy notifications and spoofed session headers remain stateless", async () => {
  await withHub(async (_hub, handle) => {
    const notification = await fetch(
      `${handle.url}/mcp`,
      legacyRequest("notifications/initialized")
    );
    assert.equal(notification.status, 202);
    assert.equal(await notification.text(), "");

    const list = await fetch(`${handle.url}/stream`, {
      ...legacyRequest("tools/list", {}, 2),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "attacker-value"
      }
    });
    assert.equal(list.status, 200);
    assert.equal(list.headers.get("mcp-session-id"), null);
    assert.equal((await list.text()).includes("attacker-value"), false);
  });
});

test("modern raw requests preserve SDK protocol boundary validation", async () => {
  await withHub(async (_hub, handle) => {
    const list = await fetch(`${handle.url}/mcp`, modernRequest("tools/list"));
    assert.equal(list.status, 200);
    const listPayload = await list.json() as JsonRpcResponse;
    assert.ok(listPayload.result?.tools?.some(({ name }) => name === "bp_debug_start"));

    const missingVersion = modernRequest("tools/list");
    const missingVersionHeaders = new Headers(missingVersion.headers);
    missingVersionHeaders.delete("mcp-protocol-version");
    await assertJsonRpcError(await fetch(`${handle.url}/mcp`, {
      ...missingVersion,
      headers: missingVersionHeaders
    }), 400, -32020);

    await assertJsonRpcError(await fetch(`${handle.url}/mcp`, modernRequest("tools/list", {}, {
      "mcp-method": "tools/call"
    })), 400, -32020);

    await assertJsonRpcError(await fetch(`${handle.url}/mcp`, modernRequest("tools/call", {
      name: "bp_debug_status",
      arguments: {}
    })), 400, -32020);

    await assertJsonRpcError(await fetch(`${handle.url}/mcp`, modernRequest("tools/call", {
      name: "bp_debug_status",
      arguments: {}
    }, { "mcp-name": "bp_debug_start" })), 400, -32020);

    const unsupported = modernRequest("tools/list", {}, {
      "mcp-protocol-version": "2026-08-01"
    });
    const unsupportedBody = JSON.parse(String(unsupported.body)) as {
      params: { _meta: Record<string, unknown> };
    };
    unsupportedBody.params._meta["io.modelcontextprotocol/protocolVersion"] = "2026-08-01";
    await assertJsonRpcError(await fetch(`${handle.url}/mcp`, {
      ...unsupported,
      body: JSON.stringify(unsupportedBody)
    }), 400, -32022);

    await assertJsonRpcError(await fetch(
      `${handle.url}/mcp`,
      modernRequest("unknown/method")
    ), 404, -32601);
  });
});

test("Hub status advertises stateless MCP endpoints and protocol eras", async () => {
  await withHub(async (hub, handle) => {
    assert.deepEqual(hub.status(), {
      server: "breakpilot-hub",
      host: "127.0.0.1",
      port: handle.port,
      mcpUrl: `${handle.url}/mcp`,
      streamUrl: `${handle.url}/stream`,
      mcpTransport: "stateless",
      mcpProtocolVersions: {
        modern: "2026-07-28",
        legacy: { min: "2024-10-07", max: "2025-11-25", mode: "stateless" }
      },
      activeMcpRequests: 0,
      bridgeUrl: `${handle.url.replace("http://", "ws://")}/bridge`,
      projects: hub.projects.listProjects(),
      ideBridge: hub.ideBridge.status()
    });
  });
});
