import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import test from "node:test";

import { IdeClientRegistry } from "../src/ide/IdeClientRegistry.ts";
import { IdeMessageTypes } from "../src/ide/IdeProtocol.ts";
import { IdeRuntimeProvider } from "../src/runtime/providers/IdeRuntimeProvider.ts";
import type { BridgeMessage, IdeDebugSessionInfo } from "../src/types/ide.ts";
import { ErrorCodes } from "../src/utils/errors.ts";

type CommandHandler = (message: BridgeMessage, bridge: TransitionIdeBridge) => void;

class TransitionIdeBridge extends EventEmitter {
  registry = new IdeClientRegistry();
  sent: BridgeMessage[] = [];
  commandHandler: CommandHandler;

  constructor(commandHandler: CommandHandler) {
    super();
    this.commandHandler = commandHandler;
    this.registry.add({} as Socket, {
      clientId: "idea_transition",
      ide: "idea",
      workspaceRoot: "/workspace",
      capabilities: { pause: true, stepping: true, runToLine: true }
    });
    this.receive({
      type: IdeMessageTypes.IDE_SESSION_PAUSED,
      ideSessionId: "idea_transition_session",
      reason: "breakpoint",
      threadId: 7,
      topFrame: frame(10)
    });
  }

  sendToClient(clientId: string | undefined, message: Partial<BridgeMessage>): boolean {
    assert.equal(clientId, "idea_transition");
    const outbound = { ...message, clientId } as BridgeMessage;
    this.sent.push(outbound);
    queueMicrotask(() => {
      if (message.type === "agent_request_confirmation") {
        this.receive({
          type: IdeMessageTypes.USER_CONFIRM_CONTINUE,
          confirmationId: message.confirmationId
        });
        return;
      }
      this.commandHandler(outbound, this);
    });
    return true;
  }

  acknowledge(message: BridgeMessage, result: Record<string, unknown> = { ok: true }): void {
    this.receive({
      type: IdeMessageTypes.IDE_COMMAND_RESULT,
      requestId: message.requestId,
      ideSessionId: message.ideSessionId,
      command: message.command,
      result
    });
  }

  receive(message: BridgeMessage, clientId = "idea_transition"): void {
    const isStopMessage =
      message.type === IdeMessageTypes.IDE_SESSION_PAUSED ||
      message.type === IdeMessageTypes.IDE_SESSION_STOPPED ||
      message.type === IdeMessageTypes.IDE_BREAKPOINT_HIT;
    const inbound = {
      ...message,
      clientId,
      stopped: isStopMessage && !message.stopped
        ? {
            reason: message.reason,
            threadId: message.threadId,
            description: message.description,
            topFrame: message.topFrame
          }
        : message.stopped
    };
    if (
      inbound.type === IdeMessageTypes.IDE_SESSION_PAUSED ||
      inbound.type === IdeMessageTypes.IDE_SESSION_STOPPED ||
      inbound.type === IdeMessageTypes.IDE_BREAKPOINT_HIT
    ) {
      this.registry.upsertSession(clientId, inbound, "paused");
    } else if (inbound.type === IdeMessageTypes.IDE_SESSION_RESUMED) {
      this.registry.upsertSession(clientId, inbound, "running");
    }
    this.emit("message", { clientId, message: inbound });
  }
}

function frame(line: number) {
  return {
    id: line,
    name: `line-${line}`,
    line,
    source: { path: "/workspace/Hello.java" }
  };
}

function providerWith(handler: CommandHandler): {
  bridge: TransitionIdeBridge;
  provider: IdeRuntimeProvider;
} {
  const bridge = new TransitionIdeBridge(handler);
  const ideSession = bridge.registry.findSession(
    "idea_transition_session",
    "idea_transition"
  ) as IdeDebugSessionInfo;
  return {
    bridge,
    provider: new IdeRuntimeProvider({
      sessionId: "bp_transition_session",
      bridge: bridge as unknown as ConstructorParameters<typeof IdeRuntimeProvider>[0]["bridge"],
      ideSession,
      workspaceRoot: "/workspace",
      confirmationTimeoutMs: 250
    })
  };
}

function commandResultOnly(message: BridgeMessage, bridge: TransitionIdeBridge): void {
  bridge.acknowledge(message);
}

async function expectBreakpointTimeout(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => (error as { code?: string }).code === ErrorCodes.BREAKPOINT_TIMEOUT
  );
}

test("standalone wait may return the registry's current paused snapshot", async () => {
  const { provider } = providerWith(commandResultOnly);

  const stopped = await provider.waitForBreakpoint(25);

  assert.equal(stopped.sessionId, "bp_transition_session");
  assert.equal(stopped.ideSessionId, "idea_transition_session");
  assert.equal(stopped.topFrame?.line, 10);
});

