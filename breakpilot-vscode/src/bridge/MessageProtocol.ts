export type AnyRecord = Record<string, unknown>;

export type BridgeMessage = {
  id?: string;
  type: string;
  clientId?: string;
  sessionId?: string;
  ideSessionId?: string;
  workspaceRoot?: string;
  requestId?: string;
  confirmationId?: string;
  action?: string;
  actionKind?: string;
  riskLevel?: "safe" | "control" | "high" | string;
  title?: string;
  description?: string;
  expressionPreview?: string;
  sessionName?: string;
  file?: string;
  filePath?: string;
  line?: number;
  path?: string[];
  newValue?: string;
  rememberScopes?: string[];
  rememberScope?: string;
  command?: string;
  expression?: string;
  ide?: string;
  name?: string;
  language?: string;
  state?: string;
  active?: boolean;
  threadId?: number;
  frameId?: number;
  reason?: string;
  breakpoint?: AgentBreakpoint;
  breakpointId?: string;
  capabilities?: AnyRecord;
  options?: AnyRecord;
  payload?: AnyRecord;
  snapshot?: AnyRecord;
  result?: AnyRecord;
  error?: AnyRecord;
  stopped?: AnyRecord;
  topFrame?: AnyRecord;
  timestamp?: string;
  [key: string]: unknown;
};

export type AgentBreakpoint = {
  id: string;
  file: string;
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  owner?: "agent" | "user";
  verified?: boolean;
  adapterBreakpointId?: number | string;
};

export const MessageTypes = {
  BridgeWelcome: "bridge_welcome",
  BridgeRejected: "bridge_rejected",
  BridgeDisconnected: "bridge_disconnected",
  IdeRegistered: "ide_registered",
  IdeHeartbeatAck: "ide_heartbeat_ack",
  IdeRegister: "ide_register",
  IdeHeartbeat: "ide_heartbeat",
  IdeCapabilities: "ide_capabilities",
  IdeSessionStarted: "ide_session_started",
  IdeSessionPaused: "ide_session_paused",
  IdeSessionResumed: "ide_session_resumed",
  IdeSessionStopped: "ide_session_stopped",
  IdeSessionTerminated: "ide_session_terminated",
  IdeBreakpointAdded: "ide_breakpoint_added",
  IdeBreakpointRemoved: "ide_breakpoint_removed",
  IdeBreakpointChanged: "ide_breakpoint_changed",
  IdeBreakpointHit: "ide_breakpoint_hit",
  IdeBreakpointsSnapshot: "ide_breakpoints_snapshot",
  IdeStackSnapshot: "ide_stack_snapshot",
  IdeVariablesSnapshot: "ide_variables_snapshot",
  IdeCommandResult: "ide_command_result",
  AgentSetBreakpoint: "agent_set_breakpoint",
  AgentRemoveBreakpoint: "agent_remove_breakpoint",
  AgentClearBreakpoints: "agent_clear_breakpoints",
  AgentListBreakpoints: "agent_list_breakpoints",
  AgentRequestVariables: "agent_request_variables",
  AgentContinue: "agent_continue",
  AgentPause: "agent_pause",
  AgentStepOver: "agent_step_over",
  AgentStepInto: "agent_step_into",
  AgentStepOut: "agent_step_out",
  AgentRunToLine: "agent_run_to_line",
  AgentSetVariable: "agent_set_variable",
  AgentEvaluate: "agent_evaluate",
  AgentStopDebug: "agent_stop_debug",
  UserConfirmContinue: "user_confirm_continue",
  UserRejectContinue: "user_reject_continue",
  UserRequestAiAnalysis: "user_request_ai_analysis",
  AuditEvent: "audit_event"
} as const;

export type MessageType = (typeof MessageTypes)[keyof typeof MessageTypes] | string;
