import path from "node:path";
import type {
  DapBreakpoint,
  DapEventMessage,
  DapGotoTarget,
  DapStackFrame,
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
  type TemporaryBreakpointTransaction
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

  async runToLine(args: RunToLineArgs): Promise<RunToLineResult> {
    const requestedPosition = this.#requestedPosition(args);
    this.#assertPaused();
    const threadId = await this.#resolveThreadId(args.threadId);

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

  async getCallStack(threadId: number | null = this.dap.threadId, limit = 20): Promise<AnyRecord> {
    return this.dap.stackTrace(threadId, limit);
  }

  async getRuntimeSnapshot(args: AnyRecord, limits: Required<VariableLimits>): Promise<RuntimeSnapshot> {
    return new RuntimeSnapshotBuilder(this.dap, limits).build(args);
  }

  async inspectVariable(
    args: AnyRecord,
    limits: Required<VariableLimits>
  ): Promise<InspectVariableResult> {
    const variablesReference = Number(args.variablesReference);
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
    const parentRef = Number(args.parentRef ?? 0);
    const name = String(args.name ?? "");
    const value = String(args.newValue ?? "");
    if (!parentRef || !name) {
      throw new Error("DAP setVariable requires parentRef and name.");
    }
    return this.dap.setVariable(parentRef, name, value);
  }

  async evaluate(expression: string, options: AnyRecord = {}): Promise<AnyRecord> {
    let frameId = options.frameId;
    if (!frameId) {
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
    if (!session || session.provider !== this || session.dap !== this.dap || session.providerKind !== "dap") return null;
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
    this.dap.markRunning();
    const boundary = this.dap.captureStopBoundary();
    try {
      // `waitForStopOrTerminationAfter` rechecks its causal boundary, so a
      // stopped event delivered synchronously before `goto` resolves still
      // counts while any stale queued stop cannot.
      await this.dap.goto(threadId, target.id);
      const outcome = await this.dap.waitForStopOrTerminationAfter(boundary, timeoutMs ?? 30000);
      return this.#resultFromOutcome(outcome, {
        requestedPosition,
        target: resolvedPosition,
        threadId,
        cleanedUp: true,
        ...(targetWasResolved ? { resolvedPosition } : {}),
        warnings: targetWasResolved
          ? ["Requested source position was resolved to the nearest executable target."]
          : []
      });
    } catch (error) {
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
    try {
      transaction = await this.options.breakpointReconciler!.withTemporaryBreakpoint(
        session,
        requestedPosition,
        async (context: TemporaryBreakpointExecutionContext): Promise<FreshStopResult> => {
          this.dap.markRunning();
          await this.dap.continue(threadId);
          return this.dap.waitForStopOrTerminationAfter(context.boundary, timeoutMs ?? 30000);
        }
      );
    } catch (error) {
      if (this.#isTimeout(error)) return this.#timeoutResult(requestedPosition, true);
      throw error;
    }

    const temporaryPosition = this.#breakpointPosition(transaction.temporaryBreakpoint);
    const resolved = this.#targetDiffersFromRequest(requestedPosition, temporaryPosition)
      ? temporaryPosition
      : undefined;
    return this.#resultFromOutcome(transaction.result, {
      requestedPosition,
      target: temporaryPosition,
      threadId,
      cleanedUp: transaction.cleanedUp,
      temporaryBreakpointId: transaction.temporaryBreakpoint.id,
      ...(resolved ? { resolvedPosition: resolved } : {}),
      warnings: resolved
        ? ["Temporary breakpoint was resolved to a different executable source position."]
        : []
    });
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
    options: {
      requestedPosition: RunToLineRequestedPosition;
      target: RunToLineTarget;
      threadId: number;
      cleanedUp: boolean;
      resolvedPosition?: RunToLineRequestedPosition;
      temporaryBreakpointId?: string;
      warnings: string[];
    }
  ): Promise<RunToLineResult> {
    if ("terminated" in outcome) {
      return {
        status: "stopped",
        targetReached: false,
        requestedPosition: options.requestedPosition,
        cleanedUp: options.cleanedUp,
        ...(options.resolvedPosition ? { resolvedPosition: options.resolvedPosition } : {}),
        ...(options.temporaryBreakpointId ? { temporaryBreakpointId: options.temporaryBreakpointId } : {}),
        message: "The debug session terminated before a fresh run-to-line stop was observed.",
        warnings: [...options.warnings]
      };
    }

    const stoppedThread = typeof outcome.threadId === "number" && Number.isSafeInteger(outcome.threadId)
      ? outcome.threadId
      : options.threadId;
    const evidence = await this.#freshStopEvidence(stoppedThread);
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
}
