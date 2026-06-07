import type { DapSession } from "./dap/DapSession.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };
export type AnyRecord = Record<string, any>;

export type DebugLanguage = "python" | "node" | "typescript" | "java" | string;
export type DebugMode = "headless" | "ide" | "hybrid" | string;
export type RuntimeProviderKind = "dap" | "ide" | string;
export type RuntimeStepKind = "over" | "into" | "out";
export type SessionOwnerValue = "mcp" | "ide" | "hybrid" | string;
export type SessionStateValue =
  | "created"
  | "initializing"
  | "running"
  | "paused"
  | "terminated"
  | "failed"
  | string;

export interface DebugMcpPolicy {
  workspace: {
    root: string;
    allowOutsideWorkspace: boolean;
  };
  network: {
    allowedHosts: string[];
    allowedPorts: number[];
  };
  ide: {
    enabled: boolean;
    preferredMode: string;
    bridge: {
      host: string;
      port: number;
    };
    requireUserConfirmation: {
      continueAfterBreakpoint: boolean;
      unsafeEvaluate: boolean;
      attachRemote: boolean;
    };
    confirmationTimeoutMs: number;
    defaultOnTimeout: "continue" | "stop" | string;
  };
  evaluate: {
    defaultMode: EvaluateMode;
    allowFunctionCalls: boolean;
    requireConfirmationForUnsafe: boolean;
    timeoutMs: number;
  };
  variables: VariableLimits & {
    redactPatterns: string[];
  };
  runtime: {
    maxPauseMs: number;
    autoContinue: boolean;
    forbidProduction: boolean;
  };
  audit: {
    enabled: boolean;
    file: string;
  };
}

export type EvaluateMode = "readonly" | "guarded" | "unsafe" | string;

export interface VariableLimits {
  maxDepth: number;
  maxItems: number;
  maxStringLength: number;
  redactPatterns?: string[];
}

export type SnapshotProfile = "focused" | "locals" | "full" | "custom" | string;
export type ObjectFieldsMode = "none" | "preview" | "shallow" | "deep" | string;
export type ScopeCategory =
  | "arguments"
  | "locals"
  | "receiver"
  | "closures"
  | "globals"
  | "statics"
  | "module"
  | "runtime"
  | "other"
  | string;

export type VariableKind =
  | "primitive"
  | "object"
  | "array"
  | "boolean"
  | "number"
  | "null"
  | "metadata";

export interface SerializedVariable {
  name: string;
  type?: string;
  kind: VariableKind;
  valuePreview?: string;
  value?: unknown;
  variablesReference?: number;
  truncated: boolean;
  redacted?: boolean;
  cycle?: boolean;
}

export type SerializedVariableMap = Record<string, SerializedVariable | {
  kind: "metadata";
  value: string;
  truncated: boolean;
}>;

export interface RuntimeSnapshot {
  sessionId: string;
  source: "headless" | "ide";
  language: DebugLanguage;
  profile?: SnapshotProfile;
  threadId: number | null;
  frameId: number | null;
  stackFrames: DapStackFrame[];
  variables: Record<string, {
    name: string;
    category?: ScopeCategory;
    rawScopes?: string[];
    expensive: boolean;
    variables: SerializedVariableMap;
  }>;
  availableCategories?: ScopeCategory[];
  omittedCategories?: ScopeCategory[];
  availableScopes?: string[];
  omittedScopes?: string[];
  scopeMetadata?: ScopeMetadata[];
  limits: Pick<Required<VariableLimits>, "maxDepth" | "maxItems" | "maxStringLength">;
}

export interface InspectVariableResult extends AnyRecord {
  variablesReference?: number;
  start?: number;
  count?: number;
  variables?: SerializedVariableMap;
  snapshot?: RuntimeSnapshot | AnyRecord;
}

export interface ScopeMetadata {
  rawName: string;
  category: ScopeCategory;
  included: boolean;
  expensive: boolean;
  variablesReference: number;
}

export interface DapTransport {
  on(event: string, listener: (...args: any[]) => void): this;
  start(): void;
  write(buffer: Buffer): void;
  close(): void;
}

export interface DapRequestMessage {
  seq: number;
  type: "request";
  command: string;
  arguments?: AnyRecord;
}

export interface DapResponseMessage {
  seq: number;
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: AnyRecord;
}

export interface DapEventMessage {
  seq: number;
  type: "event";
  event: string;
  body?: AnyRecord;
}

export type DapMessage = DapRequestMessage | DapResponseMessage | DapEventMessage | AnyRecord;

