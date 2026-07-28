import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import test from "node:test";

import { ToolRouter } from "../src/control/ToolRouter.ts";
import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import { IdeClientRegistry } from "../src/ide/IdeClientRegistry.ts";
import { IdeMessageTypes } from "../src/ide/IdeProtocol.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import type { DapTransport } from "../src/types/dap.ts";
import type { BridgeMessage } from "../src/types/ide.ts";
import type { AnyRecord } from "../src/types/json.ts";

type StartCommand = { command: string; arguments: AnyRecord };

class RecordingDapTransport extends EventEmitter implements DapTransport {
  readonly commands: StartCommand[];
  #buffer = Buffer.alloc(0);

  constructor(commands: StartCommand[]) {
    super();
    this.commands = commands;
  }

  start(): void {}

  close(): void {}

  write(buffer: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, buffer]);
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("utf8");
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (!Number.isFinite(length) || this.#buffer.length < bodyEnd) return;
      const request = JSON.parse(this.#buffer.subarray(bodyStart, bodyEnd).toString("utf8")) as {
        seq: number;
        command: string;
        arguments?: AnyRecord;
      };
      this.#buffer = this.#buffer.subarray(bodyEnd);
      this.commands.push({ command: request.command, arguments: request.arguments ?? {} });
      queueMicrotask(() => this.#respond(request.seq, request.command));
    }
  }

  #respond(requestSeq: number, command: string): void {
    const response = JSON.stringify({
      seq: 0,
      type: "response",
      request_seq: requestSeq,
      success: true,
      command,
      body: {}
    });
    this.emit(
      "data",
      Buffer.from(`Content-Length: ${Buffer.byteLength(response, "utf8")}\r\n\r\n${response}`, "utf8")
    );
    if (command === "initialize") {
      const initialized = JSON.stringify({ seq: 0, type: "event", event: "initialized", body: {} });
      this.emit(
        "data",
        Buffer.from(`Content-Length: ${Buffer.byteLength(initialized, "utf8")}\r\n\r\n${initialized}`, "utf8")
      );
    }
  }
}

class RoutingAdapter extends LanguageAdapter {
  readonly commands: StartCommand[] = [];

  constructor() {
    super({
      language: "routing-test",
      adapterId: "routing-test",
      envCommandName: "BREAKPILOT_ROUTING_TEST_ADAPTER",
      fileExtensions: [".routing"]
    });
  }

  override async createTransport(): Promise<DapTransport> {
    return new RecordingDapTransport(this.commands);
  }
}

class StartIdeBridge extends EventEmitter {
  readonly registry = new IdeClientRegistry();
  readonly sent: BridgeMessage[] = [];
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    super();
    this.workspaceRoot = workspaceRoot;
    this.registry.add({} as Socket, {
      clientId: "idea_start",
      ide: "idea",
      workspaceRoot,
      capabilities: { debugCommands: true, variableSnapshot: true },
      debuggerProtocolVersion: 2,
      debuggerFeatures: { causalDebugStart: true }
    });
  }

  sendToClient(clientId: string | undefined, message: Partial<BridgeMessage>): boolean {
    if (clientId !== "idea_start") return false;
    const outbound = { ...message, clientId } as BridgeMessage;
    this.sent.push(outbound);
    if (message.type === IdeMessageTypes.AGENT_START_DEBUG) {
      queueMicrotask(() => {
        const started: BridgeMessage = {
          type: IdeMessageTypes.IDE_SESSION_STARTED,
          clientId,
          requestId: message.requestId,
          originRequestId: message.originRequestId,
          ideSessionId: "idea_started_session",
          workspaceRoot: this.workspaceRoot,
          state: "running",
          active: true,
          language: "java"
        };
        this.registry.upsertSession(clientId, started, "running");
        this.emit(IdeMessageTypes.IDE_SESSION_STARTED, { clientId, message: started });
      });
    }
    return true;
  }
}

