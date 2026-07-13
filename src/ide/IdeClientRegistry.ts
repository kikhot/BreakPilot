import type { Socket } from "node:net";
import type { BridgeMessage, IdeClientInfo, IdeDebugSessionInfo } from "../types/ide.ts";
import type { AnyRecord } from "../types/json.ts";
import { makeId } from "../utils/ids.ts";

export interface IdeClientRecord extends IdeClientInfo {
  socket: Socket;
}

export class IdeClientRegistry {
  clients: Map<string, IdeClientRecord>;
  sessions: Map<string, IdeDebugSessionInfo>;
  sessionRevisions: Map<string, number>;

  constructor() {
    this.clients = new Map();
    this.sessions = new Map();
    this.sessionRevisions = new Map();
  }

  add(socket: Socket, metadata: Partial<IdeClientInfo> = {}): IdeClientRecord {
    const clientId = metadata.clientId ?? makeId("ide");
    const client = {
      clientId,
      socket,
      ide: metadata.ide ?? "unknown",
      workspaceRoot: metadata.workspaceRoot,
      capabilities: metadata.capabilities ?? {},
      connectedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString()
    };
    this.clients.set(clientId, client);
    return client;
  }

  update(clientId: string | undefined, patch: Partial<IdeClientInfo> & AnyRecord): IdeClientRecord | null {
    if (!clientId) return null;
    const client = this.clients.get(clientId);
    if (!client) return null;
    Object.assign(client, patch);
    return client;
  }

  remove(clientId: string): void {
    this.clients.delete(clientId);
    for (const [key, session] of this.sessions.entries()) {
      if (session.clientId === clientId) {
        this.sessions.delete(key);
        this.sessionRevisions.delete(key);
      }
    }
  }

  get(clientId: string | undefined): IdeClientRecord | undefined {
    if (!clientId) return undefined;
    return this.clients.get(clientId);
  }

  list(): IdeClientInfo[] {
    return [...this.clients.values()].map(({ socket, ...client }) => ({
      ...client,
      sessions: this.listSessions({ clientId: client.clientId })
    }));
  }

  sockets(): Socket[] {
    return [...this.clients.values()].map((client) => client.socket);
  }

  socketForClient(clientId: string | undefined): Socket | undefined {
    if (!clientId) return undefined;
    return this.clients.get(clientId)?.socket;
  }

  upsertSession(clientId: string | undefined, message: BridgeMessage, state: string): IdeDebugSessionInfo | null {
    if (!clientId || !message.ideSessionId) return null;
    const client = this.clients.get(clientId);
    const now = new Date().toISOString();
    const existing = this.sessions.get(this.#sessionKey(clientId, message.ideSessionId));
    const paused = state === "paused";
    const running = state === "running";
    const stopped = paused
      ? this.#stopDetails(message)
      : running
        ? undefined
        : this.#stopDetails(message) ?? existing?.stopped;
    const incomingThreadId = message.threadId ?? stopped?.threadId;
    const incomingTopFrame = this.#meaningfulFrame(message.topFrame ?? stopped?.topFrame);
    const session: IdeDebugSessionInfo = {
      ideSessionId: message.ideSessionId,
      clientId,
      workspaceRoot: message.workspaceRoot ?? existing?.workspaceRoot ?? client?.workspaceRoot,
      name: message.name ?? existing?.name,
      language: message.language ?? existing?.language ?? "idea",
      state,
      active: message.active ?? existing?.active ?? true,
      threadId: incomingThreadId ?? (paused || running ? null : existing?.threadId ?? null),
      stopped,
      topFrame: incomingTopFrame ?? (paused || running ? undefined : existing?.topFrame),
      capabilities: message.capabilities ?? existing?.capabilities ?? {},
      startedAt: existing?.startedAt ?? message.startedAt ?? now,
      updatedAt: now
    };
    const key = this.#sessionKey(clientId, message.ideSessionId);
    this.sessions.set(key, session);
    this.sessionRevisions.set(key, (this.sessionRevisions.get(key) ?? 0) + 1);
    return session;
  }

  removeSession(clientId: string | undefined, ideSessionId: string | undefined): void {
    if (!clientId || !ideSessionId) return;
    const key = this.#sessionKey(clientId, ideSessionId);
    this.sessions.delete(key);
    this.sessionRevisions.delete(key);
  }

  getSessionRevision(ideSessionId: string | undefined, clientId?: string): number {
    if (!ideSessionId) return 0;
    if (clientId) return this.sessionRevisions.get(this.#sessionKey(clientId, ideSessionId)) ?? 0;
    const session = this.findSession(ideSessionId);
    return session
      ? this.sessionRevisions.get(this.#sessionKey(session.clientId, ideSessionId)) ?? 0
      : 0;
  }

  listSessions(filter: { clientId?: string; workspaceRoot?: string } = {}): IdeDebugSessionInfo[] {
    return [...this.sessions.values()].filter((session) => {
      if (filter.clientId && session.clientId !== filter.clientId) return false;
      if (filter.workspaceRoot && session.workspaceRoot !== filter.workspaceRoot) return false;
      return true;
    });
  }

  findSession(ideSessionId: string | undefined, clientId?: string): IdeDebugSessionInfo | undefined {
    if (!ideSessionId) return undefined;
    if (clientId) return this.sessions.get(this.#sessionKey(clientId, ideSessionId));
    return [...this.sessions.values()].find((session) => session.ideSessionId === ideSessionId);
  }

  findPrimaryClient(workspaceRoot?: string, ideSessionId?: string): IdeClientRecord | undefined {
    if (ideSessionId) {
      const session = this.findSession(ideSessionId);
      const client = this.clients.get(session?.clientId ?? "");
      if (client) return client;
    }
    const clients = [...this.clients.values()];
    if (!workspaceRoot) return clients[0];
    return clients.find((client) => client.workspaceRoot === workspaceRoot) ?? clients[0];
  }

  #sessionKey(clientId: string, ideSessionId: string): string {
    return `${clientId}:${ideSessionId}`;
  }

  #stopDetails(message: BridgeMessage): AnyRecord | undefined {
    const raw = message.stopped && typeof message.stopped === "object" && !Array.isArray(message.stopped)
      ? message.stopped as AnyRecord
      : {};
    const details: AnyRecord = {
      ...raw,
      reason: message.reason ?? raw.reason,
      threadId: message.threadId ?? raw.threadId,
      description: message.description ?? raw.description,
      allThreadsStopped: message.allThreadsStopped ?? raw.allThreadsStopped,
      topFrame: this.#meaningfulFrame(message.topFrame ?? raw.topFrame)
    };
    const threadId = details.threadId;
    const meaningful =
      (typeof details.reason === "string" && details.reason.trim().length > 0) ||
      (typeof details.description === "string" && details.description.trim().length > 0) ||
      (typeof threadId === "number" && Number.isFinite(threadId)) ||
      (typeof threadId === "string" && threadId.trim().length > 0) ||
      details.topFrame !== undefined ||
      typeof details.allThreadsStopped === "boolean";
    return meaningful ? details : undefined;
  }

  #meaningfulFrame(value: unknown): AnyRecord | undefined {
    return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0
      ? value as AnyRecord
      : undefined;
  }
}
