import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { BridgeMessage, MessageTypes } from "./MessageProtocol";

export class BridgeClient {
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;
  private listeners = new Set<(message: BridgeMessage) => void>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  connect() {
    const url = this.resolveBridgeUrl();
    this.socket?.close();
    this.socket = new WebSocket(url);
    this.socket.onopen = () => {
      if (this.reconnect) clearTimeout(this.reconnect);
      this.send({
        type: MessageTypes.IdeRegister,
        ide: "vscode",
        workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        capabilities: {
          visualBreakpoints: true,
          debugCommands: true,
          confirmationDialog: true,
          webviewPanel: true,
          variableSnapshot: false,
          adoptSession: false,
          provider: "vscode-partial"
        }
      });
      this.heartbeat = setInterval(() => {
        this.send({ type: MessageTypes.IdeHeartbeat });
      }, 5000);
    };
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as BridgeMessage;
      for (const listener of this.listeners) listener(message);
    };
    this.socket.onclose = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.reconnect = setTimeout(() => this.connect(), 2000);
    };
  }

  onMessage(listener: (message: BridgeMessage) => void) {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  send(message: BridgeMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ ...message, timestamp: new Date().toISOString() }));
    }
  }

  dispose() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.socket?.close();
  }

  private resolveBridgeUrl(): string {
    const config = vscode.workspace.getConfiguration("breakpilot");
    const inspected = config.inspect<string>("bridgeUrl");
    const configured = inspected?.workspaceValue ?? inspected?.globalValue;
    if (configured && configured.trim()) return configured;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      const hubFile = path.join(workspaceRoot, ".breakpilot", "hub.json");
      try {
        const manifest = JSON.parse(fs.readFileSync(hubFile, "utf8")) as { bridgeUrl?: string };
        if (manifest.bridgeUrl) return manifest.bridgeUrl;
      } catch {
        // Fall back to the legacy default below.
      }
    }
    return config.get<string>("bridgeUrl", "ws://127.0.0.1:27891");
  }
}
