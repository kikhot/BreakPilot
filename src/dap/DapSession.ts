import { EventEmitter } from "node:events";
import type { DapBreakpoint, DapScope, DapStackFrame, DapVariable, StoppedEvent } from "../types/dap.ts";
import type { DebugLanguage } from "../types/debug.ts";
import type { AnyRecord } from "../types/json.ts";
import type { BreakpointRecord } from "../types/sessions.ts";
import { DapClient } from "./DapClient.ts";
import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";
import { createDeferred, withTimeout } from "../utils/timeout.ts";
import { toDapSource } from "../utils/path.ts";

export class DapSession extends EventEmitter {
  sessionId: string;
  language: DebugLanguage;
  client: DapClient;
  workspaceRoot: string;
  capabilities: AnyRecord;
  initialized: boolean;
  configurationDone: boolean;
  initializedWaiters: ReturnType<typeof createDeferred<void>>[];
  startRequestPromise: Promise<AnyRecord> | null;
  startError: Error | null;
  stoppedQueue: StoppedEvent[];
  stoppedWaiters: ReturnType<typeof createDeferred<StoppedEvent>>[];
  threadId: number | null;
  terminated: boolean;

  constructor({
    sessionId,
    language,
    client,
    workspaceRoot
  }: {
    sessionId: string;
    language: DebugLanguage;
    client: DapClient;
    workspaceRoot: string;
  }) {
    super();
    this.sessionId = sessionId;
    this.language = language;
    this.client = client;
    this.workspaceRoot = workspaceRoot;
    this.capabilities = {};
    this.initialized = false;
    this.configurationDone = false;
    this.initializedWaiters = [];
    this.startRequestPromise = null;
    this.startError = null;
    this.stoppedQueue = [];
    this.stoppedWaiters = [];
    this.threadId = null;
    this.terminated = false;
  }

  startClient(): void {
    this.client.on("initialized", () => {
      this.initialized = true;
      for (const waiter of this.initializedWaiters.splice(0)) waiter.resolve();
      this.emit("initialized");
    });
    this.client.on("stopped", (body: StoppedEvent) => {
      this.threadId = body.threadId ?? this.threadId;
      const event = { sessionId: this.sessionId, ...body };
      const waiter = this.stoppedWaiters.shift();
      if (waiter) waiter.resolve(event);
      else this.stoppedQueue.push(event);
      this.emit("stopped", event);
    });
    this.client.on("continued", (body: AnyRecord) => this.emit("continued", body));
    this.client.on("terminated", (body: AnyRecord) => {
      this.terminated = true;
      this.emit("terminated", body);
    });
    this.client.on("exited", (body: AnyRecord) => this.emit("exited", body));
    this.client.start();
  }

  async initialize(adapterId = this.language): Promise<AnyRecord> {
    this.capabilities = await this.client.request("initialize", {
      adapterID: adapterId,
      clientID: "breakpilot-debugger",
      clientName: "BreakPilot Debugger",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: false,
      locale: "en-US"
    });
    return this.capabilities;
  }

  async launch(args: AnyRecord = {}): Promise<AnyRecord> {
    return this.#start("launch", args);
  }

  async attach(args: AnyRecord = {}): Promise<AnyRecord> {
    return this.#start("attach", args);
  }

  async setBreakpoints(filePath: string, breakpoints: BreakpointRecord[]): Promise<DapBreakpoint[]> {
    const response = await this.client.request("setBreakpoints", {
      source: toDapSource(filePath),
      breakpoints: breakpoints.map((bp) => ({
        line: bp.line,
        column: bp.column,
        condition: bp.condition,
        hitCondition: bp.hitCondition,
        logMessage: bp.logMessage
      })),
      sourceModified: false
    });
    await this.ensureConfigurationDone();
    return response.breakpoints ?? [];
  }