function dapRouter(): { router: ToolRouter; adapter: RoutingAdapter } {
  const manager = new DebugSessionManager({ policy: loadPolicy("breakpilot.yaml") });
  const adapter = new RoutingAdapter();
  manager.adapters.register(adapter);
  return { router: new ToolRouter(manager), adapter };
}

test("bp_debug_start defaults to launch when routing fields are omitted", async () => {
  const { router, adapter } = dapRouter();

  const response = await router.callTool("bp_debug_start", {
    language: "routing-test",
    program: "src/serve.ts"
  });

  assert.equal(response.error, undefined);
  assert.equal(response.startMode, "launch");
  assert.equal(adapter.commands.some(({ command }) => command === "launch"), true);
  assert.equal(adapter.commands.some(({ command }) => command === "attach"), false);
});

test("explicit launch remains authoritative when host-like fields are present", async () => {
  const { router, adapter } = dapRouter();

  const response = await router.callTool("bp_debug_start", {
    mode: "launch",
    language: "routing-test",
    program: "src/serve.ts",
    host: "127.0.0.1",
    port: 5678
  });

  assert.equal(response.error, undefined);
  assert.equal(response.startMode, "launch");
  assert.equal(adapter.commands.some(({ command }) => command === "launch"), true);
  assert.equal(adapter.commands.some(({ command }) => command === "attach"), false);
});

test("omitted mode with host or port preserves legacy attach routing", async () => {
  const { router, adapter } = dapRouter();

  const response = await router.callTool("bp_debug_start", {
    language: "routing-test",
    port: 5678
  });

  assert.equal(response.error, undefined);
  assert.equal(response.startMode, "attach");
  assert.equal(adapter.commands.some(({ command }) => command === "attach"), true);
  assert.equal(adapter.commands.some(({ command }) => command === "launch"), false);
});

test("omitted mode with only a source location routes through IDE launch", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const bridge = new StartIdeBridge(policy.workspace.root);
  const manager = new DebugSessionManager({
    policy,
    ideBridge: bridge as unknown as ConstructorParameters<typeof DebugSessionManager>[0]["ideBridge"]
  });
  const router = new ToolRouter(manager);

  const response = await router.callTool("bp_debug_start", {
    filePath: "src/serve.ts",
    line: 1
  });

  assert.equal(response.error, undefined);
  assert.equal(response.startMode, "ide");
  assert.equal(
    bridge.sent.some((message) => (
      message.type === IdeMessageTypes.AGENT_START_DEBUG &&
      message.filePath === "src/serve.ts" &&
      message.line === 1
    )),
    true
  );
});

test("remote IDE launch fails closed for a client without causal start support", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const bridge = new StartIdeBridge(policy.workspace.root);
  bridge.registry.update("idea_start", {
    debuggerFeatures: { causalDebugStart: false }
  });
  const manager = new DebugSessionManager({
    policy,
    ideBridge: bridge as unknown as ConstructorParameters<typeof DebugSessionManager>[0]["ideBridge"]
  });

  await assert.rejects(
    manager.bpDebugStart({ filePath: "src/serve.ts", line: 1 }),
    (error: unknown) => (error as { code?: string }).code === "UNSUPPORTED_CAPABILITY"
  );
  assert.equal(bridge.sent.length, 0);
});

test("remote IDE launch ignores anonymous and wrong-origin lifecycle events", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  class WrongOriginBridge extends StartIdeBridge {
    override sendToClient(clientId: string | undefined, message: Partial<BridgeMessage>): boolean {
      if (clientId !== "idea_start") return false;
      this.sent.push({ ...message, clientId } as BridgeMessage);
      if (message.type === IdeMessageTypes.AGENT_START_DEBUG) {
        queueMicrotask(() => {
          for (const [ideSessionId, originRequestId] of [
            ["anonymous-session", undefined],
            ["wrong-origin-session", "foreign-request"],
            ["trusted-session", message.originRequestId]
          ] as const) {
            const started: BridgeMessage = {
              type: IdeMessageTypes.IDE_SESSION_STARTED,
              ideSessionId,
              originRequestId,
              workspaceRoot: this.workspaceRoot,
              state: "running",
              active: true
            };
            this.registry.upsertSession(String(clientId), started, "running");
            this.emit(IdeMessageTypes.IDE_SESSION_STARTED, { clientId, message: started });
          }
        });
      }
      return true;
    }
  }
  const bridge = new WrongOriginBridge(policy.workspace.root);
  const manager = new DebugSessionManager({ policy, ideBridge: bridge as any });

  const response = await manager.bpDebugStart({ filePath: "src/serve.ts", line: 1, timeout: 100 });

  assert.equal(response.ideSessionId, "trusted-session");
});

