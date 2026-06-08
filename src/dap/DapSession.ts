import { EventEmitter } from "node:events";
import type {
  AnyRecord,
  BreakpointRecord,
  DapBreakpoint,
  DapScope,
  DapStackFrame,
  DapVariable,
  DebugLanguage,
  StoppedEvent
} from "../types.ts";
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
    this.startRequestPromise = this.client.request(command, args, args.timeoutMs ?? 60000);
    this.startRequestPromise.catch(() => {
      // The request is observed by callers through the race below or configurationDone.
    });
    return Promise.race([
      this.startRequestPromise,
      this.#waitForInitialized(args.initializedTimeoutMs ?? 15000).then(() => ({ initialized: true }))
    ]);
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

  async continue(threadId: number | null = this.threadId): Promise<AnyRecord> {
    if (!threadId) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "threadId is required for continue.");
    }
    return this.client.request("continue", { threadId });
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
