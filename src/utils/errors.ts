import type { AnyRecord, ToolResponse } from "../types.ts";

export const ErrorCodes = Object.freeze({
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  ADAPTER_START_FAILED: "ADAPTER_START_FAILED",
  ATTACH_FAILED: "ATTACH_FAILED",
  LAUNCH_FAILED: "LAUNCH_FAILED",
  BREAKPOINT_NOT_VERIFIED: "BREAKPOINT_NOT_VERIFIED",
  BREAKPOINT_TIMEOUT: "BREAKPOINT_TIMEOUT",
  SOURCE_MAP_NOT_FOUND: "SOURCE_MAP_NOT_FOUND",
  VARIABLE_TOO_LARGE: "VARIABLE_TOO_LARGE",
  EVALUATE_TIMEOUT: "EVALUATE_TIMEOUT",
  EVALUATE_BLOCKED_BY_POLICY: "EVALUATE_BLOCKED_BY_POLICY",
  TARGET_PROCESS_EXITED: "TARGET_PROCESS_EXITED",
  DEBUG_PORT_NOT_ALLOWED: "DEBUG_PORT_NOT_ALLOWED",
  WORKSPACE_VIOLATION: "WORKSPACE_VIOLATION",
  IDE_NOT_CONNECTED: "IDE_NOT_CONNECTED",
  IDE_SESSION_NOT_FOUND: "IDE_SESSION_NOT_FOUND",
  IDE_CONFIRMATION_TIMEOUT: "IDE_CONFIRMATION_TIMEOUT",
  USER_REJECTED_CONTINUE: "USER_REJECTED_CONTINUE",
  SESSION_OWNER_CONFLICT: "SESSION_OWNER_CONFLICT",
  IDE_BRIDGE_DISCONNECTED: "IDE_BRIDGE_DISCONNECTED",
  POLICY_VIOLATION: "POLICY_VIOLATION",
  UNSUPPORTED_LANGUAGE: "UNSUPPORTED_LANGUAGE",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  TOOL_FAILED: "TOOL_FAILED"
} as const);

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class BreakPilotError extends Error {
  code: ErrorCode | string;
  details: AnyRecord;

  constructor(code: ErrorCode | string, message: string, details: AnyRecord = {}) {
    super(message);
    this.name = "BreakPilotError";
    this.code = code;
    this.details = details;
  }
}

export function toErrorPayload(error: unknown): {
  code: string;
  message: string;
  details: AnyRecord;
} {
  if (error instanceof BreakPilotError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }
  return {
    code: ErrorCodes.TOOL_FAILED,
    message: error instanceof Error ? error.message : String(error),
    details: {}
  };
}

export function ok<TData extends AnyRecord>(
  sessionId: string | null | undefined,
  data: TData,
  auditId: string,
  warnings: string[] = []
): ToolResponse<TData> {
  const response: ToolResponse<TData> = { ok: true, data, warnings, auditId };
  if (sessionId) response.sessionId = sessionId;
  return response;
}

export function fail(error: unknown, auditId: string): ToolResponse {
  return {
    ok: false,
    error: toErrorPayload(error),
    auditId
  };
}
