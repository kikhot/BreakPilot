import * as vscode from "vscode";
import { BridgeClient } from "../bridge/BridgeClient";
import { AnyRecord, BridgeMessage, MessageTypes } from "../bridge/MessageProtocol";
import { DebugSessionTracker } from "./DebugSessionTracker";
import { PauseScopedHandleRegistry } from "./PauseScopedHandleRegistry";

type SnapshotOptions = {
  profile?: string;
  threadId?: number;
  frameId?: number;
  frameIndex?: number;
  variablesReference?: number | string;
  includeScopes?: string[];
  includeCategories?: string[];
  objectFields?: "none" | "preview" | "shallow" | "deep" | string;
  maxDepth?: number;
  maxItems?: number;
  maxStringLength?: number;
  redactPatterns?: string[];
  __pauseEpoch?: number;
  __parentVariablesReference?: number;
  __truncation?: { truncated: boolean };
};

type DapScope = {
  name: string;
  variablesReference: number;
  expensive?: boolean;
  source?: AnyRecord;
  line?: number;
  column?: number;
};

type DapVariable = {
  name: string;
  value?: string;
  type?: string;
  variablesReference?: number;
  evaluateName?: string;
  namedVariables?: number;
  indexedVariables?: number;
  memoryReference?: string;
  presentationHint?: AnyRecord;
};

type FrameSelection = {
  threadId: number;
  frameId: number;
  stackFrames: AnyRecord[];
};

export class VariableReader {
  private readonly handles = new PauseScopedHandleRegistry();

  constructor(
    private readonly bridge: BridgeClient,
    private readonly tracker: DebugSessionTracker
  ) {
    this.tracker.onEpochChanged((ideSessionId) => this.handles.invalidateSession(ideSessionId));
  }

  async handle(message: BridgeMessage) {
    if (message.type !== MessageTypes.AgentRequestVariables) return;
    const session = this.tracker.find(message.ideSessionId);
    if (!session) {
      this.sendSnapshotError(message, "IDE_SESSION_NOT_FOUND", "VS Code debug session was not found.");
      return;
    }
    try {
      const pauseEpoch = this.tracker.pauseEpoch(message.ideSessionId);
      if (message.expectedPauseEpoch !== undefined && message.expectedPauseEpoch !== pauseEpoch) {
        this.sendSnapshotError(message, "STALE_RUNTIME_HANDLE", "Runtime reference belongs to another paused state.");
        return;
      }
      if (typeof message.ref === "string") {
        const descriptor = this.handles.resolve(message.ref, String(message.ideSessionId), pauseEpoch ?? -1);
        if (!descriptor) {
          this.sendSnapshotError(message, "STALE_RUNTIME_HANDLE", "Runtime reference is stale or belongs to another session.");
          return;
        }
        const truncation = { truncated: false };
        const options = { ...this.optionsFromMessage(message), __pauseEpoch: pauseEpoch, __truncation: truncation };
        const limits = this.limits(options);
        const variables = descriptor.dapVariablesReference > 0
          ? await this.readVariablesReference(session, descriptor.dapVariablesReference, limits, options)
          : {
              [descriptor.name]: {
                name: descriptor.name,
                kind: "primitive",
                valuePreview: descriptor.valuePreview ?? "",
                value: descriptor.valuePreview ?? "",
                type: descriptor.type,
                variablesReference: 0,
                ref: message.ref,
                pauseEpoch,
                modifiable: descriptor.modifiable === true,
                truncated: false
              }
            };
        if (this.tracker.pauseEpoch(message.ideSessionId) !== pauseEpoch) {
          this.sendSnapshotError(message, "STALE_RUNTIME_HANDLE", "Paused state changed while variables were being read.", this.tracker.pauseEpoch(message.ideSessionId));
          return;
        }
        this.bridge.send({
          type: MessageTypes.IdeVariablesSnapshot,
          requestId: message.requestId,
          sessionId: message.sessionId,
          ideSessionId: message.ideSessionId,
          originRequestId: message.originRequestId,
          pauseEpoch,
          result: { ref: message.ref, pauseEpoch, items: Object.values(variables), truncated: truncation.truncated }
        });
        return;
      }
      const snapshot = await this.currentSnapshot(session, { ...this.optionsFromMessage(message), __pauseEpoch: pauseEpoch });
      if (this.tracker.pauseEpoch(message.ideSessionId) !== pauseEpoch) {
        this.sendSnapshotError(message, "STALE_RUNTIME_HANDLE", "Paused state changed while variables were being read.", this.tracker.pauseEpoch(message.ideSessionId));
        return;
      }
      this.bridge.send({
        type: MessageTypes.IdeVariablesSnapshot,
        requestId: message.requestId,
        sessionId: message.sessionId,
        ideSessionId: message.ideSessionId,
        originRequestId: message.originRequestId,
        pauseEpoch,
        snapshot
      });
    } catch (error) {
      this.sendSnapshotError(message, "VARIABLE_SNAPSHOT_FAILED", this.errorMessage(error));
    }
  }

