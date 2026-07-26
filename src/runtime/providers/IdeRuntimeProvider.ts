import path from "node:path";
import type {
  BridgeMessage,
  IdeDebugSessionInfo,
} from "../../types/ide.ts";
import type { DapBreakpoint, StoppedEvent } from "../../types/dap.ts";
import type { DebugLanguage, RuntimeStepKind } from "../../types/debug.ts";
import type { InspectVariableResult, RuntimeSnapshot, VariableLimits } from "../../types/inspection.ts";
import type { AnyRecord } from "../../types/json.ts";
import type {
  BreakpointFilter,
  BreakpointRecord,
  RunToLineArgs,
  RunToLineResult,
  RuntimeDebugProvider,
  RuntimeStackRequest,
  RuntimeStackResult,
  ThreadId
} from "../../types/sessions.ts";
import {
  debugControlConfirmationRequest,
  evaluateConfirmationRequest,
  type IdeConfirmationRequest,
  variableInspectionConfirmationRequest
} from "../../ide/ConfirmationPolicy.ts";
import { IdeBridgeServer } from "../../ide/IdeBridgeServer.ts";
import {
  decodeBridgeEvent,
  publicBridgeSnapshot,
  safeBridgeDataRecord,
  type SafeBridgeSnapshot
} from "../../ide/BridgeEventDecoder.ts";
import { IdeMessageTypes } from "../../ide/IdeProtocol.ts";
import { BreakPilotError, ErrorCodes } from "../../utils/errors.ts";
import { makeId } from "../../utils/ids.ts";
import { createDeferred, withTimeout } from "../../utils/timeout.ts";
import type { RuntimeProviderCapabilities } from "../../types/capabilities.ts";
import { ideProviderCapabilities, mergeIdeCapabilityRecords } from "../ProviderCapabilities.ts";

type StopTransitionBoundary = {
  operation: string;
  revision: number;
  capturedStop?: StoppedEvent;
  listener?: (event: unknown) => void;
};

export interface IdeRuntimeProviderOptions {
  sessionId: string;
  bridge: IdeBridgeServer;
  ideSession: IdeDebugSessionInfo;
  workspaceRoot: string;
  language?: DebugLanguage;
  confirmationTimeoutMs?: number;
}

export class IdeRuntimeProvider implements RuntimeDebugProvider {
  kind = "ide";
  sessionId: string;
  bridge: IdeBridgeServer;
  ideClientId: string;
  ideSessionId: string;
  workspaceRoot: string;
  language: DebugLanguage;
  confirmationTimeoutMs: number;
  pendingStopTransition: StopTransitionBoundary | null;

  constructor({
    sessionId,
    bridge,
    ideSession,
    workspaceRoot,
    language = ideSession.language ?? "idea",
    confirmationTimeoutMs = 30000
  }: IdeRuntimeProviderOptions) {
    this.sessionId = sessionId;
    this.bridge = bridge;
    this.ideClientId = ideSession.clientId;
    this.ideSessionId = ideSession.ideSessionId;
    this.workspaceRoot = workspaceRoot;
    this.language = language;
    this.confirmationTimeoutMs = confirmationTimeoutMs;
    this.pendingStopTransition = null;
  }

  get capabilities(): RuntimeProviderCapabilities {
    const client = this.bridge.registry.get(this.ideClientId)?.capabilities ?? {};
    const session = this.#sessionInfo()?.capabilities ?? {};
    return ideProviderCapabilities(mergeIdeCapabilityRecords(client, session));
  }

  get threadId(): number | null {
    return this.#sessionInfo()?.threadId ?? null;
  }

