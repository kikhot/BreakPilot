import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import test from "node:test";

import { IdeClientRegistry } from "../src/ide/IdeClientRegistry.ts";
import { IdeMessageTypes } from "../src/ide/IdeProtocol.ts";
import { IdeRuntimeProvider } from "../src/runtime/providers/IdeRuntimeProvider.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import type { BridgeMessage, IdeDebugSessionInfo } from "../src/types/ide.ts";

const features = {
  stackPagination: true,
  variableHandles: true,
  nativeSetVariable: true
};

class V2RuntimeBridge extends EventEmitter {
  readonly registry = new IdeClientRegistry();
  readonly sent: BridgeMessage[] = [];

  constructor() {
    super();
    this.registry.add({ writable: true } as Socket, {
      clientId: "v2-client",
      ide: "idea",
      workspaceRoot: "/workspace",
      capabilities: { debugCommands: true, variableSnapshot: true, setVariable: true },
      debuggerProtocolVersion: 2,
      debuggerFeatures: features
    });
    this.registry.upsertSession("v2-client", {
      type: IdeMessageTypes.IDE_SESSION_PAUSED,
      ideSessionId: "v2-ide-session",
      debuggerProtocolVersion: 2,
      debuggerFeatures: features,
      pauseEpoch: 8,
      state: "paused",
      threadId: 7
    }, "paused");
  }

  sendToClient(clientId: string | undefined, message: Partial<BridgeMessage>): boolean {
    assert.equal(clientId, "v2-client");
    this.sent.push({ ...message, clientId } as BridgeMessage);
    queueMicrotask(() => {
      if (message.type === "agent_request_confirmation") {
        this.reply(message, {
          type: IdeMessageTypes.USER_CONFIRM_CONTINUE,
          confirmationId: message.confirmationId
        });
      }
    });
    return true;
  }

  reply(request: Partial<BridgeMessage>, response: Partial<BridgeMessage>): void {
    this.emit("message", {
      clientId: "v2-client",
      message: {
        sessionId: request.sessionId,
        ideSessionId: request.ideSessionId,
        requestId: request.requestId,
        pauseEpoch: request.expectedPauseEpoch,
        ...response
      }
    });
  }

  last(type: string): BridgeMessage {
    const message = [...this.sent].reverse().find((candidate) => candidate.type === type);
    assert.ok(message, `missing outbound ${type}`);
    return message;
  }
}

function fixture(): { bridge: V2RuntimeBridge; provider: IdeRuntimeProvider } {
  const bridge = new V2RuntimeBridge();
  const ideSession = bridge.registry.findSession("v2-ide-session", "v2-client") as IdeDebugSessionInfo;
  return {
    bridge,
    provider: new IdeRuntimeProvider({
      sessionId: "v2-breakpilot-session",
      bridge: bridge as any,
      ideSession,
      workspaceRoot: "/workspace",
      confirmationTimeoutMs: 100
    })
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("negotiated v2 stack pagination uses a direct correlated stack request", async () => {
  const { bridge, provider } = fixture();
  const pending = provider.getCallStack(7, { offset: 4, limit: 2, pauseEpoch: 8 });
  await nextTurn();
  const request = bridge.last(IdeMessageTypes.AGENT_REQUEST_STACK);
  assert.equal(request.threadId, 7);
  assert.equal(request.offset, 4);
  assert.equal(request.limit, 2);
  assert.equal(request.expectedPauseEpoch, 8);
  bridge.reply(request, {
    type: IdeMessageTypes.IDE_STACK_SNAPSHOT,
    result: {
      threadId: 7,
      stackFrames: [{ id: "frame-4", name: "work", line: 20 }],
      offset: 4,
      totalFrames: 5,
      completeness: "complete",
      pauseEpoch: 8
    }
  });

  const result = await pending;
  assert.equal(result.completeness, "complete");
  assert.equal(result.partial, false);
  assert.equal(result.totalFrames, 5);
  assert.equal(result.pauseEpoch, 8);
});

test("negotiated opaque refs are expanded without numeric coercion", async () => {
  const { bridge, provider } = fixture();
  const pending = provider.inspectVariable({ ref: "bpref_child", count: 20 }, {
    maxDepth: 1,
    maxItems: 20,
    maxStringLength: 200,
    redactPatterns: []
  });
  await nextTurn();
  const request = bridge.last(IdeMessageTypes.AGENT_REQUEST_VARIABLES);
  assert.equal(request.ref, "bpref_child");
  assert.equal(request.expectedPauseEpoch, 8);
  bridge.reply(request, {
    type: IdeMessageTypes.IDE_VARIABLES_SNAPSHOT,
    result: {
      ref: "bpref_child",
      pauseEpoch: 8,
      items: [{ name: "score", valuePreview: "41", modifiable: true }]
    }
  });

  assert.deepEqual(await pending, {
    ref: "bpref_child",
    pauseEpoch: 8,
    items: [{ name: "score", valuePreview: "41", modifiable: true }]
  });
});

test("negotiated ref mutation preserves native read-back evidence through the manager", async () => {
  const { bridge, provider } = fixture();
  const policy = loadPolicy("breakpilot.yaml");
  provider.workspaceRoot = policy.workspace.root;
  const manager = new DebugSessionManager({ policy, ideBridge: bridge as any });
  manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot: provider.workspaceRoot,
    mode: "ide",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "ide",
    provider,
    ideClientId: provider.ideClientId,
    ideSessionId: provider.ideSessionId
  });

  const pending = manager.bpDebugSetValue({
    sessionId: provider.sessionId,
    ref: "bpref_score",
    newValue: "42"
  });
  await nextTurn();
  const request = bridge.last(IdeMessageTypes.AGENT_SET_VARIABLE);
  assert.equal(request.ref, "bpref_score");
  assert.equal(request.expectedPauseEpoch, 8);
  bridge.reply(request, {
    type: IdeMessageTypes.IDE_COMMAND_RESULT,
    command: "set_variable",
    result: {
      applied: true,
      verified: true,
      mutationMode: "native",
      oldValue: "41",
      newValue: "42",
      value: { name: "score", valuePreview: "42" }
    }
  });

  const result = await pending;
  assert.equal(result.ref, "bpref_score");
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.equal(result.mutationMode, "native");
  assert.equal(result.oldValue, "41");
});

test("negotiated features upgrade only the proven provider capabilities", () => {
  const { provider } = fixture();
  assert.equal(provider.capabilities.variableReferences, "native");
  assert.equal(provider.capabilities.setValue, "native");
});