export interface DapVariable {
  name: string;
  value?: string;
  type?: string;
  variablesReference?: number;
  indexedVariables?: number;
  namedVariables?: number;
  memoryReference?: string;
  [key: string]: any;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
  [key: string]: any;
}

export interface DapStackFrame {
  id: number;
  name?: string;
  line?: number;
  column?: number;
  source?: AnyRecord;
  [key: string]: any;
}

export interface DapBreakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  line?: number;
  column?: number;
  [key: string]: any;
}

export interface StoppedEvent {
  sessionId?: string;
  reason?: string;
  threadId?: number;
  description?: string;
  allThreadsStopped?: boolean;
  [key: string]: any;
}

export interface RuntimeDebugProvider {
  kind: RuntimeProviderKind;
  sessionId: string;
  language: DebugLanguage;
  workspaceRoot: string;
  capabilities: AnyRecord;
  threadId: number | null;
  setBreakpoints(filePath: string, breakpoints: BreakpointRecord[]): Promise<DapBreakpoint[]>;
  removeBreakpoint?(breakpoint: BreakpointRecord): Promise<AnyRecord>;
  waitForBreakpoint(timeoutMs?: number): Promise<StoppedEvent>;
  getRuntimeSnapshot(args: AnyRecord, limits: Required<VariableLimits>): Promise<RuntimeSnapshot>;
  inspectVariable?(args: AnyRecord, limits: Required<VariableLimits>): Promise<InspectVariableResult | AnyRecord>;
  evaluate(expression: string, options?: AnyRecord): Promise<AnyRecord>;
  continue(threadId?: number | null): Promise<AnyRecord>;
  step(kind: RuntimeStepKind, threadId?: number | null): Promise<AnyRecord>;
  disconnect(options?: { terminateDebuggee?: boolean; restart?: boolean }): Promise<AnyRecord>;
}

export interface BreakpointInput {
  id?: string;
  file: string;
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  owner?: string;
}

export interface BreakpointRecord extends BreakpointInput {
  id: string;
  sessionId: string;
  verified: boolean;
  adapterBreakpointId?: number;
  message?: string;
  createdAt: string;
}

export interface SessionSummary {
  sessionId: string;
  language: DebugLanguage;
  mode: DebugMode;
  owner: SessionOwnerValue;
  state: SessionStateValue;
  createdAt?: string;
  workspaceRoot: string;
  providerKind?: RuntimeProviderKind;
  ideClientId?: string;
  ideSessionId?: string;
  capabilities?: AnyRecord;
}

export interface DebugSessionRecord {
  sessionId: string;
  language: DebugLanguage;
  workspaceRoot: string;
  mode: DebugMode;
  owner: SessionOwnerValue;
  state: SessionStateValue;
  createdAt: string;
  providerKind: RuntimeProviderKind;
  provider: RuntimeDebugProvider;
  dap?: DapSession;
  ideClientId?: string;
  ideSessionId?: string;
}

export interface BridgeMessage {
  id?: string;
  type: string;
  clientId?: string;
  sessionId?: string;
  ideSessionId?: string;
  workspaceRoot?: string;
  breakpoint?: BreakpointRecord | BreakpointInput | AnyRecord;
  breakpointId?: string;
  confirmationId?: string;
  action?: string;
  command?: string;
  requestId?: string;
  options?: AnyRecord;
  snapshot?: AnyRecord;
  ide?: string;
  capabilities?: AnyRecord;
  error?: AnyRecord;
  [key: string]: any;
}

export interface IdeDebugSessionInfo {
  ideSessionId: string;
  clientId: string;
  workspaceRoot?: string;
  name?: string;
  language?: DebugLanguage;
  state: SessionStateValue;
  active?: boolean;
  threadId?: number | null;
  stopped?: StoppedEvent | AnyRecord;
  topFrame?: DapStackFrame | AnyRecord;
  capabilities?: AnyRecord;
  startedAt: string;
  updatedAt: string;
}

export interface IdeClientInfo {
  clientId: string;
  ide: string;
  workspaceRoot?: string;
  capabilities: AnyRecord;
  connectedAt: string;
  lastHeartbeatAt: string;
  sessions?: IdeDebugSessionInfo[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: AnyRecord;
}

export interface ToolResponse<TData = unknown> {
  ok: boolean;
  sessionId?: string;
  data?: TData;
  warnings?: string[];
  auditId: string;
  error?: {
    code: string;
    message: string;
    details: AnyRecord;
  };
}

export interface ToolCallArgs extends AnyRecord {
  sessionId?: string;
}
