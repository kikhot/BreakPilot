import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import test from "node:test";

import { IdeClientRegistry } from "../src/ide/IdeClientRegistry.ts";
import { IdeMessageTypes } from "../src/ide/IdeProtocol.ts";
import { IdeRuntimeProvider } from "../src/runtime/providers/IdeRuntimeProvider.ts";
import type { BridgeMessage, IdeDebugSessionInfo } from "../src/types/ide.ts";
import { ErrorCodes } from "../src/utils/errors.ts";

const features = {
  breakpointUpdate: true,
  eventStream: true,
  stackPagination: true,
  variableHandles: true,
  nativeSetVariable: true,
  causalDebugStart: true
};

class CausalBridge extends EventEmitter {
  readonly registry = new IdeClientRegistry();
  readonly sent: BridgeMessage[] = [];
  connected = true;

  constructor() {
    super();
    this.registry.add({ writable: true } as Socket, {
      clientId: "causal-client",
      ide: "idea",
      workspaceRoot: "/workspace",
      capabilities: { evaluate: true, stepping: true },
      debuggerProtocolVersion: 2,
      debuggerFeatures: features
    });
    this.receive({
      type: IdeMessageTypes.IDE_SESSION_PAUSED,
      ideSessionId: "causal-ide-session",
      debuggerProtocolVersion: 2,
      debuggerFeatures: features,
      pauseEpoch: 5,
      threadId: 7,
      topFrame: frame(10)
    });
  }

  sendToClient(clientId: string | undefined, message: Partial<BridgeMessage>): boolean {
    assert.equal(clientId, "causal-client");
    if (!this.connected) return false;
    this.sent.push({ ...message, clientId } as BridgeMessage);
    return true;
  }

  receive(message: BridgeMessage, clientId = "causal-client"): void {
    const lifecycle = new Set<string>([
      IdeMessageTypes.IDE_SESSION_PAUSED,
      IdeMessageTypes.IDE_SESSION_STOPPED,
      IdeMessageTypes.IDE_BREAKPOINT_HIT
    ]);
    if (lifecycle.has(message.type)) {
      this.registry.upsertSession(clientId, message, "paused");
    }
    this.emit("message", { clientId, message });
  }

  last(type: string): BridgeMessage {
    const message = [...this.sent].reverse().find((candidate) => candidate.type === type);
    assert.ok(message, `missing outbound ${type}`);
    return message;
  }

  confirm(message: BridgeMessage): void {
    this.receive({
      type: IdeMessageTypes.USER_CONFIRM_CONTINUE,
      confirmationId: message.confirmationId,
      sessionId: message.sessionId,
      ideSessionId: message.ideSessionId,
      pauseEpoch: message.expectedPauseEpoch
    });
  }
}

function frame(line: number) {
  return { id: line, name: `line-${line}`, line, source: { path: "/workspace/App.java" } };
}