  async currentSnapshot(session: vscode.DebugSession, options: SnapshotOptions = {}): Promise<AnyRecord> {
    const limits = this.limits(options);
    if (typeof options.variablesReference === "number") {
      const truncation = { truncated: false };
      const variables = await this.readVariablesReference(session, options.variablesReference, limits, { ...options, __truncation: truncation });
      return this.baseSnapshot(session, options, {
        threadId: this.numberOption(options.threadId),
        frameId: this.numberOption(options.frameId),
        stackFrames: [],
        variables: {
          variables: {
            name: "variables",
            category: "locals",
            rawScopes: [`variablesReference:${options.variablesReference}`],
            expensive: false,
            variables
          }
        },
        availableCategories: ["locals"],
        availableScopes: [`variablesReference:${options.variablesReference}`],
        partial: truncation.truncated
      });
    }

    const frame = await this.resolveFrame(session, options);
    const scopesResponse = await session.customRequest("scopes", { frameId: frame.frameId });
    const rawScopes = (scopesResponse?.scopes ?? []) as DapScope[];
    const selectedScopes = rawScopes.filter((scope) => this.includeScope(scope, options));
    const variables: AnyRecord = {};
    const availableScopes: string[] = [];
    const availableCategories = new Set<string>();
    let partial = selectedScopes.length > limits.maxItems;

    for (const scope of selectedScopes.slice(0, limits.maxItems)) {
      const category = this.scopeCategory(scope.name);
      const scopeTruncation = { truncated: false };
      const scopeVariables = await this.readVariablesReference(
        session,
        scope.variablesReference,
        limits,
        { ...options, __truncation: scopeTruncation }
      );
      partial ||= scopeTruncation.truncated;
      availableScopes.push(scope.name);
      availableCategories.add(category);
      variables[category] = {
        name: category,
        category,
        rawScopes: [...(((variables[category] as AnyRecord | undefined)?.rawScopes as string[] | undefined) ?? []), scope.name],
        expensive: Boolean(scope.expensive),
        truncated: Boolean((variables[category] as AnyRecord | undefined)?.truncated) || scopeTruncation.truncated,
        variables: {
          ...(((variables[category] as AnyRecord | undefined)?.variables as AnyRecord | undefined) ?? {}),
          ...scopeVariables
        }
      };
    }

    return this.baseSnapshot(session, options, {
      threadId: frame.threadId,
      frameId: frame.frameId,
      stackFrames: frame.stackFrames,
      variables,
      availableCategories: [...availableCategories],
      availableScopes,
      partial
    });
  }

  async evaluate(
    ideSessionId: string | undefined,
    expression: string,
    options: AnyRecord = {}
  ): Promise<{ result?: AnyRecord; error?: string }> {
    const session = this.tracker.find(ideSessionId);
    if (!session) return { error: "VS Code debug session was not found." };
    try {
      const frame = await this.resolveFrame(session, {
        frameId: this.numberOption(options.frameId),
        threadId: this.numberOption(options.threadId)
      });
      const response = await session.customRequest("evaluate", {
        expression,
        frameId: frame.frameId,
        context: typeof options.context === "string" ? options.context : "watch"
      });
      return {
        result: {
          value: this.serializeEvaluateResult(response as DapVariable)
        }
      };
    } catch (error) {
      return { error: this.errorMessage(error) };
    }
  }