test("failed remote IDE launch dispatch removes every start waiter", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const bridge = new StartIdeBridge(policy.workspace.root);
  bridge.sendToClient = () => false;
  const manager = new DebugSessionManager({ policy, ideBridge: bridge as any });
  const baseline = {
    command: bridge.listenerCount(IdeMessageTypes.IDE_COMMAND_RESULT),
    started: bridge.listenerCount(IdeMessageTypes.IDE_SESSION_STARTED),
    paused: bridge.listenerCount(IdeMessageTypes.IDE_SESSION_PAUSED)
  };

  await assert.rejects(
    manager.bpDebugStart({ filePath: "src/serve.ts", line: 1, timeout: 20 }),
    (error: unknown) => (error as { code?: string }).code === "IDE_BRIDGE_DISCONNECTED"
  );
  assert.equal(bridge.listenerCount(IdeMessageTypes.IDE_COMMAND_RESULT), baseline.command);
  assert.equal(bridge.listenerCount(IdeMessageTypes.IDE_SESSION_STARTED), baseline.started);
  assert.equal(bridge.listenerCount(IdeMessageTypes.IDE_SESSION_PAUSED), baseline.paused);
});

test("explicit launch remains authoritative when ideSessionId is present", async () => {
  const { router, adapter } = dapRouter();

  const response = await router.callTool("bp_debug_start", {
    mode: "launch",
    language: "routing-test",
    program: "src/serve.ts",
    ideSessionId: "stale_ide_session"
  });

  assert.equal(response.error, undefined);
  assert.equal(response.startMode, "launch");
  assert.equal(adapter.commands.some(({ command }) => command === "launch"), true);
  assert.equal(adapter.commands.some(({ command }) => command === "attach"), false);
});

test("explicit attach remains authoritative when ideSessionId is present", async () => {
  const { router, adapter } = dapRouter();

  const response = await router.callTool("bp_debug_start", {
    mode: "attach",
    language: "routing-test",
    host: "127.0.0.1",
    port: 5678,
    ideSessionId: "stale_ide_session"
  });

  assert.equal(response.error, undefined);
  assert.equal(response.startMode, "attach");
  assert.equal(adapter.commands.some(({ command }) => command === "attach"), true);
  assert.equal(adapter.commands.some(({ command }) => command === "launch"), false);
});

test("omitted mode with ideSessionId still adopts the matching IDE session", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const bridge = new StartIdeBridge(policy.workspace.root);
  bridge.registry.upsertSession("idea_start", {
    type: IdeMessageTypes.IDE_SESSION_PAUSED,
    ideSessionId: "idea_existing_session",
    workspaceRoot: policy.workspace.root,
    state: "paused",
    active: true,
    language: "java",
    pauseEpoch: 1,
    threadId: 7,
    topFrame: { id: 11, name: "main", line: 1, source: { path: "src/serve.ts" } }
  }, "paused");
  const manager = new DebugSessionManager({
    policy,
    ideBridge: bridge as unknown as ConstructorParameters<typeof DebugSessionManager>[0]["ideBridge"]
  });

  const response = await new ToolRouter(manager).callTool("bp_debug_start", {
    ideSessionId: "idea_existing_session"
  });

  assert.equal(response.error, undefined);
  assert.equal(response.startMode, "ide");
  assert.equal(response.ideSessionId, "idea_existing_session");
  assert.equal(bridge.sent.some((message) => message.type === IdeMessageTypes.AGENT_START_DEBUG), false);
});
