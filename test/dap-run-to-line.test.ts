import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ToolRouter } from "../src/control/ToolRouter.ts";
import { DapSession } from "../src/dap/DapSession.ts";
import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import { DapRuntimeProvider } from "../src/runtime/providers/DapRuntimeProvider.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { BreakpointManager } from "../src/sessions/BreakpointManager.ts";
import { BreakpointReconciler } from "../src/sessions/BreakpointReconciler.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import type { DapClient } from "../src/dap/DapClient.ts";
import type { DapGotoTarget, DapStackFrame, DapTransport, StoppedEvent } from "../src/types/dap.ts";
import type { AnyRecord } from "../src/types/json.ts";
import type {
  BreakpointRecord,
  DebugSessionRecord,
  RunToLineArgs,
  RunToLineResult,
  RuntimeDebugProvider
} from "../src/types/sessions.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";

type DispatchOutcome = "target" | "unrelated" | "terminal" | "none";
type RecordedRequest = { command: string; arguments: AnyRecord };
type HighLevelBreakpointCall = { filePath: string; breakpoints: BreakpointRecord[] };

class ScriptedDapClient extends EventEmitter {
  started = false;
  requests: RecordedRequest[] = [];
  targets: DapGotoTarget[] = [];
  threads: AnyRecord[] = [{ id: 7, name: "main" }];
  currentFrame: DapStackFrame | null = null;
  gotoOutcome: DispatchOutcome = "target";
  continueOutcome: DispatchOutcome = "target";
  gotoFrame: DapStackFrame = frame("/workspace/Foo.java", 20, 5);
  continueFrame: DapStackFrame = frame("/workspace/Foo.java", 20, 5);
  setBreakpointFailures = new Map<number, Error>();
  continuedBeforeResponse = new Set<string>();
  exitBeforeResponse = new Set<string>();
  deferGotoDispatch = false;
  terminateAfterStop = false;
  continueFailure: Error | null = null;
  setBreakpointCalls = 0;

  start(): void {
    this.started = true;
  }

  close(): void {
    this.started = false;
  }

  emitStopped(body: StoppedEvent = { reason: "breakpoint", threadId: 7 }): void {
    this.emit("stopped", body);
  }

  emitTerminated(): void {
    this.emit("terminated", {});
  }

  async request(command: string, arguments_: AnyRecord = {}): Promise<AnyRecord> {
    this.requests.push({ command, arguments: structuredClone(arguments_) });
    if (this.continuedBeforeResponse.has(command)) this.emit("continued", { threadId: 7 });
    if (this.exitBeforeResponse.has(command)) {
      this.emit("exit", { command });
      throw new BreakPilotError(ErrorCodes.TARGET_PROCESS_EXITED, "Scripted adapter exited during request.", { command });
    }
    if (command === "gotoTargets") return { targets: structuredClone(this.targets) };
    if (command === "threads") return { threads: structuredClone(this.threads) };
    if (command === "stackTrace") {
      return { stackFrames: this.currentFrame ? [structuredClone(this.currentFrame)] : [] };
    }
    if (command === "setBreakpoints") {
      this.setBreakpointCalls += 1;
      const failure = this.setBreakpointFailures.get(this.setBreakpointCalls);
      if (failure) throw failure;
      const breakpoints = Array.isArray(arguments_.breakpoints) ? arguments_.breakpoints : [];
      return {
        breakpoints: breakpoints.map((breakpoint, index) => ({
          id: index + 1,
          verified: true,
          line: breakpoint.line,
          ...(breakpoint.column === undefined ? {} : { column: breakpoint.column })
        }))
      };
    }
    if (command === "goto") {
      if (this.deferGotoDispatch) {
        setTimeout(() => this.#dispatch(this.gotoOutcome, this.gotoFrame), 0);
        return {};
      }
      this.#dispatch(this.gotoOutcome, this.gotoFrame);
      await Promise.resolve();
      return {};
    }
    if (command === "continue") {
      if (this.continueFailure) throw this.continueFailure;
      this.#dispatch(this.continueOutcome, this.continueFrame);
      await Promise.resolve();
      return {};
    }
    return {};
  }

  #dispatch(outcome: DispatchOutcome, nextFrame: DapStackFrame): void {
    if (outcome === "none") return;
    if (outcome === "terminal") {
      this.emitTerminated();
      return;
    }
    this.currentFrame = structuredClone(
      outcome === "target" ? nextFrame : frame("/workspace/Other.java", 99, 1)
    );
    // This arrives synchronously before the request promise settles, exercising
    // the Task 4 causal boundary rather than a mock-only ordering assertion.
    this.emitStopped({ reason: outcome === "target" ? "goto" : "breakpoint", threadId: 7 });
    if (this.terminateAfterStop) this.emitTerminated();
  }
}

/**
 * A real framed DAP transport for the manager lifecycle race.  It deliberately
 * sends `terminated` *before* responding to `continue`, which is the ordering
 * that used to let manager cleanup dispose the client before the fallback
 * transaction could restore its temporary breakpoint.
 */
class TerminalDuringContinueTransport extends EventEmitter implements DapTransport {
  #buffer = Buffer.alloc(0);
  #sequence = 1;
  commands: string[] = [];
  setBreakpointLists: Array<Array<{ line?: number; column?: number }>> = [];
  closed = false;

