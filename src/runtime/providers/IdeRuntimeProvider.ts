import type {
  BridgeMessage,
  IdeDebugSessionInfo,
} from "../../types/ide.ts";
import type { DapBreakpoint, StoppedEvent } from "../../types/dap.ts";
import type { DebugLanguage, RuntimeStepKind } from "../../types/debug.ts";
import type { InspectVariableResult, RuntimeSnapshot, VariableLimits } from "../../types/inspection.ts";
import type { AnyRecord } from "../../types/json.ts";
import type { BreakpointFilter, BreakpointRecord, RunToLineArgs, RunToLineResult, RuntimeDebugProvider } from "../../types/sessions.ts";
import {
  debugControlConfirmationRequest,
  evaluateConfirmationRequest,
  type IdeConfirmationRequest,
  variableInspectionConfirmationRequest
} from "../../ide/ConfirmationPolicy.ts";
import { IdeBridgeServer } from "../../ide/IdeBridgeServer.ts";
import { IdeMessageTypes } from "../../ide/IdeProtocol.ts";
import { BreakPilotError, ErrorCodes } from "../../utils/errors.ts";
import { makeId } from "../../utils/ids.ts";
import { createDeferred, withTimeout } from "../../utils/timeout.ts";

type BridgeEvent = { clientId?: string; message: BridgeMessage };

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
  }

  get capabilities(): AnyRecord {
    return this.#sessionInfo()?.capabilities ?? this.bridge.registry.get(this.ideClientId)?.capabilities ?? {};
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
        id: Number(responseBreakpoint?.adapterBreakpointId ?? breakpoint.adapterBreakpointId ?? 0),
        verified: responseBreakpoint?.verified ?? true,
        line: responseBreakpoint?.line ?? breakpoint.line,
        column: responseBreakpoint?.column ?? breakpoint.column,
        message: response.error?.message
      });
    }
    return results;
  }

  async removeBreakpoint(breakpoint: BreakpointRecord): Promise<AnyRecord> {
    return this.#request(
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
      .map((breakpoint, index) => this.#breakpointFromIde(breakpoint as AnyRecord, index))
      .filter((breakpoint): breakpoint is BreakpointRecord => Boolean(breakpoint));
  }

  async waitForBreakpoint(timeoutMs = 30000): Promise<StoppedEvent> {
    const current = this.#sessionInfo();
    if (current?.state === "paused") {
      return this.#stoppedFromSession(current);
    }

    const requestId = makeId("ide_wait");
    const deferred = createDeferred<StoppedEvent>();
    const listener = ({ message }: BridgeEvent) => {
      if (message.ideSessionId !== this.ideSessionId) return;
      if (
        message.type !== IdeMessageTypes.IDE_SESSION_PAUSED &&
        message.type !== IdeMessageTypes.IDE_BREAKPOINT_HIT
      ) {
        return;
      }
      this.bridge.off("message", listener);
      deferred.resolve({
        sessionId: this.sessionId,
        reason: message.reason ?? message.stopped?.reason ?? "breakpoint",
        threadId: message.threadId ?? message.stopped?.threadId ?? null,
        description: message.description ?? message.stopped?.description ?? "IDE debug session paused.",
        allThreadsStopped: true,
        ideSessionId: this.ideSessionId,
        requestId,
        topFrame: message.topFrame ?? message.stopped?.topFrame
      });
    };
    this.bridge.on("message", listener);
    return withTimeout(deferred.promise, timeoutMs, () => {
      this.bridge.off("message", listener);
      return new BreakPilotError(ErrorCodes.BREAKPOINT_TIMEOUT, "Timed out waiting for IDE breakpoint hit.", {
        sessionId: this.sessionId,
        ideSessionId: this.ideSessionId,
        timeoutMs
      });
    });
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

  async getCallStack(threadId: number | null = this.threadId, limit = 20): Promise<AnyRecord> {
    const snapshot = await this.getRuntimeSnapshot({ threadId, levels: limit, profile: "focused" }, {
      maxDepth: 0,
      maxItems: 1,
      maxStringLength: 200,
      redactPatterns: []
    });
    const hasThreadSnapshot = Array.isArray((snapshot as AnyRecord).threads);
    const partial = Boolean((snapshot as AnyRecord).partial) || (!hasThreadSnapshot && (snapshot.stackFrames?.length ?? 0) <= 1);
    return {
      threadId: snapshot.threadId ?? threadId,
      stackFrames: snapshot.stackFrames.slice(0, limit),
      totalFrames: snapshot.stackFrames.length,
      partial,
      capabilities: partial ? { stack: "topFrameOnly" } : { stack: "full" }
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
    return this.#command("pause", { threadId }, IdeMessageTypes.AGENT_PAUSE);
  }

  async runToLine(args: RunToLineArgs): Promise<RunToLineResult> {
    await this.#confirm(debugControlConfirmationRequest("run_to_line", {
      threadId: args.threadId ?? this.threadId,
      file: args.filePath,
      line: args.line
    }));
    const result = await this.#command("run_to_line", {
      filePath: args.filePath,
      line: args.line,
      threadId: args.threadId ?? this.threadId,
      timeoutMs: args.timeoutMs
    }, IdeMessageTypes.AGENT_RUN_TO_LINE);
    if (result.status === "paused" || result.status === "stopped" || result.status === "timeout") {
      return result as RunToLineResult;
    }
    const stopped = await this.waitForBreakpoint(args.timeoutMs ?? 30000);
    return {
      status: "paused",
      position: this.#positionFromStopped(stopped),
      frame: stopped.topFrame
    };
  }

  async step(kind: RuntimeStepKind, threadId: number | null = this.threadId): Promise<AnyRecord> {
    await this.#confirm(debugControlConfirmationRequest(`step_${kind}`, { threadId }));
    const messageType =
      kind === "into"
        ? IdeMessageTypes.AGENT_STEP_INTO
        : kind === "out"
          ? IdeMessageTypes.AGENT_STEP_OUT
          : IdeMessageTypes.AGENT_STEP_OVER;
    return this.#command(`step_${kind}`, { threadId }, messageType);
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
    return response.result ?? response;
  }

  async #confirm(request: IdeConfirmationRequest): Promise<void> {
    const confirmationId = makeId("confirm");
    const sessionInfo = this.#sessionInfo();
    const topFrame = sessionInfo?.topFrame as AnyRecord | undefined;
    const source = topFrame?.source as AnyRecord | undefined;
    const deferred = createDeferred<void>();
    const listener = ({ message }: BridgeEvent) => {
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
    const listener = ({ message }: BridgeEvent) => {
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

  #isPendingPresentation(result: AnyRecord): boolean {
    const value = result.value as AnyRecord | undefined;
    const raw = value?.valuePreview ?? value?.value ?? result.valuePreview ?? result.value;
    if (typeof raw !== "string") return false;
    const normalized = raw.replace(/\u2026/g, "...").trim().toLowerCase();
    return normalized === "collecting data..." || normalized === "collecting data";
  }

  #breakpointFromIde(raw: AnyRecord, index: number): BreakpointRecord | null {
    const file = raw.file ?? raw.filePath;
    const line = raw.line;
    const type = typeof raw.type === "string" ? raw.type : "line";
    if (type === "line" && (typeof file !== "string" || typeof line !== "number")) return null;
    const id = String(raw.id ?? raw.breakpointId ?? raw.ideBreakpointId ?? `ide_bp_${index}`);
    return {
      id,
      sessionId: this.sessionId,
      file: typeof file === "string" ? file : "",
      line: typeof line === "number" ? line : -1,
      column: typeof raw.column === "number" ? raw.column : undefined,
      condition: typeof raw.condition === "string" ? raw.condition : undefined,
      hitCondition: typeof raw.hitCondition === "string" ? raw.hitCondition : undefined,
      logMessage: typeof raw.logMessage === "string" ? raw.logMessage : undefined,
      enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
      temporary: Boolean(raw.temporary),
      suspendPolicy: raw.suspendPolicy === "ALL" || raw.suspendPolicy === "THREAD" || raw.suspendPolicy === "NONE"
        ? raw.suspendPolicy
        : undefined,
      isLogMessage: Boolean(raw.isLogMessage),
      isLogStack: Boolean(raw.isLogStack),
      owner: typeof raw.owner === "string" ? raw.owner : "user",
      verified: raw.verified === undefined ? true : Boolean(raw.verified),
      adapterBreakpointId: typeof raw.adapterBreakpointId === "number" || typeof raw.adapterBreakpointId === "string"
        ? raw.adapterBreakpointId
        : undefined,
      ideBreakpointId: typeof raw.ideBreakpointId === "string" ? raw.ideBreakpointId : id,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString()
    };
  }

  #stoppedFromSession(session: IdeDebugSessionInfo): StoppedEvent {
    return {
      sessionId: this.sessionId,
      reason: session.stopped?.reason ?? "breakpoint",
      threadId: session.threadId ?? session.stopped?.threadId ?? null,
      description: session.stopped?.description ?? "IDE debug session is paused.",
      allThreadsStopped: true,
      ideSessionId: this.ideSessionId,
      topFrame: session.topFrame ?? (session.stopped as AnyRecord | undefined)?.topFrame
    };
  }

  #positionFromStopped(stopped: AnyRecord): AnyRecord | undefined {
    const topFrame = (stopped.topFrame ?? stopped.stopped?.topFrame) as AnyRecord | undefined;
    if (!topFrame) return undefined;
    const source = topFrame.source as AnyRecord | undefined;
    return {
      filePath: source?.path ?? topFrame.filePath,
      line: topFrame.line
    };
  }
}

function bridgeErrorPayload(error: unknown): AnyRecord | null {
  if (!error) return null;
  if (typeof error !== "object") {
    return { code: ErrorCodes.TOOL_FAILED, message: String(error) };
  }
  const payload = error as AnyRecord;
  return Object.keys(payload).length > 0 ? payload : null;
}
