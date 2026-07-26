import { types } from "node:util";
import { validateToolOutput } from "../control/ToolInputValidator.ts";
import type { JsonSchema, ToolResponse } from "../types/control.ts";
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
  BREAKPOINT_UPDATE_FAILED: "BREAKPOINT_UPDATE_FAILED",
  BREAKPOINT_ROLLBACK_FAILED: "BREAKPOINT_ROLLBACK_FAILED",
  RUN_TO_LINE_CLEANUP_FAILED: "RUN_TO_LINE_CLEANUP_FAILED",
  BREAKPOINT_TIMEOUT: "BREAKPOINT_TIMEOUT",
  SOURCE_MAP_NOT_FOUND: "SOURCE_MAP_NOT_FOUND",
  VARIABLE_TOO_LARGE: "VARIABLE_TOO_LARGE",
  STALE_RUNTIME_HANDLE: "STALE_RUNTIME_HANDLE",
  VARIABLE_NOT_MUTABLE: "VARIABLE_NOT_MUTABLE",
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

const UNKNOWN_TOOL_FAILURE_MESSAGE = "Unknown tool failure.";
const SAFE_ERROR_DETAILS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true
};

function unknownToolFailurePayload(): { code: string; message: string } {
  return {
    code: ErrorCodes.TOOL_FAILED,
    message: UNKNOWN_TOOL_FAILURE_MESSAGE
  };
}

function normalizeErrorDetails(value: unknown): AnyRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;

  const normalized: AnyRecord = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    if (descriptor.value === undefined) continue;
    Object.defineProperty(normalized, key, {
      value: descriptor.value,
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
  return validateToolOutput(SAFE_ERROR_DETAILS_SCHEMA, normalized).errors.length === 0
    ? normalized
    : null;
}

function safeErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message;
      return typeof message === "string" ? message : String(message);
    }
    return String(error);
  } catch {
    return UNKNOWN_TOOL_FAILURE_MESSAGE;
  }
}

export function toErrorPayload(error: unknown): {
  code: string;
  message: string;
  details?: AnyRecord;
} {
  try {
    if (typeof error === "object" && error !== null && types.isProxy(error)) {
      return unknownToolFailurePayload();
    }
    if (error instanceof BreakPilotError) {
      const code = Object.getOwnPropertyDescriptor(error, "code");
      const message = Object.getOwnPropertyDescriptor(error, "message");
      const details = Object.getOwnPropertyDescriptor(error, "details");
      const normalizedDetails = details && "value" in details
        ? normalizeErrorDetails(details.value)
        : null;
      if (
        !code || !("value" in code) || typeof code.value !== "string" ||
        !message || !("value" in message) || typeof message.value !== "string" ||
        normalizedDetails === null
      ) {
        return unknownToolFailurePayload();
      }
      const payload: { code: string; message: string; details?: AnyRecord } = {
        code: code.value,
        message: message.value
      };
      if (Object.keys(normalizedDetails).length > 0) payload.details = normalizedDetails;
      return payload;
    }
  } catch {
    return unknownToolFailurePayload();
  }
  return {
    code: ErrorCodes.TOOL_FAILED,
    message: safeErrorMessage(error)
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
