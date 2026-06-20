import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";

import { IdeClientRegistry } from "../src/ide/IdeClientRegistry.ts";
import { IdeMessageTypes } from "../src/ide/IdeProtocol.ts";
import { IdeRuntimeProvider } from "../src/runtime/providers/IdeRuntimeProvider.ts";
import type { BridgeMessage, IdeDebugSessionInfo } from "../src/types/ide.ts";

class FakeIdeBridge extends EventEmitter {
  registry = new IdeClientRegistry();
  sent: BridgeMessage[] = [];
  evaluateCalls = 0;

  constructor() {
    super();
    this.registry.add({} as Socket, {
      clientId: "idea_one",
      ide: "idea",
      workspaceRoot: "/workspace",
      capabilities: { evaluate: true, pause: true }
    });
    this.registry.upsertSession(
      "idea_one",
      {
        type: IdeMessageTypes.IDE_SESSION_PAUSED,
        ideSessionId: "idea_session",
        workspaceRoot: "/workspace",
        state: "paused",
        active: true,
        topFrame: { id: 1, name: "hello", line: 21, source: { path: "/workspace/Hello.java" } }
      },
      "paused"
    );
  }

  sendToClient(clientId: string | undefined, message: Partial<BridgeMessage>): boolean {
    assert.equal(clientId, "idea_one");
    const outbound = { ...message, clientId } as BridgeMessage;
    this.sent.push(outbound);

    queueMicrotask(() => {
      if (message.type === "agent_request_confirmation") {
        this.emit("message", {
          clientId,
          message: {
            type: IdeMessageTypes.USER_CONFIRM_CONTINUE,
            confirmationId: message.confirmationId
          }
        });
        return;
      }

      if (message.type === IdeMessageTypes.AGENT_EVALUATE) {
        this.evaluateCalls += 1;
        const valuePreview = this.evaluateCalls === 1 ? "Collecting data..." : "ADA LOVELACE";
        this.emit("message", {
          clientId,
          message: {
            type: IdeMessageTypes.IDE_COMMAND_RESULT,
            requestId: message.requestId,
            ideSessionId: message.ideSessionId,
            command: "evaluate",
            result: {
              value: {
                name: "result",
                kind: "primitive",
                valuePreview,
                value: valuePreview
              }
            }
          }
        });
        return;
      }

      if (message.type === "agent_pause") {
        this.emit("message", {
          clientId,
          message: {
            type: IdeMessageTypes.IDE_COMMAND_RESULT,
            requestId: message.requestId,
            ideSessionId: message.ideSessionId,
            command: "pause",
            result: { ok: true }
          }
        });
      }
    });
    return true;
  }
}

const bridge = new FakeIdeBridge();
const ideSession = bridge.registry.findSession("idea_session", "idea_one") as IdeDebugSessionInfo;
const provider = new IdeRuntimeProvider({
  sessionId: "sess_ide",
  bridge: bridge as unknown as ConstructorParameters<typeof IdeRuntimeProvider>[0]["bridge"],
  ideSession,
  workspaceRoot: "/workspace",
  confirmationTimeoutMs: 1000
});

const pauseResult = await provider.pause(123);
assert.deepEqual(pauseResult, { ok: true });
assert.equal(bridge.sent.some((message) => message.type === "agent_pause" && message.threadId === 123), true);

const evalResult = await provider.evaluate("name.toUpperCase()", { mode: "readonly", timeoutMs: 1000 });
assert.equal(bridge.evaluateCalls, 2);
assert.equal(evalResult.value.valuePreview, "ADA LOVELACE");

console.log("ide runtime provider tests ok");
