import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import type { Socket } from "node:net";

import { IdeClientRegistry } from "../src/ide/IdeClientRegistry.ts";
import { IdeMessageTypes } from "../src/ide/IdeProtocol.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import type { BridgeMessage } from "../src/types/ide.ts";
import type { AnyRecord } from "../src/types/json.ts";
import { ErrorCodes } from "../src/utils/errors.ts";

class FakeIdeBridge extends EventEmitter {
  registry = new IdeClientRegistry();
  sent: BridgeMessage[] = [];

  addClient(clientId: string, ide: "vscode" | "idea", workspaceRoot: string) {
    this.registry.add({} as Socket, {
      clientId,
      ide,
      workspaceRoot,
      capabilities: { visualBreakpoints: true }
    });
  }

  addSession(clientId: string, ideSessionId: string, workspaceRoot: string, active: boolean) {
    this.registry.upsertSession(
      clientId,
      {
        type: IdeMessageTypes.IDE_SESSION_PAUSED,
        ideSessionId,
        workspaceRoot,
        active,
        state: "paused"
      },
      "paused"
    );
  }

  sendToClient(clientId: string | undefined, message: Partial<BridgeMessage>): boolean {
    if (!clientId || !this.registry.get(clientId)) return false;
    const outbound = { ...message, clientId } as BridgeMessage;
    this.sent.push(outbound);
    queueMicrotask(() => {
      if (message.type === IdeMessageTypes.AGENT_SET_BREAKPOINT) {
        const breakpoint = message.breakpoint as AnyRecord;
        const response: BridgeMessage = {
          type: IdeMessageTypes.IDE_BREAKPOINT_ADDED,
          clientId,
          requestId: message.requestId,
          ideSessionId: message.ideSessionId,
          breakpointId: String(breakpoint.id),
          breakpoint: {
            ...breakpoint,
            verified: true,
            adapterBreakpointId: `${clientId}:${String(breakpoint.id)}`
          }
        };
        this.emit(IdeMessageTypes.IDE_BREAKPOINT_ADDED, { clientId, message: response });
      }
      if (message.type === IdeMessageTypes.AGENT_REMOVE_BREAKPOINT) {
        const response: BridgeMessage = {
          type: IdeMessageTypes.IDE_BREAKPOINT_REMOVED,
          clientId,
          requestId: message.requestId,
          ideSessionId: message.ideSessionId,
          breakpointId: message.breakpointId
        };
        this.emit(IdeMessageTypes.IDE_BREAKPOINT_REMOVED, { clientId, message: response });
      }
    });
    return true;
  }

  status() {
    return {
      enabled: true,
      clients: this.registry.list(),
      sessions: this.registry.listSessions()
    };
  }
}

const policy = loadPolicy("breakpilot.yaml");
const workspaceRoot = path.resolve(policy.workspace.root);
const filePath = path.join(workspaceRoot, "src", "sessions", "DebugSessionManager.ts");

function managerWithBridge(bridge: FakeIdeBridge) {
  return new DebugSessionManager({ policy, ideBridge: bridge as unknown as ConstructorParameters<typeof DebugSessionManager>[0]["ideBridge"] });
}

function addFakeSession(manager: DebugSessionManager, sessionId = "sess_existing") {
  manager.sessions.add({
    sessionId,
    language: "python",
    workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "running",
    createdAt: new Date().toISOString(),
    providerKind: "dap",
    provider: {
      kind: "dap",
      sessionId,
      language: "python",
      workspaceRoot,
      capabilities: {},
      threadId: null,
      setBreakpoints: async (_file: string, breakpoints: AnyRecord[]) =>
        breakpoints.map((breakpoint, index) => ({
          id: index + 1,
          verified: true,
          line: breakpoint.line,
          column: breakpoint.column
        })),
      waitForBreakpoint: async () => ({ reason: "breakpoint" }),
      getRuntimeSnapshot: async () => ({
        sessionId,
        source: "headless",
        language: "python",
        threadId: null,
        frameId: null,
        stackFrames: [],
        variables: {},
        limits: {
          maxDepth: 1,
          maxItems: 20,
          maxStringLength: 200
        }
      }),
      evaluate: async () => ({}),
      continue: async () => ({}),
      step: async () => ({}),
      disconnect: async () => ({ acknowledged: true })
    }
  });
}

