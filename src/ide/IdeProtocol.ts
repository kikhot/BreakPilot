import type { BridgeMessage } from "../types/ide.ts";

export const IdeMessageTypes = Object.freeze({
  IDE_REGISTER: "ide_register",
  IDE_HEARTBEAT: "ide_heartbeat",
  IDE_CAPABILITIES: "ide_capabilities",
  IDE_SESSION_STARTED: "ide_session_started",
  IDE_SESSION_PAUSED: "ide_session_paused",
  IDE_SESSION_RESUMED: "ide_session_resumed",
  IDE_SESSION_STOPPED: "ide_session_stopped",
  IDE_SESSION_TERMINATED: "ide_session_terminated",
  IDE_BREAKPOINT_ADDED: "ide_breakpoint_added",
  IDE_BREAKPOINT_REMOVED: "ide_breakpoint_removed",
  IDE_BREAKPOINT_CHANGED: "ide_breakpoint_changed",
  IDE_BREAKPOINT_HIT: "ide_breakpoint_hit",
  IDE_BREAKPOINTS_SNAPSHOT: "ide_breakpoints_snapshot",
  IDE_STACK_SNAPSHOT: "ide_stack_snapshot",
  IDE_VARIABLES_SNAPSHOT: "ide_variables_snapshot",
  IDE_COMMAND_RESULT: "ide_command_result",
  AGENT_SET_BREAKPOINT: "agent_set_breakpoint",
  AGENT_REMOVE_BREAKPOINT: "agent_remove_breakpoint",
  AGENT_CLEAR_BREAKPOINTS: "agent_clear_breakpoints",
  AGENT_LIST_BREAKPOINTS: "agent_list_breakpoints",
  AGENT_REQUEST_VARIABLES: "agent_request_variables",
  AGENT_START_DEBUG: "agent_start_debug",
  AGENT_CONTINUE: "agent_continue",
  AGENT_PAUSE: "agent_pause",
  AGENT_STEP_OVER: "agent_step_over",
  AGENT_STEP_INTO: "agent_step_into",
  AGENT_STEP_OUT: "agent_step_out",
  AGENT_RUN_TO_LINE: "agent_run_to_line",
  AGENT_SET_VARIABLE: "agent_set_variable",
  AGENT_EVALUATE: "agent_evaluate",
  AGENT_STOP_DEBUG: "agent_stop_debug",
  USER_CONFIRM_CONTINUE: "user_confirm_continue",
  USER_REJECT_CONTINUE: "user_reject_continue",
  USER_REQUEST_AI_ANALYSIS: "user_request_ai_analysis",
  AUDIT_EVENT: "audit_event"
} as const);

export type IdeMessageType = (typeof IdeMessageTypes)[keyof typeof IdeMessageTypes] | string;

export function makeBridgeMessage(
  type: IdeMessageType,
  payload: Partial<BridgeMessage> = {}
): BridgeMessage {
  return {
    id: payload.id,
    type,
    timestamp: new Date().toISOString(),
    ...payload
  };
}
