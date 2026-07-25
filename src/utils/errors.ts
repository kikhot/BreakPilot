import type { ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";

export const ErrorCodes = Object.freeze({
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_AMBIGUOUS: "SESSION_AMBIGUOUS",
  PROJECT_AMBIGUOUS: "PROJECT_AMBIGUOUS",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
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
  IDE_SESSION_AMBIGUOUS: "IDE_SESSION_AMBIGUOUS",
  IDE_CONFIRMATION_TIMEOUT: "IDE_CONFIRMATION_TIMEOUT",
  USER_REJECTED_CONTINUE: "USER_REJECTED_CONTINUE",
  SESSION_OWNER_CONFLICT: "SESSION_OWNER_CONFLICT",
  IDE_BRIDGE_DISCONNECTED: "IDE_BRIDGE_DISCONNECTED",
  POLICY_VIOLATION: "POLICY_VIOLATION",
  UNSUPPORTED_LANGUAGE: "UNSUPPORTED_LANGUAGE",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  INVALID_LANGUAGE_IDENTIFIER: "INVALID_LANGUAGE_IDENTIFIER",
  DUPLICATE_LANGUAGE: "DUPLICATE_LANGUAGE",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  OUTPUT_CONTRACT_VIOLATION: "OUTPUT_CONTRACT_VIOLATION",
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
  details?: AnyRecord;
} {
  if (error instanceof BreakPilotError) {
    const payload: { code: string; message: string; details?: AnyRecord } = {
      code: error.code,
      message: error.message
    };
    const details = Object.fromEntries(
      Object.entries(error.details).filter(([, value]) => value !== undefined)
    );
    if (Object.keys(details).length > 0) payload.details = details;
    return payload;
  }
  return {
    code: ErrorCodes.TOOL_FAILED,
    message: error instanceof Error ? error.message : String(error)
  };
}

export function ok<TData extends AnyRecord>(
  _sessionId: string | null | undefined,
  data: TData,
  _auditId: string,
  warnings: string[] = []
): ToolResponse<TData> {
  const response: ToolResponse<TData> = { ...data };
  if (warnings.length > 0) response.warnings = warnings;
  return response;
}

export function fail(error: unknown, _auditId: string): ToolResponse {
  return {
    error: toErrorPayload(error)
  };
}

export function toolResponseHttpStatus(response: ToolResponse): number {
  if (!response.error) return 200;
  return response.error.code === ErrorCodes.OUTPUT_CONTRACT_VIOLATION ? 500 : 400;
}
