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
  DrainEventsArgs,
  RuntimeEventPage,
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
import { isDebuggerProtocolV2 } from "../../ide/DebuggerFeatureNegotiation.ts";
import { BreakPilotError, ErrorCodes } from "../../utils/errors.ts";
import { makeId } from "../../utils/ids.ts";
import { createDeferred, withTimeout } from "../../utils/timeout.ts";
import type { RuntimeProviderCapabilities } from "../../types/capabilities.ts";
import { ideProviderCapabilities, mergeIdeCapabilityRecords } from "../ProviderCapabilities.ts";
import { RuntimeEventBuffer } from "../RuntimeEventBuffer.ts";

type StopTransitionBoundary = {
  operation: string;
  revision: number;
  originRequestId: string;
  pauseEpoch?: number;
  causal: boolean;
  capturedEpoch?: number;
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
  runtimeEvents?: RuntimeEventBuffer;
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
  runtimeEvents?: RuntimeEventBuffer;

  constructor({
    sessionId,
    bridge,
    ideSession,
    workspaceRoot,
    language = ideSession.language ?? "idea",
    confirmationTimeoutMs = 30000,
    runtimeEvents
  }: IdeRuntimeProviderOptions) {
    this.sessionId = sessionId;
    this.bridge = bridge;
    this.ideClientId = ideSession.clientId;
    this.ideSessionId = ideSession.ideSessionId;
    this.workspaceRoot = workspaceRoot;
    this.language = language;
    this.confirmationTimeoutMs = confirmationTimeoutMs;
    this.runtimeEvents = runtimeEvents;
    this.pendingStopTransition = null;
  }

  get capabilities(): RuntimeProviderCapabilities {
    const client = this.bridge.registry.get(this.ideClientId)?.capabilities ?? {};
    const sessionInfo = this.#sessionInfo();
    const session = sessionInfo?.capabilities ?? {};
    const features = sessionInfo?.negotiatedDebuggerFeatures;
    return ideProviderCapabilities({
      ...mergeIdeCapabilityRecords(client, session),
      breakpointUpdate: features?.breakpointUpdate === true,
      variableHandles: features?.variableHandles === true,
      nativeSetVariable: features?.nativeSetVariable === true,
      eventStream: features?.eventStream === true && Boolean(this.runtimeEvents)
    });
  }

  get threadId(): number | null {
    return this.#sessionInfo()?.threadId ?? null;
  }

  async drainEvents(args: DrainEventsArgs = {}): Promise<RuntimeEventPage> {
    if (!this.runtimeEvents || this.capabilities.eventDrain !== "native") {
      throw new BreakPilotError(ErrorCodes.UNSUPPORTED_CAPABILITY, "IDE event stream is not available.", {
        sessionId: this.sessionId,
        ideSessionId: this.ideSessionId,
        capability: "eventDrain"
      });
    }
    return this.runtimeEvents.read(args);
  }

  async setBreakpoints(filePath: string, breakpoints: BreakpointRecord[]): Promise<DapBreakpoint[]> {
    if (this.capabilities.breakpointUpdate !== "unsupported") {
      const desiredIds = new Set(breakpoints.map((breakpoint) => breakpoint.id));
      const current = await this.listBreakpoints({ filePath, owner: "agent", includeDisabled: true });
      const normalizedSource = path.resolve(filePath);
      for (const breakpoint of current) {
        if (
          breakpoint.owner !== "agent" ||
          path.resolve(breakpoint.file) !== normalizedSource ||
          desiredIds.has(breakpoint.id)
        ) {
          continue;
        }
        const removal = await this.removeBreakpoint(breakpoint);
        if (removal.removed !== true) {
          throw new BreakPilotError(
            ErrorCodes.BREAKPOINT_UPDATE_FAILED,
            "IDE did not acknowledge removal of a stale BreakPilot breakpoint.",
            { sessionId: this.sessionId, breakpointId: breakpoint.id, filePath }
          );
        }
      }
    }
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
    const breakpoints = rawBreakpoints
      .map((breakpoint, index) => this.#breakpointFromIde(breakpoint, index))
      .filter((breakpoint): breakpoint is BreakpointRecord => Boolean(breakpoint));
    return breakpoints.filter((breakpoint) => {
      if (filter.filePath && path.resolve(breakpoint.file) !== path.resolve(filter.filePath)) return false;
      if (filter.owner && filter.owner !== "all" && breakpoint.owner !== filter.owner) return false;
      if (filter.includeDisabled === false && !breakpoint.enabled) return false;
      return true;
    });
  }

  async waitForBreakpoint(timeoutMs = 30000): Promise<StoppedEvent> {
    const transition = this.pendingStopTransition;
    const current = this.#sessionInfo();
    if (
      transition?.capturedStop &&
      current?.state === "paused" &&
      (transition.causal
        ? transition.capturedEpoch !== undefined && current.pauseEpoch === transition.capturedEpoch
        : this.#sessionRevision() > transition.revision)
    ) {
      const captured = transition.capturedStop;
      this.#clearStopTransition(transition);
      return captured;
    }
    const currentStopped =
      current?.state === "paused" &&
      (!transition || (!transition.causal && this.#sessionRevision() > transition.revision))
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
      if (transition) {
        if (transition.causal) {
          if (!this.#matchesStopOrigin(message, transition)) return;
        } else if (this.#sessionRevision() <= transition.revision) {
          return;
        }
      }
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
    const session = this.#sessionInfo();
    if (session?.negotiatedDebuggerFeatures?.stackPagination) {
      if (request.pauseEpoch !== undefined && request.pauseEpoch !== session.pauseEpoch) {
        throw this.#staleCorrelationError(session.pauseEpoch, request.pauseEpoch, "stack");
      }
      const response = await this.#request(
        IdeMessageTypes.AGENT_REQUEST_STACK,
        { threadId, offset: request.offset, limit: request.limit },
        [IdeMessageTypes.IDE_STACK_SNAPSHOT],
        5000
      );
      const raw = publicBridgeSnapshot((response.result ?? response) as SafeBridgeSnapshot) as AnyRecord;
      const completeness = raw.completeness === "complete" || raw.completeness === "partial"
        ? raw.completeness
        : "unknown";
      const stackFrames = Array.isArray(raw.stackFrames) ? raw.stackFrames : [];
      const offset = typeof raw.offset === "number" && Number.isSafeInteger(raw.offset) && raw.offset >= 0
        ? raw.offset
        : request.offset;
      const totalFrames = typeof raw.totalFrames === "number" && Number.isSafeInteger(raw.totalFrames) && raw.totalFrames >= 0
        ? raw.totalFrames
        : undefined;
      const nextOffset = typeof raw.nextOffset === "number" && Number.isSafeInteger(raw.nextOffset) && raw.nextOffset > offset
        ? raw.nextOffset
        : undefined;
      const truncationReason = raw.truncationReason === "limit" || raw.truncationReason === "provider" ||
        raw.truncationReason === "timeout" || raw.truncationReason === "noSuspendContext"
        ? raw.truncationReason
        : undefined;
      return {
        threadId: raw.threadId ?? threadId ?? null,
        stackFrames,
        offset,
        ...(totalFrames === undefined ? {} : { totalFrames }),
        completeness,
        partial: completeness !== "complete",
        ...(nextOffset === undefined ? {} : { nextOffset }),
        ...(truncationReason === undefined ? {} : { truncationReason }),
        ...(typeof raw.pauseEpoch === "number" ? { pauseEpoch: raw.pauseEpoch } : {})
      };
    }
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
    const ref = args.ref ?? args.variablesReference;
    const session = this.#sessionInfo();
    if (typeof ref === "string" && session?.negotiatedDebuggerFeatures?.variableHandles) {
      await this.#confirm(variableInspectionConfirmationRequest({
        frameId: args.frameId,
        threadId: args.threadId,
        ref
      }));
      const response = await this.#request(
        IdeMessageTypes.AGENT_REQUEST_VARIABLES,
        {
          ref,
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
      return publicBridgeSnapshot((response.result ?? response.snapshot ?? response) as SafeBridgeSnapshot) as AnyRecord;
    }
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
    if (args.ref !== undefined) {
      if (typeof args.ref !== "string" || !this.#sessionInfo()?.negotiatedDebuggerFeatures?.nativeSetVariable) {
        throw new BreakPilotError(
          ErrorCodes.UNSUPPORTED_CAPABILITY,
          "IDE provider does not support native mutation for this runtime reference.",
          { providerKind: this.kind, ref: args.ref, capability: "nativeSetVariable" }
        );
      }
      const result = await this.#command("set_variable", {
        ref: args.ref,
        newValue: args.newValue,
        frameId: args.frameId,
        threadId: args.threadId
      }, IdeMessageTypes.AGENT_SET_VARIABLE);
      return {
        ...result,
        applied: result.applied === true,
        verified: result.verified === true,
        mutationMode: "native"
      };
    }
    if (!Array.isArray(args.path) || args.path.length === 0) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "IDE variable mutation requires a non-empty path.", {
        providerKind: this.kind,
        path: args.path
      });
    }
    const result = await this.#command("set_variable", {
      path: args.path,
      newValue: args.newValue,
      frameId: args.frameId,
      frameIndex: args.frameIndex,
      threadId: args.threadId
    }, IdeMessageTypes.AGENT_SET_VARIABLE);
    return {
      ...result,
      applied: result.applied !== false,
      verified: false,
      mutationMode: "evaluateAssignment"
    };
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
    const originRequestId = makeId("ide_req");
    const transition = this.#armStopTransition("pause", originRequestId);
    try {
      return await this.#command("pause", { threadId }, IdeMessageTypes.AGENT_PAUSE, originRequestId);
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
    const originRequestId = makeId("ide_req");
    const transition = this.#armStopTransition("run_to_line", originRequestId);
    try {
      const result = await this.#command("run_to_line", {
        filePath: args.filePath,
        line: args.line,
        ...(args.column === undefined ? {} : { column: args.column }),
        threadId: args.threadId ?? this.threadId,
        timeoutMs: args.timeoutMs
      }, IdeMessageTypes.AGENT_RUN_TO_LINE, originRequestId);
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
    const originRequestId = makeId("ide_req");
    const transition = this.#armStopTransition(`step_${kind}`, originRequestId);
    try {
      return await this.#command(`step_${kind}`, { threadId }, messageType, originRequestId);
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

  async #command(
    command: string,
    payload: AnyRecord,
    type = "agent_evaluate",
    requestId?: string
  ): Promise<AnyRecord> {
    const response = await this.#request(
      type,
      { command, ...payload },
      [IdeMessageTypes.IDE_COMMAND_RESULT],
      payload.timeoutMs ?? 5000,
      (message) => message.command === command,
      requestId
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
    const causal = this.#usesV2Correlation(sessionInfo);
    const expectedPauseEpoch = causal ? sessionInfo?.pauseEpoch : undefined;
    const topFrame = sessionInfo?.topFrame as AnyRecord | undefined;
    const source = topFrame?.source as AnyRecord | undefined;
    const deferred = createDeferred<void>();
    const listener = (event: unknown) => {
      const decoded = decodeBridgeEvent(event);
      if (!decoded || decoded.clientId !== this.ideClientId) return;
      const message = decoded.message as BridgeMessage;
      if (message.confirmationId !== confirmationId) return;
      if (causal) {
        if (message.ideSessionId !== this.ideSessionId || message.sessionId !== this.sessionId) return;
        if (message.pauseEpoch !== expectedPauseEpoch) {
          this.bridge.off("message", listener);
          deferred.reject(this.#staleCorrelationError(expectedPauseEpoch, message.pauseEpoch, "confirmation"));
          return;
        }
      }
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
    try {
      this.#send({
        type: "agent_request_confirmation",
        confirmationId,
        ...(expectedPauseEpoch === undefined ? {} : { expectedPauseEpoch }),
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
    } catch (error) {
      this.bridge.off("message", listener);
      throw error;
    }
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
    predicate: (message: BridgeMessage) => boolean = () => true,
    requestedId?: string
  ): Promise<BridgeMessage> {
    const requestId = requestedId ?? makeId("ide_req");
    const sessionInfo = this.#sessionInfo();
    const causal = this.#usesV2Correlation(sessionInfo);
    const expectedPauseEpoch = causal ? sessionInfo?.pauseEpoch : undefined;
    const deferred = createDeferred<BridgeMessage>();
    const listener = (event: unknown) => {
      const decoded = decodeBridgeEvent(event);
      if (!decoded || decoded.clientId !== this.ideClientId) return;
      const message = decoded.message as BridgeMessage;
      if (message.requestId !== requestId) return;
      if (!responseTypes.includes(message.type)) return;
      if (causal) {
        if (message.ideSessionId !== this.ideSessionId || message.sessionId !== this.sessionId) return;
        if (message.pauseEpoch !== expectedPauseEpoch) {
          this.bridge.off("message", listener);
          deferred.reject(this.#staleCorrelationError(expectedPauseEpoch, message.pauseEpoch, type));
          return;
        }
      }
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
    try {
      this.#send({
        ...payload,
        type,
        requestId,
        originRequestId: requestId,
        ...(expectedPauseEpoch === undefined ? {} : { expectedPauseEpoch })
      });
    } catch (error) {
      this.bridge.off("message", listener);
      throw error;
    }
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

  #armStopTransition(operation: string, originRequestId: string): StopTransitionBoundary {
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
      revision: this.#sessionRevision(),
      originRequestId,
      pauseEpoch: this.#sessionInfo()?.pauseEpoch,
      causal: this.#usesV2Correlation()
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
      if (transition.causal) {
        if (!this.#matchesStopOrigin(message, transition)) return;
      } else if (this.#sessionRevision() <= transition.revision) {
        return;
      }
      const stopped = this.#stoppedFromMessage(message);
      if (stopped && !transition.capturedStop) {
        transition.capturedStop = stopped;
        transition.capturedEpoch = message.pauseEpoch;
      }
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

  #usesV2Correlation(session = this.#sessionInfo()): boolean {
    const client = this.bridge.registry.get(this.ideClientId);
    return Boolean(client && session && isDebuggerProtocolV2(client, session));
  }

  #matchesStopOrigin(message: BridgeMessage, transition: StopTransitionBoundary): boolean {
    return message.originRequestId === transition.originRequestId &&
      typeof message.pauseEpoch === "number" &&
      Number.isSafeInteger(message.pauseEpoch) &&
      typeof transition.pauseEpoch === "number" &&
      message.pauseEpoch > transition.pauseEpoch;
  }

  #staleCorrelationError(expected: number | undefined, received: unknown, operation: string): BreakPilotError {
    return new BreakPilotError(
      ErrorCodes.STALE_RUNTIME_HANDLE,
      "IDE bridge response belongs to a different paused state.",
      {
        sessionId: this.sessionId,
        ideSessionId: this.ideSessionId,
        operation,
        expectedPauseEpoch: expected,
        receivedPauseEpoch: received,
        currentPauseEpoch: this.#sessionInfo()?.pauseEpoch,
        retrySafe: true,
        recommendedAction: "Request fresh context and retry with references from the current pause."
      }
    );
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
