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
import { ErrorCodes } from "../src/utils/errors.ts";

const features = {
  breakpointUpdate: true,
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
        originRequestId: request.originRequestId,
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

test("negotiated opaque refs accept a bounded page beyond the strict decoder key budget", async () => {
  const { bridge, provider } = fixture();
  const pending = provider.inspectVariable({ ref: "bpref_page", count: 12, timeoutMs: 250 }, {
    maxDepth: 0,
    maxItems: 12,
    maxStringLength: 200,
    redactPatterns: []
  });
  await nextTurn();
  const request = bridge.last(IdeMessageTypes.AGENT_REQUEST_VARIABLES);
  const items = Array.from({ length: 12 }, (_, index) => ({
    name: `field${index}`,
    kind: "primitive",
    valuePreview: String(index),
    variablesReference: `bpref_${index}`,
    truncated: false,
    ref: `bpref_${index}`,
    pauseEpoch: 8,
    modifiable: false,
    mutationMode: null,
    type: "int",
    value: String(index)
  }));
  bridge.reply(request, {
    type: IdeMessageTypes.IDE_VARIABLES_SNAPSHOT,
    result: {
      ref: "bpref_page",
      pauseEpoch: 8,
      items,
      truncated: false
    }
  });

  const result = await pending as { items: Array<{ name: string }> };
  assert.equal(result.items.length, 12);
  assert.equal(result.items[11]?.name, "field11");
});

test("an over-budget correlated response rejects immediately instead of timing out", async () => {
  const { bridge, provider } = fixture();
  const pending = provider.inspectVariable({ ref: "bpref_oversized", count: 20 }, {
    maxDepth: 1,
    maxItems: 20,
    maxStringLength: 200,
    redactPatterns: []
  });
  const outcome = pending.then(
    () => ({ kind: "resolved" as const }),
    (error: Error & { code?: string }) => ({ kind: "rejected" as const, error })
  );
  await nextTurn();
  const request = bridge.last(IdeMessageTypes.AGENT_REQUEST_VARIABLES);
  bridge.reply(request, {
    type: IdeMessageTypes.IDE_VARIABLES_SNAPSHOT,
    result: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field${index}`, index]))
  });

  const early = await Promise.race([
    outcome,
    new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 30))
  ]);
  if (early.kind === "pending") {
    bridge.reply(request, {
      type: IdeMessageTypes.IDE_VARIABLES_SNAPSHOT,
      result: { ref: "bpref_oversized", pauseEpoch: 8, items: [], truncated: false }
    });
    await outcome;
  }

  assert.equal(early.kind, "rejected");
  if (early.kind === "rejected") assert.equal(early.error.code, ErrorCodes.BRIDGE_PAYLOAD_LIMIT);
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
  assert.equal(provider.capabilities.breakpointUpdate, "fallback");
});

test("IDE breakpoint updates are exact upserts and never infer removal from an incomplete source catalog", async () => {
  const { bridge, provider } = fixture();
  const replacement = provider.setBreakpoints("/workspace/App.java", [{
    id: "bp-new",
    sessionId: provider.sessionId,
    file: "/workspace/App.java",
    line: 20,
    enabled: true,
    temporary: false,
    owner: "agent",
    verified: false,
    createdAt: new Date(0).toISOString()
  }]);

  await nextTurn();
  const list = bridge.sent.find((message) => message.type === IdeMessageTypes.AGENT_LIST_BREAKPOINTS);
  if (list) {
    bridge.reply(list, {
      type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
      result: { breakpoints: [
        { id: "bp-stale", file: "/workspace/App.java", line: 10, owner: "agent", enabled: true, verified: true },
        { id: "user-bp", file: "/workspace/App.java", line: 11, owner: "user", enabled: true, verified: true }
      ] }
    });
    await nextTurn();
  }

  const remove = bridge.sent.find((message) => message.type === IdeMessageTypes.AGENT_REMOVE_BREAKPOINT);
  if (remove) {
    bridge.reply(remove, {
      type: IdeMessageTypes.IDE_BREAKPOINT_REMOVED,
      breakpointId: remove.breakpointId,
      removed: true
    });
    await nextTurn();
  }

  const add = bridge.last(IdeMessageTypes.AGENT_SET_BREAKPOINT);
  assert.equal(add.breakpoint?.id, "bp-new");
  bridge.reply(add, {
    type: IdeMessageTypes.IDE_BREAKPOINT_ADDED,
    breakpointId: "bp-new",
    breakpoint: { ...add.breakpoint, verified: true, adapterBreakpointId: "ide-20" }
  });

  const evidence = await replacement;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.verified, true);
  assert.equal(evidence[0]?.line, 20);
  assert.equal(bridge.sent.some((message) => message.type === IdeMessageTypes.AGENT_LIST_BREAKPOINTS), false);
  assert.equal(bridge.sent.some((message) => message.type === IdeMessageTypes.AGENT_REMOVE_BREAKPOINT), false);
});

test("IDE session cleanup removes only its exact breakpoint and never broadcasts a destructive clear", async () => {
  const { bridge, provider } = fixture();
  const policy = loadPolicy("breakpilot.yaml");
  provider.workspaceRoot = policy.workspace.root;
  bridge.registry.update(provider.ideClientId, { workspaceRoot: provider.workspaceRoot });
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

  const createdPending = manager.bpDebugSetBreakpoint({
    sessionId: provider.sessionId,
    filePath: `${provider.workspaceRoot}/src/serve.ts`,
    line: 1
  });
  await nextTurn();
  const add = bridge.last(IdeMessageTypes.AGENT_SET_BREAKPOINT);
  const createdId = String(add.breakpoint?.id);
  bridge.reply(add, {
    type: IdeMessageTypes.IDE_BREAKPOINT_ADDED,
    breakpointId: createdId,
    breakpoint: { ...add.breakpoint, verified: true, ideBreakpointId: "native-current-lifecycle" }
  });
  await createdPending;

  const disconnectPending = manager.bpDebugControl({
    sessionId: provider.sessionId,
    action: "disconnect"
  });
  await nextTurn();
  const remove = bridge.sent.find((message) => message.type === IdeMessageTypes.AGENT_REMOVE_BREAKPOINT);
  if (remove) {
    bridge.reply(remove, {
      type: IdeMessageTypes.IDE_BREAKPOINT_REMOVED,
      breakpointId: createdId,
      removed: true
    });
  }
  await disconnectPending;

  assert.deepEqual(
    bridge.sent
      .filter((message) => message.type === IdeMessageTypes.AGENT_REMOVE_BREAKPOINT)
      .map((message) => message.breakpointId),
    [createdId]
  );
  assert.equal(
    bridge.sent.some((message) => message.type === IdeMessageTypes.AGENT_CLEAR_BREAKPOINTS),
    false
  );
});
