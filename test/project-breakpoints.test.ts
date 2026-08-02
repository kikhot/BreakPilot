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
import { dapProviderCapabilities } from "../src/runtime/ProviderCapabilities.ts";

class FakeIdeBridge extends EventEmitter {
  registry = new IdeClientRegistry();
  sent: BridgeMessage[] = [];
  removeAcknowledged = true;
  listedBreakpoints: AnyRecord[] = [];

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
          breakpointId: message.breakpointId,
          removed: this.removeAcknowledged
        };
        this.emit(IdeMessageTypes.IDE_BREAKPOINT_REMOVED, { clientId, message: response });
      }
      if (message.type === IdeMessageTypes.AGENT_LIST_BREAKPOINTS) {
        const response: BridgeMessage = {
          type: IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT,
          clientId,
          requestId: message.requestId,
          ideSessionId: message.ideSessionId,
          result: {
            breakpoints: this.listedBreakpoints.length > 0
              ? this.listedBreakpoints
              : [{
                  id: `${clientId}:user:21`,
                  file: filePath,
                  line: 21,
                  owner: "user",
                  enabled: true,
                  verified: true
                }]
          }
        };
        this.emit(IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT, { clientId, message: response });
      }
      if (message.type === IdeMessageTypes.AGENT_LIST_RUN_CONFIGURATIONS) {
        const response: BridgeMessage = {
          type: IdeMessageTypes.IDE_RUN_CONFIGURATIONS_SNAPSHOT,
          clientId,
          requestId: message.requestId,
          result: message.filePath
            ? {
                filePath: message.filePath,
                runPoints: [
                  {
                    line: 9,
                    description: "Run 'DemoApplication.main()'\nDebug 'DemoApplication.main()'",
                    elementText: "com.example.demo.DemoApplication"
                  }
                ]
              }
            : {
                configurations: [
                  {
                    name: "DemoApplication",
                    description: "Spring Boot Application",
                    supportsDynamicLaunchOverrides: true
                  }
                ]
              }
        };
        this.emit(IdeMessageTypes.IDE_RUN_CONFIGURATIONS_SNAPSHOT, { clientId, message: response });
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

function addFakeSession(
  manager: DebugSessionManager,
  sessionId = "sess_existing",
  removeBreakpoint?: () => Promise<AnyRecord>
) {
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
      capabilities: dapProviderCapabilities(),
      threadId: null,
      setBreakpoints: async (_file: string, breakpoints: AnyRecord[]) =>
        breakpoints.map((breakpoint, index) => ({
          id: index + 1,
          verified: true,
          line: breakpoint.line,
          column: breakpoint.column
        })),
      ...(removeBreakpoint ? { removeBreakpoint } : {}),
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

  assert.equal((response.at as AnyRecord).line, 1);
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

  assert.equal((response.at as AnyRecord).line, 2);
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

  assert.equal((response.at as AnyRecord).line, 3);
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

  assert.equal((response.at as AnyRecord).line, 5);
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

  assert.equal((vscodeList.breakpoints as AnyRecord[]).length, 1);
  assert.equal((ideaList.breakpoints as AnyRecord[]).length, 1);

  const vscodeBreakpoint = vscode as AnyRecord;
  const ideaBreakpoint = idea as AnyRecord;
  assert.equal((vscodeBreakpoint.at as AnyRecord).line, 7);
  assert.equal((ideaBreakpoint.at as AnyRecord).line, 8);

  const removed = await manager.bpDebugRemoveBreakpoint({ breakpointId: String(vscodeBreakpoint.id), ide: "vscode" });
  const afterRemove = await manager.bpDebugListBreakpoints({ ide: "vscode" });

  assert.equal(removed.removed, true);
  assert.equal((afterRemove.breakpoints as AnyRecord[]).length, 1);
  assert.equal((afterRemove.breakpoints as AnyRecord[])[0]?.owner, "user");
  assert.equal(bridge.sent.some((message) => message.type === IdeMessageTypes.AGENT_REMOVE_BREAKPOINT), true);
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("idea_one", "idea", workspaceRoot);
  const manager = managerWithBridge(bridge);

  const listed = await manager.bpDebugListBreakpoints({ ide: "idea", owner: "all" });

  assert.deepEqual(
    (listed.breakpoints as AnyRecord[]).map((breakpoint) => ({
      id: breakpoint.id,
      owner: breakpoint.owner,
      line: (breakpoint.at as AnyRecord).line
    })),
    [{ id: "idea_one:user:21", owner: "user", line: 21 }]
  );
  assert.equal(bridge.sent.at(-1)?.type, IdeMessageTypes.AGENT_LIST_BREAKPOINTS);
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("idea_one", "idea", workspaceRoot);
  bridge.listedBreakpoints = [
    { id: "idea-native-user-63", file: filePath, line: 63, owner: "user", enabled: true, verified: true }
  ];
  const manager = managerWithBridge(bridge);

  const protectedResult = await manager.bpDebugRemoveBreakpoint({
    ide: "idea",
    filePath,
    line: 63
  });
  assert.equal(protectedResult.removed, false);
  assert.equal(protectedResult.protected, true);
  assert.equal(
    bridge.sent.filter((message) => message.type === IdeMessageTypes.AGENT_REMOVE_BREAKPOINT).length,
    0,
    "default owner must protect a live user breakpoint"
  );

  const removed = await manager.bpDebugRemoveBreakpoint({
    ide: "idea",
    filePath,
    line: 63,
    owner: "all"
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.id, "idea-native-user-63");
  assert.equal(bridge.sent.at(-1)?.type, IdeMessageTypes.AGENT_REMOVE_BREAKPOINT);
  assert.equal(bridge.sent.at(-1)?.breakpointId, "idea-native-user-63");
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("idea_one", "idea", workspaceRoot);
  bridge.listedBreakpoints = [
    { id: "another-native-breakpoint", file: filePath, line: 64, owner: "user", enabled: true, verified: true }
  ];
  const manager = managerWithBridge(bridge);

  const missing = await manager.bpDebugRemoveBreakpoint({
    ide: "idea",
    filePath,
    line: 65,
    owner: "all"
  });
  assert.equal(missing.removed, false);
  assert.equal(Object.hasOwn(missing, "id"), false);
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("idea_one", "idea", workspaceRoot);
  const manager = managerWithBridge(bridge);

  const configurations = await manager.bpDebugRunConfigurations({ ide: "idea" });
  assert.deepEqual(configurations.configurations, [
    {
      name: "DemoApplication",
      type: "Spring Boot Application",
      overrides: ["location"]
    }
  ]);
  assert.equal(Object.hasOwn(configurations, "runPoints"), false);

  const runPoints = await manager.bpDebugRunConfigurations({
    ide: "idea",
    filePath: "src/main/java/com/example/demo/DemoApplication.java"
  });
  assert.deepEqual(runPoints.runPoints, [
    {
      filePath: "src/main/java/com/example/demo/DemoApplication.java",
      line: 9,
      function: "com.example.demo.DemoApplication"
    }
  ]);
  assert.equal(Object.hasOwn(runPoints, "configurations"), false);
  assert.equal(bridge.sent.at(-1)?.type, IdeMessageTypes.AGENT_LIST_RUN_CONFIGURATIONS);
}

{
  const bridge = new FakeIdeBridge();
  const manager = managerWithBridge(bridge);
  let acknowledged = false;
  addFakeSession(manager, "sess_removal_truth", async () => ({ removed: acknowledged }));
  const created = await manager.bpDebugSetBreakpoint({
    sessionId: "sess_removal_truth",
    filePath,
    line: 31
  });
  const breakpointId = String(created.id);

  const missing = await manager.bpDebugRemoveBreakpoint({
    sessionId: "sess_removal_truth",
    breakpointId
  });
  assert.equal(missing.removed, false);
  assert.equal(manager.breakpoints.list("sess_removal_truth").some((breakpoint) => breakpoint.id === breakpointId), true);

  acknowledged = true;
  const removed = await manager.bpDebugRemoveBreakpoint({
    sessionId: "sess_removal_truth",
    breakpointId
  });
  assert.equal(removed.removed, true);
  assert.equal(manager.breakpoints.list("sess_removal_truth").some((breakpoint) => breakpoint.id === breakpointId), false);
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("vscode_one", "vscode", workspaceRoot);
  const manager = managerWithBridge(bridge);
  const created = await manager.bpDebugSetBreakpoint({ filePath, line: 32, ide: "vscode" });
  const breakpointId = String(created.id);

  bridge.removeAcknowledged = false;
  const missing = await manager.bpDebugRemoveBreakpoint({ breakpointId, ide: "vscode" });
  assert.equal(missing.removed, false);
  assert.ok(manager.breakpoints.findProject(breakpointId), "missing bridge removal must retain desired state");

  bridge.removeAcknowledged = true;
  const removed = await manager.bpDebugRemoveBreakpoint({ breakpointId, ide: "vscode" });
  assert.equal(removed.removed, true);
  assert.equal(manager.breakpoints.findProject(breakpointId), undefined);
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("idea_one", "idea", workspaceRoot);
  const manager = managerWithBridge(bridge);
  const otherFile = path.join(workspaceRoot, "src", "control", "ToolRouter.ts");
  bridge.listedBreakpoints = [
    { id: "disabled-target", file: filePath, line: 40, owner: "user", enabled: false, verified: true },
    { id: "enabled-target", file: filePath, line: 41, owner: "user", enabled: true, verified: true },
    { id: "other-file", file: otherFile, line: 42, owner: "user", enabled: true, verified: true }
  ];

  const allForFile = await manager.bpDebugListBreakpoints({
    ide: "idea",
    filePath,
    owner: "all",
    includeDisabled: true
  });
  assert.deepEqual(
    (allForFile.breakpoints as AnyRecord[]).map((breakpoint) => breakpoint.id),
    ["disabled-target", "enabled-target"]
  );
  assert.equal((allForFile.breakpoints as AnyRecord[])[0]?.enabled, false);

  const enabledForFile = await manager.bpDebugListBreakpoints({
    ide: "idea",
    filePath,
    owner: "all",
    includeDisabled: false
  });
  assert.deepEqual(
    (enabledForFile.breakpoints as AnyRecord[]).map((breakpoint) => breakpoint.id),
    ["enabled-target"]
  );
}

{
  const bridge = new FakeIdeBridge();
  bridge.addClient("idea_one", "idea", workspaceRoot);
  const manager = managerWithBridge(bridge);
  const created = await manager.bpDebugSetBreakpoint({ filePath, line: 51, ide: "idea" });
  const breakpointId = String(created.id);
  const sentBeforeUpdate = bridge.sent.length;

  await assertRejectsWithCode(ErrorCodes.UNSUPPORTED_CAPABILITY, () =>
    manager.bpDebugSetBreakpoint({ breakpointId, line: 52, ide: "idea" })
  );

  assert.equal(bridge.sent.length, sentBeforeUpdate, "project update must not send a create-style IDE bridge message");
  assert.equal(manager.breakpoints.findProject(breakpointId)?.line, 51, "project update refusal must retain desired state");
}

console.log("project breakpoint routing tests ok");
