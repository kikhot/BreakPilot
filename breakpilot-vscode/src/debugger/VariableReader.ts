import * as vscode from "vscode";
import { BridgeClient } from "../bridge/BridgeClient";
import { AnyRecord, BridgeMessage, MessageTypes } from "../bridge/MessageProtocol";
import { DebugSessionTracker } from "./DebugSessionTracker";

type SnapshotOptions = {
  profile?: string;
  threadId?: number;
  frameId?: number;
  frameIndex?: number;
  variablesReference?: number;
  includeScopes?: string[];
  includeCategories?: string[];
  objectFields?: "none" | "preview" | "shallow" | "deep" | string;
  maxDepth?: number;
  maxItems?: number;
  maxStringLength?: number;
  redactPatterns?: string[];
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
  constructor(
    private readonly bridge: BridgeClient,
    private readonly tracker: DebugSessionTracker
  ) {}

  async handle(message: BridgeMessage) {
    if (message.type !== MessageTypes.AgentRequestVariables) return;
    const session = this.tracker.find(message.ideSessionId);
    if (!session) {
      this.sendSnapshotError(message, "IDE_SESSION_NOT_FOUND", "VS Code debug session was not found.");
      return;
    }
    try {
      const snapshot = await this.currentSnapshot(session, this.optionsFromMessage(message));
      this.bridge.send({
        type: MessageTypes.IdeVariablesSnapshot,
        requestId: message.requestId,
        sessionId: message.sessionId,
        ideSessionId: message.ideSessionId,
        snapshot
      });
    } catch (error) {
      this.sendSnapshotError(message, "VARIABLE_SNAPSHOT_FAILED", this.errorMessage(error));
    }
  }

  async currentSnapshot(session: vscode.DebugSession, options: SnapshotOptions = {}): Promise<AnyRecord> {
    const limits = this.limits(options);
    if (options.variablesReference != null) {
      const variables = await this.readVariablesReference(session, options.variablesReference, limits, options);
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
        availableScopes: [`variablesReference:${options.variablesReference}`]
      });
    }

    const frame = await this.resolveFrame(session, options);
    const scopesResponse = await session.customRequest("scopes", { frameId: frame.frameId });
    const rawScopes = (scopesResponse?.scopes ?? []) as DapScope[];
    const selectedScopes = rawScopes.filter((scope) => this.includeScope(scope, options));
    const variables: AnyRecord = {};
    const availableScopes: string[] = [];
    const availableCategories = new Set<string>();

    for (const scope of selectedScopes.slice(0, limits.maxItems)) {
      const category = this.scopeCategory(scope.name);
      availableScopes.push(scope.name);
      availableCategories.add(category);
      variables[category] = {
        name: category,
        category,
        rawScopes: [...(((variables[category] as AnyRecord | undefined)?.rawScopes as string[] | undefined) ?? []), scope.name],
        expensive: Boolean(scope.expensive),
        variables: {
          ...(((variables[category] as AnyRecord | undefined)?.variables as AnyRecord | undefined) ?? {}),
          ...(await this.readVariablesReference(session, scope.variablesReference, limits, options))
        }
      };
    }

    return this.baseSnapshot(session, options, {
      threadId: frame.threadId,
      frameId: frame.frameId,
      stackFrames: frame.stackFrames,
      variables,
      availableCategories: [...availableCategories],
      availableScopes
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
    const output: AnyRecord = {};
    for (const variable of variables.slice(0, limits.maxItems)) {
      output[variable.name] = await this.serializeVariable(session, variable, limits, options, depth);
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
    const valuePreview = this.truncate(
      this.redact(variable.name, variable.value ?? "", options.redactPatterns ?? []),
      limits.maxStringLength
    );
    const result: AnyRecord = {
      name: variable.name,
      kind: variablesReference > 0 ? "object" : "primitive",
      valuePreview,
      variablesReference,
      truncated: false
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
      result.value = await this.readVariablesReference(session, variablesReference, limits, options, depth - 1);
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
      limits
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
    return (message.options ?? {}) as SnapshotOptions;
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
    if (patterns.length === 0) return value;
    if (patterns.some((pattern) => this.patternMatches(pattern, name) || this.patternMatches(pattern, value))) {
      return "[redacted]";
    }
    return value;
  }

  private patternMatches(pattern: string, value: string): boolean {
    if (!pattern || !value) return false;
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return value.includes(pattern);
    }
  }

  private sendSnapshotError(message: BridgeMessage, code: string, text: string) {
    this.bridge.send({
      type: MessageTypes.IdeVariablesSnapshot,
      requestId: message.requestId,
      sessionId: message.sessionId,
      ideSessionId: message.ideSessionId,
      error: {
        code,
        message: text
      }
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
