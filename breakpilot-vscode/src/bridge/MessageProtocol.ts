export type BridgeMessage = {
  id?: string;
  type: string;
  sessionId?: string;
  workspaceRoot?: string;
  breakpoint?: AgentBreakpoint;
  breakpointId?: string;
  [key: string]: unknown;
};

export type AgentBreakpoint = {
  id: string;
  file: string;
  line: number;
  column?: number;
  condition?: string;
  owner?: "agent" | "user";
  verified?: boolean;
};

export const MessageTypes = {
  IdeRegister: "ide_register",
  IdeHeartbeat: "ide_heartbeat",
  BridgeWelcome: "bridge_welcome",
  BridgeRejected: "bridge_rejected",
  IdeBreakpointAdded: "ide_breakpoint_added",
  IdeBreakpointRemoved: "ide_breakpoint_removed",
  IdeBreakpointHit: "ide_breakpoint_hit",
  IdeVariablesSnapshot: "ide_variables_snapshot",
  AgentSetBreakpoint: "agent_set_breakpoint",
  AgentRemoveBreakpoint: "agent_remove_breakpoint",
  AgentClearBreakpoints: "agent_clear_breakpoints",
  AgentRequestVariables: "agent_request_variables",
  AgentContinue: "agent_continue",
  UserConfirmContinue: "user_confirm_continue",
  UserRejectContinue: "user_reject_continue"
} as const;