async function assertRejectsWithCode(code: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
    return;
  }
  assert.fail(`Expected ${code}`);
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("vscode_one", "vscode", workspaceRoot);
  const manager = managerWithBridge(bridge);

  const response = await manager.bpDebugSetBreakpoint({ filePath, line: 1 });

  assert.equal(response.line, 1);
  assert.equal(response.verified, true);
  assert.equal("clientId" in response, false);
  assert.equal("ide" in response, false);
  assert.equal(bridge.sent.at(-1)?.clientId, "vscode_one");
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("vscode_one", "vscode", workspaceRoot);
  const manager = managerWithBridge(bridge);
  addFakeSession(manager);

  const response = await manager.bpDebugSetBreakpoint({ filePath, line: 2 });
  const listed = await manager.bpDebugListBreakpoints({});

  assert.equal(response.line, 2);
  assert.equal((listed.breakpoints as AnyRecord[]).length, 1);
  assert.equal(bridge.sent.length, 1);
  assert.equal(bridge.sent[0]?.sessionId, "sess_existing");
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("vscode_one", "vscode", workspaceRoot);
  bridge.addClient("idea_one", "idea", workspaceRoot);
  bridge.addSession("vscode_one", "vscode_debug", workspaceRoot, false);
  bridge.addSession("idea_one", "idea_debug", workspaceRoot, true);
  const manager = managerWithBridge(bridge);

  const response = await manager.bpDebugSetBreakpoint({ filePath, line: 3 });

  assert.equal(response.line, 3);
  assert.equal("clientId" in response, false);
  assert.equal("ideSessionId" in response, false);
  assert.equal(bridge.sent.at(-1)?.clientId, "idea_one");
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("vscode_one", "vscode", workspaceRoot);
  bridge.addClient("idea_one", "idea", workspaceRoot);
  const manager = managerWithBridge(bridge);

  await assertRejectsWithCode(ErrorCodes.PROJECT_AMBIGUOUS, () =>
    manager.bpDebugSetBreakpoint({ filePath, line: 4 })
  );
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("vscode_one", "vscode", workspaceRoot);
  bridge.addClient("idea_one", "idea", workspaceRoot);
  const manager = managerWithBridge(bridge);

  const response = await manager.bpDebugSetBreakpoint({ filePath, line: 5, ide: "idea" });

  assert.equal(response.line, 5);
  assert.equal("clientId" in response, false);
  assert.equal(bridge.sent.at(-1)?.clientId, "idea_one");
}

{
  const bridge = new FakeIdeBridge();
  const manager = managerWithBridge(bridge);

  await assertRejectsWithCode(ErrorCodes.IDE_NOT_CONNECTED, () =>
    manager.bpDebugSetBreakpoint({ filePath, line: 6 })
  );
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("vscode_one", "vscode", workspaceRoot);
  bridge.addClient("idea_one", "idea", workspaceRoot);
  const manager = managerWithBridge(bridge);

  const vscode = await manager.bpDebugSetBreakpoint({ filePath, line: 7, ide: "vscode" });
  const idea = await manager.bpDebugSetBreakpoint({ filePath, line: 8, ide: "idea" });
  const vscodeList = await manager.bpDebugListBreakpoints({ ide: "vscode" });
  const ideaList = await manager.bpDebugListBreakpoints({ ide: "idea" });

  assert.equal(vscodeList.totalCount, 1);
  assert.equal(ideaList.totalCount, 1);

  const vscodeBreakpoint = vscode as AnyRecord;
  const ideaBreakpoint = idea as AnyRecord;
  assert.equal(vscodeBreakpoint.line, 7);
  assert.equal(ideaBreakpoint.line, 8);

  const removed = await manager.bpDebugRemoveBreakpoint({ breakpointId: String(vscodeBreakpoint.breakpointId), ide: "vscode" });
  const afterRemove = await manager.bpDebugListBreakpoints({ ide: "vscode" });

  assert.equal(removed.removed, true);
  assert.equal(afterRemove.totalCount, 0);
  assert.equal(bridge.sent.at(-1)?.type, IdeMessageTypes.AGENT_REMOVE_BREAKPOINT);
}

console.log("project breakpoint routing tests ok");
