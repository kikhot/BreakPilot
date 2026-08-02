import type { DapSession } from "../dap/DapSession.ts";
import type { RuntimeEventBuffer } from "../runtime/RuntimeEventBuffer.ts";
import type { RuntimeProviderCapabilities } from "./capabilities.ts";
import type { DapBreakpoint, FreshStopBoundary, StoppedEvent } from "./dap.ts";
import type {
  DebugLanguage,
  DebugMode,
  RuntimeProviderKind,
  RuntimeStepKind,
  SessionOwnerValue,
  SessionStateValue
} from "./debug.ts";
import type { AnyRecord } from "./json.ts";
import type { InspectVariableResult, RuntimeSnapshot, RuntimeStackFrame, VariableLimits } from "./inspection.ts";

export type ThreadId = number | string;

export type DetailLevel = "compact" | "diagnostic";

export interface RuntimeStackRequest {
  offset: number;
  limit: number;
  pauseEpoch?: number;
}

export interface RuntimeStackResult {
  threadId: ThreadId | null;
  stackFrames: RuntimeStackFrame[];
  offset: number;
  totalFrames?: number;
  pauseEpoch?: number;
  completeness: "complete" | "partial" | "unknown";
  partial: boolean;
  nextOffset?: number;
  truncationReason?: "limit" | "provider" | "timeout" | "noSuspendContext";
}

export interface RunToLineArgs {
  filePath: string;
  line: number;
  column?: number;
  threadId?: ThreadId | null;
  timeoutMs?: number;
}

export interface RunToLineRequestedPosition {
  filePath: string;
  line: number;
  column?: number;
}

export interface RunToLineResult {
  status: "paused" | "stopped" | "timeout";
  /** True only when a fresh runtime stop was observed at the resolved target. */
  targetReached: boolean;
  /** The source location the agent asked BreakPilot to execute to. */
  requestedPosition: RunToLineRequestedPosition;
  /** True only when no temporary state remains or its full restoration was proven. */
  cleanedUp: boolean;
  /** The adapter-selected executable location when it differs from the request. */
  resolvedPosition?: RunToLineRequestedPosition;
  position?: AnyRecord;
  frame?: AnyRecord;
  variables?: AnyRecord[];
  temporaryBreakpointId?: string;
  cleanupRequired?: boolean;
  message?: string;
  warnings?: string[];
}

export interface BreakpointFilter {
  filePath?: string;
  owner?: "agent" | "user" | "all";
  includeDisabled?: boolean;
}

export type RuntimeEventKind =
  | "breakpoint"
  | "breakpointError"
  | "tracepoint"
  | "output"
  | "stopped"
  | "continued"
  | "thread"
  | "process"
  | "invalidated"
  | "terminated";

export interface RuntimeEventPosition {
  filePath: string | number | null;
  line: number | null;
}

export interface RuntimeEvent extends AnyRecord {
  sequence: number;
  timestamp: string;
  kind: RuntimeEventKind;
  sessionId: string;
  breakpointId?: string;
  threadId?: ThreadId;
  position?: RuntimeEventPosition;
  message?: string;
  category?: string;
  data?: AnyRecord;
}

export type RuntimeEventInput = Omit<RuntimeEvent, "sequence" | "timestamp" | "sessionId" | "position"> & {
  position?: unknown;
};

export interface DrainEventsArgs {
  cursor?: number;
  limit?: number;
}

/** Compatibility projection retained for providers that only expose legacy event arrays. */
export interface DebugEventBuffer {
  breakpointErrors: AnyRecord[];
  tracepoints: AnyRecord[];
}

export interface RuntimeEventPage extends DebugEventBuffer {
  items: RuntimeEvent[];
  cursor: number;
  nextCursor: number;
  oldestCursor: number;
  hasMore: boolean;
  overflowed: boolean;
  droppedCount: number;
  supportedKinds: RuntimeEventKind[];
}

