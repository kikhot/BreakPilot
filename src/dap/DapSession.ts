import { EventEmitter } from "node:events";
import type {
  DapBreakpoint,
  DapEventMessage,
  DapGotoTarget,
  DapGotoTargetsResponse,
  DapScope,
  DapStackFrame,
  DapVariable,
  FreshStopBoundary,
  FreshStopResult,
  StoppedEvent
} from "../types/dap.ts";
import type { DebugLanguage } from "../types/debug.ts";
import type { AnyRecord } from "../types/json.ts";
import type { BreakpointRecord } from "../types/sessions.ts";
import { DapClient } from "./DapClient.ts";
import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";
import { createDeferred, withTimeout } from "../utils/timeout.ts";
import { toDapSource } from "../utils/path.ts";

type ObservedStop = {
  sequence: number;
  event: StoppedEvent;
};

type FreshStopWaiter = {
  boundary: FreshStopBoundary;
  deferred: ReturnType<typeof createDeferred<FreshStopResult>>;
  timer: ReturnType<typeof setTimeout> | null;
};

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
  freshStopWaiters: FreshStopWaiter[];
  stopSequence: number;
  readonly #runtimeEventListeners: Set<(event: DapEventMessage) => void>;
  readonly #clientListeners: Array<[event: string, listener: (...args: any[]) => void]>;
  #runtimeEventSourceAttached: boolean;
  #startGraceTimer: ReturnType<typeof setTimeout> | null;
  #disposed: boolean;
  #terminalSequence: number;
  #latestStopped: ObservedStop | null;
  #paused: boolean;
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
    this.freshStopWaiters = [];
    this.stopSequence = 0;
    this.#runtimeEventListeners = new Set();
    this.#clientListeners = [];
    this.#runtimeEventSourceAttached = false;
    this.#startGraceTimer = null;
    this.#disposed = false;
    this.#terminalSequence = 0;
    this.#latestStopped = null;
    this.#paused = false;
    this.threadId = null;
    this.terminated = false;
  }

  /** Runtime truth derived from DAP events, never from a request response. */
  get isPaused(): boolean {
    return this.#paused;
  }

  get isRunning(): boolean {
    return !this.#paused && !this.terminated && !this.#disposed;
  }

  /**
   * Called immediately before an execution request. A synchronous `stopped`
   * event that arrives before that request resolves will correctly overwrite it.
   */
  markRunning(): void {
    this.#paused = false;
  }

  startClient(): void {
    this.#listenToClient("event", (event: DapEventMessage) => {
      for (const listener of [...this.#runtimeEventListeners]) {
        try {
          listener(structuredClone(event));
        } catch {
          // Runtime observation must never interfere with the named DAP event
          // handlers below, especially stopped-queue and waiter delivery.
        }
      }
    });
    this.#listenToClient("initialized", () => {
      this.initialized = true;
      for (const waiter of this.initializedWaiters.splice(0)) waiter.resolve();
      this.emit("initialized");
    });
    this.#listenToClient("stopped", (body: StoppedEvent) => {
      this.#paused = true;
      this.threadId = body.threadId ?? this.threadId;
      const event = { sessionId: this.sessionId, ...body };
      this.stopSequence += 1;
      const observed: ObservedStop = { sequence: this.stopSequence, event };
      this.#latestStopped = observed;
      const waiter = this.stoppedWaiters.shift();
      if (waiter) waiter.resolve(event);
      else this.stoppedQueue.push(event);
      this.#resolveFreshStopWaiters(observed);
      this.emit("stopped", event);
    });
    this.#listenToClient("continued", (body: AnyRecord) => {
      this.#paused = false;
      this.emit("continued", body);
    });
    this.#listenToClient("terminated", (body: AnyRecord) => {
      this.#paused = false;
      this.terminated = true;
      this.#runtimeEventSourceAttached = false;
      this.#terminalSequence += 1;
      this.#resolveFreshTerminalWaiters(this.#terminalSequence);
      this.emit("terminated", body);
    });
    this.#listenToClient("exited", (body: AnyRecord) => {
      this.#paused = false;
      this.terminated = true;
      this.#runtimeEventSourceAttached = false;
      this.#terminalSequence += 1;
      this.#resolveFreshTerminalWaiters(this.#terminalSequence);
      this.emit("exited", body);
    });
    this.#listenToClient("exit", () => {
      this.#paused = false;
      this.terminated = true;
      this.#runtimeEventSourceAttached = false;
      this.#terminalSequence += 1;
      this.#resolveFreshTerminalWaiters(this.#terminalSequence);
      this.emit("transportExit");
    });
    this.#listenToClient("adapterError", () => {
      this.#paused = false;
      this.terminated = true;
      this.#runtimeEventSourceAttached = false;
      this.#terminalSequence += 1;
      this.#resolveFreshTerminalWaiters(this.#terminalSequence);
      this.emit("adapterError");
    });
    this.#runtimeEventSourceAttached = true;
    try {
      this.client.start();
    } catch (error) {
      this.#runtimeEventSourceAttached = false;
      this.#detachClientListeners();
      this.#runtimeEventListeners.clear();
      throw error;
    }
  }

  onRuntimeEvent(listener: (event: DapEventMessage) => void): () => void {
    this.#runtimeEventListeners.add(listener);
    return () => {
      this.#runtimeEventListeners.delete(listener);
    };
  }

  hasRuntimeEventSource(): boolean {
    return this.#runtimeEventSourceAttached;
  }

  disposeClient(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#paused = false;
    this.#runtimeEventSourceAttached = false;
    if (this.#startGraceTimer) {
      clearTimeout(this.#startGraceTimer);
      this.#startGraceTimer = null;
    }
    const error = this.#sessionEndedError();
    for (const waiter of this.initializedWaiters.splice(0)) waiter.reject(error);
    for (const waiter of this.stoppedWaiters.splice(0)) waiter.reject(error);
    for (const waiter of [...this.freshStopWaiters]) this.#rejectFreshStopWaiter(waiter, error);
    this.stoppedQueue = [];
    this.#latestStopped = null;
    this.startRequestPromise = null;
    this.#detachClientListeners();
    this.#runtimeEventListeners.clear();
    try {
      this.client.close();
    } catch {
      // Cleanup must release manager state even if a failed transport cannot close.
    }
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
    let reportedReady = false;

    // Wrap the start request so its outcome can be inspected without an
    // unhandled rejection, and so a *late* failure is recorded on the session
    // for downstream operations (waitForBreakpoint, continue, ...) to fail fast
    // instead of hanging.
    const tracked = startRequest.then(
      (value) => ({ outcome: "resolved" as const, value }),
      (error) => ({ outcome: "rejected" as const, error: error as Error })
    );
    void tracked.then((result) => {
      if (result.outcome !== "rejected") return;
      this.startError = result.error;
      if (reportedReady && !this.#disposed) this.emit("startFailed");
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
    const grace = new Promise<{ outcome: "pending" }>((resolve) => {
      this.#startGraceTimer = setTimeout(() => {
        this.#startGraceTimer = null;
        resolve({ outcome: "pending" });
      }, graceMs);
    });
    const settled = await Promise.race([tracked, grace]);
    if (this.#startGraceTimer) {
      clearTimeout(this.#startGraceTimer);
      this.#startGraceTimer = null;
    }
    if (settled.outcome === "rejected") throw settled.error;
    if (settled.outcome === "resolved") return settled.value;
    reportedReady = true;
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

  captureStopBoundary(): FreshStopBoundary {
    return {
      stopSequence: this.stopSequence,
      terminalSequence: this.#terminalSequence
    };
  }

  async waitForStopOrTerminationAfter(
    boundary: FreshStopBoundary,
    timeoutMs = 30000
  ): Promise<FreshStopResult> {
    const captured: FreshStopBoundary = {
      stopSequence: boundary.stopSequence,
      terminalSequence: boundary.terminalSequence
    };
    const alreadyObserved = this.#freshOutcomeAfter(captured);
    if (alreadyObserved) return alreadyObserved;
    if (this.#disposed) throw this.#sessionEndedError();

    const deferred = createDeferred<FreshStopResult>();
    const waiter: FreshStopWaiter = {
      boundary: captured,
      deferred,
      timer: null
    };
    this.freshStopWaiters.push(waiter);
    waiter.timer = setTimeout(() => {
      this.#rejectFreshStopWaiter(
        waiter,
        new BreakPilotError(ErrorCodes.BREAKPOINT_TIMEOUT, "Timed out waiting for a fresh debug stop.", {
          sessionId: this.sessionId,
          timeoutMs,
          boundary: captured
        })
      );
    }, timeoutMs);

    // This second read closes the causal registration window without touching
    // the ordinary stopped FIFO. JavaScript normally cannot interleave an
    // event here, but preserving it makes the boundary safe if future client
    // hooks gain synchronous delivery during registration.
    const raced = this.#freshOutcomeAfter(captured);
    if (raced) this.#resolveFreshStopWaiter(waiter, raced);
    return deferred.promise;
  }

  async gotoTargets(filePath: string, line: number, column?: number): Promise<DapGotoTarget[]> {
    const response = await this.client.request<DapGotoTargetsResponse>("gotoTargets", {
      source: { path: filePath },
      line,
      ...(column === undefined ? {} : { column })
    });
    return response.targets ?? [];
  }

  async goto(threadId: number, targetId: number): Promise<void> {
    await this.client.request("goto", { threadId, targetId });
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
      this.disposeClient();
    }
  }

  #freshOutcomeAfter(boundary: FreshStopBoundary): FreshStopResult | null {
    if (this.#terminalSequence > boundary.terminalSequence) return { terminated: true };
    const latest = this.#latestStopped;
    if (latest && latest.sequence > boundary.stopSequence) return latest.event;
    return null;
  }

  #resolveFreshStopWaiters(observed: ObservedStop): void {
    for (const waiter of [...this.freshStopWaiters]) {
      if (observed.sequence > waiter.boundary.stopSequence) {
        this.#resolveFreshStopWaiter(waiter, observed.event);
      }
    }
  }

  #resolveFreshTerminalWaiters(terminalSequence: number): void {
    for (const waiter of [...this.freshStopWaiters]) {
      if (terminalSequence > waiter.boundary.terminalSequence) {
        this.#resolveFreshStopWaiter(waiter, { terminated: true });
      }
    }
  }

  #resolveFreshStopWaiter(waiter: FreshStopWaiter, result: FreshStopResult): void {
    if (!this.#removeFreshStopWaiter(waiter)) return;
    waiter.deferred.resolve(result);
  }

  #rejectFreshStopWaiter(waiter: FreshStopWaiter, error: Error): void {
    if (!this.#removeFreshStopWaiter(waiter)) return;
    waiter.deferred.reject(error);
  }

  #removeFreshStopWaiter(waiter: FreshStopWaiter): boolean {
    const index = this.freshStopWaiters.indexOf(waiter);
    if (index < 0) return false;
    this.freshStopWaiters.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.timer = null;
    return true;
  }

  #sessionEndedError(): Error {
    return this.startError ?? new BreakPilotError(
      ErrorCodes.TARGET_PROCESS_EXITED,
      "Debug session ended.",
      { sessionId: this.sessionId }
    );
  }

  #listenToClient(event: string, listener: (...args: any[]) => void): void {
    this.#clientListeners.push([event, listener]);
    this.client.on(event, listener);
  }

  #detachClientListeners(): void {
    for (const [event, listener] of this.#clientListeners.splice(0)) {
      this.client.off(event, listener);
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