function fixture(): { bridge: CausalBridge; provider: IdeRuntimeProvider } {
  const bridge = new CausalBridge();
  const ideSession = bridge.registry.findSession(
    "causal-ide-session",
    "causal-client"
  ) as IdeDebugSessionInfo;
  return {
    bridge,
    provider: new IdeRuntimeProvider({
      sessionId: "breakpilot-session",
      bridge: bridge as unknown as ConstructorParameters<typeof IdeRuntimeProvider>[0]["bridge"],
      ideSession,
      workspaceRoot: "/workspace",
      confirmationTimeoutMs: 100
    })
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function assertPending(promise: Promise<unknown>): Promise<void> {
  const state = await Promise.race([
    promise.then(() => "resolved", () => "rejected"),
    nextTurn().then(() => "pending")
  ]);
  assert.equal(state, "pending");
}

test("v2 provider ignores same-client replies outside the exact session tuple", async () => {
  const { bridge, provider } = fixture();
  const pending = provider.listBreakpoints?.();
  assert.ok(pending);
  const request = bridge.last(IdeMessageTypes.AGENT_LIST_BREAKPOINTS);

  bridge.receive({
    type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
    requestId: request.requestId,
    sessionId: request.sessionId,
    ideSessionId: "foreign-ide-session",
    pauseEpoch: request.expectedPauseEpoch,
    result: { breakpoints: [] }
  });
  await assertPending(pending);

  bridge.receive({
    type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
    requestId: request.requestId,
    sessionId: "foreign-breakpilot-session",
    ideSessionId: request.ideSessionId,
    pauseEpoch: request.expectedPauseEpoch,
    result: { breakpoints: [] }
  });
  await assertPending(pending);

  bridge.receive({
    type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
    requestId: request.requestId,
    sessionId: request.sessionId,
    ideSessionId: request.ideSessionId,
    pauseEpoch: request.expectedPauseEpoch,
    result: { breakpoints: [] }
  });
  assert.deepEqual(await pending, []);
});

test("v2 provider rejects a stale reply on the otherwise trusted tuple", async () => {
  const { bridge, provider } = fixture();
  const pending = provider.listBreakpoints?.();
  assert.ok(pending);
  const request = bridge.last(IdeMessageTypes.AGENT_LIST_BREAKPOINTS);

  bridge.receive({
    type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
    requestId: request.requestId,
    sessionId: request.sessionId,
    ideSessionId: request.ideSessionId,
    pauseEpoch: 4,
    result: { breakpoints: [] }
  });

  await assert.rejects(
    pending,
    (error: unknown) => (error as { code?: string }).code === ErrorCodes.STALE_RUNTIME_HANDLE
  );
});

test("v2 confirmation and command results require their complete correlation tuple", async () => {
  const { bridge, provider } = fixture();
  const pending = provider.evaluate("score", { timeoutMs: 100 });
  const confirmation = bridge.last("agent_request_confirmation");

  bridge.receive({
    type: IdeMessageTypes.USER_CONFIRM_CONTINUE,
    confirmationId: confirmation.confirmationId,
    sessionId: "foreign-breakpilot-session",
    ideSessionId: confirmation.ideSessionId,
    pauseEpoch: confirmation.expectedPauseEpoch
  });
  await nextTurn();
  assert.equal(bridge.sent.some((message) => message.type === IdeMessageTypes.AGENT_EVALUATE), false);

  bridge.confirm(confirmation);
  await nextTurn();
  const request = bridge.last(IdeMessageTypes.AGENT_EVALUATE);
  bridge.receive({
    type: IdeMessageTypes.IDE_COMMAND_RESULT,
    requestId: request.requestId,
    sessionId: request.sessionId,
    ideSessionId: request.ideSessionId,
    pauseEpoch: request.expectedPauseEpoch,
    result: { value: "forged-without-command" }
  });
  await assertPending(pending);

  bridge.receive({
    type: IdeMessageTypes.IDE_COMMAND_RESULT,
    requestId: request.requestId,
    sessionId: request.sessionId,
    ideSessionId: request.ideSessionId,
    pauseEpoch: request.expectedPauseEpoch,
    command: "evaluate",
    result: { value: "trusted" }
  });
  assert.deepEqual(await pending, { value: "trusted" });
});

test("v2 control stop evidence requires the command origin and a newer pause epoch", async () => {
  const { bridge, provider } = fixture();
  const step = provider.step("over", 7);
  const confirmation = bridge.last("agent_request_confirmation");
  bridge.confirm(confirmation);
  await nextTurn();
  const request = bridge.last(IdeMessageTypes.AGENT_STEP_OVER);

  bridge.receive({
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: request.ideSessionId,
    pauseEpoch: 6,
    reason: "unrelated",
    threadId: 7,
    topFrame: frame(11)
  });
  bridge.receive({
    type: IdeMessageTypes.IDE_COMMAND_RESULT,
    requestId: request.requestId,
    sessionId: request.sessionId,
    ideSessionId: request.ideSessionId,
    pauseEpoch: request.expectedPauseEpoch,
    command: "step_over",
    result: { ok: true }
  });
  await step;
  const stopped = provider.waitForBreakpoint(100);
  await assertPending(stopped);

  bridge.receive({
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: request.ideSessionId,
    originRequestId: request.requestId,
    pauseEpoch: 7,
    reason: "step",
    threadId: 7,
    topFrame: frame(12)
  });
  assert.equal((await stopped).topFrame?.line, 12);
});

test("provider dispatch failure removes request and confirmation listeners", async () => {
  const { bridge, provider } = fixture();
  const baseline = bridge.listenerCount("message");
  bridge.connected = false;

  await assert.rejects(
    provider.listBreakpoints?.(),
    (error: unknown) => (error as { code?: string }).code === ErrorCodes.IDE_NOT_CONNECTED
  );
  assert.equal(bridge.listenerCount("message"), baseline);

  await assert.rejects(
    provider.evaluate("score", { timeoutMs: 20 }),
    (error: unknown) => (error as { code?: string }).code === ErrorCodes.IDE_NOT_CONNECTED
  );
  assert.equal(bridge.listenerCount("message"), baseline);
});
