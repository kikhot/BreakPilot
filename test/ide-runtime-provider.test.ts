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

      if (message.type === IdeMessageTypes.AGENT_LIST_BREAKPOINTS) {
        this.emit("message", {
          clientId,
          message: {
            type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
            requestId: message.requestId,
            ideSessionId: message.ideSessionId,
            result: {
              breakpoints: [
                {
                  id: "line|/workspace/Hello.java|20",
                  file: "/workspace/Hello.java",
                  line: 21,
                  owner: "user",
                  enabled: true,
                  verified: true
                }
              ]
            }
          }
        });
        return;
      }

      if (message.type === IdeMessageTypes.AGENT_SET_VARIABLE) {
        this.emit("message", {
          clientId,
          message: {
            type: IdeMessageTypes.IDE_COMMAND_RESULT,
            requestId: message.requestId,
            ideSessionId: message.ideSessionId,
            command: "set_variable",
            result: {
              path: message.path,
              oldValue: "\"Alan Turing\"",
              newValue: message.newValue,
              applied: true
            }
          }
        });
        return;
      }

      if (message.type === IdeMessageTypes.AGENT_RUN_TO_LINE) {
        this.emit("message", {
          clientId,
          message: {
            type: IdeMessageTypes.IDE_COMMAND_RESULT,
            requestId: message.requestId,
            ideSessionId: message.ideSessionId,
            command: "run_to_line",
            result: {
              status: "paused",
              position: { filePath: message.filePath, line: message.line }
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

const breakpoints = await provider.listBreakpoints?.({ owner: "all", includeDisabled: true });
assert.deepEqual(breakpoints?.map((breakpoint) => ({
  id: breakpoint.id,
  file: breakpoint.file,
  line: breakpoint.line,
  owner: breakpoint.owner,
  enabled: breakpoint.enabled
})), [{
  id: "line|/workspace/Hello.java|20",
  file: "/workspace/Hello.java",
  line: 21,
  owner: "user",
  enabled: true
}]);
assert.equal(bridge.sent.some((message) => message.type === IdeMessageTypes.AGENT_LIST_BREAKPOINTS), true);

const setValue = await provider.setVariable?.({ path: ["name"], newValue: "\"Katherine Johnson\"" });
assert.deepEqual(setValue, {
  path: ["name"],
  oldValue: "\"Alan Turing\"",
  newValue: "\"Katherine Johnson\"",
  applied: true
});

const runToLine = await provider.runToLine?.({
  filePath: "/workspace/Hello.java",
  line: 24,
  timeoutMs: 1000
});
assert.deepEqual(runToLine, {
  status: "paused",
  position: { filePath: "/workspace/Hello.java", line: 24 }
});

console.log("ide runtime provider tests ok");
