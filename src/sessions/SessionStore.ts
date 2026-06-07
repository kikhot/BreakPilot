import type { DebugSessionRecord, SessionSummary } from "../types.ts";
import { DebugMcpError, ErrorCodes } from "../utils/errors.ts";

export class SessionStore {
  sessions: Map<string, DebugSessionRecord>;

  constructor() {
    this.sessions = new Map();
  }

  add(record: DebugSessionRecord): DebugSessionRecord {
    this.sessions.set(record.sessionId, record);
    return record;
  }

  get(sessionId: string): DebugSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new DebugMcpError(ErrorCodes.SESSION_NOT_FOUND, `Session not found: ${sessionId}`, {
        sessionId
      });
    }
    return session;
  }

  maybeGet(sessionId: string): DebugSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      language: session.language,
      mode: session.mode,
      owner: session.owner,
      state: session.state,
      createdAt: session.createdAt,
      workspaceRoot: session.workspaceRoot,
      providerKind: session.providerKind,
      ideClientId: session.ideClientId,
      ideSessionId: session.ideSessionId,
      capabilities: session.provider.capabilities
    }));
  }
}
