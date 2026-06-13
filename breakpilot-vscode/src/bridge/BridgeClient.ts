import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { BridgeMessage, MessageTypes } from "./MessageProtocol";

export class BridgeClient {
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;
  private watcher?: vscode.FileSystemWatcher;
  private currentUrl?: string;
  private currentInstanceId?: string;
  private listeners = new Set<(message: BridgeMessage) => void>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.startManifestWatcher();
  }

  connect() {
    const target = this.resolveBridgeTarget();
    if (!target) {
      this.closeSocket();
      this.scheduleReconnect();
      return;
    }
    if (this.socket && this.currentUrl === target.url && this.currentInstanceId === target.instanceId) return;
    this.currentUrl = target.url;
    this.currentInstanceId = target.instanceId;
    this.socket?.close();
    this.socket = new WebSocket(target.url);
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
      if (message.type === MessageTypes.BridgeWelcome && message.workspaceRoot && message.workspaceRoot !== this.workspaceRoot()) {
        this.socket?.close();
        return;
      }
      if (message.type === MessageTypes.BridgeRejected) {
        this.socket?.close();
        return;
      }
      for (const listener of this.listeners) listener(message);
    };
    this.socket.onclose = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.socket = undefined;
      this.scheduleReconnect();
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
    this.watcher?.dispose();
    this.socket?.close();
  }

  private resolveBridgeTarget(): { url: string; instanceId?: string } | null {
    const config = vscode.workspace.getConfiguration("breakpilot");
    const inspected = config.inspect<string>("bridgeUrl");
    const configured = inspected?.workspaceValue ?? inspected?.globalValue;
    if (configured && configured.trim()) return { url: configured.trim() };
    const workspaceRoot = this.workspaceRoot();
    if (workspaceRoot) {
      const hubFile = path.join(workspaceRoot, ".breakpilot", "hub.json");
      try {
        const manifest = JSON.parse(fs.readFileSync(hubFile, "utf8")) as { bridgeUrl?: string; instanceId?: string };
        if (manifest.bridgeUrl) return { url: manifest.bridgeUrl, instanceId: manifest.instanceId };
      } catch {
        return null;
      }
    }
    return null;
  }

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private startManifestWatcher() {
    const workspaceRoot = this.workspaceRoot();
    if (!workspaceRoot) return;
    const pattern = new vscode.RelativePattern(workspaceRoot, ".breakpilot/hub.json");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidCreate(() => this.connect());
    this.watcher.onDidChange(() => this.connect());
    this.watcher.onDidDelete(() => {
      this.currentUrl = undefined;
      this.currentInstanceId = undefined;
      this.closeSocket();
      this.emitLocal({ type: "bridge_disconnected", workspaceRoot });
      this.scheduleReconnect();
    });
    this.context.subscriptions.push(this.watcher);
  }

  private closeSocket() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.socket?.close();
    this.socket = undefined;
  }

  private scheduleReconnect() {
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => this.connect(), 2000);
  }

  private emitLocal(message: BridgeMessage) {
    for (const listener of this.listeners) listener(message);
  }
}
