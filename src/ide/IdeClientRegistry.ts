import type { Socket } from "node:net";
import type { AnyRecord, IdeClientInfo } from "../types.ts";
import { makeId } from "../utils/ids.ts";

export interface IdeClientRecord extends IdeClientInfo {
  socket: Socket;
}

export class IdeClientRegistry {
  clients: Map<string, IdeClientRecord>;

  constructor() {
    this.clients = new Map();
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
  }

  list(): IdeClientInfo[] {
    return [...this.clients.values()].map(({ socket, ...client }) => client);
  }

  sockets(): Socket[] {
    return [...this.clients.values()].map((client) => client.socket);
  }
}