  async ensureConfigurationDone(): Promise<void> {
    if (this.configurationDone) return;
    try {
      await this.client.request("configurationDone", {}, 5000);
    } catch {
      // Some adapters do not require or support configurationDone in attach flows.
    }
    this.configurationDone = true;
    if (this.startRequestPromise) {
      try {
        await withTimeout(
          this.startRequestPromise,
          5000,
          () =>
            new BreakPilotError(ErrorCodes.TOOL_FAILED, "Timed out waiting for start request response.", {
              sessionId: this.sessionId
            })
        );
      } catch {
        // Some adapters, including debugpy in launch mode, can delay or omit the
        // start response after configurationDone even though the debuggee is live.
        // Keep the session usable and let later DAP requests surface real failures.
      }
    }
  }

  async #start(command: "launch" | "attach", args: AnyRecord): Promise<AnyRecord> {
    const startRequest = this.client.request(command, args, args.timeoutMs ?? 60000);
    this.startRequestPromise = startRequest;

    // Wrap the start request so its outcome can be inspected without an
    // unhandled rejection, and so a *late* failure is recorded on the session
    // for downstream operations (waitForBreakpoint, continue, ...) to fail fast
    // instead of hanging.
    const tracked = startRequest.then(
      (value) => ({ outcome: "resolved" as const, value }),
      (error) => ({ outcome: "rejected" as const, error: error as Error })
    );
    void tracked.then((result) => {
      if (result.outcome === "rejected") this.startError = result.error;
    });

