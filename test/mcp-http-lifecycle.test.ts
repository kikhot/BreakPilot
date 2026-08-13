import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { BreakPilotHub } from "../src/hub/HubServer.ts";
import type { ToolResponse } from "../src/types/control.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface RawRequest {
  response: Promise<{ status: number; body: string }>;
  destroy(): void;
}

interface RawStreamingRequest {
  opened: Promise<{ status: number; contentType?: string }>;
  completed: Promise<{ status: number; body: string }>;
  destroy(): void;
}

const STATUS_RESULT: ToolResponse = {
  sessions: [],
  ideConnected: false
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function within<T>(promise: Promise<T>, message: string, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for lifecycle condition.");
    await delay(5);
  }
}

function modernRequest(
  url: string,
  method: string,
  params: Record<string, unknown>,
  name?: string
): RawRequest {
  const target = new URL(url);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "lifecycle-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    }
  });
  const request = httpRequest({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "content-length": Buffer.byteLength(body),
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {})
    }
  });
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request.on("response", (incoming) => {
      incoming.setEncoding("utf8");
      let responseBody = "";
      incoming.on("data", (chunk) => {
        responseBody += chunk;
      });
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: responseBody }));
    });
    request.on("error", reject);
  });
  request.end(body);
  return {
    response,
    destroy: () => request.destroy()
  };
}

function modernStreamingRequest(
  url: string,
  method: string,
  params: Record<string, unknown>
): RawStreamingRequest {
  const target = new URL(url);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "lifecycle-stream-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    }
  });
  const request = httpRequest({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "content-length": Buffer.byteLength(body),
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method
    }
  });
  let resolveOpened!: (value: { status: number; contentType?: string }) => void;
  let rejectOpened!: (error: Error) => void;
  const opened = new Promise<{ status: number; contentType?: string }>((resolve, reject) => {
    resolveOpened = resolve;
    rejectOpened = reject;
  });
  const completed = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request.on("response", (incoming) => {
      const status = incoming.statusCode ?? 0;
      resolveOpened({ status, contentType: incoming.headers["content-type"] });
      incoming.setEncoding("utf8");
      let responseBody = "";
      incoming.on("data", (chunk) => {
        responseBody += chunk;
      });
      incoming.on("end", () => resolve({ status, body: responseBody }));
      incoming.on("error", reject);
    });
    request.on("error", (error) => {
      rejectOpened(error);
      reject(error);
    });
  });
  request.end(body);
  return {
    opened,
    completed,
    destroy: () => request.destroy()
  };
}

function legacyListRequest(url: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": Buffer.byteLength(body)
      }
    }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: responseBody }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("an active MCP tool call blocks idle shutdown and idles after its response", async () => {
  const idleTimeoutMs = 40;
  let idleCalls = 0;
  const hub = new BreakPilotHub({
    port: 0,
    idleTimeoutMs,
    onIdle: () => {
      idleCalls += 1;
    }
  });
  const status = deferred<ToolResponse>();
  const entered = deferred<void>();
  const runtime = hub.projects.getOrCreate();
  runtime.manager.bpDebugStatus = async () => {
    entered.resolve();
    return status.promise;
  };
  const handle = await hub.start();
  let call: RawRequest | undefined;
  try {
    call = modernRequest(`${handle.url}/mcp`, "tools/call", {
      name: "bp_debug_status",
      arguments: {}
    }, "bp_debug_status");
    await entered.promise;

    assert.equal(hub.status().activeMcpRequests, 1);
    await delay(idleTimeoutMs * 2);
    assert.equal(idleCalls, 0);

    status.resolve(STATUS_RESULT);
    const response = await call.response;
    assert.equal(response.status, 200);
    await waitUntil(() => hub.status().activeMcpRequests === 0);
    await waitUntil(() => idleCalls === 1);
  } finally {
    status.resolve(STATUS_RESULT);
    call?.destroy();
    await Promise.allSettled([call?.response ?? Promise.resolve(), handle.close()]);
  }
});

test("ordinary tools/list resets the Hub idle deadline", async () => {
  const idleTimeoutMs = 100;
  let idleCalls = 0;
  const hub = new BreakPilotHub({
    port: 0,
    idleTimeoutMs,
    onIdle: () => {
      idleCalls += 1;
    }
  });
  const handle = await hub.start();
  try {
    await delay(70);
    const response = await legacyListRequest(`${handle.url}/stream`);
    assert.equal(response.status, 200);

    await delay(60);
    assert.equal(idleCalls, 0);
    await waitUntil(() => idleCalls === 1);
  } finally {
    await handle.close();
  }
});

