import type { DapSession } from "../dap/DapSession.ts";
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
  listThreads?(): Promise<AnyRecord[]>;
  getCallStack?(threadId?: number | null, limit?: number): Promise<AnyRecord>;
  getRuntimeSnapshot(args: AnyRecord, limits: Required<VariableLimits>): Promise<RuntimeSnapshot>;
  inspectVariable?(args: AnyRecord, limits: Required<VariableLimits>): Promise<InspectVariableResult | AnyRecord>;
  setVariable?(args: AnyRecord): Promise<AnyRecord>;
  evaluate(expression: string, options?: AnyRecord): Promise<AnyRecord>;
  pause?(threadId?: number | null): Promise<AnyRecord>;
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
