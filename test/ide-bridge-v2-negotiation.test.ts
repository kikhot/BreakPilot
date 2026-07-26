import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";
import type { Socket } from "node:net";

import { negotiateDebuggerFeatures } from "../src/ide/DebuggerFeatureNegotiation.ts";
import { IdeClientRegistry } from "../src/ide/IdeClientRegistry.ts";
import { IdeBridgeServer } from "../src/ide/IdeBridgeServer.ts";
import { IdeMessageTypes } from "../src/ide/IdeProtocol.ts";

const v2Features = {
  breakpointUpdate: true,
  eventStream: true,
  stackPagination: true,
  variableHandles: true,
  nativeSetVariable: true
};

function addClient(registry: IdeClientRegistry, clientId: string, protocol: Record<string, unknown> = {}): void {
  registry.add({ writable: true } as Socket, {
    clientId,
    ide: "idea",
    capabilities: {},
    ...protocol
  });
}

function clientFrame(message: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ (mask[index % mask.length] ?? 0)));
  return Buffer.concat([header, mask, masked]);
}

async function connectBridge(bridge: IdeBridgeServer) {
  await bridge.start();
  const socket = createConnection({ host: bridge.host, port: bridge.port });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write([
        "GET / HTTP/1.1",
        `Host: ${bridge.host}:${bridge.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n"));
    });
    socket.once("data", () => resolve());
  });
  return socket;
}

async function nextBridgeMessage(bridge: IdeBridgeServer, type: string): Promise<void> {
  await new Promise<void>((resolve) => bridge.once(type, () => resolve()));
}

test("protocol v2 features require an explicit v2 client declaration", () => {
  assert.equal(
    negotiateDebuggerFeatures({ debuggerProtocolVersion: 1, debuggerFeatures: { variableHandles: true } }, {}).variableHandles,
    false
  );
  assert.equal(
    negotiateDebuggerFeatures({ debuggerProtocolVersion: 2, debuggerFeatures: { variableHandles: true } }, {}).variableHandles,
    true
  );
  assert.equal(
    negotiateDebuggerFeatures(
      { debuggerProtocolVersion: 2, debuggerFeatures: { nativeSetVariable: true } },
      { debuggerProtocolVersion: 2, debuggerFeatures: { nativeSetVariable: false } }
    ).nativeSetVariable,
    false
  );
  const legacyAlias = { debuggerProtocolVersion: 2, capabilities: { variableHandles: true } };
  assert.equal(negotiateDebuggerFeatures(legacyAlias, {}).variableHandles, false);
});

test("registry persists raw protocol, negotiated session features, and a pause epoch", () => {
  const registry = new IdeClientRegistry();
  addClient(registry, "client-a", {
    debuggerProtocolVersion: 2,
    debuggerFeatures: { variableHandles: true }
  });

  registry.upsertSession("client-a", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "ide-1",
    debuggerProtocolVersion: 2,
    debuggerFeatures: { nativeSetVariable: false },
    pauseEpoch: 4
  }, "paused");

  const session = registry.findSessionForClient("client-a", "ide-1");
  assert.equal(session?.pauseEpoch, 4);
  assert.equal(session?.debuggerProtocolVersion, 2);
  assert.equal(session?.debuggerFeatures?.nativeSetVariable, false);
  assert.equal(session?.negotiatedDebuggerFeatures.variableHandles, true);
  assert.equal(session?.negotiatedDebuggerFeatures.nativeSetVariable, false);
});

test("a replacement client invalidates its previous session epoch", () => {
  const registry = new IdeClientRegistry();
  addClient(registry, "client-a", {
    debuggerProtocolVersion: 2,
    debuggerFeatures: v2Features
  });
  registry.upsertSession("client-a", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "ide-1",
    debuggerProtocolVersion: 2,
    pauseEpoch: 4
  }, "paused");

  addClient(registry, "client-a", {
    debuggerProtocolVersion: 2,
    debuggerFeatures: v2Features
  });

  assert.equal(registry.findSessionForClient("client-a", "ide-1"), undefined);
  assert.equal(registry.getPauseEpoch("client-a", "ide-1"), undefined);
  assert.equal(registry.getSessionRevision("ide-1", "client-a"), 0);
});

test("only a higher v2 paused epoch replaces pause state", () => {
  const registry = new IdeClientRegistry();
  addClient(registry, "client-a", {
    debuggerProtocolVersion: 2,
    debuggerFeatures: v2Features
  });
  registry.upsertSession("client-a", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "ide-1",
    debuggerProtocolVersion: 2,
    pauseEpoch: 4,
    topFrame: { id: 4 }
  }, "paused");
  const initialRevision = registry.getSessionRevision("ide-1", "client-a");

  registry.upsertSession("client-a", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "ide-1",
    debuggerProtocolVersion: 2,
    pauseEpoch: 3,
    topFrame: { id: 3 }
  }, "paused");
  assert.equal(registry.findSessionForClient("client-a", "ide-1")?.topFrame?.id, 4);
  assert.equal(registry.getSessionRevision("ide-1", "client-a"), initialRevision);

  registry.upsertSession("client-a", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "ide-1",
    debuggerProtocolVersion: 2,
    pauseEpoch: 4,
    topFrame: { id: 40 }
  }, "paused");
  assert.equal(registry.findSessionForClient("client-a", "ide-1")?.topFrame?.id, 4);
  assert.equal(registry.getSessionRevision("ide-1", "client-a"), initialRevision);

  registry.upsertSession("client-a", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "ide-1",
    debuggerProtocolVersion: 2,
    pauseEpoch: 5,
    topFrame: { id: 5 }
  }, "paused");
  assert.equal(registry.findSessionForClient("client-a", "ide-1")?.pauseEpoch, 5);
  assert.equal(registry.findSessionForClient("client-a", "ide-1")?.topFrame?.id, 5);
  assert.equal(registry.getSessionRevision("ide-1", "client-a"), initialRevision + 1);
});

test("a protocol v1 client is not sent a v2 stack request", () => {
  const bridge = new IdeBridgeServer();
  const writes: Buffer[] = [];
  const socket = {
    writable: true,
    write: (chunk: Buffer) => {
      writes.push(chunk);
      return true;
    }
  } as Socket;
  bridge.registry.add(socket, {
    clientId: "legacy-client",
    ide: "idea",
    capabilities: { stackPagination: true },
    debuggerProtocolVersion: 1,
    debuggerFeatures: { stackPagination: true }
  });
  bridge.registry.upsertSession("legacy-client", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "legacy-session",
    debuggerProtocolVersion: 1
  }, "paused");

  assert.equal(bridge.sendToClient("legacy-client", {
    type: IdeMessageTypes.AGENT_REQUEST_STACK,
    ideSessionId: "legacy-session"
  }), false);
  assert.equal(bridge.sendToClient("legacy-client", {
    type: IdeMessageTypes.AGENT_REQUEST_STACK
  }), false);
  assert.equal(writes.length, 0);
});

test("the bridge rejects a mismatched session response but accepts a legacy response without session identity", async () => {
  const bridge = new IdeBridgeServer({ port: 0 });
  const socket = await connectBridge(bridge);
  try {
    const clientId = bridge.registry.list()[0]?.clientId;
    assert.ok(clientId);
    socket.write(clientFrame({ type: IdeMessageTypes.IDE_REGISTER, ide: "idea" }));
    const started = nextBridgeMessage(bridge, IdeMessageTypes.IDE_SESSION_STARTED);
    socket.write(clientFrame({
      type: IdeMessageTypes.IDE_SESSION_STARTED,
      ideSessionId: "owned-session"
    }));
    await started;

    let mismatchedResponseEmitted = false;
    bridge.once(IdeMessageTypes.IDE_COMMAND_RESULT, () => {
      mismatchedResponseEmitted = true;
    });
    socket.write(clientFrame({
      type: IdeMessageTypes.IDE_COMMAND_RESULT,
      ideSessionId: "other-session",
      requestId: "mismatched"
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(mismatchedResponseEmitted, false);

    const legacyResponse = nextBridgeMessage(bridge, IdeMessageTypes.IDE_COMMAND_RESULT);
    socket.write(clientFrame({
      type: IdeMessageTypes.IDE_COMMAND_RESULT,
      requestId: "legacy"
    }));
    await legacyResponse;
  } finally {
    socket.destroy();
    bridge.stop();
  }
});

test("a resumed v2 epoch rejects a delayed paused lifecycle message before bridge emission", async () => {
  const bridge = new IdeBridgeServer({ port: 0 });
  const socket = await connectBridge(bridge);
  try {
    socket.write(clientFrame({
      type: IdeMessageTypes.IDE_REGISTER,
      ide: "idea",
      debuggerProtocolVersion: 2,
      debuggerFeatures: {}
    }));
    const started = nextBridgeMessage(bridge, IdeMessageTypes.IDE_SESSION_STARTED);
    socket.write(clientFrame({
      type: IdeMessageTypes.IDE_SESSION_STARTED,
      ideSessionId: "v2-session",
      debuggerProtocolVersion: 2
    }));
    await started;
    const paused = nextBridgeMessage(bridge, IdeMessageTypes.IDE_SESSION_PAUSED);
    socket.write(clientFrame({
      type: IdeMessageTypes.IDE_SESSION_PAUSED,
      ideSessionId: "v2-session",
      debuggerProtocolVersion: 2,
      pauseEpoch: 4
    }));
    await paused;
    const resumed = nextBridgeMessage(bridge, IdeMessageTypes.IDE_SESSION_RESUMED);
    socket.write(clientFrame({
      type: IdeMessageTypes.IDE_SESSION_RESUMED,
      ideSessionId: "v2-session",
      debuggerProtocolVersion: 2,
      pauseEpoch: 5
    }));
    await resumed;

    const clientId = bridge.registry.list()[0]?.clientId;
    assert.ok(clientId);
    const revision = bridge.registry.getSessionRevision("v2-session", clientId);
    let stalePauseEmitted = false;
    bridge.once(IdeMessageTypes.IDE_SESSION_PAUSED, () => {
      stalePauseEmitted = true;
    });
    socket.write(clientFrame({
      type: IdeMessageTypes.IDE_SESSION_PAUSED,
      ideSessionId: "v2-session",
      debuggerProtocolVersion: 2,
      pauseEpoch: 5
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stalePauseEmitted, false);
    assert.equal(bridge.registry.findSessionForClient(clientId, "v2-session")?.state, "running");
    assert.equal(bridge.registry.getSessionRevision("v2-session", clientId), revision);
  } finally {
    socket.destroy();
    bridge.stop();
  }
});

test("v2 pause correlation fails closed while v1 pauses retain legacy behavior", () => {
  const registry = new IdeClientRegistry();
  addClient(registry, "v2", { debuggerProtocolVersion: 2, debuggerFeatures: {} });
  registry.upsertSession("v2", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "v2-session",
    debuggerProtocolVersion: 2,
    pauseEpoch: 4,
    topFrame: { id: 4 }
  }, "paused");
  const revision = registry.getSessionRevision("v2-session", "v2");

  assert.equal(registry.upsertSession("v2", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "v2-session",
    debuggerProtocolVersion: 2,
    topFrame: { id: 99 }
  }, "paused"), null);
  assert.equal(registry.upsertSession("v2", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "v2-session",
    debuggerProtocolVersion: 2,
    pauseEpoch: "bad" as unknown as number,
    topFrame: { id: 99 }
  }, "paused"), null);
  assert.equal(registry.findSessionForClient("v2", "v2-session")?.topFrame?.id, 4);
  assert.equal(registry.getSessionRevision("v2-session", "v2"), revision);

  addClient(registry, "v1", { debuggerProtocolVersion: 1, debuggerFeatures: {} });
  registry.upsertSession("v1", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "v1-session",
    topFrame: { id: 1 }
  }, "paused");
  registry.upsertSession("v1", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "v1-session",
    topFrame: { id: 2 }
  }, "paused");
  assert.equal(registry.findSessionForClient("v1", "v1-session")?.topFrame?.id, 2);
});

test("an established v2 session cannot downgrade to bypass its epoch floor", () => {
  const registry = new IdeClientRegistry();
  addClient(registry, "client", { debuggerProtocolVersion: 2, debuggerFeatures: {} });
  registry.upsertSession("client", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "session",
    debuggerProtocolVersion: 2,
    pauseEpoch: 4
  }, "paused");
  registry.upsertSession("client", {
    type: IdeMessageTypes.IDE_SESSION_RESUMED,
    ideSessionId: "session",
    debuggerProtocolVersion: 2,
    pauseEpoch: 5
  }, "running");

  assert.equal(registry.upsertSession("client", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "session",
    debuggerProtocolVersion: 1,
    pauseEpoch: 4
  }, "paused"), null);
  assert.equal(registry.findSessionForClient("client", "session")?.state, "running");
  assert.equal(registry.findSessionForClient("client", "session")?.debuggerProtocolVersion, 2);
});

test("session feature false remains sticky across partial protocol feature updates", () => {
  const registry = new IdeClientRegistry();
  addClient(registry, "client", {
    debuggerProtocolVersion: 2,
    debuggerFeatures: { nativeSetVariable: true, variableHandles: true }
  });
  registry.upsertSession("client", {
    type: IdeMessageTypes.IDE_SESSION_STARTED,
    ideSessionId: "session",
    debuggerProtocolVersion: 2,
    debuggerFeatures: { nativeSetVariable: false }
  }, "running");
  registry.upsertSession("client", {
    type: IdeMessageTypes.IDE_SESSION_RESUMED,
    ideSessionId: "session",
    debuggerFeatures: { variableHandles: true }
  }, "running");

  const session = registry.findSessionForClient("client", "session");
  assert.equal(session?.debuggerFeatures?.nativeSetVariable, false);
  assert.equal(session?.negotiatedDebuggerFeatures.nativeSetVariable, false);
  assert.equal(session?.negotiatedDebuggerFeatures.variableHandles, true);
});

test("an old socket closing cannot remove its replacement client state", async () => {
  const bridge = new IdeBridgeServer({ port: 0 });
  const oldSocket = await connectBridge(bridge);
  const clientId = bridge.registry.list()[0]?.clientId;
  assert.ok(clientId);
  const oldServerSocket = bridge.registry.get(clientId)?.socket;
  assert.ok(oldServerSocket);
  const replacement = {
    writable: true,
    write: () => true,
    destroy: () => undefined
  } as unknown as Socket;
  try {
    bridge.registry.add(replacement, { clientId, ide: "idea", capabilities: {} });
    oldServerSocket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(bridge.registry.get(clientId)?.socket, replacement);
  } finally {
    oldSocket.destroy();
    bridge.stop();
  }
});

test("an inherited v2 session rejects a malformed protocol downgrade before stale pause filtering", () => {
  const registry = new IdeClientRegistry();
  addClient(registry, "client", { debuggerProtocolVersion: 2, debuggerFeatures: {} });
  registry.upsertSession("client", {
    type: IdeMessageTypes.IDE_SESSION_STARTED,
    ideSessionId: "session"
  }, "running");
  registry.upsertSession("client", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "session",
    pauseEpoch: 4
  }, "paused");
  registry.upsertSession("client", {
    type: IdeMessageTypes.IDE_SESSION_RESUMED,
    ideSessionId: "session",
    pauseEpoch: 5
  }, "running");

  assert.equal(registry.upsertSession("client", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "session",
    debuggerProtocolVersion: "bogus" as unknown as number,
    pauseEpoch: 4
  }, "paused"), null);
  assert.equal(registry.findSessionForClient("client", "session")?.state, "running");
});

test("a live session keeps its explicit protocol version after later lifecycle payloads", () => {
  const registry = new IdeClientRegistry();
  addClient(registry, "client", { debuggerProtocolVersion: 2, debuggerFeatures: {} });
  registry.upsertSession("client", {
    type: IdeMessageTypes.IDE_SESSION_STARTED,
    ideSessionId: "session",
    debuggerProtocolVersion: 1
  }, "running");
  registry.upsertSession("client", {
    type: IdeMessageTypes.IDE_SESSION_RESUMED,
    ideSessionId: "session",
    debuggerProtocolVersion: 2
  }, "running");

  assert.equal(registry.findSessionForClient("client", "session")?.debuggerProtocolVersion, 1);
});

test("repeat IDE registration preserves an established v2 protocol and epoch enforcement", async () => {
  const bridge = new IdeBridgeServer({ port: 0 });
  const socket = await connectBridge(bridge);
  try {
    const firstRegistration = nextBridgeMessage(bridge, IdeMessageTypes.IDE_REGISTER);
    socket.write(clientFrame({
      type: IdeMessageTypes.IDE_REGISTER,
      ide: "idea",
      debuggerProtocolVersion: 2,
      debuggerFeatures: { variableHandles: true }
    }));
    await firstRegistration;
    const repeatRegistration = nextBridgeMessage(bridge, IdeMessageTypes.IDE_REGISTER);
    socket.write(clientFrame({ type: IdeMessageTypes.IDE_REGISTER, ide: "idea" }));
    await repeatRegistration;

    const clientId = bridge.registry.list()[0]?.clientId;
    const client = bridge.registry.get(clientId);
    assert.equal(client?.debuggerProtocolVersion, 2);
    assert.equal(client?.debuggerFeatures?.variableHandles, true);
    bridge.registry.upsertSession(clientId, {
      type: IdeMessageTypes.IDE_SESSION_PAUSED,
      ideSessionId: "session",
      pauseEpoch: 4
    }, "paused");
    bridge.registry.upsertSession(clientId, {
      type: IdeMessageTypes.IDE_SESSION_RESUMED,
      ideSessionId: "session",
      pauseEpoch: 5
    }, "running");
    assert.equal(bridge.registry.upsertSession(clientId, {
      type: IdeMessageTypes.IDE_SESSION_PAUSED,
      ideSessionId: "session",
      pauseEpoch: 5
    }, "paused"), null);
  } finally {
    socket.destroy();
    bridge.stop();
  }
});

test("an initial explicit invalid session protocol cannot inherit client v2", () => {
  const registry = new IdeClientRegistry();
  addClient(registry, "client", { debuggerProtocolVersion: 2, debuggerFeatures: {} });
  for (const debuggerProtocolVersion of ["bogus", null, 2.5]) {
    assert.equal(registry.upsertSession("client", {
      type: IdeMessageTypes.IDE_SESSION_STARTED,
      ideSessionId: String(debuggerProtocolVersion),
      debuggerProtocolVersion: debuggerProtocolVersion as unknown as number
    }, "running"), null);
  }
  assert.equal(registry.listSessions({ clientId: "client" }).length, 0);
});

test("a superseded socket cannot dispatch or disconnect its replacement client", async () => {
  const bridge = new IdeBridgeServer({ port: 0 });
  const oldSocket = await connectBridge(bridge);
  try {
    const clientId = bridge.registry.list()[0]?.clientId;
    assert.ok(clientId);
    const oldServerSocket = bridge.registry.get(clientId)?.socket;
    assert.ok(oldServerSocket);
    const replacement = {
      writable: true,
      write: () => true,
      destroy: () => undefined
    } as unknown as Socket;
    bridge.registry.add(replacement, { clientId, ide: "idea", capabilities: {} });

    let staleMessageEmitted = false;
    let staleDisconnectEmitted = false;
    bridge.once("message", () => {
      staleMessageEmitted = true;
    });
    bridge.once("disconnect", () => {
      staleDisconnectEmitted = true;
    });
    oldSocket.write(clientFrame({
      type: IdeMessageTypes.IDE_SESSION_STARTED,
      ideSessionId: "injected"
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    oldServerSocket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(staleMessageEmitted, false);
    assert.equal(staleDisconnectEmitted, false);
    assert.equal(bridge.registry.get(clientId)?.socket, replacement);
    assert.equal(bridge.registry.findSessionForClient(clientId, "injected"), undefined);
  } finally {
    oldSocket.destroy();
    bridge.stop();
  }
});

test("a current socket still dispatches and disconnects normally", async () => {
  const bridge = new IdeBridgeServer({ port: 0 });
  const socket = await connectBridge(bridge);
  try {
    const clientId = bridge.registry.list()[0]?.clientId;
    assert.ok(clientId);
    const serverSocket = bridge.registry.get(clientId)?.socket;
    assert.ok(serverSocket);
    const command = nextBridgeMessage(bridge, IdeMessageTypes.IDE_COMMAND_RESULT);
    socket.write(clientFrame({ type: IdeMessageTypes.IDE_COMMAND_RESULT, requestId: "current" }));
    await command;
    const disconnect = new Promise<void>((resolve) => bridge.once("disconnect", () => resolve()));
    serverSocket.destroy();
    await disconnect;
    assert.equal(bridge.registry.get(clientId), undefined);
  } finally {
    socket.destroy();
    bridge.stop();
  }
});
