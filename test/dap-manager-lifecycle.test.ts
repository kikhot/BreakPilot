import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import type { DapTransport } from "../src/types/dap.ts";
import type { AnyRecord } from "../src/types/json.ts";
import type { RuntimeDebugProvider } from "../src/types/sessions.ts";
import { ErrorCodes } from "../src/utils/errors.ts";

type RejectCommand = "initialize" | "launch" | "attach";

class LifecycleDapTransport extends EventEmitter implements DapTransport {
  #buffer = Buffer.alloc(0);
  #sequence = 1;
  readonly startFailure?: Error;
  readonly rejectCommand?: RejectCommand;
  readonly responseDelayMs: Partial<Record<RejectCommand, number>>;
  readonly terminateOnReject: boolean;
  readonly commands: string[] = [];
  beforeResponse?: (command: string) => void;
  closed = false;
  closeCount = 0;

  constructor(
    startFailure?: Error,
    rejectCommand?: RejectCommand,
    options: {
      responseDelayMs?: Partial<Record<RejectCommand, number>>;
      terminateOnReject?: boolean;
    } = {}
  ) {
    super();
    this.startFailure = startFailure;
    this.rejectCommand = rejectCommand;
    this.responseDelayMs = options.responseDelayMs ?? {};
    this.terminateOnReject = options.terminateOnReject ?? false;
  }

  start(): void {
    if (this.startFailure) throw this.startFailure;
  }

  close(): void {
    this.closeCount += 1;
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
      this.commands.push(request.command);
      const respond = () => {
        this.beforeResponse?.(request.command);
        const success = request.command !== this.rejectCommand;
        this.#publishMessage({
          seq: this.#sequence++,
          type: "response",
          request_seq: request.seq,
          success,
          command: request.command,
          ...(!success ? { message: `${request.command} rejected` } : {}),
          body: {}
        });
        if (request.command === "initialize" && success) this.publish("initialized");
        if (!success && this.terminateOnReject) {
          this.publish("terminated", { restart: false, exitCode: 17 });
        }
      };
      const delayMs = this.responseDelayMs[request.command as RejectCommand];
      if (delayMs !== undefined) setTimeout(respond, delayMs);
      else queueMicrotask(respond);
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