test("step does not reuse the paused snapshot that predates command dispatch", async () => {
  const { provider } = providerWith(commandResultOnly);

  await provider.step("over", 7);

  await expectBreakpointTimeout(provider.waitForBreakpoint(25));
  assert.equal((await provider.waitForBreakpoint(25)).topFrame?.line, 10);
});

test("pause does not reuse the paused snapshot that predates command dispatch", async () => {
  const { provider } = providerWith(commandResultOnly);

  await provider.pause(7);

  await expectBreakpointTimeout(provider.waitForBreakpoint(25));
});

test("run-to-line does not reuse the paused snapshot that predates command dispatch", async () => {
  const { provider } = providerWith(commandResultOnly);

  await expectBreakpointTimeout(provider.runToLine({
    filePath: "/workspace/Hello.java",
    line: 20,
    threadId: 7,
    timeoutMs: 25
  }));
});

test("run-to-line does not treat a stopped command acknowledgement as runtime evidence", async () => {
  const { provider } = providerWith((message, bridge) => {
    bridge.acknowledge(message, { status: "stopped" });
  });

  await expectBreakpointTimeout(provider.runToLine({
    filePath: "/workspace/Hello.java",
    line: 20,
    threadId: 7,
    timeoutMs: 25
  }));
});

test("step accepts a fresh pause event delivered before its command result", async () => {
  const { provider } = providerWith((message, bridge) => {
    bridge.receive({
      type: IdeMessageTypes.IDE_SESSION_PAUSED,
      ideSessionId: "idea_transition_session",
      reason: "step",
      threadId: 7,
      topFrame: frame(11)
    });
    bridge.acknowledge(message);
  });

  await provider.step("over", 7);
  const stopped = await provider.waitForBreakpoint(100);

  assert.equal(stopped.reason, "step");
  assert.equal(stopped.topFrame?.line, 11);
});

test("pause accepts a fresh pause event delivered after its command result", async () => {
  const { provider, bridge } = providerWith(commandResultOnly);

  await provider.pause(7);
  const stoppedPromise = provider.waitForBreakpoint(100);
  queueMicrotask(() => bridge.receive({
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "idea_transition_session",
    reason: "pause",
    threadId: 7,
    topFrame: frame(12)
  }));

  const stopped = await stoppedPromise;
  assert.equal(stopped.reason, "pause");
  assert.equal(stopped.topFrame?.line, 12);
});

test("run-to-line waits for a fresh event even when it arrives before the command result", async () => {
  const { provider } = providerWith((message, bridge) => {
    bridge.receive({
      type: IdeMessageTypes.IDE_BREAKPOINT_HIT,
      ideSessionId: "idea_transition_session",
      reason: "breakpoint",
      threadId: 7,
      topFrame: frame(20)
    });
    bridge.acknowledge(message, { status: "running" });
  });

  const result = await provider.runToLine({
    filePath: "/workspace/Hello.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });

  assert.equal(result.status, "paused");
  assert.deepEqual(result.position, { filePath: "/workspace/Hello.java", line: 20 });
});

test("a stop for another IDE session cannot satisfy a pending step", async () => {
  const { provider, bridge } = providerWith(commandResultOnly);

  await provider.step("over", 7);
  const stoppedPromise = provider.waitForBreakpoint(25);
  queueMicrotask(() => bridge.receive({
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "another_ide_session",
    reason: "step",
    threadId: 7,
    topFrame: frame(99)
  }));

  await expectBreakpointTimeout(stoppedPromise);
});

test("command failure clears the transition boundary for a later standalone wait", async () => {
  const { provider } = providerWith((message, bridge) => {
    bridge.receive({
      type: IdeMessageTypes.IDE_COMMAND_RESULT,
      requestId: message.requestId,
      ideSessionId: message.ideSessionId,
      command: message.command,
      error: { code: ErrorCodes.TOOL_FAILED, message: "pause failed" }
    });
  });

  await assert.rejects(
    provider.pause(7),
    (error: unknown) => (error as { code?: string }).code === ErrorCodes.TOOL_FAILED
  );
  const stopped = await provider.waitForBreakpoint(25);

  assert.equal(stopped.topFrame?.line, 10);
});

test("command timeout clears the transition boundary for a later standalone wait", async () => {
  const { provider } = providerWith(() => {});

  await assert.rejects(
    provider.runToLine({
      filePath: "/workspace/Hello.java",
      line: 20,
      threadId: 7,
      timeoutMs: 25
    }),
    (error: unknown) => (error as { code?: string }).code === ErrorCodes.IDE_BRIDGE_DISCONNECTED
  );
  const stopped = await provider.waitForBreakpoint(25);

  assert.equal(stopped.topFrame?.line, 10);
});