    const initialized = this.#waitForInitialized(args.initializedTimeoutMs ?? 15000).then(
      () => ({ outcome: "initialized" as const })
    );

    const winner = await Promise.race([tracked, initialized]);
    if (winner.outcome === "resolved") return winner.value;
    if (winner.outcome === "rejected") throw winner.error;

    // The `initialized` event won the race. Some adapters (e.g. debugpy in
    // launch mode) legitimately delay or omit the start RESPONSE even though the
    // debuggee is live, so we proceed rather than block on it. However, an
    // *error* response (e.g. the Java bridge rejecting a launch with no
    // mainClass) must not be masked as success: give the start request a short
    // grace window to surface such an error before reporting the session ready.
    const graceMs = (args.startGraceMs as number | undefined) ?? 750;
    const settled = await Promise.race([
      tracked,
      new Promise<{ outcome: "pending" }>((resolve) =>
        setTimeout(() => resolve({ outcome: "pending" }), graceMs)
      )
    ]);
    if (settled.outcome === "rejected") throw settled.error;
    if (settled.outcome === "resolved") return settled.value;
    return { initialized: true };
  }

  async #waitForInitialized(timeoutMs: number): Promise<void> {
    if (this.initialized) return;
    const deferred = createDeferred<void>();
    this.initializedWaiters.push(deferred);
    return withTimeout(
      deferred.promise,
      timeoutMs,
      () =>
        new BreakPilotError(ErrorCodes.TOOL_FAILED, "Timed out waiting for initialized event.", {
          sessionId: this.sessionId,
          timeoutMs
        })
    );
  }

  async waitForBreakpoint(timeoutMs = 30000): Promise<StoppedEvent> {
    const queued = this.#takeQueuedStopped();
    if (queued) return queued;

    // If launch/attach failed (e.g. the adapter rejected the start request after
    // the `initialized` race resolved), surface that error instead of blocking
    // until the timeout — there will never be a stopped event.
    if (this.startError) throw this.startError;

    const deferred = createDeferred<StoppedEvent>();
    this.stoppedWaiters.push(deferred);
    try {
      return await withTimeout(
        deferred.promise,
        timeoutMs,
        () =>
          new BreakPilotError(ErrorCodes.BREAKPOINT_TIMEOUT, "Timed out waiting for breakpoint hit.", {
            sessionId: this.sessionId,
            timeoutMs
          })
      );
    } catch (error) {
      this.#removeStoppedWaiter(deferred);
      const stopped = this.#takeQueuedStopped();
      if (stopped) return stopped;
      if (this.startError) throw this.startError;
      throw error;
    }
  }

  async threads(): Promise<AnyRecord[]> {
    const response = await this.client.request("threads", {});
    return response.threads ?? [];
  }

  async stackTrace(
    threadId: number | null = this.threadId,
    levels = 20
  ): Promise<{ threadId: number | null; stackFrames: DapStackFrame[]; totalFrames?: number }> {
    if (!threadId) {
      const threads = await this.threads();
      threadId = threads[0]?.id;
    }
    if (!threadId) return { threadId: null, stackFrames: [] };
    const response = await this.client.request("stackTrace", {
      threadId,
      startFrame: 0,
      levels
    });
    return {
      threadId,
      stackFrames: response.stackFrames ?? [],
      totalFrames: response.totalFrames
    };
  }

  async scopes(frameId: number): Promise<DapScope[]> {
    const response = await this.client.request("scopes", { frameId });
    return response.scopes ?? [];
  }

  async variables(
    variablesReference: number,
    options: { start?: number; count?: number; filter?: string } = {}
  ): Promise<DapVariable[]> {
    const response = await this.client.request("variables", {
      variablesReference,
      start: options.start,
      count: options.count,
      filter: options.filter
    });
    return response.variables ?? [];
  }

  async setVariable(variablesReference: number, name: string, value: string): Promise<AnyRecord> {
    return this.client.request("setVariable", {
      variablesReference,
      name,
      value
    });
  }

  async evaluate(expression: string, options: AnyRecord = {}): Promise<AnyRecord> {
    return this.client.request(
      "evaluate",
      {
        expression,
        frameId: options.frameId,
        context: options.context ?? "watch",
        format: options.format
      },
      options.timeoutMs ?? 1000
    );
  }

  async pause(threadId: number | null = this.threadId): Promise<AnyRecord> {
    return this.client.request("pause", threadId ? { threadId } : {});
  }

  async continue(threadId: number | null = this.threadId): Promise<AnyRecord> {
    let resolved = threadId;
    if (!resolved) {
      // No thread has been selected yet (e.g. attach to a VM suspended at
      // startup before any stopped event). Fall back to the first live thread
      // so the runtime can be resumed.
      const threads = await this.threads();
      resolved = (threads[0]?.id as number | undefined) ?? null;
    }
    if (!resolved) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "threadId is required for continue.");
    }
    this.threadId = resolved;
    return this.client.request("continue", { threadId: resolved });
  }

  async stepOver(threadId: number | null = this.threadId): Promise<AnyRecord> {
    return this.client.request("next", { threadId });
  }

  async stepInto(threadId: number | null = this.threadId): Promise<AnyRecord> {
    return this.client.request("stepIn", { threadId });
  }

  async stepOut(threadId: number | null = this.threadId): Promise<AnyRecord> {
    return this.client.request("stepOut", { threadId });
  }

  async disconnect({
    terminateDebuggee = false,
    restart = false
  }: { terminateDebuggee?: boolean; restart?: boolean } = {}): Promise<AnyRecord> {
    try {
      const response = await this.client.request("disconnect", { terminateDebuggee, restart }, 5000);
      return { acknowledged: true, ...response };
    } catch (error) {
      if (
        error instanceof BreakPilotError &&
        (error.details?.command === "disconnect" || error.code === ErrorCodes.TARGET_PROCESS_EXITED)
      ) {
        return {
          acknowledged: false,
          message: error.message,
          details: error.details
        };
      }
      throw error;
    } finally {
      this.client.close();
    }
  }

  #takeQueuedStopped(): StoppedEvent | null {
    return this.stoppedQueue.shift() ?? null;
  }

  #removeStoppedWaiter(waiter: ReturnType<typeof createDeferred<StoppedEvent>>): void {
    const index = this.stoppedWaiters.indexOf(waiter);
    if (index >= 0) this.stoppedWaiters.splice(index, 1);
  }
}