test("a modern subscriptions/listen stream blocks idle and settles when the Hub closes", async () => {
  const idleTimeoutMs = 40;
  let idleCalls = 0;
  const hub = new BreakPilotHub({
    port: 0,
    idleTimeoutMs,
    onIdle: () => {
      idleCalls += 1;
    }
  });
  const handle = await hub.start();
  const listen = modernStreamingRequest(`${handle.url}/mcp`, "subscriptions/listen", {
    notifications: {}
  });
  let closePromise: Promise<void> | undefined;
  try {
    const opened = await within(listen.opened, "Timed out waiting for the modern listen stream.");
    assert.equal(opened.status, 200);
    assert.equal(opened.contentType, "text/event-stream");
    assert.equal(hub.status().activeMcpRequests, 1);

    await delay(idleTimeoutMs * 2);
    assert.equal(idleCalls, 0);
    assert.equal(hub.status().activeMcpRequests, 1);

    closePromise = hub.close();
    const [completed, closed] = await Promise.allSettled([listen.completed, closePromise]);
    assert.equal(completed.status, "fulfilled");
    assert.equal(closed.status, "fulfilled");
    assert.equal(hub.status().activeMcpRequests, 0);
  } finally {
    listen.destroy();
    await Promise.allSettled([listen.completed, closePromise ?? hub.close()]);
  }
});

test("an aborted modern client releases its response but not detached tool work", async () => {
  const idleTimeoutMs = 40;
  let idleCalls = 0;
  const hub = new BreakPilotHub({
    port: 0,
    idleTimeoutMs,
    onIdle: () => {
      idleCalls += 1;
    }
  });
  const status = deferred<ToolResponse>();
  const entered = deferred<void>();
  const runtime = hub.projects.getOrCreate();
  runtime.manager.bpDebugStatus = async () => {
    entered.resolve();
    return status.promise;
  };
  let cleanupEntered = false;
  const originalCleanupAll = hub.projects.cleanupAll.bind(hub.projects);
  hub.projects.cleanupAll = async (reason) => {
    cleanupEntered = true;
    await originalCleanupAll(reason);
  };
  const handle = await hub.start();
  const call = modernRequest(`${handle.url}/mcp`, "tools/call", {
    name: "bp_debug_status",
    arguments: {}
  }, "bp_debug_status");
  const callSettled = call.response.catch(() => undefined);
  let closePromise: Promise<void> | undefined;
  try {
    await within(entered.promise, "Timed out waiting for the aborted tool call to enter its handler.");
    assert.equal(hub.status().activeMcpRequests, 1);

    call.destroy();
    await waitUntil(() => hub.status().activeMcpRequests === 0);
    await delay(idleTimeoutMs * 2);
    assert.equal(hub.status().activeMcpRequests, 0);
    assert.equal(idleCalls, 0);

    closePromise = hub.close();
    await delay(30);
    assert.equal(cleanupEntered, false);

    status.resolve(STATUS_RESULT);
    await Promise.all([callSettled, closePromise]);
    assert.equal(cleanupEntered, true);
  } finally {
    status.resolve(STATUS_RESULT);
    call.destroy();
    await Promise.allSettled([callSettled, closePromise ?? hub.close()]);
  }
});

test("close rejects new MCP dispatch and waits accepted work before cleanup", async () => {
  const hub = new BreakPilotHub({ port: 0, idleTimeoutMs: 0 });
  const status = deferred<ToolResponse>();
  const entered = deferred<void>();
  const runtime = hub.projects.getOrCreate();
  runtime.manager.bpDebugStatus = async () => {
    entered.resolve();
    return status.promise;
  };
  let listCalls = 0;
  const originalListTools = runtime.router.listTools.bind(runtime.router);
  runtime.router.listTools = () => {
    listCalls += 1;
    return originalListTools();
  };
  let cleanupEntered = false;
  const originalCleanupAll = hub.projects.cleanupAll.bind(hub.projects);
  hub.projects.cleanupAll = async (reason) => {
    cleanupEntered = true;
    await originalCleanupAll(reason);
  };
  const handle = await hub.start();
  let call: RawRequest | undefined;
  let firstClose: Promise<void> | undefined;
  let secondClose: Promise<void> | undefined;
  try {
    call = modernRequest(`${handle.url}/mcp`, "tools/call", {
      name: "bp_debug_status",
      arguments: {}
    }, "bp_debug_status");
    await entered.promise;
    firstClose = hub.close();
    secondClose = hub.close();

    const rejected = await legacyListRequest(`${handle.url}/mcp`);
    assert.equal(rejected.status, 503);
    assert.equal(listCalls, 0);
    await delay(30);
    assert.equal(cleanupEntered, false);

    status.resolve(STATUS_RESULT);
    const [, firstResult, secondResult] = await Promise.allSettled([
      call.response,
      firstClose,
      secondClose
    ]);
    assert.equal(firstResult.status, "fulfilled");
    assert.equal(secondResult.status, "fulfilled");
    assert.equal(cleanupEntered, true);
  } finally {
    status.resolve(STATUS_RESULT);
    call?.destroy();
    await Promise.allSettled([
      call?.response ?? Promise.resolve(),
      firstClose ?? Promise.resolve(),
      secondClose ?? Promise.resolve(),
      hub.close()
    ]);
  }
});
