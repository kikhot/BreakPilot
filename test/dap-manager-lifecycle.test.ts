import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import type { DapTransport } from "../src/types/dap.ts";
import type { AnyRecord } from "../src/types/json.ts";

class LifecycleDapTransport extends EventEmitter implements DapTransport {
  #buffer = Buffer.alloc(0);
  #sequence = 1;
  readonly startFailure?: Error;
  closed = false;

  constructor(startFailure?: Error) {
    super();
    this.startFailure = startFailure;
  }

  start(): void {
    if (this.startFailure) throw this.startFailure;
  }

  close(): void {
    this.closed = true;
  }

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
      };
      this.#buffer = this.#buffer.subarray(bodyEnd);
      queueMicrotask(() => {
        this.#publishMessage({
          seq: this.#sequence++,
          type: "response",
          request_seq: request.seq,
          success: true,
          command: request.command,
          body: {}
        });
        if (request.command === "initialize") this.publish("initialized");
      });
    }
  }

  publish(event: string, body: AnyRecord = {}): void {
    this.#publishMessage({
      seq: this.#sequence++,
      type: "event",
      event,
      body
    });
  }

  failAdapter(error: Error): void {
    this.emit("error", error);
  }

  exit(info: AnyRecord): void {
    this.emit("exit", info);
  }

  #publishMessage(message: AnyRecord): void {
    const json = JSON.stringify(message);
    this.emit(
      "data",
      Buffer.from(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`, "utf8")
    );
  }
}

class LifecycleAdapter extends LanguageAdapter {
  readonly transport: LifecycleDapTransport;

  constructor(language: string, transport: LifecycleDapTransport) {
    super({
      language,
      adapterId: language,
      envCommandName: `BREAKPILOT_${language.toUpperCase()}_ADAPTER`
    });
    this.transport = transport;
  }

  override async createTransport(): Promise<DapTransport> {
    return this.transport;
  }
}

function createManager(
  name: string,
  transport = new LifecycleDapTransport()
): { manager: DebugSessionManager; transport: LifecycleDapTransport; language: string } {
  const manager = new DebugSessionManager({ policy: loadPolicy("breakpilot.yaml") });
  const language = `lifecycle-${name}`;
  manager.adapters.register(new LifecycleAdapter(language, transport));
  return { manager, transport, language };
}

async function startManagedSession(
  name: string
): Promise<{
  manager: DebugSessionManager;
  transport: LifecycleDapTransport;
  sessionId: string;
  client: EventEmitter;
}> {
  const { manager, transport, language } = createManager(name);
  const started = await manager.bpDebugStart({ mode: "launch", language }) as AnyRecord;
  const sessionId = String(started.sessionId);
  const record = manager.sessions.get(sessionId);
  return { manager, transport, sessionId, client: record.dap!.client };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function assertTransportDetached(transport: LifecycleDapTransport): void {
  assert.equal(transport.listenerCount("data"), 0);
  assert.equal(transport.listenerCount("stderr"), 0);
  assert.equal(transport.listenerCount("error"), 0);
  assert.equal(transport.listenerCount("exit"), 0);
}

function assertSessionDetached(client: EventEmitter): void {
  for (const event of [
    "event",
    "initialized",
    "stopped",
    "continued",
    "terminated",
    "exited",
    "exit",
    "adapterError"
  ]) {
    assert.equal(client.listenerCount(event), 0, event);
  }
}

test("managed terminated history remains drainable by explicit id after automatic cleanup", async () => {
  const { manager, transport, sessionId } = await startManagedSession("terminated");

  transport.publish("terminated", { restart: false, exitCode: 0, raw: "drop" });
  await nextTurn();

  assert.equal(manager.sessions.maybeGet(sessionId), undefined);
  const drained = await manager.bpDebugControl({ sessionId, action: "drainEvents" }) as AnyRecord;
  assert.equal(drained.status, "terminated");
  assert.deepEqual(drained.events.items.map((event: AnyRecord) => event.kind), ["terminated"]);
  assert.deepEqual(drained.events.items[0].data, { exitCode: 0, restart: false });
  assert.doesNotMatch(JSON.stringify(drained), /"raw"|"drop"/);
});

test("DAP exited grace captures the later terminated fact without selecting the pending record", async () => {
  const { manager, transport, sessionId } = await startManagedSession("exited-terminated");

  transport.publish("exited", { exitCode: 7, raw: "drop" });
  await nextTurn();

  assert.equal(manager.sessions.maybeGet(sessionId)?.state, "terminated");
  assert.deepEqual((await manager.bpDebugStatus({}) as AnyRecord).sessions, []);
  const pendingDrain = await manager.bpDebugControl({ sessionId, action: "drainEvents" }) as AnyRecord;
  assert.deepEqual(
    pendingDrain.events.items.map((event: AnyRecord) => [event.kind, event.data]),
    [["terminated", { reason: "dapExited", exitCode: 7 }]]
  );

  transport.publish("terminated", { restart: false, secret: "drop" });
  await nextTurn();

  assert.equal(manager.sessions.maybeGet(sessionId), undefined);
  const drained = manager.readRuntimeEvents(sessionId, { cursor: 0 });
  assert.deepEqual(
    drained.items.map((event: AnyRecord) => [event.kind, event.data]),
    [
      ["terminated", { reason: "dapExited", exitCode: 7 }],
      ["terminated", { restart: false }]
    ]
  );
  assert.doesNotMatch(JSON.stringify(drained), /"raw"|"secret"|"drop"/);
});

test("synchronous DAP client start failure rolls back the record and every transport listener", async () => {
  const transport = new LifecycleDapTransport(new Error("synchronous start failure"));
  const { manager, language } = createManager("start-failure", transport);

  await assert.rejects(
    manager.bpDebugStart({ mode: "launch", language }),
    /synchronous start failure/
  );

  assert.deepEqual(manager.sessions.list(), []);
  assertTransportDetached(transport);
});

for (const failure of ["adapterError", "transportExit"] as const) {
  test(`${failure} cleans the managed session and subscriptions with safe postmortem history`, async () => {
    const { manager, transport, sessionId, client } = await startManagedSession(failure);

    if (failure === "adapterError") {
      transport.failAdapter(new Error("adapter secret"));
    } else {
      transport.exit({ code: 9, signal: "private-signal" });
    }
    await nextTurn();

    assert.equal(manager.sessions.maybeGet(sessionId), undefined);
    assertSessionDetached(client);
    assertTransportDetached(transport);

    const drained = await manager.bpDebugControl({ sessionId, action: "drainEvents" }) as AnyRecord;
    assert.deepEqual(
      drained.events.items.map((event: AnyRecord) => [event.kind, event.data]),
      [["terminated", { reason: failure }]]
    );
    assert.doesNotMatch(JSON.stringify(drained), /secret|private-signal/);
  });
}
