import crypto from "node:crypto";
import type { ServerResponse } from "node:http";

export type McpTransportKind = "stream" | "sse" | "stdio";

export interface McpSessionRecord {
  sessionId: string;
  transport: McpTransportKind;
  projectPath?: string;
  response?: ServerResponse;
  createdAt: string;
  lastActiveAt: string;
}

export class McpSessionRegistry {
  sessions: Map<string, McpSessionRecord>;

  constructor() {
    this.sessions = new Map();
  }

  create(transport: McpTransportKind, projectPath?: string): McpSessionRecord {
    const now = new Date().toISOString();
    const session: McpSessionRecord = {
      sessionId: crypto.randomUUID(),
      transport,
      projectPath,
      createdAt: now,
      lastActiveAt: now
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string | undefined): McpSessionRecord | undefined {
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId);
  }

  require(sessionId: string | undefined): McpSessionRecord {
    const session = this.get(sessionId);
    if (!session) throw new Error("Missing or unknown MCP session id.");
    session.lastActiveAt = new Date().toISOString();
    return session;
  }

  setResponse(sessionId: string, response: ServerResponse): void {
    const session = this.require(sessionId);
    session.response = response;
    session.lastActiveAt = new Date().toISOString();
  }

  remove(sessionId: string | undefined): void {
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (session?.response && !session.response.destroyed) session.response.end();
    this.sessions.delete(sessionId);
  }

  list(): Omit<McpSessionRecord, "response">[] {
    return [...this.sessions.values()].map(({ response, ...session }) => session);
  }

  activeCount(): number {
    return this.sessions.size;
  }

  pruneIdle(nowMs: number, idleTimeoutMs: number): void {
    for (const session of this.sessions.values()) {
      if (session.response && !session.response.destroyed) continue;
      if (nowMs - Date.parse(session.lastActiveAt) >= idleTimeoutMs) this.remove(session.sessionId);
    }
  }
}
