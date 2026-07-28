import type { DapStackFrame, StoppedEvent } from "./dap.ts";
import type { DebugLanguage, SessionStateValue } from "./debug.ts";
import type { AnyRecord } from "./json.ts";
import type { BreakpointInput, BreakpointRecord } from "./sessions.ts";
import type { RuntimeReference } from "./inspection.ts";

export interface DebuggerFeatureMap {
  breakpointUpdate?: boolean;
  eventStream?: boolean;
  stackPagination?: boolean;
  variableHandles?: boolean;
  nativeSetVariable?: boolean;
  causalDebugStart?: boolean;
}

export interface DebuggerProtocolInfo {
  debuggerProtocolVersion?: number;
  debuggerFeatures?: DebuggerFeatureMap;
}

export interface BridgeMessage extends DebuggerProtocolInfo {
  id?: string;
  type: string;
  clientId?: string;
  sessionId?: string;
  ideSessionId?: string;
  workspaceRoot?: string;
  breakpoint?: BreakpointRecord | BreakpointInput | AnyRecord;
  breakpointId?: string;
  removed?: boolean;
  confirmationId?: string;
  action?: string;
  command?: string;
  requestId?: string;
  originRequestId?: string;
  pauseEpoch?: number;
  expectedPauseEpoch?: number;
  ref?: RuntimeReference;
  offset?: number;
  limit?: number;
  options?: AnyRecord;
  snapshot?: AnyRecord;
  ide?: string;
  capabilities?: AnyRecord;
  error?: AnyRecord;
  [key: string]: any;
}

export interface IdeDebugSessionInfo extends DebuggerProtocolInfo {
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
  negotiatedDebuggerFeatures: Required<DebuggerFeatureMap>;
  pauseEpoch?: number;
  startedAt: string;
  updatedAt: string;
}

export interface IdeClientInfo extends DebuggerProtocolInfo {
  clientId: string;
  ide: string;
  workspaceRoot?: string;
  capabilities: AnyRecord;
  connectedAt: string;
  lastHeartbeatAt: string;
  sessions?: IdeDebugSessionInfo[];
}
