import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import test from "node:test";

import { IdeClientRegistry } from "../src/ide/IdeClientRegistry.ts";
import { IdeMessageTypes } from "../src/ide/IdeProtocol.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import type { BridgeMessage } from "../src/types/ide.ts";
import { ErrorCodes } from "../src/utils/errors.ts";

class EventIdeBridge extends EventEmitter {
  readonly registry = new IdeClientRegistry();

  constructor(eventStream: boolean) {
    super();
    const workspaceRoot = loadPolicy("breakpilot.yaml").workspace.root;
    this.registry.add({ writable: true } as Socket, {
      clientId: "event-client",
      ide: "idea",
      workspaceRoot,
      capabilities: { variableSnapshot: true },
      debuggerProtocolVersion: 2,
      debuggerFeatures: { eventStream }
    });
    this.registry.upsertSession("event-client", {
      type: IdeMessageTypes.IDE_SESSION_PAUSED,
      ideSessionId: "event-ide-session",
      workspaceRoot,
      debuggerProtocolVersion: 2,
      debuggerFeatures: { eventStream },
      pauseEpoch: 3,
      state: "paused",
      active: true
    }, "paused");
  }

  sendToClient(): boolean {
    return true;
  }

  debugEvent(message: Partial<BridgeMessage>, clientId = "event-client"): void {
    this.emit(IdeMessageTypes.IDE_DEBUG_EVENT, {
      clientId,
      message: {
        type: IdeMessageTypes.IDE_DEBUG_EVENT,
        ideSessionId: "event-ide-session",
        pauseEpoch: 3,
        ...message
      }
    });
  }
}

async function fixture(eventStream = true) {
  const policy = loadPolicy("breakpilot.yaml");
  const bridge = new EventIdeBridge(eventStream);
  const manager = new DebugSessionManager({ policy, ideBridge: bridge as any });
  const started = await manager.bpDebugStart({
    mode: "ide",
    clientId: "event-client",
    ideSessionId: "event-ide-session"
  });
  return { bridge, manager, sessionId: String(started.sessionId) };
}

test("negotiated IDE events drain in order without raw debugger payloads", async () => {
  const { bridge, manager, sessionId } = await fixture();
  bridge.debugEvent({
    event: {
      kind: "output",
      category: "stdout",
      message: "server ready",
      data: {
        reason: "console",
        stackFrames: [{ name: "secret-frame" }],
        variables: { password: "secret" }
      }
    }
  });
  bridge.debugEvent({
    event: {
      kind: "stopped",
      threadId: 4,
      position: { filePath: "App.java", line: 20 },
      data: { reason: "breakpoint", allThreadsStopped: true }
    }
  });

  const response = await manager.bpDebugControl({
    sessionId,
    action: "drainEvents",
    cursor: 0,
    limit: 8
  });
  const items = (response.events as { items: Array<Record<string, unknown>> }).items;
  assert.deepEqual(items.map((event) => event.kind), ["output", "stopped"]);
  assert.deepEqual(items.map((event) => event.sequence), [1, 2]);
  assert.equal(items[1]?.threadId, 4);
  assert.deepEqual(items[0]?.data, { reason: "console" });
  assert.equal(JSON.stringify(items).includes("secret"), false);
});

test("IDE event ingress requires the exact adopted client, session, and pause epoch", async () => {
  const { bridge, manager, sessionId } = await fixture();
  bridge.debugEvent({ event: { kind: "output", message: "wrong client" } }, "foreign-client");
  bridge.debugEvent({
    ideSessionId: "foreign-session",
    event: { kind: "output", message: "wrong session" }
  });
  bridge.debugEvent({
    pauseEpoch: 2,
    event: { kind: "output", message: "stale epoch" }
  });
  bridge.debugEvent({ event: { kind: "rawAdapterPacket", message: "unknown" } });
  bridge.debugEvent({ event: { kind: "output", message: "trusted" } });

  const response = await manager.bpDebugControl({ sessionId, action: "drainEvents", cursor: 0 });
  const items = (response.events as { items: Array<Record<string, unknown>> }).items;
  assert.deepEqual(items.map((event) => event.message), ["trusted"]);
  assert.deepEqual(items.map((event) => event.sequence), [1]);
});

test("legacy or explicitly disabled IDE event streams remain unsupported", async () => {
  const { bridge, manager, sessionId } = await fixture(false);
  bridge.debugEvent({ event: { kind: "output", message: "ignored" } });

  await assert.rejects(
    manager.bpDebugControl({ sessionId, action: "drainEvents", cursor: 0 }),
    (error: unknown) => (error as { code?: string }).code === ErrorCodes.UNSUPPORTED_CAPABILITY
  );
});
