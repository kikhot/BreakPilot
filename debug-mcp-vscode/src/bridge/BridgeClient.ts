import * as vscode from "vscode";
import { BridgeMessage, MessageTypes } from "./MessageProtocol";

export class BridgeClient {
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private listeners = new Set<(message: BridgeMessage) => void>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  connect() {
    const url = vscode.workspace
      .getConfiguration("debugMcp")
      .get<string>("bridgeUrl", "ws://127.0.0.1:27891");
    this.socket?.close();
    this.socket = new WebSocket(url);
    this.socket.onopen = () => {
      this.send({
        type: MessageTypes.IdeRegister,
        ide: "vscode",
        workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        capabilities: {
          visualBreakpoints: true,
          debugCommands: true,
          confirmationDialog: true,
          webviewPanel: true,
          variableSnapshot: "poc-required"
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
    this.socket?.close();
  }
}
