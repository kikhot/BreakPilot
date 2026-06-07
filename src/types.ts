import type { DapSession } from "./dap/DapSession.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };
export type AnyRecord = Record<string, any>;

export type DebugLanguage = "python" | "node" | "typescript" | "java" | string;
export type DebugMode = "headless" | "ide" | "hybrid" | string;
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
  threadId: number | null;
  frameId: number | null;
  stackFrames: DapStackFrame[];
  variables: Record<string, {
    name: string;
    expensive: boolean;
    variables: SerializedVariableMap;
  }>;
  limits: Pick<Required<VariableLimits>, "maxDepth" | "maxItems" | "maxStringLength">;
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
  dap: DapSession;
}

export interface BridgeMessage {
  id?: string;
  type: string;
  sessionId?: string;
  workspaceRoot?: string;
  breakpoint?: BreakpointRecord | BreakpointInput | AnyRecord;
  breakpointId?: string;
  confirmationId?: string;
  action?: string;
  requestId?: string;
  options?: AnyRecord;
  snapshot?: AnyRecord;
  ide?: string;
  capabilities?: AnyRecord;
  [key: string]: any;
}

export interface IdeClientInfo {
  clientId: string;
  ide: string;
  workspaceRoot?: string;
  capabilities: AnyRecord;
  connectedAt: string;
  lastHeartbeatAt: string;
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
