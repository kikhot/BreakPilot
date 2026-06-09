import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { BridgeMessage, IdeClientInfo, IdeDebugSessionInfo } from "../types/ide.ts";
import { AuditLogger } from "../audit/AuditLogger.ts";
import { IdeClientRegistry } from "./IdeClientRegistry.ts";
import { IdeMessageTypes, makeBridgeMessage } from "./IdeProtocol.ts";
import { safeJsonParse } from "../utils/json.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface DecodedFrame {
  close?: boolean;
  text?: string;
}

interface DecodeResult {
  messages: DecodedFrame[];
  rest: Buffer;
}

interface IdeBridgeServerOptions {
  host?: string;
  port?: number | string;
  audit?: AuditLogger;
}

export interface IdeBridgeStatus {
  enabled: true;
  host: string;
  port: number;
  clients: IdeClientInfo[];
  sessions: IdeDebugSessionInfo[];
}

function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), payload]);
  }
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer: Buffer): DecodeResult {
  const messages: DecodedFrame[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const opcode = (byte1 ?? 0) & 0x0f;
    const masked = Boolean((byte2 ?? 0) & 0x80);
    let length = (byte2 ?? 0) & 0x7f;
    offset += 2;
    if (length === 126) {
      if (offset + 2 > buffer.length) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    let mask: Buffer | undefined;
    if (masked) {
      if (offset + 4 > buffer.length) break;
      mask = buffer.slice(offset, offset + 4);
      offset += 4;
    }
    if (offset + length > buffer.length) break;
    let payload = buffer.slice(offset, offset + length);
    offset += length;
    if (masked) {
      payload = Buffer.from(payload.map((byte, index) => byte ^ (mask?.[index % 4] ?? 0)));
    }
    if (opcode === 0x8) {
      messages.push({ close: true });
    } else if (opcode === 0x1) {
      messages.push({ text: payload.toString("utf8") });
    }
  }
  return { messages, rest: buffer.slice(offset) };
}

export class IdeBridgeServer extends EventEmitter {
  host: string;
  port: number;
  audit?: AuditLogger;
  registry: IdeClientRegistry;
  server: Server | null;
  buffers: WeakMap<Socket, Buffer>;
  socketClientIds: WeakMap<Socket, string>;

  constructor({ host = "127.0.0.1", port = 27891, audit }: IdeBridgeServerOptions = {}) {
    super();
    this.host = host;
    this.port = Number(port);
    this.audit = audit;
    this.registry = new IdeClientRegistry();
    this.server = null;
    this.buffers = new WeakMap();
    this.socketClientIds = new WeakMap();
  }

  start(): void {
    this.server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(this.status()));
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    });

    this.server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
      const key = req.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }
      const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          ""
        ].join("\r\n")
      );
      const client = this.registry.add(socket, {});
      this.socketClientIds.set(socket, client.clientId);
      this.buffers.set(socket, Buffer.alloc(0));
      this.#send(socket, makeBridgeMessage("bridge_welcome", { clientId: client.clientId }));
      socket.on("data", (chunk) => this.#onSocketData(socket, chunk));
      socket.on("close", () => this.#removeSocket(socket));
      socket.on("error", () => this.#removeSocket(socket));
    });

    this.server.listen(this.port, this.host);
  }

  stop(): void {
    for (const socket of this.registry.sockets()) socket.destroy();
    this.server?.close();
  }

  broadcast(message: BridgeMessage): void {
    const payload = makeBridgeMessage(message.type, message);
    for (const socket of this.registry.sockets()) this.#send(socket, payload);
  }

  sendToClient(clientId: string | undefined, message: Partial<BridgeMessage>): boolean {
    const socket = this.registry.socketForClient(clientId);
    if (!socket) return false;
    this.#send(socket, makeBridgeMessage(String(message.type), { ...message, clientId }));
    return true;
  }

  sendToSession(ideSessionId: string | undefined, message: Partial<BridgeMessage>): boolean {
    const session = this.registry.findSession(ideSessionId);
    if (!session) return false;
    return this.sendToClient(session.clientId, {
      ...message,
      ideSessionId: session.ideSessionId,
      workspaceRoot: session.workspaceRoot
    });
  }

  status(): IdeBridgeStatus {
    return {
      enabled: true,
      host: this.host,
      port: this.port,
      clients: this.registry.list(),
      sessions: this.registry.listSessions()
    };
  }

  #onSocketData(socket: Socket, chunk: Buffer): void {
    const previous = this.buffers.get(socket) ?? Buffer.alloc(0);
    const decoded = decodeFrames(Buffer.concat([previous, chunk]));
    this.buffers.set(socket, decoded.rest);
    for (const frame of decoded.messages) {
      if (frame.close) {
        socket.end();
        continue;
      }
      if (typeof frame.text !== "string") continue;
      const message = safeJsonParse<BridgeMessage>(frame.text);
      if (message) this.#handleMessage(socket, message);
    }
  }

  #handleMessage(socket: Socket, message: BridgeMessage): void {
    const clientId = this.socketClientIds.get(socket);
    if (clientId) message.clientId = clientId;
    if (message.type === IdeMessageTypes.IDE_REGISTER) {
      this.registry.update(clientId, {
        ide: message.ide,
        workspaceRoot: message.workspaceRoot,
        capabilities: message.capabilities ?? {}
      });
      this.#send(socket, makeBridgeMessage("ide_registered", { clientId }));
    } else if (message.type === IdeMessageTypes.IDE_HEARTBEAT) {
      this.registry.update(clientId, { lastHeartbeatAt: new Date().toISOString() });
      this.#send(socket, makeBridgeMessage("ide_heartbeat_ack", { clientId }));
    } else if (message.type === IdeMessageTypes.IDE_SESSION_STARTED) {
      this.registry.upsertSession(clientId, message, "running");
    } else if (
      message.type === IdeMessageTypes.IDE_SESSION_PAUSED ||
      message.type === IdeMessageTypes.IDE_SESSION_STOPPED ||
      message.type === IdeMessageTypes.IDE_BREAKPOINT_HIT
    ) {
      this.registry.upsertSession(clientId, message, "paused");
    } else if (message.type === IdeMessageTypes.IDE_SESSION_RESUMED) {
      this.registry.upsertSession(clientId, message, "running");
    } else if (message.type === IdeMessageTypes.IDE_SESSION_TERMINATED) {
      this.registry.upsertSession(clientId, message, "terminated");
    }
    this.audit?.record("ide_bridge_message", { clientId, type: message.type });
    this.emit("message", { clientId, message });
    if (message.type) this.emit(message.type, { clientId, message });
  }

  #send(socket: Socket, message: BridgeMessage): void {
    if (!socket.writable) return;
    socket.write(encodeFrame(JSON.stringify(message)));
  }

  #removeSocket(socket: Socket): void {
    const clientId = this.socketClientIds.get(socket);
    if (clientId) this.registry.remove(clientId);
    this.socketClientIds.delete(socket);
    this.buffers.delete(socket);
    this.emit("disconnect", { clientId });
  }
}
