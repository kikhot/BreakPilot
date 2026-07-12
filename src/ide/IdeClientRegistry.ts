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

  constructor() {
    this.clients = new Map();
    this.sessions = new Map();
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
      if (session.clientId === clientId) this.sessions.delete(key);
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
    const session: IdeDebugSessionInfo = {
      ideSessionId: message.ideSessionId,
      clientId,
      workspaceRoot: message.workspaceRoot ?? existing?.workspaceRoot ?? client?.workspaceRoot,
      name: message.name ?? existing?.name,
      language: message.language ?? existing?.language ?? "idea",
      state,
      active: message.active ?? existing?.active ?? true,
      threadId: message.threadId ?? message.stopped?.threadId ?? existing?.threadId ?? null,
      stopped: message.stopped ?? existing?.stopped,
      topFrame: message.topFrame ?? message.stopped?.topFrame ?? existing?.topFrame,
      capabilities: message.capabilities ?? existing?.capabilities ?? {},
      startedAt: existing?.startedAt ?? message.startedAt ?? now,
      updatedAt: now
    };
    this.sessions.set(this.#sessionKey(clientId, message.ideSessionId), session);
    return session;
  }

  removeSession(clientId: string | undefined, ideSessionId: string | undefined): void {
    if (!clientId || !ideSessionId) return;
    this.sessions.delete(this.#sessionKey(clientId, ideSessionId));
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
}