  async setBreakpoints(_filePath: string, breakpoints: BreakpointRecord[]): Promise<DapBreakpoint[]> {
    const results: DapBreakpoint[] = [];
    for (const breakpoint of breakpoints) {
      const response = await this.#request(
        IdeMessageTypes.AGENT_SET_BREAKPOINT,
        { breakpoint },
        [IdeMessageTypes.IDE_BREAKPOINT_ADDED],
        5000,
        (message) => message.breakpointId === breakpoint.id || message.breakpoint?.id === breakpoint.id
      );
      const responseBreakpoint = response.breakpoint as BreakpointRecord | undefined;
      results.push({
        id: this.#dapBreakpointId(responseBreakpoint?.adapterBreakpointId ?? breakpoint.adapterBreakpointId, 0),
        verified: this.#breakpointBoolean(responseBreakpoint?.verified, true),
        line: responseBreakpoint?.line ?? breakpoint.line,
        column: responseBreakpoint?.column ?? breakpoint.column,
        message: response.error?.message
      });
    }
    return results;
  }

  async removeBreakpoint(breakpoint: BreakpointRecord): Promise<AnyRecord> {
    const response = await this.#request(
      IdeMessageTypes.AGENT_REMOVE_BREAKPOINT,
      {
        breakpointId: breakpoint.id,
        breakpoint,
        file: breakpoint.file,
        line: breakpoint.line
      },
      [IdeMessageTypes.IDE_BREAKPOINT_REMOVED],
      5000,
      (message) => message.breakpointId === breakpoint.id
    );
    return {
      removed: response.removed === true || response.result?.removed === true
    };
  }

  async listBreakpoints(filter: BreakpointFilter = {}): Promise<BreakpointRecord[]> {
    const response = await this.#request(
      IdeMessageTypes.AGENT_LIST_BREAKPOINTS,
      { options: filter },
      [IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT],
      5000
    );
    const rawBreakpoints: unknown[] = Array.isArray(response.result?.breakpoints)
      ? response.result.breakpoints
      : Array.isArray(response.breakpoints)
        ? response.breakpoints
        : [];
    return rawBreakpoints
      .map((breakpoint, index) => this.#breakpointFromIde(breakpoint, index))
      .filter((breakpoint): breakpoint is BreakpointRecord => Boolean(breakpoint));
  }

  async waitForBreakpoint(timeoutMs = 30000): Promise<StoppedEvent> {
    const transition = this.pendingStopTransition;
    const current = this.#sessionInfo();
    if (
      transition?.capturedStop &&
      current?.state === "paused" &&
      this.#sessionRevision() > transition.revision
    ) {
      const captured = transition.capturedStop;
      this.#clearStopTransition(transition);
      return captured;
    }
    const currentStopped =
      current?.state === "paused" &&
      (!transition || this.#sessionRevision() > transition.revision)
        ? this.#stoppedFromSession(current)
        : null;
    if (currentStopped) {
      this.#clearStopTransition(transition);
      return currentStopped;
    }

    const requestId = makeId("ide_wait");
    const deferred = createDeferred<StoppedEvent>();
    const listener = (event: unknown) => {
      const decoded = decodeBridgeEvent(event);
      if (!decoded) return;
      const { clientId } = decoded;
      const message = decoded.message as BridgeMessage;
      if (clientId !== this.ideClientId) return;
      if (message.ideSessionId !== this.ideSessionId) return;
      if (
        message.type !== IdeMessageTypes.IDE_SESSION_PAUSED &&
        message.type !== IdeMessageTypes.IDE_SESSION_STOPPED &&
        message.type !== IdeMessageTypes.IDE_BREAKPOINT_HIT
      ) {
        return;
      }
      if (transition && this.#sessionRevision() <= transition.revision) return;
      const stopped = this.#stoppedFromMessage(message, requestId);
      if (!stopped) return;
      this.bridge.off("message", listener);
      deferred.resolve(stopped);
    };
    this.bridge.on("message", listener);
    try {
      return await withTimeout(deferred.promise, timeoutMs, () => {
        this.bridge.off("message", listener);
        return new BreakPilotError(ErrorCodes.BREAKPOINT_TIMEOUT, "Timed out waiting for IDE breakpoint hit.", {
          sessionId: this.sessionId,
          ideSessionId: this.ideSessionId,
          timeoutMs
        });
      });
    } finally {
      this.bridge.off("message", listener);
      this.#clearStopTransition(transition);
    }
  }

  async listThreads(): Promise<AnyRecord[]> {
    const snapshot = await this.getRuntimeSnapshot({ profile: "focused" }, {
      maxDepth: 0,
      maxItems: 1,
      maxStringLength: 200,
      redactPatterns: []
    });
    const threads = Array.isArray((snapshot as AnyRecord).threads)
      ? ((snapshot as AnyRecord).threads as AnyRecord[])
      : [];
    if (threads.length > 0) return threads;
    const threadId = snapshot.threadId ?? this.threadId;
    return threadId !== null && threadId !== undefined
      ? [{
          id: threadId,
          name: String(threadId),
          state: this.#sessionInfo()?.state ?? "unknown",
          isCurrent: true,
          frameCount: snapshot.stackFrames?.length ?? 0,
          partial: true,
          capabilities: { stack: "topFrameOnly" }
        }]
      : [];
  }

  async getCallStack(
    threadId: ThreadId | null | undefined = this.threadId,
    request: RuntimeStackRequest = { offset: 0, limit: 20 }
  ): Promise<RuntimeStackResult> {
    const snapshot = await this.getRuntimeSnapshot({
      threadId,
      levels: request.offset + request.limit,
      profile: "focused"
    }, {
      maxDepth: 0,
      maxItems: 1,
      maxStringLength: 200,
      redactPatterns: []
    });
    return {
      threadId: snapshot.threadId ?? threadId,
      stackFrames: snapshot.stackFrames.slice(request.offset, request.offset + request.limit),
      offset: request.offset,
      completeness: "unknown",
      partial: true,
      truncationReason: "provider"
    };
  }

  async getRuntimeSnapshot(args: AnyRecord, limits: Required<VariableLimits>): Promise<RuntimeSnapshot> {
    // IDE snapshots can expose application data, so they go through the same
    // consent path as evaluate even though they do not resume or mutate runtime.
    await this.#confirm(
      variableInspectionConfirmationRequest({
        profile: args.profile,
        frameId: args.frameId,
        threadId: args.threadId
      })
    );
    const response = await this.#request(
      IdeMessageTypes.AGENT_REQUEST_VARIABLES,
      {
        options: {
          ...args,
          maxDepth: limits.maxDepth,
          maxItems: limits.maxItems,
          maxStringLength: limits.maxStringLength,
          redactPatterns: limits.redactPatterns
        }
      },
      [IdeMessageTypes.IDE_VARIABLES_SNAPSHOT],
      args.timeoutMs ?? 5000
    );
    const snapshot = response.snapshot ?? response;
    return {
      sessionId: this.sessionId,
      source: "ide",
      language: this.language,
      profile: args.profile ?? snapshot.profile,
      threadId: snapshot.threadId ?? this.threadId,
      frameId: snapshot.frameId ?? null,
      threads: snapshot.threads,
      partial: Boolean(snapshot.partial),
      stackFrames: snapshot.stackFrames ?? [],
      variables: snapshot.variables ?? {},
      availableCategories: snapshot.availableCategories,
      omittedCategories: snapshot.omittedCategories,
      availableScopes: snapshot.availableScopes,
      omittedScopes: snapshot.omittedScopes,
      scopeMetadata: snapshot.scopeMetadata,
      limits: {
        maxDepth: limits.maxDepth,
        maxItems: limits.maxItems,
        maxStringLength: limits.maxStringLength
      }
    };
  }

  async inspectVariable(
    args: AnyRecord,
    limits: Required<VariableLimits>
  ): Promise<InspectVariableResult | AnyRecord> {
    const snapshot = await this.getRuntimeSnapshot(
      {
        ...args,
        profile: args.profile ?? "custom",
        variablesReference: args.variablesReference
      },
      limits
    );
    return {
      variablesReference: args.variablesReference,
      snapshot
    };
  }

  async setVariable(args: AnyRecord): Promise<AnyRecord> {
    if (!Array.isArray(args.path) || args.path.length === 0) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "IDE variable mutation requires a non-empty path.", {
        providerKind: this.kind,
        path: args.path
      });
    }
    return this.#command("set_variable", {
      path: args.path,
      newValue: args.newValue,
      frameId: args.frameId,
      frameIndex: args.frameIndex,
      threadId: args.threadId
    }, IdeMessageTypes.AGENT_SET_VARIABLE);
  }

  async evaluate(expression: string, options: AnyRecord = {}): Promise<AnyRecord> {
    await this.#confirm(
      evaluateConfirmationRequest(expression, options.mode ?? "readonly", {
        frameId: options.frameId,
        threadId: options.threadId,
        context: options.context ?? "watch"
      })
    );
    const timeoutMs = options.timeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    let lastResult: AnyRecord = {};
    while (attempts < 3) {
      attempts += 1;
      const remaining = Math.max(250, deadline - Date.now());
      lastResult = await this.#command("evaluate", {
        expression,
        frameId: options.frameId,
        threadId: options.threadId,
        timeoutMs: remaining
      });
      if (!this.#isPendingPresentation(lastResult)) return lastResult;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(150, Math.max(0, deadline - Date.now()))));
    }
    throw new BreakPilotError(ErrorCodes.TOOL_FAILED, "IDE evaluate returned only a pending placeholder before timeout.", {
      expression,
      result: lastResult
    });
  }

  async continue(threadId: number | null = this.threadId): Promise<AnyRecord> {
    await this.#confirm(debugControlConfirmationRequest("continue", { threadId }));
    return this.#command("continue", { threadId }, IdeMessageTypes.AGENT_CONTINUE);
  }

  async pause(threadId: number | null = this.threadId): Promise<AnyRecord> {
    await this.#confirm(debugControlConfirmationRequest("pause", { threadId }));
    const transition = this.#armStopTransition("pause");
    try {
      return await this.#command("pause", { threadId }, IdeMessageTypes.AGENT_PAUSE);
    } catch (error) {
      this.#clearStopTransition(transition);
      throw error;
    }
  }

  async runToLine(args: RunToLineArgs): Promise<RunToLineResult> {
    const requestedPosition = {
      filePath: args.filePath,
      line: args.line,
      ...(args.column === undefined ? {} : { column: args.column })
    };
    await this.#confirm(debugControlConfirmationRequest("run_to_line", {
      threadId: args.threadId ?? this.threadId,
      file: args.filePath,
      line: args.line,
      ...(args.column === undefined ? {} : { column: args.column })
    }));
    const transition = this.#armStopTransition("run_to_line");
    try {
      const result = await this.#command("run_to_line", {
        filePath: args.filePath,
        line: args.line,
        ...(args.column === undefined ? {} : { column: args.column }),
        threadId: args.threadId ?? this.threadId,
        timeoutMs: args.timeoutMs
      }, IdeMessageTypes.AGENT_RUN_TO_LINE);
      if (result.status === "stopped") {
        this.#clearStopTransition(transition);
        return {
          status: "stopped",
          targetReached: false,
          requestedPosition,
          cleanedUp: true,
          message: "The IDE reported that the debug session stopped before a fresh run-to-line pause."
        };
      }
      if (result.status === "timeout") {
        this.#clearStopTransition(transition);
        return {
          status: "timeout",
          targetReached: false,
          requestedPosition,
          cleanedUp: true,
          ...(typeof result.message === "string" ? { message: result.message } : {}),
          warnings: ["The IDE did not report a fresh stop before the run-to-line timeout."]
        };
      }
      const stopped = await this.waitForBreakpoint(args.timeoutMs ?? 30000);
      const observedPosition = this.#positionFromStopped(stopped);
      const resultPosition = this.#runToLinePosition(result.position);
      const position = observedPosition ?? resultPosition;
      const targetReached = position ? this.#positionMatchesRequested(position, requestedPosition) : false;
      const warnings = targetReached
        ? []
        : ["A fresh IDE stop was observed at a different or unknown source position; execution was not resumed automatically."];
      return {
        status: "paused",
        targetReached,
        requestedPosition,
        cleanedUp: true,
        ...(position ? { position: this.#publicRunToLinePosition(position) } : {}),
        ...(stopped.topFrame ?? result.frame ? { frame: stopped.topFrame ?? result.frame } : {}),
        ...(warnings.length > 0 ? { warnings } : {})
      };
    } catch (error) {
      this.#clearStopTransition(transition);
      throw error;
    }
  }

  async step(kind: RuntimeStepKind, threadId: number | null = this.threadId): Promise<AnyRecord> {
    await this.#confirm(debugControlConfirmationRequest(`step_${kind}`, { threadId }));
    const messageType =
      kind === "into"
        ? IdeMessageTypes.AGENT_STEP_INTO
        : kind === "out"
          ? IdeMessageTypes.AGENT_STEP_OUT
          : IdeMessageTypes.AGENT_STEP_OVER;
    const transition = this.#armStopTransition(`step_${kind}`);
    try {
      return await this.#command(`step_${kind}`, { threadId }, messageType);
    } catch (error) {
      this.#clearStopTransition(transition);
      throw error;
    }
  }

  async disconnect(options: { terminateDebuggee?: boolean; restart?: boolean } = {}): Promise<AnyRecord> {
    if (!options.terminateDebuggee) {
      return { detached: true, ideSessionId: this.ideSessionId };
    }
    await this.#confirm(debugControlConfirmationRequest("stop_debug", {}));
    return this.#command("stop_debug", options, IdeMessageTypes.AGENT_STOP_DEBUG);
  }

  async #command(command: string, payload: AnyRecord, type = "agent_evaluate"): Promise<AnyRecord> {
    const response = await this.#request(
      type,
      { command, ...payload },
      [IdeMessageTypes.IDE_COMMAND_RESULT],
      payload.timeoutMs ?? 5000,
      (message) => !message.command || message.command === command
    );
    const bridgeError = bridgeErrorPayload(response.error);
    if (bridgeError) {
      throw new BreakPilotError(
        bridgeError.code ?? ErrorCodes.TOOL_FAILED,
        bridgeError.message ?? "IDE command failed.",
        bridgeError
      );
    }
    return publicBridgeSnapshot((response.result ?? response) as SafeBridgeSnapshot) as AnyRecord;
  }

  async #confirm(request: IdeConfirmationRequest): Promise<void> {
    const confirmationId = makeId("confirm");
    const sessionInfo = this.#sessionInfo();
    const topFrame = sessionInfo?.topFrame as AnyRecord | undefined;
    const source = topFrame?.source as AnyRecord | undefined;
    const deferred = createDeferred<void>();
    const listener = (event: unknown) => {
      const decoded = decodeBridgeEvent(event);
      if (!decoded || decoded.clientId !== this.ideClientId) return;
      const message = decoded.message as BridgeMessage;
      if (message.confirmationId !== confirmationId) return;
      if (message.type === IdeMessageTypes.USER_REJECT_CONTINUE) {
        this.bridge.off("message", listener);
        deferred.reject(
          new BreakPilotError(ErrorCodes.USER_REJECTED_CONTINUE, "User rejected IDE debug command.", {
            action: request.action,
            sessionId: this.sessionId,
            ideSessionId: this.ideSessionId
          })
        );
        return;
      }
      if (message.type === IdeMessageTypes.USER_CONFIRM_CONTINUE) {
        this.bridge.off("message", listener);
        deferred.resolve();
      }
    };
    this.bridge.on("message", listener);
    // Enrich the policy-level request with live IDE context here so every
    // caller gets consistent dialog text, audit metadata, and allowlist inputs.
    this.#send({
      type: "agent_request_confirmation",
      confirmationId,
      action: request.action,
      actionKind: request.actionKind,
      riskLevel: request.riskLevel,
      title: request.title,
      description: request.description,
      expressionPreview: request.expressionPreview,
      sessionName: request.sessionName ?? sessionInfo?.name,
      file: request.file ?? source?.path,
      line: request.line ?? topFrame?.line,
      rememberScopes: request.rememberScopes,
      payload: request.payload
    });
    return withTimeout(deferred.promise, this.confirmationTimeoutMs, () => {
      this.bridge.off("message", listener);
      return new BreakPilotError(ErrorCodes.IDE_CONFIRMATION_TIMEOUT, "Timed out waiting for IDE confirmation.", {
        confirmationId,
        action: request.action,
        sessionId: this.sessionId,
        ideSessionId: this.ideSessionId
      });
    });
  }

  async #request(
    type: string,
    payload: Partial<BridgeMessage>,
    responseTypes: string[],
    timeoutMs: number,
    predicate: (message: BridgeMessage) => boolean = () => true
  ): Promise<BridgeMessage> {
    const requestId = makeId("ide_req");
    const deferred = createDeferred<BridgeMessage>();
    const listener = (event: unknown) => {
      const decoded = decodeBridgeEvent(event);
      if (!decoded || decoded.clientId !== this.ideClientId) return;
      const message = decoded.message as BridgeMessage;
      if (message.requestId !== requestId) return;
      if (!responseTypes.includes(message.type)) return;
      if (!predicate(message)) return;
      this.bridge.off("message", listener);
      const bridgeError = bridgeErrorPayload(message.error);
      if (bridgeError) {
        deferred.reject(
          new BreakPilotError(
            bridgeError.code ?? ErrorCodes.TOOL_FAILED,
            bridgeError.message ?? "IDE bridge request failed.",
            bridgeError
          )
        );
        return;
      }
      deferred.resolve(message);
    };
    this.bridge.on("message", listener);
    this.#send({ ...payload, type, requestId });
    return withTimeout(deferred.promise, timeoutMs, () => {
      this.bridge.off("message", listener);
      return new BreakPilotError(ErrorCodes.IDE_BRIDGE_DISCONNECTED, "Timed out waiting for IDE bridge response.", {
        sessionId: this.sessionId,
        ideSessionId: this.ideSessionId,
        requestId,
        type,
        responseTypes
      });
    });
  }

  #send(message: Partial<BridgeMessage>): void {
    const sent = this.bridge.sendToClient(this.ideClientId, {
      ...message,
      sessionId: this.sessionId,
      ideSessionId: this.ideSessionId,
      workspaceRoot: this.workspaceRoot
    });
    if (!sent) {
      throw new BreakPilotError(ErrorCodes.IDE_NOT_CONNECTED, "IDE client is not connected.", {
        clientId: this.ideClientId,
        ideSessionId: this.ideSessionId
      });
    }
  }

  #sessionInfo(): IdeDebugSessionInfo | undefined {
    return this.bridge.registry.findSession(this.ideSessionId, this.ideClientId);
  }

  #sessionRevision(): number {
    return this.bridge.registry.getSessionRevision(this.ideSessionId, this.ideClientId);
  }

  #armStopTransition(operation: string): StopTransitionBoundary {
    if (this.pendingStopTransition) {
      throw new BreakPilotError(
        ErrorCodes.TOOL_FAILED,
        "An IDE control transition is already waiting for fresh stop evidence.",
        {
          sessionId: this.sessionId,
          ideSessionId: this.ideSessionId,
          pendingOperation: this.pendingStopTransition.operation,
          requestedOperation: operation
        }
      );
    }
    const transition: StopTransitionBoundary = {
      operation,
      revision: this.#sessionRevision()
    };
    transition.listener = (event: unknown) => {
      const decoded = decodeBridgeEvent(event);
      if (!decoded) return;
      const { clientId } = decoded;
      const message = decoded.message as BridgeMessage;
      if (clientId !== this.ideClientId) return;
      if (message.ideSessionId !== this.ideSessionId) return;
      if (
        message.type !== IdeMessageTypes.IDE_SESSION_PAUSED &&
        message.type !== IdeMessageTypes.IDE_SESSION_STOPPED &&
        message.type !== IdeMessageTypes.IDE_BREAKPOINT_HIT
      ) {
        return;
      }
      if (this.#sessionRevision() <= transition.revision) return;
      const stopped = this.#stoppedFromMessage(message);
      if (stopped && !transition.capturedStop) transition.capturedStop = stopped;
    };
    this.pendingStopTransition = transition;
    this.bridge.on("message", transition.listener);
    return transition;
  }

  #clearStopTransition(transition: StopTransitionBoundary | null): void {
    if (transition && this.pendingStopTransition === transition) {
      if (transition.listener) this.bridge.off("message", transition.listener);
      this.pendingStopTransition = null;
    }
  }

  #isPendingPresentation(result: AnyRecord): boolean {
    const value = result.value as AnyRecord | undefined;
    const raw = value?.valuePreview ?? value?.value ?? result.valuePreview ?? result.value;
    if (typeof raw !== "string") return false;
    const normalized = raw.replace(/\u2026/g, "...").trim().toLowerCase();
    return normalized === "collecting data..." || normalized === "collecting data";
  }

  #breakpointFromIde(value: unknown, index: number): BreakpointRecord | null {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const raw = value as AnyRecord;
      const file = raw.file ?? raw.filePath;
      const line = raw.line;
      const type = typeof raw.type === "string" ? raw.type : "line";
      if (type === "line" && (typeof file !== "string" || typeof line !== "number")) return null;
      const id = this.#opaqueId(raw.id) ?? this.#opaqueId(raw.breakpointId) ?? this.#opaqueId(raw.ideBreakpointId) ?? `ide_bp_${index}`;
      return {
      id,
      sessionId: this.sessionId,
      file: typeof file === "string" ? file : "",
      line: typeof line === "number" ? line : -1,
      column: typeof raw.column === "number" ? raw.column : undefined,
      condition: typeof raw.condition === "string" ? raw.condition : undefined,
      hitCondition: typeof raw.hitCondition === "string" ? raw.hitCondition : undefined,
      logMessage: typeof raw.logMessage === "string" ? raw.logMessage : undefined,
      enabled: this.#breakpointBoolean(raw.enabled, true),
      temporary: this.#breakpointBoolean(raw.temporary, false),
      suspendPolicy: raw.suspendPolicy === "ALL" || raw.suspendPolicy === "THREAD" || raw.suspendPolicy === "NONE"
        ? raw.suspendPolicy
        : undefined,
      isLogMessage: this.#breakpointBoolean(raw.isLogMessage, false),
      isLogStack: this.#breakpointBoolean(raw.isLogStack, false),
      owner: typeof raw.owner === "string" ? raw.owner : "user",
      verified: this.#breakpointBoolean(raw.verified, true),
      adapterBreakpointId: this.#adapterBreakpointId(raw.adapterBreakpointId),
      ideBreakpointId: this.#opaqueId(raw.ideBreakpointId) ?? id,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString()
      };
    } catch {
      return null;
    }
  }

  #opaqueId(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  }

  #adapterBreakpointId(value: unknown): number | string | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : this.#opaqueId(value);
  }

  #breakpointBoolean(value: unknown, missingDefault: boolean): boolean {
    if (typeof value === "boolean") return value;
    return value === undefined ? missingDefault : false;
  }

  #dapBreakpointId(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  #stoppedFromSession(session: IdeDebugSessionInfo): StoppedEvent | null {
    const stopped = session.stopped as AnyRecord | undefined;
    return this.#makeStoppedEvent({
      reason: stopped?.reason,
      threadId: session.threadId ?? stopped?.threadId,
      description: stopped?.description,
      allThreadsStopped: stopped?.allThreadsStopped,
      topFrame: session.topFrame ?? stopped?.topFrame
    });
  }

  #stoppedFromMessage(message: BridgeMessage, requestId?: string): StoppedEvent | null {
    const stopped = message.stopped as AnyRecord | undefined;
    return this.#makeStoppedEvent({
      reason: message.reason ?? stopped?.reason,
      threadId: message.threadId ?? stopped?.threadId,
      description: message.description ?? stopped?.description,
      allThreadsStopped: message.allThreadsStopped ?? stopped?.allThreadsStopped,
      topFrame: message.topFrame ?? stopped?.topFrame,
      requestId
    });
  }

  #makeStoppedEvent(raw: AnyRecord): StoppedEvent | null {
    const reason = typeof raw.reason === "string" && raw.reason.trim().length > 0
      ? raw.reason
      : undefined;
    const description = typeof raw.description === "string" && raw.description.trim().length > 0
      ? raw.description
      : undefined;
    const threadId =
      (typeof raw.threadId === "number" && Number.isFinite(raw.threadId)) ||
      (typeof raw.threadId === "string" && raw.threadId.trim().length > 0)
        ? raw.threadId
        : undefined;
    const topFrame = raw.topFrame && typeof raw.topFrame === "object" && !Array.isArray(raw.topFrame) && Object.keys(raw.topFrame).length > 0
      ? publicBridgeSnapshot(raw.topFrame as SafeBridgeSnapshot) as AnyRecord
      : undefined;
    const allThreadsStopped = typeof raw.allThreadsStopped === "boolean"
      ? raw.allThreadsStopped
      : undefined;
    if (!reason && !description && threadId === undefined && !topFrame && allThreadsStopped === undefined) {
      return null;
    }
    return {
      sessionId: this.sessionId,
      reason,
      threadId,
      description,
      allThreadsStopped,
      ideSessionId: this.ideSessionId,
      requestId: raw.requestId,
      topFrame
    } as StoppedEvent;
  }

  #positionFromStopped(stopped: AnyRecord): { filePath: string | number | null; line: number | null; column?: number } | undefined {
    const topFrame = (stopped.topFrame ?? stopped.stopped?.topFrame) as AnyRecord | undefined;
    if (!topFrame) return undefined;
    const source = topFrame.source as AnyRecord | undefined;
    return {
      filePath: typeof (source?.path ?? topFrame.filePath) === "string" || typeof (source?.path ?? topFrame.filePath) === "number"
        ? source?.path ?? topFrame.filePath
        : null,
      line: typeof topFrame.line === "number" && Number.isFinite(topFrame.line) ? topFrame.line : null,
      ...(typeof topFrame.column === "number" && Number.isFinite(topFrame.column) ? { column: topFrame.column } : {})
    };
  }

  #runToLinePosition(value: unknown): { filePath: string | number | null; line: number | null; column?: number } | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const position = value as AnyRecord;
    const filePath = position.filePath;
    const line = position.line;
    if (!(typeof filePath === "string" || typeof filePath === "number" || filePath === null)) return undefined;
    if (!(typeof line === "number" || line === null)) return undefined;
    const column = position.column;
    return {
      filePath,
      line,
      ...(typeof column === "number" && Number.isFinite(column) ? { column } : {})
    };
  }

  #positionMatchesRequested(
    position: { filePath: string | number | null; line: number | null; column?: number },
    requested: { filePath: string; line: number; column?: number }
  ): boolean {
    if (typeof position.filePath !== "string" || position.line !== requested.line) return false;
    if (path.resolve(position.filePath) !== path.resolve(requested.filePath)) return false;
    return requested.column === undefined || position.column === requested.column;
  }

  #publicRunToLinePosition(position: { filePath: string | number | null; line: number | null }): AnyRecord {
    return { filePath: position.filePath, line: position.line };
  }
}

function bridgeErrorPayload(error: unknown): AnyRecord | null {
  const payload = safeBridgeDataRecord(error);
  if (!payload || Object.keys(payload).length === 0) return null;
  return {
    ...payload,
    code: typeof payload.code === "string" && payload.code.trim().length > 0 ? payload.code : ErrorCodes.TOOL_FAILED,
    message: typeof payload.message === "string" && payload.message.trim().length > 0 ? payload.message : "IDE bridge request failed."
  };
}
