import type { DapSession } from "../dap/DapSession.ts";
import type { RuntimeProviderCapabilities } from "./capabilities.ts";
import type { DapBreakpoint, StoppedEvent } from "./dap.ts";
import type {
  DebugLanguage,
  DebugMode,
  RuntimeProviderKind,
  RuntimeStepKind,
  SessionOwnerValue,
  SessionStateValue
} from "./debug.ts";
import type { AnyRecord } from "./json.ts";
import type { InspectVariableResult, RuntimeSnapshot, VariableLimits } from "./inspection.ts";

export type ThreadId = number | string;

export type DetailLevel = "compact" | "diagnostic";

export interface RunToLineArgs {
  filePath: string;
  line: number;
  threadId?: ThreadId | null;
  timeoutMs?: number;
}

export interface RunToLineResult {
  status: "paused" | "stopped" | "timeout";
  position?: AnyRecord;
  frame?: AnyRecord;
  variables?: AnyRecord[];
  temporaryBreakpointId?: string;
  cleanedUp?: boolean;
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

export interface RuntimeEvent extends AnyRecord {
  sequence: number;
  timestamp: string;
  kind: RuntimeEventKind;
  sessionId: string;
  breakpointId?: string;
  threadId?: ThreadId;
  position?: AnyRecord;
  message?: string;
  category?: string;
  data?: AnyRecord;
}

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
  runToLine?(args: RunToLineArgs): Promise<RunToLineResult>;
  listBreakpoints?(filter?: BreakpointFilter): Promise<BreakpointRecord[]>;
  updateBreakpoint?(breakpoint: BreakpointRecord): Promise<BreakpointRecord>;
  drainEvents?(args?: DrainEventsArgs): Promise<DebugEventBuffer | RuntimeEventPage>;
  listThreads?(args?: { offset?: number; limit?: number }): Promise<AnyRecord[]>;
  getCallStack?(threadId?: ThreadId | null, args?: number | { offset?: number; limit?: number }): Promise<AnyRecord>;
  getRuntimeSnapshot(args: AnyRecord, limits: Required<VariableLimits>): Promise<RuntimeSnapshot>;
  inspectVariable?(args: AnyRecord, limits: Required<VariableLimits>): Promise<InspectVariableResult | AnyRecord>;
  setVariable?(args: AnyRecord): Promise<AnyRecord>;
  evaluate(expression: string, options?: AnyRecord): Promise<AnyRecord>;
  pause?(threadId?: ThreadId | null): Promise<AnyRecord>;
  continue(threadId?: ThreadId | null): Promise<AnyRecord>;
  step(kind: RuntimeStepKind, threadId?: ThreadId | null): Promise<AnyRecord>;
  disconnect(options?: { terminateDebuggee?: boolean; restart?: boolean }): Promise<AnyRecord>;
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
  dap?: DapSession;
  ideClientId?: string;
  ideSessionId?: string;
}