  async setVariable(
    ideSessionId: string | undefined,
    path: string[] | undefined,
    newValue: string | undefined,
    options: AnyRecord = {},
    ref?: number | string
  ): Promise<{ result?: AnyRecord; error?: string }> {
    if (typeof ref === "string") {
      if (newValue === undefined) return { error: "newValue is required." };
      const session = this.tracker.find(ideSessionId);
      const pauseEpoch = this.tracker.pauseEpoch(ideSessionId);
      const descriptor = this.handles.resolve(ref, String(ideSessionId), pauseEpoch ?? -1);
      if (!session || !descriptor) return { error: "STALE_RUNTIME_HANDLE" };
      if (!descriptor.parentVariablesReference || descriptor.modifiable === false) return { error: "VARIABLE_NOT_MUTABLE" };
      let before: string | undefined;
      try {
        before = await this.childValue(session, descriptor.parentVariablesReference, descriptor.name);
        if (!this.handleStillCurrent(ref, String(ideSessionId), descriptor.pauseEpoch)) {
          return { error: "STALE_RUNTIME_HANDLE" };
        }
      } catch (error) {
        return { error: this.errorMessage(error) };
      }
      try {
        await session.customRequest("setVariable", {
          variablesReference: descriptor.parentVariablesReference,
          name: descriptor.name,
          value: newValue
        });
        if (!this.handleStillCurrent(ref, String(ideSessionId), descriptor.pauseEpoch)) {
          return {
            result: {
              ref,
              oldValue: before ?? null,
              newValue,
              applied: true,
              verified: false,
              mutationMode: "native",
              pauseChangedAfterDispatch: true
            }
          };
        }
      } catch (error) {
        return { error: this.errorMessage(error) };
      }
      try {
        const after = await this.childValue(session, descriptor.parentVariablesReference, descriptor.name);
        const currentAfterReadback = this.handleStillCurrent(ref, String(ideSessionId), descriptor.pauseEpoch);
        return {
          result: {
            ref,
            oldValue: before ?? null,
            newValue,
            applied: true,
            verified: currentAfterReadback && after === newValue,
            mutationMode: "native",
            value: { name: descriptor.name, valuePreview: after ?? newValue },
            ...(!currentAfterReadback ? { pauseChangedDuringReadback: true } : {})
          }
        };
      } catch (error) {
        return {
          result: {
            ref,
            oldValue: before ?? null,
            newValue,
            applied: true,
            verified: false,
            mutationMode: "native",
            verificationError: this.errorMessage(error)
          }
        };
      }
    }
    if (!path?.length || !newValue) return { error: "path and newValue are required." };
    const expression = `${path.join(".")} = ${newValue}`;
    const evaluated = await this.evaluate(ideSessionId, expression, options);
    if (evaluated.error) return evaluated;
    return {
      result: {
        path,
        newValue,
        applied: true,
        result: evaluated.result
      }
    };
  }

  private async resolveFrame(session: vscode.DebugSession, options: SnapshotOptions): Promise<FrameSelection> {
    const explicitThreadId = this.numberOption(options.threadId);
    const explicitFrameId = this.numberOption(options.frameId);
    const activeItem = vscode.debug.activeStackItem as
      | { session?: vscode.DebugSession; threadId?: number; frameId?: number }
      | undefined;
    const state = this.tracker.sessionInfo(this.tracker.sessionId(session));
    const threadId = explicitThreadId ?? (activeItem?.session === session ? activeItem.threadId : undefined) ?? state?.threadId;
    if (threadId == null) {
      throw new Error("VS Code debug session is not paused on a thread.");
    }
    const response = await session.customRequest("stackTrace", {
      threadId,
      startFrame: 0,
      levels: Math.max(1, (options.frameIndex ?? 0) + 20)
    });
    const stackFrames = ((response?.stackFrames ?? []) as AnyRecord[]).map((frame) => this.normalizeFrame(frame));
    const frame =
      stackFrames.find((candidate) => candidate.id === explicitFrameId) ??
      stackFrames[options.frameIndex ?? 0] ??
      stackFrames[0];
    if (!frame?.id) {
      throw new Error("No stack frame is available from the VS Code debug adapter.");
    }
    return {
      threadId,
      frameId: Number(frame.id),
      stackFrames
    };
  }