  start(): void {}

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
        arguments?: AnyRecord;
      };
      this.#buffer = this.#buffer.subarray(bodyEnd);
      this.commands.push(request.command);

      const requestedBreakpoints = Array.isArray(request.arguments?.breakpoints)
        ? request.arguments.breakpoints as Array<{ line?: number; column?: number }>
        : [];
      if (request.command === "setBreakpoints") {
        this.setBreakpointLists.push(structuredClone(requestedBreakpoints));
      }

      // This must happen before the request response: it exercises the
      // destructive manager lifecycle listener while run-to-line is in flight.
      if (request.command === "continue") this.publish("terminated", { exitCode: 17 });

      const body: AnyRecord = request.command === "setBreakpoints"
        ? {
            breakpoints: requestedBreakpoints.map((breakpoint, index) => ({
              id: index + 1,
              verified: true,
              line: breakpoint.line,
              ...(breakpoint.column === undefined ? {} : { column: breakpoint.column })
            }))
          }
        : {};
      this.#respond(request.seq, request.command, body);
      if (request.command === "initialize") this.publish("initialized");
    }
  }

  publish(event: string, body: AnyRecord = {}): void {
    this.#publish({
      seq: this.#sequence++,
      type: "event",
      event,
      body
    });
  }

  #respond(requestSequence: number, command: string, body: AnyRecord): void {
    this.#publish({
      seq: this.#sequence++,
      type: "response",
      request_seq: requestSequence,
      success: true,
      command,
      body
    });
  }

  #publish(message: AnyRecord): void {
    const json = JSON.stringify(message);
    this.emit("data", Buffer.from(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`, "utf8"));
  }
}

class TerminalDuringContinueAdapter extends LanguageAdapter {
  readonly transport: TerminalDuringContinueTransport;

  constructor(transport: TerminalDuringContinueTransport) {
    super({
      language: "run-to-line-terminal-race",
      adapterId: "run-to-line-terminal-race",
      envCommandName: "BREAKPILOT_RUN_TO_LINE_TERMINAL_RACE"
    });
    this.transport = transport;
  }

  override async createTransport(): Promise<DapTransport> {
    return this.transport;
  }
}

function frame(filePath: string, line: number, column?: number): DapStackFrame {
  return {
    id: line,
    name: `line-${line}`,
    line,
    ...(column === undefined ? {} : { column }),
    source: { path: filePath }
  };
}

function run(provider: DapRuntimeProvider, args: RunToLineArgs): Promise<RunToLineResult> {
  assert.equal(typeof provider.runToLine, "function", "DAP provider must implement runToLine");
  return (provider.runToLine as (value: RunToLineArgs) => Promise<RunToLineResult>)(args);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<BreakPilotError> {
  let captured: unknown;
  await assert.rejects(promise, (error: unknown) => {
    captured = error;
    return error instanceof BreakPilotError && error.code === code;
  });
  return captured as BreakPilotError;
}

function requestCommands(client: ScriptedDapClient, command: string): RecordedRequest[] {
  return client.requests.filter((request) => request.command === command);
}

function createFixture(options: {
  native?: boolean;
  fallback?: boolean;
  paused?: boolean;
  targets?: DapGotoTarget[];
  gotoOutcome?: DispatchOutcome;
  continueOutcome?: DispatchOutcome;
} = {}): {
  client: ScriptedDapClient;
  dap: DapSession;
  provider: DapRuntimeProvider;
  breakpoints: BreakpointManager;
  reconciler: BreakpointReconciler;
  record: DebugSessionRecord;
  highLevelSetBreakpoints: HighLevelBreakpointCall[];
} {
  const client = new ScriptedDapClient();
  client.targets = options.targets ?? [{ id: 41, label: "line 20", line: 20, column: 5 }];
  client.gotoOutcome = options.gotoOutcome ?? "target";
  client.continueOutcome = options.continueOutcome ?? "target";

  const dap = new DapSession({
    sessionId: "dap_run_to_line",
    language: "java",
    client: client as unknown as DapClient,
    workspaceRoot: "/workspace"
  });
  dap.startClient();
  dap.capabilities = options.native === false ? {} : { supportsGotoTargetsRequest: true };
  if (options.paused !== false) {
    client.currentFrame = frame("/workspace/Before.java", 3, 1);
    client.emitStopped({ reason: "breakpoint", threadId: 7 });
  }

  const breakpoints = new BreakpointManager();
  const reconciler = new BreakpointReconciler(breakpoints);
  const highLevelSetBreakpoints: HighLevelBreakpointCall[] = [];
  const dapSetBreakpoints = dap.setBreakpoints.bind(dap);
  dap.setBreakpoints = async (filePath, records) => {
    highLevelSetBreakpoints.push({
      filePath,
      breakpoints: structuredClone(records)
    });
    return dapSetBreakpoints(filePath, records);
  };

  let record!: DebugSessionRecord;
  const provider = new (DapRuntimeProvider as unknown as new (...args: any[]) => DapRuntimeProvider)(
    dap,
    undefined,
    {
      breakpointReconciler: options.fallback ? reconciler : undefined,
      getSession: () => record,
      assertWorkspacePath: (filePath: string) => {
        if (!filePath.startsWith("/workspace/")) {
          throw new BreakPilotError(ErrorCodes.WORKSPACE_VIOLATION, "Path is outside the test workspace.", { filePath });
        }
        return filePath;
      }
    }
  );
  record = {
    sessionId: dap.sessionId,
    language: dap.language,
    workspaceRoot: dap.workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider,
    dap
  };
  return { client, dap, provider, breakpoints, reconciler, record, highLevelSetBreakpoints };
}

test("native run-to-line records a target stop emitted before the goto response", async () => {
  const { client, provider } = createFixture({
    targets: [{ id: 41, label: "line 20", line: 20, column: 5 }]
  });

  assert.equal(provider.capabilities.runToLine, "native");
  const result = await run(provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });

  assert.deepEqual(result, {
    status: "paused",
    targetReached: true,
    requestedPosition: { filePath: "/workspace/Foo.java", line: 20 },
    position: { filePath: "/workspace/Foo.java", line: 20 },
    frame: frame("/workspace/Foo.java", 20, 5),
    cleanedUp: true
  });
  assert.deepEqual(requestCommands(client, "gotoTargets"), [{
    command: "gotoTargets",
    arguments: { source: { path: "/workspace/Foo.java" }, line: 20 }
  }]);
  assert.deepEqual(requestCommands(client, "goto"), [{
    command: "goto",
    arguments: { threadId: 7, targetId: 41 }
  }]);
  assert.equal(requestCommands(client, "continue").length, 0);
});

test("native run-to-line chooses a deterministic nearest executable target and refuses an empty list", async () => {
  const { client, provider } = createFixture({
    targets: [
      { id: 8, label: "line 18", line: 18, column: 3 },
      { id: 3, label: "line 21", line: 21, column: 1 }
    ]
  });
  client.gotoFrame = frame("/workspace/Foo.java", 21, 1);

  const nearest = await run(provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });
  assert.equal(nearest.targetReached, true);
  assert.deepEqual(nearest.resolvedPosition, { filePath: "/workspace/Foo.java", line: 21, column: 1 });
  assert.match(nearest.warnings?.join(" ") ?? "", /nearest executable target/i);
  assert.deepEqual(requestCommands(client, "goto")[0], {
    command: "goto",
    arguments: { threadId: 7, targetId: 3 }
  });

  const empty = createFixture({ targets: [] });
  await expectCode(
    run(empty.provider, { filePath: "/workspace/Foo.java", line: 20, threadId: 7, timeoutMs: 100 }),
    ErrorCodes.UNSUPPORTED_CAPABILITY
  );
  assert.equal(requestCommands(empty.client, "goto").length, 0);
  assert.equal(requestCommands(empty.client, "continue").length, 0);
});

test("native run-to-line ignores stale stops and truthfully returns unrelated, terminal, and timeout outcomes", async () => {
  const unrelated = createFixture({ gotoOutcome: "unrelated" });
  const unrelatedResult = await run(unrelated.provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });
  assert.equal(unrelatedResult.status, "paused");
  assert.equal(unrelatedResult.targetReached, false);
  assert.match(unrelatedResult.warnings?.join(" ") ?? "", /different|target/i);
  assert.equal(requestCommands(unrelated.client, "goto").length, 1);
  assert.equal(requestCommands(unrelated.client, "continue").length, 0, "an unrelated stop must not auto-resume");

  const terminal = createFixture({ gotoOutcome: "terminal" });
  const terminalResult = await run(terminal.provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });
  assert.equal(terminalResult.status, "stopped");
  assert.equal(terminalResult.targetReached, false);
  assert.equal(terminalResult.cleanedUp, true);

  const timeout = createFixture({ gotoOutcome: "none" });
  const timeoutResult = await run(timeout.provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 10
  });
  assert.equal(timeoutResult.status, "timeout");
  assert.equal(timeoutResult.targetReached, false);
  assert.equal(timeoutResult.cleanedUp, true);
  assert.equal((timeout.dap as unknown as { isPaused?: boolean }).isPaused, false, "timeout must not leave a false paused state");
});

test("run-to-line gives terminal truth when a fresh stop is immediately followed by termination", async () => {
  const native = createFixture();
  native.client.deferGotoDispatch = true;
  native.client.terminateAfterStop = true;

  const nativeResult = await run(native.provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });
  assert.equal(nativeResult.status, "stopped");
  assert.equal(nativeResult.targetReached, false);
  assert.equal(nativeResult.cleanedUp, true);
  assert.equal(native.dap.terminated, true);
  assert.equal(native.dap.isPaused, false);

  const fallback = createFixture({ native: false, fallback: true });
  fallback.client.continueOutcome = "target";
  fallback.client.terminateAfterStop = true;
  const fallbackResult = await run(fallback.provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });
  assert.equal(fallbackResult.status, "stopped");
  assert.equal(fallbackResult.targetReached, false);
  assert.equal(fallbackResult.cleanedUp, true);
  assert.equal(fallback.dap.terminated, true);
  assert.equal(fallback.dap.isPaused, false);
});

test("run-to-line maps a terminal adapter request rejection after cleanup", async () => {
  const native = createFixture();
  native.client.exitBeforeResponse.add("goto");
  const nativeResult = await run(native.provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });
  assert.equal(nativeResult.status, "stopped");
  assert.equal(nativeResult.targetReached, false);
  assert.equal(nativeResult.cleanedUp, true);
  assert.equal(native.dap.terminated, true);

  const fallback = createFixture({ native: false, fallback: true });
  fallback.client.exitBeforeResponse.add("continue");
  const fallbackResult = await run(fallback.provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });
  assert.equal(fallbackResult.status, "stopped");
  assert.equal(fallbackResult.targetReached, false);
  assert.equal(fallbackResult.cleanedUp, true);
  assert.equal(fallback.dap.terminated, true);
  assert.equal(fallback.client.setBreakpointCalls, 2, "fallback must restore before publishing terminal truth");
  assert.deepEqual(fallback.breakpoints.listForSource(fallback.record.sessionId, "/workspace/Foo.java"), []);
});

test("DAP run-to-line rejects unsafe source, non-paused state, and nonnumeric thread before mutation", async () => {
  const unsafe = createFixture();
  await expectCode(
    run(unsafe.provider, { filePath: "/outside/Foo.java", line: 20, threadId: 7, timeoutMs: 100 }),
    ErrorCodes.WORKSPACE_VIOLATION
  );
  assert.equal(unsafe.client.requests.length, 0);

  const running = createFixture({ paused: false });
  await expectCode(
    run(running.provider, { filePath: "/workspace/Foo.java", line: 20, threadId: 7, timeoutMs: 100 }),
    ErrorCodes.INVALID_ARGUMENT
  );
  assert.equal(running.client.requests.length, 0);

  const invalidThread = createFixture();
  await expectCode(
    run(invalidThread.provider, {
      filePath: "/workspace/Foo.java",
      line: 20,
      threadId: "7",
      timeoutMs: 100
    }),
    ErrorCodes.INVALID_ARGUMENT
  );
  assert.equal(invalidThread.client.requests.length, 0);
});

test("fallback run-to-line preserves an explicit zero DAP thread id", async () => {
  const { client, dap, provider } = createFixture({ native: false, fallback: true });
  client.threads = [{ id: 99, name: "fallback-only" }];

  const result = await run(provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 0,
    timeoutMs: 100
  });
  assert.equal(result.status, "paused");
  assert.deepEqual(requestCommands(client, "continue"), [{
    command: "continue",
    arguments: { threadId: 0 }
  }]);
  assert.equal(requestCommands(client, "threads").length, 0, "an explicit zero must not be replaced by another thread");

  client.requests.length = 0;
  await dap.stackTrace(0, 1);
  assert.deepEqual(requestCommands(client, "stackTrace"), [{
    command: "stackTrace",
    arguments: { threadId: 0, startFrame: 0, levels: 1 }
  }]);
});

test("DAP stack lookup returns an empty result when no fallback thread exists", async () => {
  const { client, dap } = createFixture();
  client.threads = [];
  client.requests.length = 0;

  const stack = await dap.stackTrace(null, 1);
  assert.deepEqual(stack, { threadId: null, stackFrames: [] });
  assert.equal(requestCommands(client, "threads").length, 1);
  assert.equal(requestCommands(client, "stackTrace").length, 0);
});

test("native run-to-line rechecks pause state after thread and target lookup waits", async () => {
  const afterThreadLookup = createFixture();
  afterThreadLookup.dap.threadId = null;
  afterThreadLookup.client.continuedBeforeResponse.add("threads");
  await expectCode(
    run(afterThreadLookup.provider, { filePath: "/workspace/Foo.java", line: 20, timeoutMs: 100 }),
    ErrorCodes.INVALID_ARGUMENT
  );
  assert.equal(requestCommands(afterThreadLookup.client, "threads").length, 1);
  assert.equal(requestCommands(afterThreadLookup.client, "gotoTargets").length, 0);
  assert.equal(requestCommands(afterThreadLookup.client, "goto").length, 0);

  const afterTargetLookup = createFixture();
  afterTargetLookup.client.continuedBeforeResponse.add("gotoTargets");
  await expectCode(
    run(afterTargetLookup.provider, {
      filePath: "/workspace/Foo.java",
      line: 20,
      threadId: 7,
      timeoutMs: 100
    }),
    ErrorCodes.INVALID_ARGUMENT
  );
  assert.equal(requestCommands(afterTargetLookup.client, "gotoTargets").length, 1);
  assert.equal(requestCommands(afterTargetLookup.client, "goto").length, 0);
});

test("concrete DAP fallback capability requires manager wiring when goto is unavailable", async () => {
  const wired = createFixture({ native: false, fallback: true });
  const unwired = createFixture({ native: false, fallback: false });

  assert.equal(wired.provider.capabilities.runToLine, "fallback");
  assert.equal(unwired.provider.capabilities.runToLine, "unsupported");
  await expectCode(
    run(unwired.provider, {
      filePath: "/workspace/Foo.java",
      line: 20,
      threadId: 7,
      timeoutMs: 100
    }),
    ErrorCodes.UNSUPPORTED_CAPABILITY
  );
  assert.equal(unwired.client.requests.length, 0, "unwired fallback must not mutate the adapter");
});

test("fallback run-to-line preserves every source breakpoint, resumes once, and proves cleanup", async () => {
  const { client, provider, breakpoints, record, highLevelSetBreakpoints } = createFixture({
    native: false,
    fallback: true
  });
  const user = breakpoints.add(record.sessionId, {
    id: "user-existing",
    file: "/workspace/Foo.java",
    line: 4,
    owner: "user",
    enabled: true
  });
  const agent = breakpoints.add(record.sessionId, {
    id: "agent-existing",
    file: "/workspace/Foo.java",
    line: 8,
    owner: "agent",
    enabled: true
  });

  assert.equal(provider.capabilities.runToLine, "fallback");
  const result = await run(provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });

  assert.equal(result.status, "paused");
  assert.equal(result.targetReached, true);
  assert.equal(result.cleanedUp, true);
  assert.ok(result.temporaryBreakpointId);
  assert.equal(requestCommands(client, "goto").length, 0);
  assert.equal(requestCommands(client, "continue").length, 1, "fallback must continue exactly once");
  assert.equal(highLevelSetBreakpoints.length, 2, "apply and complete restoration are both required");
  assert.deepEqual(
    highLevelSetBreakpoints[0]?.breakpoints.map((breakpoint) => breakpoint.id).sort(),
    [agent.id, user.id, result.temporaryBreakpointId].sort()
  );
  assert.deepEqual(
    highLevelSetBreakpoints[1]?.breakpoints.map((breakpoint) => breakpoint.id).sort(),
    [agent.id, user.id].sort()
  );
  assert.deepEqual(
    breakpoints.listForSource(record.sessionId, "/workspace/Foo.java").map((breakpoint) => breakpoint.id).sort(),
    [agent.id, user.id].sort(),
    "local desired state must be restored only after complete provider evidence"
  );
});

test("fallback run-to-line rechecks pause state before temporary mutation after a source-lock wait", async () => {
  const { client, dap, provider, reconciler, record } = createFixture({ native: false, fallback: true });
  let releaseHeld!: () => void;
  let markHeld!: () => void;
  const hold = new Promise<void>((resolve) => { releaseHeld = resolve; });
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  const incumbent = reconciler.withTemporaryBreakpoint(
    record,
    { filePath: "/workspace/Foo.java", line: 5 },
    async () => {
      markHeld();
      await hold;
      return undefined;
    }
  );
  await held;

  const contender = run(provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });
  await Promise.resolve();
  client.emit("continued", { threadId: 7 });
  releaseHeld();
  await incumbent;

  await expectCode(contender, ErrorCodes.INVALID_ARGUMENT);
  assert.equal(requestCommands(client, "continue").length, 0);
  assert.equal(client.setBreakpointCalls, 2, "only the incumbent apply and restore may reach the adapter");
  assert.equal(dap.isPaused, false);
});

test("fallback run-to-line rechecks pause state before its single continue", async () => {
  const { client, provider, breakpoints, record, highLevelSetBreakpoints } = createFixture({
    native: false,
    fallback: true
  });
  client.continuedBeforeResponse.add("setBreakpoints");

  await expectCode(
    run(provider, {
      filePath: "/workspace/Foo.java",
      line: 20,
      threadId: 7,
      timeoutMs: 100
    }),
    ErrorCodes.INVALID_ARGUMENT
  );
  assert.equal(requestCommands(client, "continue").length, 0);
  assert.equal(highLevelSetBreakpoints.length, 2, "the temporary mutation must still be restored");
  assert.deepEqual(breakpoints.listForSource(record.sessionId, "/workspace/Foo.java"), []);
});

test("fallback returns real fresh outcomes and exposes indeterminate cleanup instead of fabricating success", async () => {
  const unrelated = createFixture({ native: false, fallback: true, continueOutcome: "unrelated" });
  const unrelatedResult = await run(unrelated.provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });
  assert.equal(unrelatedResult.status, "paused");
  assert.equal(unrelatedResult.targetReached, false);
  assert.equal(requestCommands(unrelated.client, "continue").length, 1);

  const terminal = createFixture({ native: false, fallback: true, continueOutcome: "terminal" });
  const terminalResult = await run(terminal.provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 100
  });
  assert.equal(terminalResult.status, "stopped");
  assert.equal(terminalResult.targetReached, false);
  assert.equal(terminalResult.cleanedUp, true);

  const timeout = createFixture({ native: false, fallback: true, continueOutcome: "none" });
  assert.equal(timeout.dap.stopSequence, 1, "the fixture starts with a stale pre-boundary stop");
  const timeoutResult = await run(timeout.provider, {
    filePath: "/workspace/Foo.java",
    line: 20,
    threadId: 7,
    timeoutMs: 10
  });
  assert.equal(timeoutResult.status, "timeout");
  assert.equal(timeoutResult.targetReached, false);
  assert.equal(timeoutResult.cleanedUp, true);

  const initialApplyFailure = createFixture({ native: false, fallback: true });
  initialApplyFailure.client.setBreakpointFailures.set(1, new Error("apply failed"));
  const applyError = await expectCode(
    run(initialApplyFailure.provider, {
      filePath: "/workspace/Foo.java",
      line: 20,
      threadId: 7,
      timeoutMs: 100
    }),
    ErrorCodes.BREAKPOINT_UPDATE_FAILED
  );
  assert.equal(applyError.details.outcome, "restored");
  assert.equal(applyError.details.retrySafe, true);
  assert.equal(initialApplyFailure.client.setBreakpointCalls, 2, "a failed initial apply still proves original restoration");
  assert.deepEqual(
    initialApplyFailure.breakpoints.listForSource(initialApplyFailure.record.sessionId, "/workspace/Foo.java"),
    [],
    "a proven initial-apply recovery must not leave a synthetic local temporary breakpoint"
  );

  const cleanupFailure = createFixture({ native: false, fallback: true });
  cleanupFailure.client.setBreakpointFailures.set(2, new Error("restore failed"));
  const error = await expectCode(
    run(cleanupFailure.provider, {
      filePath: "/workspace/Foo.java",
      line: 20,
      threadId: 7,
      timeoutMs: 100
    }),
    ErrorCodes.RUN_TO_LINE_CLEANUP_FAILED
  );
  assert.deepEqual(error.details.outcome, "indeterminate");
  assert.deepEqual(error.details.retrySafe, false);
  assert.deepEqual(error.details.cleanupRequired, true);
  assert.equal(typeof error.details.temporaryBreakpointId, "string");
  assert.ok(Array.isArray(error.details.affectedIds));
  assert.equal(typeof error.details.recommendedAction, "string");
  const retained = cleanupFailure.breakpoints.listForSource(cleanupFailure.record.sessionId, "/workspace/Foo.java");
  assert.deepEqual(retained.map((breakpoint) => breakpoint.id), [error.details.temporaryBreakpointId]);
  assert.equal(retained[0]?.verified, true, "indeterminate cleanup must retain adapter-acknowledged evidence");
  assert.equal(retained[0]?.adapterBreakpointId, 1, "local evidence must preserve the adapter breakpoint id");
});

test("manager validates the strengthened shared result and updates state from actual outcome", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const manager = new DebugSessionManager({ policy });
  const workspaceRoot = policy.workspace.root;
  let outcome: RunToLineResult = {
    status: "paused",
    targetReached: false,
    requestedPosition: { filePath: `${workspaceRoot}/src/Foo.java`, line: 20 },
    cleanedUp: true,
    warnings: ["Stopped at another breakpoint."]
  };
  let calls = 0;
  const provider: RuntimeDebugProvider = {
    kind: "dap",
    sessionId: "manager_run_to_line",
    language: "java",
    workspaceRoot,
    capabilities: {
      pause: "native",
      stepping: "native",
      runToLine: "native",
      variableReferences: "native",
      setValue: "unsupported",
      breakpointUpdate: "fallback",
      conditionalBreakpoints: "unsupported",
      hitConditionalBreakpoints: "unsupported",
      tracepoints: "unsupported",
      eventDrain: "unsupported"
    },
    threadId: 7,
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { return { reason: "breakpoint", threadId: 7 }; },
    async runToLine() {
      calls += 1;
      return structuredClone(outcome);
    },
    async getRuntimeSnapshot() {
      return {
        sessionId: "manager_run_to_line",
        source: "headless" as const,
        language: "java",
        threadId: 7,
        frameId: null,
        stackFrames: [],
        variables: {},
        limits: { maxDepth: 1, maxItems: 1, maxStringLength: 1 }
      };
    },
    async evaluate() { return {}; },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { return {}; }
  };
  manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider
  });
  const router = new ToolRouter(manager);

  const paused = await router.callTool("bp_debug_run_to_line", {
    sessionId: provider.sessionId,
    filePath: "src/Foo.java",
    line: 20
  });
  assert.equal(paused.error, undefined);
  assert.equal(paused.status, "paused");
  assert.equal(paused.targetReached, false);
  assert.equal(manager.sessions.get(provider.sessionId).state, "paused");

  outcome = {
    status: "timeout",
    targetReached: false,
    requestedPosition: { filePath: `${workspaceRoot}/src/Foo.java`, line: 20 },
    cleanedUp: true
  };
  const timedOut = await router.callTool("bp_debug_run_to_line", {
    sessionId: provider.sessionId,
    filePath: "src/Foo.java",
    line: 20
  });
  assert.equal(timedOut.error, undefined);
  assert.equal(timedOut.status, "timeout");
  assert.equal(manager.sessions.get(provider.sessionId).state, "running");
  assert.equal(calls, 2);
});

test("manager marks an indeterminate post-dispatch cleanup failure as running", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const manager = new DebugSessionManager({ policy });
  const workspaceRoot = policy.workspace.root;
  const provider: RuntimeDebugProvider = {
    kind: "dap",
    sessionId: "run_to_line_cleanup_state",
    language: "java",
    workspaceRoot,
    capabilities: {
      pause: "native",
      stepping: "native",
      runToLine: "fallback",
      variableReferences: "native",
      setValue: "unsupported",
      breakpointUpdate: "fallback",
      conditionalBreakpoints: "unsupported",
      hitConditionalBreakpoints: "unsupported",
      tracepoints: "unsupported",
      eventDrain: "unsupported"
    },
    threadId: 7,
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { return { reason: "breakpoint", threadId: 7 }; },
    async runToLine() {
      throw new BreakPilotError(
        ErrorCodes.RUN_TO_LINE_CLEANUP_FAILED,
        "cleanup could not be proven",
        { outcome: "indeterminate", retrySafe: false, cleanupRequired: true }
      );
    },
    async getRuntimeSnapshot() {
      return {
        sessionId: "run_to_line_cleanup_state",
        source: "headless" as const,
        language: "java",
        threadId: 7,
        frameId: null,
        stackFrames: [],
        variables: {},
        limits: { maxDepth: 1, maxItems: 1, maxStringLength: 1 }
      };
    },
    async evaluate() { return {}; },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { return {}; }
  };
  const record: DebugSessionRecord = {
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider,
    // The fallback has already dispatched continue and did not receive a fresh
    // terminal or stop; the manager must not preserve the stale paused state.
    dap: { isPaused: false, terminated: false } as unknown as DapSession
  };
  manager.sessions.add(record);

  await expectCode(
    manager.bpDebugRunToLine({ sessionId: record.sessionId, filePath: "src/Cleanup.java", line: 20 }),
    ErrorCodes.RUN_TO_LINE_CLEANUP_FAILED
  );
  assert.equal(manager.sessions.get(record.sessionId).state, "running");
});

test("manager derives running state after a dispatched DAP request fails", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const manager = new DebugSessionManager({ policy });
  const workspaceRoot = policy.workspace.root;
  const dapState = { isPaused: true, terminated: false };
  const provider: RuntimeDebugProvider = {
    kind: "dap",
    sessionId: "run_to_line_dispatch_failure_state",
    language: "java",
    workspaceRoot,
    capabilities: {
      pause: "native",
      stepping: "native",
      runToLine: "native",
      variableReferences: "native",
      setValue: "unsupported",
      breakpointUpdate: "fallback",
      conditionalBreakpoints: "unsupported",
      hitConditionalBreakpoints: "unsupported",
      tracepoints: "unsupported",
      eventDrain: "unsupported"
    },
    threadId: 7,
    async setBreakpoints() { return []; },
    async waitForBreakpoint() { return { reason: "breakpoint", threadId: 7 }; },
    async runToLine() {
      // This models DapRuntimeProvider after it has called markRunning() but
      // before the adapter rejects its dispatched `goto` request.
      dapState.isPaused = false;
      throw new BreakPilotError(ErrorCodes.TOOL_FAILED, "DAP goto request failed after dispatch.");
    },
    async getRuntimeSnapshot() {
      return {
        sessionId: "run_to_line_dispatch_failure_state",
        source: "headless" as const,
        language: "java",
        threadId: 7,
        frameId: null,
        stackFrames: [],
        variables: {},
        limits: { maxDepth: 1, maxItems: 1, maxStringLength: 1 }
      };
    },
    async evaluate() { return {}; },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { return {}; }
  };
  const record: DebugSessionRecord = {
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider,
    dap: dapState as unknown as DapSession
  };
  manager.sessions.add(record);

  await expectCode(
    manager.bpDebugRunToLine({ sessionId: record.sessionId, filePath: "src/Dispatch.java", line: 20 }),
    ErrorCodes.TOOL_FAILED
  );
  assert.equal(manager.sessions.get(record.sessionId).state, "running");
});

test("manager rejects every breakpoint mutation while a run-to-line lease is active", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const manager = new DebugSessionManager({ policy });
  const workspaceRoot = policy.workspace.root;
  let resolveRun!: (result: RunToLineResult) => void;
  const runResult = new Promise<RunToLineResult>((resolve) => {
    resolveRun = resolve;
  });
  let markRunStarted!: () => void;
  const runStarted = new Promise<void>((resolve) => {
    markRunStarted = resolve;
  });
  let setBreakpointCalls = 0;
  const provider: RuntimeDebugProvider = {
    kind: "dap",
    sessionId: "run_to_line_mutation_lease",
    language: "java",
    workspaceRoot,
    capabilities: {
      pause: "native",
      stepping: "native",
      runToLine: "native",
      variableReferences: "native",
      setValue: "unsupported",
      breakpointUpdate: "fallback",
      conditionalBreakpoints: "unsupported",
      hitConditionalBreakpoints: "unsupported",
      tracepoints: "unsupported",
      eventDrain: "unsupported"
    },
    threadId: 7,
    async setBreakpoints(_filePath, records) {
      setBreakpointCalls += 1;
      return records.map((record, index) => ({ id: index + 1, verified: true, line: record.line }));
    },
    async waitForBreakpoint() { return { reason: "breakpoint", threadId: 7 }; },
    async runToLine() {
      markRunStarted();
      return runResult;
    },
    async getRuntimeSnapshot() {
      return {
        sessionId: "run_to_line_mutation_lease",
        source: "headless" as const,
        language: "java",
        threadId: 7,
        frameId: null,
        stackFrames: [],
        variables: {},
        limits: { maxDepth: 1, maxItems: 1, maxStringLength: 1 }
      };
    },
    async evaluate() { return {}; },
    async continue() { return {}; },
    async step() { return {}; },
    async disconnect() { return {}; }
  };
  manager.sessions.add({
    sessionId: provider.sessionId,
    language: provider.language,
    workspaceRoot,
    mode: "headless",
    owner: "mcp",
    state: "paused",
    createdAt: new Date(0).toISOString(),
    providerKind: "dap",
    provider
  });
  const existing = manager.breakpoints.add(provider.sessionId, {
    id: "existing-breakpoint",
    file: `${workspaceRoot}/src/Lease.java`,
    line: 5,
    owner: "agent"
  });

  const running = manager.bpDebugRunToLine({
    sessionId: provider.sessionId,
    filePath: "src/Lease.java",
    line: 20
  });
  await runStarted;

  await expectCode(
    manager.bpDebugSetBreakpoint({ sessionId: provider.sessionId, filePath: "src/Lease.java", line: 8 }),
    ErrorCodes.SESSION_OWNER_CONFLICT
  );
  await expectCode(
    manager.bpDebugSetBreakpoint({ sessionId: provider.sessionId, breakpointId: existing.id, line: 9 }),
    ErrorCodes.SESSION_OWNER_CONFLICT
  );
  await expectCode(
    manager.bpDebugRemoveBreakpoint({ sessionId: provider.sessionId, breakpointId: existing.id }),
    ErrorCodes.SESSION_OWNER_CONFLICT
  );
  assert.equal(setBreakpointCalls, 0, "a rejected mutation must not reach the provider");

  resolveRun({
    status: "paused",
    targetReached: true,
    requestedPosition: { filePath: `${workspaceRoot}/src/Lease.java`, line: 20 },
    cleanedUp: true
  });
  await running;

  const allowed = await manager.bpDebugSetBreakpoint({
    sessionId: provider.sessionId,
    filePath: "src/Lease.java",
    line: 8
  });
  assert.equal(allowed.error, undefined);
  assert.equal(setBreakpointCalls, 1, "the lease must release after run-to-line completes");
});

test("manager rejects destructive debug controls while a run-to-line lease is active", async () => {
  const actions = ["resume", "pause", "stepOver", "stop", "disconnect"] as const;
  const policy = loadPolicy("breakpilot.yaml");

  for (const action of actions) {
    const manager = new DebugSessionManager({ policy });
    const workspaceRoot = policy.workspace.root;
    const controlCalls = { continue: 0, pause: 0, step: 0, disconnect: 0 };
    const provider: RuntimeDebugProvider = {
      kind: "dap",
      sessionId: `run_to_line_control_lease_${action}`,
      language: "java",
      workspaceRoot,
      capabilities: {
        pause: "native",
        stepping: "native",
        runToLine: "native",
        variableReferences: "native",
        setValue: "unsupported",
        breakpointUpdate: "fallback",
        conditionalBreakpoints: "unsupported",
        hitConditionalBreakpoints: "unsupported",
        tracepoints: "unsupported",
        eventDrain: "unsupported"
      },
      threadId: 7,
      async setBreakpoints() { return []; },
      async waitForBreakpoint() { return { reason: "breakpoint", threadId: 7 }; },
      async runToLine() {
        return {
          status: "paused" as const,
          targetReached: true,
          requestedPosition: { filePath: `${workspaceRoot}/src/Lease.java`, line: 20 },
          cleanedUp: true
        };
      },
      async getRuntimeSnapshot() {
        return {
          sessionId: `run_to_line_control_lease_${action}`,
          source: "headless" as const,
          language: "java",
          threadId: 7,
          frameId: null,
          stackFrames: [],
          variables: {},
          limits: { maxDepth: 1, maxItems: 1, maxStringLength: 1 }
        };
      },
      async evaluate() { return {}; },
      async pause() { controlCalls.pause += 1; return {}; },
      async continue() { controlCalls.continue += 1; return {}; },
      async step() { controlCalls.step += 1; return {}; },
      async disconnect() { controlCalls.disconnect += 1; return {}; }
    };
    const record: DebugSessionRecord = {
      sessionId: provider.sessionId,
      language: provider.language,
      workspaceRoot,
      mode: "headless",
      owner: "mcp",
      state: "paused",
      createdAt: new Date(0).toISOString(),
      providerKind: "dap",
      provider
    };
    manager.sessions.add(record);
    manager.coordinator.beginExecution(record, "run-to-line");
    try {
      await expectCode(
        manager.bpDebugControl({ sessionId: record.sessionId, action }),
        ErrorCodes.SESSION_OWNER_CONFLICT
      );
      assert.deepEqual(controlCalls, { continue: 0, pause: 0, step: 0, disconnect: 0 });
      assert.equal(manager.sessions.maybeGet(record.sessionId), record);
    } finally {
      manager.coordinator.endExecution(record);
    }
  }
});

test("manager defers terminal cleanup until fallback restoration has completed", async () => {
  const policy = loadPolicy("breakpilot.yaml");
  const manager = new DebugSessionManager({ policy });
  const transport = new TerminalDuringContinueTransport();
  const adapter = new TerminalDuringContinueAdapter(transport);
  manager.adapters.register(adapter);

  const started = await manager.bpDebugStart({ mode: "launch", language: adapter.language }) as AnyRecord;
  const sessionId = String(started.sessionId);
  transport.publish("stopped", { reason: "breakpoint", threadId: 7 });
  assert.equal(manager.sessions.get(sessionId).state, "paused");

  const result = await manager.bpDebugRunToLine({
    sessionId,
    filePath: "src/TerminalRace.java",
    line: 20,
    timeoutMs: 100
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, "stopped");
  assert.equal(result.targetReached, false);
  assert.equal(result.cleanedUp, true);
  assert.deepEqual(
    transport.setBreakpointLists.map((list) => list.length),
    [1, 0],
    "fallback must prove restoration before deferred session destruction"
  );
  assert.ok(transport.commands.includes("continue"));
  assert.equal(transport.closed, true, "cleanup should run only after the transaction finally block");
  assert.equal(manager.sessions.maybeGet(sessionId), undefined);
});
