import path from "node:path";
import type {
  DapBreakpoint,
  DapEventMessage,
  DapGotoTarget,
  DapStackFrame,
  FreshStopBoundary,
  FreshStopResult,
  StoppedEvent
} from "../../types/dap.ts";
import type { DebugLanguage, RuntimeStepKind } from "../../types/debug.ts";
import type { InspectVariableResult, RuntimeSnapshot, VariableLimits } from "../../types/inspection.ts";
import type { AnyRecord } from "../../types/json.ts";
import type {
  BreakpointRecord,
  DebugSessionRecord,
  DrainEventsArgs,
  RunToLineArgs,
  RunToLineRequestedPosition,
  RunToLineResult,
  RuntimeDebugProvider,
  RuntimeEvent,
  RuntimeEventKind,
  RuntimeEventPage,
  RuntimeStackRequest,
  RuntimeStackResult,
  ThreadId
} from "../../types/sessions.ts";
import { DapSession } from "../../dap/DapSession.ts";
import { RuntimeSnapshotBuilder } from "../../inspection/SnapshotBuilder.ts";
import { VariableSerializer } from "../../inspection/VariableSerializer.ts";
import type { RuntimeProviderCapabilities } from "../../types/capabilities.ts";
import { dapProviderCapabilities } from "../ProviderCapabilities.ts";
import { RuntimeEventBuffer, normalizeRuntimeEventMetadata } from "../RuntimeEventBuffer.ts";
import {
  BreakpointReconciler,
  type TemporaryBreakpointExecutionContext,
  type TemporaryBreakpointTransaction,
  type TemporaryBreakpointTransactionOptions
} from "../../sessions/BreakpointReconciler.ts";
import { BreakPilotError, ErrorCodes } from "../../utils/errors.ts";
import { assertInsideWorkspace } from "../../utils/path.ts";