  private async readVariablesReference(
    session: vscode.DebugSession,
    variablesReference: number,
    limits: Required<Pick<SnapshotOptions, "maxDepth" | "maxItems" | "maxStringLength">>,
    options: SnapshotOptions,
    depth = limits.maxDepth
  ): Promise<AnyRecord> {
    if (!variablesReference) return {};
    const response = await session.customRequest("variables", {
      variablesReference,
      start: 0,
      count: limits.maxItems
    });
    const variables = (response?.variables ?? []) as DapVariable[];
    if (variables.length > limits.maxItems && options.__truncation) options.__truncation.truncated = true;
    const output: AnyRecord = {};
    for (const variable of variables.slice(0, limits.maxItems)) {
      output[variable.name] = await this.serializeVariable(
        session,
        variable,
        limits,
        { ...options, __parentVariablesReference: variablesReference } as SnapshotOptions,
        depth
      );
    }
    return output;
  }

  private async serializeVariable(
    session: vscode.DebugSession,
    variable: DapVariable,
    limits: Required<Pick<SnapshotOptions, "maxDepth" | "maxItems" | "maxStringLength">>,
    options: SnapshotOptions,
    depth: number
  ): Promise<AnyRecord> {
    const variablesReference = this.numberOption(variable.variablesReference) ?? 0;
    const redacted = this.shouldRedact(variable.name, variable.value ?? "", options.redactPatterns ?? []);
    const displayedValue = redacted ? "[redacted]" : variable.value ?? "";
    const valuePreview = this.truncate(displayedValue, limits.maxStringLength);
    const ideSessionId = this.tracker.sessionId(session);
    const pauseEpoch = options.__pauseEpoch ?? this.tracker.pauseEpoch(ideSessionId) ?? 0;
    const parentVariablesReference = this.numberOption(options.__parentVariablesReference);
    const canRegister = !redacted && this.tracker.pauseEpoch(ideSessionId) === pauseEpoch &&
      (variablesReference > 0 || parentVariablesReference != null);
    const ref = canRegister
      ? this.handles.register({
          sessionId: ideSessionId,
          pauseEpoch,
          dapVariablesReference: variablesReference,
          parentVariablesReference,
          name: variable.name,
          evaluateName: variable.evaluateName,
          modifiable: parentVariablesReference != null,
          valuePreview,
          type: variable.type
        })
      : 0;
    const result: AnyRecord = {
      name: variable.name,
      kind: variablesReference > 0 ? "object" : "primitive",
      valuePreview,
      variablesReference: ref,
      ref,
      pauseEpoch,
      modifiable: parentVariablesReference != null,
      truncated: displayedValue.length > limits.maxStringLength,
      redacted
    };
    if (variable.type) result.type = this.truncate(variable.type, limits.maxStringLength);
    if (variable.evaluateName) result.evaluateName = variable.evaluateName;
    if (variable.namedVariables != null) result.namedVariables = variable.namedVariables;
    if (variable.indexedVariables != null) result.indexedVariables = variable.indexedVariables;
    if (variable.memoryReference) result.memoryReference = variable.memoryReference;
    if (variable.presentationHint) result.presentationHint = variable.presentationHint;
    if (!variablesReference) {
      result.value = valuePreview;
      return result;
    }
    if (depth <= 0 || options.objectFields === "none" || options.objectFields === "preview") {
      result.truncated = true;
      return result;
    }
    try {
      const childTruncation = { truncated: false };
      result.value = await this.readVariablesReference(
        session,
        variablesReference,
        limits,
        { ...options, __truncation: childTruncation },
        depth - 1
      );
      if (childTruncation.truncated) {
        result.truncated = true;
        if (options.__truncation) options.__truncation.truncated = true;
      }
      const declaredChildren = (variable.namedVariables ?? 0) + (variable.indexedVariables ?? 0);
      if (declaredChildren > 0 && Object.keys(result.value as AnyRecord).length < declaredChildren) {
        result.truncated = true;
        if (options.__truncation) options.__truncation.truncated = true;
      }
    } catch (error) {
      result.presentationError = this.errorMessage(error);
      result.truncated = true;
    }
    return result;
  }