async function waitFor(check: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
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

function assertManagerLifecycleDetached(dap: EventEmitter): void {
  for (const event of ["stopped", "terminated", "exited", "adapterError", "transportExit", "startFailed"]) {
    assert.equal(dap.listenerCount(event), 0, event);
  }
}

function assertErrorCode(error: unknown, code: string): boolean {
  assert.equal((error as { code?: string }).code, code);
  return true;
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

for (const failure of [
  { mode: "launch", command: "initialize", errorCode: ErrorCodes.LAUNCH_FAILED },
  { mode: "launch", command: "launch", errorCode: ErrorCodes.LAUNCH_FAILED },
  { mode: "attach", command: "attach", errorCode: ErrorCodes.ATTACH_FAILED }
] as const) {
  test(`${failure.mode} ${failure.command} rejection releases the failed managed session`, async () => {
    const transport = new LifecycleDapTransport(undefined, failure.command);
    const { manager, language } = createManager(`${failure.mode}-${failure.command}-failure`, transport);
    let captured: {
      sessionId: string;
      dap: EventEmitter;
      client: EventEmitter;
      provider: RuntimeDebugProvider;
    } | undefined;
    transport.beforeResponse = () => {
      const record = [...manager.sessions.sessions.values()][0];
      if (!record?.dap) return;
      captured = {
        sessionId: record.sessionId,
        dap: record.dap,
        client: record.dap.client,
        provider: record.provider
      };
    };

    await assert.rejects(
      manager.bpDebugStart({
        mode: failure.mode,
        language,
        ...(failure.mode === "attach" ? { host: "127.0.0.1", port: 5678 } : {})
      }),
      (error: unknown) => {
        assertErrorCode(error, failure.errorCode);
        assert.match((error as Error).message, new RegExp(`${failure.command} rejected`));
        return true;
      }
    );

    assert.ok(captured);
    assert.deepEqual(manager.sessions.list(), []);
    assert.equal(captured.provider.capabilities.eventDrain, "unsupported");
    assertManagerLifecycleDetached(captured.dap);
    assertSessionDetached(captured.client);
    assertTransportDetached(transport);
    assert.equal(transport.closed, true);
    await assert.rejects(
      manager.bpDebugControl({ sessionId: captured.sessionId, action: "drainEvents" }),
      (error: unknown) => assertErrorCode(error, ErrorCodes.SESSION_NOT_FOUND)
    );
  });
}

test("explicit terminal session ids reject resume during exited grace without state mutation", async () => {
  const { manager, transport, sessionId } = await startManagedSession("exited-resume");
  transport.publish("stopped", { reason: "breakpoint", threadId: 4 });
  transport.publish("exited", { exitCode: 0 });
  await nextTurn();
  const commandsBefore = [...transport.commands];

  await assert.rejects(
    manager.bpDebugControl({ sessionId, action: "resume" }),
    (error: unknown) => assertErrorCode(error, ErrorCodes.SESSION_NOT_FOUND)
  );
  await assert.rejects(
    manager.bpDebugThreads({ sessionId }),
    (error: unknown) => assertErrorCode(error, ErrorCodes.SESSION_NOT_FOUND)
  );

  assert.equal(manager.sessions.maybeGet(sessionId)?.state, "terminated");
  assert.deepEqual(transport.commands, commandsBefore);
  const stopped = await manager.bpDebugControl({ sessionId, action: "stop" }) as AnyRecord;
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.alreadyStopped, true);
});

for (const lateFailure of [
  { mode: "launch", command: "launch" },
  { mode: "attach", command: "attach" }
] as const) {
  test(`late ${lateFailure.command} rejection retires the already-started managed session`, async () => {
    const transport = new LifecycleDapTransport(undefined, lateFailure.command, {
      responseDelayMs: { [lateFailure.command]: 30 }
    });
    const { manager, language } = createManager(`late-${lateFailure.command}`, transport);
    const started = await manager.bpDebugStart({
      mode: lateFailure.mode,
      language,
      startGraceMs: 5,
      ...(lateFailure.mode === "attach" ? { host: "127.0.0.1", port: 5678 } : {})
    }) as AnyRecord;
    const sessionId = String(started.sessionId);
    const record = manager.sessions.get(sessionId);
    const pendingStop = record.provider.waitForBreakpoint(200).then(
      () => ({ outcome: "resolved" as const }),
      (error: unknown) => ({ outcome: "rejected" as const, error })
    );

    await waitFor(() => manager.sessions.maybeGet(sessionId) === undefined, 100);

    assert.equal(record.state, "failed");
    assert.equal(record.provider.capabilities.eventDrain, "unsupported");
    assertManagerLifecycleDetached(record.dap!);
    assertSessionDetached(record.dap!.client);
    assertTransportDetached(transport);
    assert.equal(transport.closeCount, 1);
    assert.equal(record.dap!.client.pending.size, 0);
    assert.deepEqual(record.dap!.initializedWaiters, []);
    assert.deepEqual(record.dap!.stoppedWaiters, []);
    const stop = await pendingStop;
    assert.equal(stop.outcome, "rejected");
    assertErrorCode(stop.error, ErrorCodes.TOOL_FAILED);
    assert.match((stop.error as Error).message, new RegExp(`${lateFailure.command} rejected`));
    await assert.rejects(
      manager.bpDebugControl({ sessionId, action: "resume" }),
      (error: unknown) => assertErrorCode(error, ErrorCodes.SESSION_NOT_FOUND)
    );
    await assert.rejects(
      manager.bpDebugControl({ sessionId, action: "drainEvents" }),
      (error: unknown) => assertErrorCode(error, ErrorCodes.SESSION_NOT_FOUND)
    );
  });
}

for (const racedFailure of [
  { mode: "launch", command: "launch", errorCode: ErrorCodes.LAUNCH_FAILED },
  { mode: "attach", command: "attach", errorCode: ErrorCodes.ATTACH_FAILED }
] as const) {
  test(`${racedFailure.command} rejection racing with terminated preserves terminal history and closes once`, async () => {
    const transport = new LifecycleDapTransport(undefined, racedFailure.command, {
      terminateOnReject: true
    });
    const { manager, language } = createManager(`raced-${racedFailure.command}`, transport);
    let record: ReturnType<DebugSessionManager["sessions"]["get"]> | undefined;
    transport.beforeResponse = (command) => {
      if (command !== racedFailure.command) return;
      record = [...manager.sessions.sessions.values()][0];
    };

    await assert.rejects(
      manager.bpDebugStart({
        mode: racedFailure.mode,
        language,
        startGraceMs: 100,
        ...(racedFailure.mode === "attach" ? { host: "127.0.0.1", port: 5678 } : {})
      }),
      (error: unknown) => {
        assertErrorCode(error, racedFailure.errorCode);
        assert.match((error as Error).message, new RegExp(`${racedFailure.command} rejected`));
        return true;
      }
    );

    assert.ok(record);
    assert.equal(record.state, "terminated");
    assert.equal(manager.sessions.maybeGet(record.sessionId), undefined);
    assert.equal(transport.closeCount, 1);
    assert.equal(record.provider.capabilities.eventDrain, "unsupported");
    assertManagerLifecycleDetached(record.dap!);
    assertSessionDetached(record.dap!.client);
    assertTransportDetached(transport);
    const drained = await manager.bpDebugControl({
      sessionId: record.sessionId,
      action: "drainEvents"
    }) as AnyRecord;
    assert.deepEqual(
      drained.events.items.map((event: AnyRecord) => [event.kind, event.data]),
      [["terminated", { exitCode: 17, restart: false }]]
    );
  });
}

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