const dapRuntimeEventKinds = new Set<RuntimeEventKind>([
  "continued",
  "stopped",
  "output",
  "thread",
  "process",
  "terminated"
]);

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function normalizedThreadId(value: unknown): ThreadId | undefined {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedDapMetadata(kind: RuntimeEventKind, body: unknown): AnyRecord | undefined {
  const data = normalizeRuntimeEventMetadata(body) ?? {};
  if (kind === "process" && data.processId === undefined) {
    const systemProcessId = ownValue(body, "systemProcessId");
    const alias = normalizeRuntimeEventMetadata({ processId: systemProcessId });
    if (alias?.processId !== undefined) data.processId = alias.processId;
  }
  return Object.keys(data).length > 0 ? data : undefined;
}

function normalizeDapRuntimeEvent(
  event: DapEventMessage
): Omit<RuntimeEvent, "sequence" | "timestamp" | "sessionId"> | null {
  const eventName = ownValue(event, "event");
  if (typeof eventName !== "string" || !dapRuntimeEventKinds.has(eventName as RuntimeEventKind)) return null;

  const kind = eventName as RuntimeEventKind;
  const body = ownValue(event, "body");
  const normalized: Omit<RuntimeEvent, "sequence" | "timestamp" | "sessionId"> = { kind };
  const threadId = normalizedThreadId(ownValue(body, "threadId"));
  if (threadId !== undefined) normalized.threadId = threadId;
  if (kind === "output") {
    const message = ownValue(body, "output");
    const category = ownValue(body, "category");
    if (typeof message === "string") normalized.message = message;
    if (typeof category === "string") normalized.category = category;
  }
  const data = normalizedDapMetadata(kind, body);
  if (data !== undefined) normalized.data = data;
  return normalized;
}

export interface DapRuntimeProviderOptions {
  /** Shared manager state; required before a DAP fallback may be advertised. */
  breakpointReconciler?: BreakpointReconciler;
  /** Resolves the exact live record managed by DebugSessionManager. */
  getSession?: () => DebugSessionRecord | null | undefined;
  /** Manager-injected policy-aware workspace validation. */
  assertWorkspacePath?: (filePath: string) => string;
}

type StopEvidence = {
  position?: { filePath: string | number | null; line: number | null; column?: number };
  frame?: AnyRecord;
  warning?: string;
};

type RunToLineTarget = RunToLineRequestedPosition;

type RunToLineOutcomeOptions = {
  requestedPosition: RunToLineRequestedPosition;
  target: RunToLineTarget;
  threadId: number;
  cleanedUp: boolean;
  resolvedPosition?: RunToLineRequestedPosition;
  temporaryBreakpointId?: string;
  warnings: string[];
};

type RunToLineTerminalOptions = Pick<
  RunToLineOutcomeOptions,
  "requestedPosition" | "cleanedUp" | "resolvedPosition" | "temporaryBreakpointId" | "warnings"
>;

export class DapRuntimeProvider implements RuntimeDebugProvider {
  kind = "dap";
  dap: DapSession;
  events: RuntimeEventBuffer;
  options: DapRuntimeProviderOptions;
  #unsubscribeRuntimeEvents: (() => void) | null = null;

  constructor(
    dap: DapSession,
    events = new RuntimeEventBuffer(dap.sessionId),
    options: DapRuntimeProviderOptions = {}
  ) {
    this.dap = dap;
    this.events = events;
    this.options = options;
    if (typeof dap.onRuntimeEvent === "function") {
      this.#unsubscribeRuntimeEvents = dap.onRuntimeEvent((event) => {
        const normalized = normalizeDapRuntimeEvent(event);
        if (normalized) this.events.append(normalized);
      });
    }
  }

  get sessionId(): string {
    return this.dap.sessionId;
  }

  get language(): DebugLanguage {
    return this.dap.language;
  }

  get workspaceRoot(): string {
    return this.dap.workspaceRoot;
  }

  get capabilities(): RuntimeProviderCapabilities {
    const capabilities = dapProviderCapabilities(this.dap.capabilities, {
      nativeRunToLineAvailable: this.#hasNativeRunToLine(),
      fallbackRunToLineAvailable: this.#fallbackSession() !== null
    });
    if (
      this.#unsubscribeRuntimeEvents &&
      typeof this.dap.hasRuntimeEventSource === "function" &&
      this.dap.hasRuntimeEventSource()
    ) {
      capabilities.eventDrain = "native";
    }
    return capabilities;
  }

  get threadId(): number | null {
    return this.dap.threadId;
  }

  async setBreakpoints(filePath: string, breakpoints: BreakpointRecord[]): Promise<DapBreakpoint[]> {
    return this.dap.setBreakpoints(filePath, breakpoints);
  }

  async waitForBreakpoint(timeoutMs = 30000): Promise<StoppedEvent> {
    return this.dap.waitForBreakpoint(timeoutMs);
  }

  captureStopBoundary(): FreshStopBoundary {
    return this.dap.captureStopBoundary();
  }

  async runToLine(args: RunToLineArgs): Promise<RunToLineResult> {
    const requestedPosition = this.#requestedPosition(args);
    this.#assertPaused();
    const threadId = await this.#resolveThreadId(args.threadId);
    // Thread discovery may have yielded while another controller resumed the
    // debuggee. No run-to-line request is safe until pause is reconfirmed.
    this.#assertPaused();

    if (this.#hasNativeRunToLine()) {
      return this.#runToLineNative(requestedPosition, threadId, args.timeoutMs);
    }

    const session = this.#fallbackSession();
    if (!session || !this.options.breakpointReconciler) {
      throw new BreakPilotError(
        ErrorCodes.UNSUPPORTED_CAPABILITY,
        "Runtime provider does not support safe run-to-line.",
        {
          sessionId: this.sessionId,
          providerKind: this.kind,
          capability: "runToLine"
        }
      );
    }
    return this.#runToLineFallback(session, requestedPosition, threadId, args.timeoutMs);
  }

  async drainEvents(args?: DrainEventsArgs): Promise<RuntimeEventPage> {
    return this.events.read(args);
  }

  disposeRuntimeEvents(): void {
    this.#unsubscribeRuntimeEvents?.();
    this.#unsubscribeRuntimeEvents = null;
  }

  async listThreads(): Promise<AnyRecord[]> {
    return this.dap.threads();
  }

  async getCallStack(
    threadId: ThreadId | null | undefined = this.dap.threadId,
    request: RuntimeStackRequest = { offset: 0, limit: 20 }
  ): Promise<RuntimeStackResult> {
    if (typeof threadId === "string") {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "DAP thread ids must be numeric.", { threadId });
    }
    const supportsDelayedStackTraceLoading = this.dap.capabilities?.supportsDelayedStackTraceLoading === true;
    const stack = supportsDelayedStackTraceLoading
      ? await this.dap.stackTrace(threadId, request.limit, request.offset)
      : await this.dap.stackTraceFull(threadId);
    const rawFrames = stack.stackFrames;
    const stackFrames = supportsDelayedStackTraceLoading
      ? rawFrames.slice(0, request.limit)
      : rawFrames.slice(request.offset, request.offset + request.limit);
    const totalFrames = Number.isSafeInteger(stack.totalFrames) && Number(stack.totalFrames) >= 0
      ? Number(stack.totalFrames)
      : undefined;
    const providerPage = {
      threadId: stack.threadId,
      stackFrames,
      offset: request.offset,
      ...(totalFrames === undefined ? {} : { totalFrames }),
      completeness: totalFrames === undefined ? "unknown" as const : "partial" as const,
      partial: true,
      truncationReason: "provider" as const
    };
    if (totalFrames === undefined || request.offset > totalFrames) return providerPage;

    if (supportsDelayedStackTraceLoading) {
      const expectedCount = Math.min(request.limit, totalFrames - request.offset);
      if (rawFrames.length !== expectedCount) return providerPage;
    } else if (rawFrames.length !== totalFrames) {
      return providerPage;
    }

    const nextOffset = request.offset + stackFrames.length;
    if (nextOffset === totalFrames) {
      return {
        threadId: stack.threadId,
        stackFrames,
        offset: request.offset,
        totalFrames,
        completeness: "complete",
        partial: false
      };
    }
    if (
      request.limit > 0 &&
      stackFrames.length === request.limit &&
      nextOffset > request.offset &&
      nextOffset < totalFrames
    ) {
      return {
        threadId: stack.threadId,
        stackFrames,
        offset: request.offset,
        totalFrames,
        completeness: "partial",
        partial: true,
        nextOffset,
        truncationReason: "limit"
      };
    }
    return providerPage;
  }

  async getRuntimeSnapshot(args: AnyRecord, limits: Required<VariableLimits>): Promise<RuntimeSnapshot> {
    return new RuntimeSnapshotBuilder(this.dap, limits).build(args);
  }

  async inspectVariable(
    args: AnyRecord,
    limits: Required<VariableLimits>
  ): Promise<InspectVariableResult> {
    const variablesReference = this.#dapVariableReference(args.variablesReference);
    const variables = await this.dap.variables(variablesReference, {
      start: args.start ?? 0,
      count: args.count ?? limits.maxItems
    });
    const serializer = new VariableSerializer(this.dap, limits, {
      objectFields: args.objectFields ?? "deep"
    });
    const serialized = await serializer.serializeVariables(variables);
    return {
      variablesReference,
      start: args.start ?? 0,
      count: args.count ?? limits.maxItems,
      variables: serialized,
      limits: {
        maxDepth: limits.maxDepth,
        maxItems: limits.maxItems,
        maxStringLength: limits.maxStringLength
      }
    };
  }

  async setVariable(args: AnyRecord): Promise<AnyRecord> {
    const parentRef = this.#dapVariableReference(args.parentRef);
    const name = String(args.name ?? "");
    const value = String(args.newValue ?? "");
    if (!name) {
      throw new Error("DAP setVariable requires parentRef and name.");
    }
    return this.dap.setVariable(parentRef, name, value);
  }

  async evaluate(expression: string, options: AnyRecord = {}): Promise<AnyRecord> {
    let frameId = options.frameId;
    if (frameId === undefined) {
      const stack = await this.dap.stackTrace(options.threadId ?? this.dap.threadId, 1);
      frameId = stack.stackFrames[0]?.id;
    }
    return this.dap.evaluate(expression, {
      frameId,
      context: options.context ?? "watch",
      timeoutMs: options.timeoutMs
    });
  }

  async pause(threadId: number | null = this.dap.threadId): Promise<AnyRecord> {
    return this.dap.pause(threadId);
  }

  async continue(threadId: number | null = this.dap.threadId): Promise<AnyRecord> {
    return this.dap.continue(threadId);
  }

  async step(kind: RuntimeStepKind, threadId: number | null = this.dap.threadId): Promise<AnyRecord> {
    if (kind === "into") return this.dap.stepInto(threadId);
    if (kind === "out") return this.dap.stepOut(threadId);
    return this.dap.stepOver(threadId);
  }

  async disconnect(options: { terminateDebuggee?: boolean; restart?: boolean } = {}): Promise<AnyRecord> {
    try {
      return await this.dap.disconnect(options);
    } finally {
      this.disposeRuntimeEvents();
    }
  }

  #dapVariableReference(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "DAP variable references must be positive integers.", {
        variablesReference: value
      });
    }
    return value;
  }

  #hasNativeRunToLine(): boolean {
    return this.dap.capabilities.supportsGotoTargetsRequest === true &&
      typeof this.dap.gotoTargets === "function" &&
      typeof this.dap.goto === "function" &&
      typeof this.dap.captureStopBoundary === "function" &&
      typeof this.dap.waitForStopOrTerminationAfter === "function";
  }

  #fallbackSession(): DebugSessionRecord | null {
    if (!this.options.breakpointReconciler || !this.options.getSession) return null;
    const session = this.options.getSession() ?? null;
    if (!session || session.provider !== this || session.sessionId !== this.sessionId) return null;
    if (typeof this.options.breakpointReconciler.withTemporaryBreakpoint !== "function") return null;
    return session;
  }

  #requestedPosition(args: RunToLineArgs): RunToLineRequestedPosition {
    if (typeof args.filePath !== "string" || args.filePath.length === 0) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "run-to-line requires filePath.", {});
    }
    if (!Number.isSafeInteger(args.line) || args.line < 1) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "run-to-line requires a positive integer line.", {
        line: args.line
      });
    }
    if (args.column !== undefined && (!Number.isSafeInteger(args.column) || args.column < 1)) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "run-to-line column must be a positive integer.", {
        column: args.column
      });
    }
    const filePath = this.options.assertWorkspacePath
      ? this.options.assertWorkspacePath(args.filePath)
      : assertInsideWorkspace(this.workspaceRoot, args.filePath);
    return {
      filePath,
      line: args.line,
      ...(args.column === undefined ? {} : { column: args.column })
    };
  }

  #assertPaused(): void {
    if (this.dap.isPaused) return;
    throw new BreakPilotError(
      ErrorCodes.INVALID_ARGUMENT,
      "run-to-line requires a paused debug session.",
      { sessionId: this.sessionId, paused: false, terminated: this.dap.terminated }
    );
  }

  async #resolveThreadId(candidate: RunToLineArgs["threadId"]): Promise<number> {
    if (candidate !== undefined && candidate !== null) {
      if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
        throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "DAP run-to-line requires a numeric threadId.", {
          threadId: candidate
        });
      }
      return candidate;
    }

    const current = this.dap.threadId;
    if (typeof current === "number" && Number.isSafeInteger(current) && current >= 0) return current;
    const threads = await this.dap.threads();
    for (const thread of threads) {
      const id = ownValue(thread, "id");
      if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) return id;
    }
    throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "A numeric DAP threadId is required for run-to-line.", {
      sessionId: this.sessionId
    });
  }

  async #runToLineNative(
    requestedPosition: RunToLineRequestedPosition,
    threadId: number,
    timeoutMs?: number
  ): Promise<RunToLineResult> {
    const targets = await this.dap.gotoTargets(
      requestedPosition.filePath,
      requestedPosition.line,
      requestedPosition.column
    );
    const target = this.#selectGotoTarget(targets, requestedPosition);
    if (!target) {
      throw new BreakPilotError(
        ErrorCodes.UNSUPPORTED_CAPABILITY,
        "The debug adapter reported no executable run-to-line target for this source position.",
        {
          sessionId: this.sessionId,
          capability: "runToLine",
          requestedPosition
        }
      );
    }

    const resolvedPosition = this.#targetPosition(requestedPosition.filePath, target);
    const targetWasResolved = this.#targetDiffersFromRequest(requestedPosition, resolvedPosition);
    const outcomeOptions: RunToLineOutcomeOptions = {
      requestedPosition,
      target: resolvedPosition,
      threadId,
      cleanedUp: true,
      ...(targetWasResolved ? { resolvedPosition } : {}),
      warnings: targetWasResolved
        ? ["Requested source position was resolved to the nearest executable target."]
        : []
    };
    // gotoTargets is observational, but it can await adapter work. Recheck
    // before transitioning state and dispatching the mutating goto request.
    this.#assertPaused();
    this.dap.markRunning();
    const boundary = this.dap.captureStopBoundary();
    try {
      // `waitForStopOrTerminationAfter` rechecks its causal boundary, so a
      // stopped event delivered synchronously before `goto` resolves still
      // counts while any stale queued stop cannot.
      await this.dap.goto(threadId, target.id);
      const outcome = await this.dap.waitForStopOrTerminationAfter(boundary, timeoutMs ?? 30000);
      return this.#resultFromOutcome(outcome, outcomeOptions);
    } catch (error) {
      if (this.dap.terminated) return this.#terminalResult(outcomeOptions);
      return this.#timeoutOrThrow(error, requestedPosition, true, targetWasResolved ? resolvedPosition : undefined);
    }
  }

  async #runToLineFallback(
    session: DebugSessionRecord,
    requestedPosition: RunToLineRequestedPosition,
    threadId: number,
    timeoutMs?: number
  ): Promise<RunToLineResult> {
    let transaction: TemporaryBreakpointTransaction<FreshStopResult>;
    const transactionOptions: TemporaryBreakpointTransactionOptions = {
      assertCanApply: () => this.#assertPaused()
    };
    try {
      transaction = await this.options.breakpointReconciler!.withTemporaryBreakpoint(
        session,
        requestedPosition,
        async (context: TemporaryBreakpointExecutionContext): Promise<FreshStopResult> => {
          // The temporary apply itself may have yielded to a continued event.
          // Do not issue a second continue unless the session is still paused.
          this.#assertPaused();
          this.dap.markRunning();
          await this.dap.continue(threadId);
          return this.dap.waitForStopOrTerminationAfter(context.boundary, timeoutMs ?? 30000);
        },
        transactionOptions
      );
    } catch (error) {
      if (this.dap.terminated && !this.#isCleanupFailure(error)) {
        return this.#terminalResult({
          requestedPosition,
          cleanedUp: true,
          warnings: []
        });
      }
      if (this.#isTimeout(error)) return this.#timeoutResult(requestedPosition, true);
      throw error;
    }

    const temporaryPosition = this.#breakpointPosition(transaction.temporaryBreakpoint);
    const resolved = this.#targetDiffersFromRequest(requestedPosition, temporaryPosition)
      ? temporaryPosition
      : undefined;
    const outcomeOptions: RunToLineOutcomeOptions = {
      requestedPosition,
      target: temporaryPosition,
      threadId,
      cleanedUp: transaction.cleanedUp,
      temporaryBreakpointId: transaction.temporaryBreakpoint.id,
      ...(resolved ? { resolvedPosition: resolved } : {}),
      warnings: resolved
        ? ["Temporary breakpoint was resolved to a different executable source position."]
        : []
    };
    return this.#resultFromOutcome(transaction.result, outcomeOptions);
  }

  #timeoutOrThrow(
    error: unknown,
    requestedPosition: RunToLineRequestedPosition,
    cleanedUp: boolean,
    resolvedPosition?: RunToLineRequestedPosition
  ): RunToLineResult {
    if (this.#isTimeout(error)) return this.#timeoutResult(requestedPosition, cleanedUp, resolvedPosition);
    throw error;
  }

  #timeoutResult(
    requestedPosition: RunToLineRequestedPosition,
    cleanedUp: boolean,
    resolvedPosition?: RunToLineRequestedPosition
  ): RunToLineResult {
    return {
      status: "timeout",
      targetReached: false,
      requestedPosition,
      cleanedUp,
      ...(resolvedPosition ? { resolvedPosition } : {}),
      message: "Timed out before a fresh debug stop was observed.",
      warnings: ["The debug session is still running; no target arrival was inferred."]
    };
  }

  async #resultFromOutcome(
    outcome: FreshStopResult,
    options: RunToLineOutcomeOptions
  ): Promise<RunToLineResult> {
    if ("terminated" in outcome || this.dap.terminated) return this.#terminalResult(options);

    const stoppedThread = typeof outcome.threadId === "number" && Number.isSafeInteger(outcome.threadId)
      ? outcome.threadId
      : options.threadId;
    const evidence = await this.#freshStopEvidence(stoppedThread);
    // A stop waiter can resolve before a terminal event in the same transport
    // turn, or termination can race the stack lookup. Terminal state wins over
    // a stale paused presentation in both cases.
    if (this.dap.terminated) return this.#terminalResult(options);
    const warnings = [...options.warnings];
    if (evidence.warning) warnings.push(evidence.warning);
    const targetReached = evidence.position
      ? this.#positionMatchesTarget(evidence.position, options.target)
      : false;
    if (!targetReached && !evidence.warning) {
      warnings.push("A fresh stop was observed at a different source position; execution was not resumed automatically.");
    }
    return {
      status: "paused",
      targetReached,
      requestedPosition: options.requestedPosition,
      cleanedUp: options.cleanedUp,
      ...(options.resolvedPosition ? { resolvedPosition: options.resolvedPosition } : {}),
      ...(evidence.position ? { position: this.#publicPosition(evidence.position) } : {}),
      ...(evidence.frame ? { frame: evidence.frame } : {}),
      ...(options.temporaryBreakpointId ? { temporaryBreakpointId: options.temporaryBreakpointId } : {}),
      ...(warnings.length > 0 ? { warnings } : {})
    };
  }

  #terminalResult(options: RunToLineTerminalOptions): RunToLineResult {
    return {
      status: "stopped",
      targetReached: false,
      requestedPosition: options.requestedPosition,
      cleanedUp: options.cleanedUp,
      ...(options.resolvedPosition ? { resolvedPosition: options.resolvedPosition } : {}),
      ...(options.temporaryBreakpointId ? { temporaryBreakpointId: options.temporaryBreakpointId } : {}),
      message: "The debug session terminated; no paused run-to-line result is available.",
      ...(options.warnings.length > 0 ? { warnings: [...options.warnings] } : {})
    };
  }

  async #freshStopEvidence(threadId: number): Promise<StopEvidence> {
    try {
      const stack = await this.dap.stackTrace(threadId, 1);
      const frame = stack.stackFrames[0];
      if (!frame) {
        return { warning: "A fresh stop was observed but the adapter provided no stack-frame position evidence." };
      }
      return this.#evidenceFromFrame(frame);
    } catch {
      return { warning: "A fresh stop was observed but its stack-frame position could not be read." };
    }
  }

  #evidenceFromFrame(frame: DapStackFrame): StopEvidence {
    const source = frame.source;
    const rawPath = ownValue(source, "path");
    const filePath = typeof rawPath === "string" || typeof rawPath === "number" ? rawPath : null;
    const line = typeof frame.line === "number" && Number.isFinite(frame.line) ? frame.line : null;
    const column = typeof frame.column === "number" && Number.isFinite(frame.column) ? frame.column : undefined;
    return {
      position: {
        filePath,
        line,
        ...(column === undefined ? {} : { column })
      },
      frame: structuredClone(frame) as AnyRecord
    };
  }

  #selectGotoTarget(targets: DapGotoTarget[], requested: RunToLineRequestedPosition): DapGotoTarget | null {
    const valid = targets.filter((target): target is DapGotoTarget =>
      typeof target === "object" && target !== null &&
      Number.isSafeInteger(target.id) &&
      Number.isSafeInteger(target.line) && target.line >= 1 &&
      (target.column === undefined || (Number.isSafeInteger(target.column) && target.column >= 1))
    );
    if (valid.length === 0) return null;
    const exact = valid.filter((target) =>
      target.line === requested.line &&
      (requested.column === undefined || target.column === requested.column)
    );
    const candidates = exact.length > 0 ? exact : valid;
    return [...candidates].sort((left, right) => {
      const leftLineDistance = Math.abs(left.line - requested.line);
      const rightLineDistance = Math.abs(right.line - requested.line);
      if (leftLineDistance !== rightLineDistance) return leftLineDistance - rightLineDistance;
      const requestedColumn = requested.column ?? 1;
      const leftColumn = left.column ?? 1;
      const rightColumn = right.column ?? 1;
      const leftColumnDistance = Math.abs(leftColumn - requestedColumn);
      const rightColumnDistance = Math.abs(rightColumn - requestedColumn);
      if (leftColumnDistance !== rightColumnDistance) return leftColumnDistance - rightColumnDistance;
      if (left.line !== right.line) return left.line - right.line;
      if (leftColumn !== rightColumn) return leftColumn - rightColumn;
      return left.id - right.id;
    })[0] ?? null;
  }

  #targetPosition(filePath: string, target: DapGotoTarget): RunToLineRequestedPosition {
    return {
      filePath,
      line: target.line,
      ...(target.column === undefined ? {} : { column: target.column })
    };
  }

  #breakpointPosition(breakpoint: BreakpointRecord): RunToLineRequestedPosition {
    return {
      filePath: breakpoint.file,
      line: breakpoint.line,
      ...(breakpoint.column === undefined ? {} : { column: breakpoint.column })
    };
  }

  #sameRequestedPosition(left: RunToLineRequestedPosition, right: RunToLineRequestedPosition): boolean {
    return path.resolve(left.filePath) === path.resolve(right.filePath) &&
      left.line === right.line &&
      left.column === right.column;
  }

  #targetDiffersFromRequest(left: RunToLineRequestedPosition, right: RunToLineRequestedPosition): boolean {
    if (path.resolve(left.filePath) !== path.resolve(right.filePath) || left.line !== right.line) return true;
    return left.column !== undefined && left.column !== right.column;
  }

  #positionMatchesTarget(
    position: { filePath: string | number | null; line: number | null; column?: number },
    target: RunToLineTarget
  ): boolean {
    if (typeof position.filePath !== "string" || position.line === null) return false;
    if (path.resolve(position.filePath) !== path.resolve(target.filePath) || position.line !== target.line) return false;
    return target.column === undefined || position.column === target.column;
  }

  #publicPosition(position: { filePath: string | number | null; line: number | null }): AnyRecord {
    return { filePath: position.filePath, line: position.line };
  }

  #isTimeout(error: unknown): boolean {
    return error instanceof BreakPilotError && error.code === ErrorCodes.BREAKPOINT_TIMEOUT;
  }

  #isCleanupFailure(error: unknown): boolean {
    return error instanceof BreakPilotError && error.code === ErrorCodes.RUN_TO_LINE_CLEANUP_FAILED;
  }
}