export interface RuntimeDebugProvider {
  kind: RuntimeProviderKind;
  sessionId: string;
  language: DebugLanguage;
  workspaceRoot: string;
  capabilities: RuntimeProviderCapabilities;
  threadId: ThreadId | null;
  setBreakpoints(filePath: string, breakpoints: BreakpointRecord[]): Promise<DapBreakpoint[]>;
  removeBreakpoint?(breakpoint: BreakpointRecord): Promise<AnyRecord>;
  waitForBreakpoint(timeoutMs?: number): Promise<StoppedEvent>;
  captureStopBoundary?(): FreshStopBoundary;
  runToLine?(args: RunToLineArgs): Promise<RunToLineResult>;
  listBreakpoints?(filter?: BreakpointFilter): Promise<BreakpointRecord[]>;
  updateBreakpoint?(breakpoint: BreakpointRecord): Promise<BreakpointRecord>;
  drainEvents?(args?: DrainEventsArgs): Promise<DebugEventBuffer | RuntimeEventPage>;
  listThreads?(args?: { offset?: number; limit?: number }): Promise<AnyRecord[]>;
  getCallStack?(threadId: ThreadId | null | undefined, request: RuntimeStackRequest): Promise<RuntimeStackResult>;
  getRuntimeSnapshot(args: AnyRecord, limits: Required<VariableLimits>): Promise<RuntimeSnapshot>;
  inspectVariable?(args: AnyRecord, limits: Required<VariableLimits>): Promise<InspectVariableResult | AnyRecord>;
  setVariable?(args: AnyRecord): Promise<AnyRecord>;
  evaluate(expression: string, options?: AnyRecord): Promise<AnyRecord>;
  pause?(threadId?: ThreadId | null): Promise<AnyRecord>;
  continue(threadId?: ThreadId | null): Promise<AnyRecord>;
  step(kind: RuntimeStepKind, threadId?: ThreadId | null): Promise<AnyRecord>;
  disconnect(options?: { terminateDebuggee?: boolean; restart?: boolean }): Promise<AnyRecord>;
  disposeRuntimeEvents?(): void;
}

export interface BreakpointInput {
  id?: string;
  file: string;
  line: number;
  column?: number;
  condition?: string | null;
  hitCondition?: string | null;
  logMessage?: string | null;
  enabled?: boolean;
  temporary?: boolean;
  suspendPolicy?: "ALL" | "THREAD" | "NONE";
  isLogMessage?: boolean;
  isLogStack?: boolean;
  owner?: "agent" | "user" | string;
}

export interface BreakpointRecord extends BreakpointInput {
  id: string;
  sessionId: string;
  verified: boolean;
  adapterBreakpointId?: number | string;
  ideBreakpointId?: string;
  message?: string;
  createdAt: string;
}

export interface BreakpointPatchRequest {
  breakpointId: string;
  filePath?: string;
  line?: number;
  column?: number | null;
  condition?: string | null;
  hitCondition?: string | null;
  logMessage?: string | null;
  enabled?: boolean;
  owner?: "agent" | "user" | "all";
  requireVerified?: boolean;
}

export interface BreakpointUpdateResult {
  operation: "updated" | "relocated";
  breakpointId: string;
  previous: BreakpointRecord;
  current: BreakpointRecord;
  changedFields: string[];
  verified: boolean;
  rollbackApplied?: boolean;
  warnings?: string[];
}

export interface ReconciliationFailureDetails {
  outcome: "indeterminate";
  retrySafe: false;
  rollbackApplied: boolean;
  affectedIds: string[];
  recommendedAction: string;
  causeCode?: string;
}

export interface ProjectBreakpointRecord extends BreakpointInput {
  id: string;
  workspaceRoot: string;
  clientId: string;
  ide: string;
  ideSessionId?: string;
  verified: boolean;
  adapterBreakpointId?: number | string;
  ideBreakpointId?: string;
  message?: string;
  createdAt: string;
}

export interface SessionSummary {
  sessionId: string;
  language: DebugLanguage;
  mode: DebugMode;
  state: SessionStateValue;
  ideSessionId?: string;
  providerKind?: RuntimeProviderKind;
  capabilities?: RuntimeProviderCapabilities;
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
  runtimeEvents?: RuntimeEventBuffer;
  disposeLifecycle?(): void;
  dap?: DapSession;
  ideClientId?: string;
  ideSessionId?: string;
  /** Core-owned generation used to scope agent-facing runtime handles. */
  pauseId?: number;
}