  private serializeEvaluateResult(variable: DapVariable): AnyRecord {
    return {
      name: "result",
      kind: variable.variablesReference ? "object" : "primitive",
      valuePreview: variable.value ?? "",
      value: variable.value ?? "",
      type: variable.type,
      variablesReference: variable.variablesReference ?? 0,
      evaluateName: variable.evaluateName
    };
  }

  private baseSnapshot(
    session: vscode.DebugSession,
    options: SnapshotOptions,
    data: {
      threadId?: number;
      frameId?: number;
      stackFrames: AnyRecord[];
      variables: AnyRecord;
      availableCategories: string[];
      availableScopes: string[];
      partial?: boolean;
    }
  ): AnyRecord {
    const limits = this.limits(options);
    return {
      source: "ide",
      ide: "vscode",
      language: session.type,
      threadId: data.threadId ?? null,
      frameId: data.frameId ?? null,
      profile: options.profile ?? "focused",
      stackFrames: data.stackFrames,
      variables: data.variables,
      availableCategories: data.availableCategories,
      availableScopes: data.availableScopes,
      limits,
      partial: data.partial === true
    };
  }

  private normalizeFrame(frame: AnyRecord): AnyRecord {
    return {
      id: frame.id,
      name: frame.name,
      line: frame.line,
      column: frame.column,
      endLine: frame.endLine,
      endColumn: frame.endColumn,
      source: frame.source
    };
  }

  private includeScope(scope: DapScope, options: SnapshotOptions): boolean {
    if (options.includeScopes?.length && !options.includeScopes.includes(scope.name)) return false;
    const category = this.scopeCategory(scope.name);
    if (options.includeCategories?.length && !options.includeCategories.includes(category)) return false;
    return true;
  }

  private scopeCategory(name: string): string {
    const lower = name.toLowerCase();
    if (lower.includes("argument")) return "arguments";
    if (lower.includes("local")) return "locals";
    if (lower.includes("global")) return "globals";
    if (lower.includes("closure")) return "closures";
    if (lower.includes("module")) return "module";
    if (lower.includes("static")) return "statics";
    if (lower.includes("runtime")) return "runtime";
    return "other";
  }

  private optionsFromMessage(message: BridgeMessage): SnapshotOptions {
    return { ...(message.options ?? {}), variablesReference: message.ref ?? message.options?.variablesReference } as SnapshotOptions;
  }

  private limits(options: SnapshotOptions): Required<Pick<SnapshotOptions, "maxDepth" | "maxItems" | "maxStringLength">> {
    return {
      maxDepth: this.numberOption(options.maxDepth) ?? 1,
      maxItems: this.numberOption(options.maxItems) ?? 20,
      maxStringLength: this.numberOption(options.maxStringLength) ?? 2000
    };
  }

  private numberOption(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    return value.slice(0, maxLength);
  }

  private redact(name: string, value: string, patterns: string[]): string {
    return this.shouldRedact(name, value, patterns) ? "[redacted]" : value;
  }

  private shouldRedact(name: string, value: string, patterns: string[]): boolean {
    return patterns.some((pattern) => this.patternMatches(pattern, name) || this.patternMatches(pattern, value));
  }

  private patternMatches(pattern: string, value: string): boolean {
    if (!pattern || !value) return false;
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return value.includes(pattern);
    }
  }

  private sendSnapshotError(message: BridgeMessage, code: string, text: string, pauseEpoch = message.expectedPauseEpoch) {
    this.bridge.send({
      type: MessageTypes.IdeVariablesSnapshot,
      requestId: message.requestId,
      sessionId: message.sessionId,
      ideSessionId: message.ideSessionId,
      originRequestId: message.originRequestId,
      pauseEpoch,
      error: {
        code,
        message: text
      }
    });
  }

  private async childValue(session: vscode.DebugSession, parentRef: number, name: string): Promise<string | undefined> {
    const response = await session.customRequest("variables", { variablesReference: parentRef });
    const child = ((response?.variables ?? []) as DapVariable[]).find((variable) => variable.name === name);
    return child?.value;
  }

  private handleStillCurrent(ref: string, ideSessionId: string, pauseEpoch: number): boolean {
    return this.tracker.pauseEpoch(ideSessionId) === pauseEpoch &&
      this.handles.resolve(ref, ideSessionId, pauseEpoch) !== undefined;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
