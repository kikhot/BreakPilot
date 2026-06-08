import type {
  AnyRecord,
  BreakpointRecord,
  BridgeMessage,
  DapBreakpoint,
  DebugLanguage,
  IdeDebugSessionInfo,
  InspectVariableResult,
  RuntimeDebugProvider,
  RuntimeSnapshot,
  RuntimeStepKind,
  StoppedEvent,
  VariableLimits
} from "../types.ts";
import { IdeBridgeServer } from "../ide/IdeBridgeServer.ts";
import { IdeMessageTypes } from "../ide/IdeProtocol.ts";
import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";
import { makeId } from "../utils/ids.ts";
import { createDeferred, withTimeout } from "../utils/timeout.ts";

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
        stopped: message.stopped
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

  async getRuntimeSnapshot(args: AnyRecord, limits: Required<VariableLimits>): Promise<RuntimeSnapshot> {
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

  async evaluate(expression: string, options: AnyRecord = {}): Promise<AnyRecord> {
    await this.#confirm("evaluate", { expression });
    return this.#command("evaluate", {
      expression,
      frameId: options.frameId,
      threadId: options.threadId,
      timeoutMs: options.timeoutMs
    });
  }

  async continue(threadId: number | null = this.threadId): Promise<AnyRecord> {
    await this.#confirm("continue", { threadId });
    return this.#command("continue", { threadId }, IdeMessageTypes.AGENT_CONTINUE);
  }

  async step(kind: RuntimeStepKind, threadId: number | null = this.threadId): Promise<AnyRecord> {
    await this.#confirm(`step_${kind}`, { threadId });
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
    await this.#confirm("stop_debug", {});
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

  async #confirm(action: string, payload: AnyRecord): Promise<void> {
    const confirmationId = makeId("confirm");
    const deferred = createDeferred<void>();
    const listener = ({ message }: BridgeEvent) => {
      if (message.confirmationId !== confirmationId) return;
      if (message.type === IdeMessageTypes.USER_REJECT_CONTINUE) {
        this.bridge.off("message", listener);
        deferred.reject(
          new BreakPilotError(ErrorCodes.USER_REJECTED_CONTINUE, "User rejected IDE debug command.", {
            action,
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
    this.#send({
      type: "agent_request_confirmation",
      confirmationId,
      action,
      payload
    });
    return withTimeout(deferred.promise, this.confirmationTimeoutMs, () => {
      this.bridge.off("message", listener);
      return new BreakPilotError(ErrorCodes.IDE_CONFIRMATION_TIMEOUT, "Timed out waiting for IDE confirmation.", {
        confirmationId,
        action,
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

  #stoppedFromSession(session: IdeDebugSessionInfo): StoppedEvent {
    return {
      sessionId: this.sessionId,
      reason: session.stopped?.reason ?? "breakpoint",
      threadId: session.threadId ?? session.stopped?.threadId ?? null,
      description: session.stopped?.description ?? "IDE debug session is paused.",
      allThreadsStopped: true,
      ideSessionId: this.ideSessionId,
      topFrame: session.topFrame,
      stopped: session.stopped
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
