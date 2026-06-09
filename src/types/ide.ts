import type { DapStackFrame, StoppedEvent } from "./dap.ts";
import type { DebugLanguage, SessionStateValue } from "./debug.ts";
import type { AnyRecord } from "./json.ts";
import type { BreakpointInput, BreakpointRecord } from "./sessions.ts";

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
