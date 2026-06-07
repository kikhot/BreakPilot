import type { DebugSessionRecord, SessionOwnerValue } from "../types.ts";
import { DebugMcpError, ErrorCodes } from "../utils/errors.ts";
import { SessionOwner } from "./SessionOwner.ts";

export class SessionCoordinator {
  executionLocks: Map<string, string>;

  constructor() {
    this.executionLocks = new Map();
  }

  assertCanControl(
    session: DebugSessionRecord,
    requester: SessionOwnerValue = SessionOwner.MCP,
    operation = "control"
  ): void {
    if (session.owner === SessionOwner.HYBRID) return;
    if (session.owner !== requester) {
      throw new DebugMcpError(
        ErrorCodes.SESSION_OWNER_CONFLICT,
        `Session owner ${session.owner} does not allow ${requester} to ${operation}.`,
        { sessionId: session.sessionId, owner: session.owner, requester, operation }
      );
    }
  }

  beginExecution(session: DebugSessionRecord, operation: string): void {
    if (this.executionLocks.has(session.sessionId)) {
      throw new DebugMcpError(
        ErrorCodes.SESSION_OWNER_CONFLICT,
        "Another execution-control operation is already in progress.",
        {
          sessionId: session.sessionId,
          operation,
          active: this.executionLocks.get(session.sessionId)
        }
      );
    }
    this.executionLocks.set(session.sessionId, operation);
  }

  endExecution(session: DebugSessionRecord): void {
    this.executionLocks.delete(session.sessionId);
  }
}
