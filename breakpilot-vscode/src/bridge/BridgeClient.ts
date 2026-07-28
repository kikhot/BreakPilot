import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { AnyRecord, BridgeMessage, MessageTypes } from "./MessageProtocol";

export type BridgeConnectionState = "disconnected" | "connecting" | "connected" | "rejected";

export class BridgeClient {
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;
  private watcher?: vscode.FileSystemWatcher;
  private currentUrl?: string;
  private currentInstanceId?: string;
  private explicitBridgeUrl?: string;
  private state: BridgeConnectionState = "disconnected";
  private generation = 0;
  private disposed = false;
  private listeners = new Set<(message: BridgeMessage) => void>();
  private pending: BridgeMessage[] = [];
  private readonly requestGenerations = new Map<string, number>();
  private readonly connectionEmitter = new vscode.EventEmitter<BridgeConnectionState>();

  readonly onDidChangeConnectionState = this.connectionEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.startManifestWatcher();
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.restartManifestWatcher();
        this.connect();
      })
    );
  }

  connect(url?: string) {
    if (this.disposed) return;
    if (url?.trim()) this.explicitBridgeUrl = url.trim();
    const target = this.resolveBridgeTarget();
    if (!target) {
      this.closeSocket();
      this.scheduleReconnect();
      return;
    }
    if (this.socket && this.currentUrl === target.url && this.currentInstanceId === target.instanceId) return;
    this.setState("connecting");
    this.currentUrl = target.url;
    this.currentInstanceId = target.instanceId;
    this.socket?.close();
    const generation = ++this.generation;
    const socket = new WebSocket(target.url);
    this.socket = socket;
    this.requestGenerations.clear();
    socket.onopen = () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      if (this.reconnect) clearTimeout(this.reconnect);
      this.pending.splice(0);
      this.send({
        type: MessageTypes.IdeRegister,
        ide: "vscode",
        workspaceRoot: this.workspaceRoot(),
        capabilities: this.capabilities(),
        debuggerProtocolVersion: 2,
        debuggerFeatures: this.debuggerFeatures()
      });
      this.setState("connected");
      this.heartbeat = setInterval(() => {
        this.send({ type: MessageTypes.IdeHeartbeat });
      }, 5000);
    };
    socket.onmessage = (event) => {
      if (!this.isCurrentSocket(socket, generation)) return;
      const message = this.parseMessage(event.data);
      if (!message) return;
      if (message.type === MessageTypes.BridgeWelcome && !this.workspaceMatches(message.workspaceRoot)) {
        this.socket?.close();
        return;
      }
      if (message.type === MessageTypes.BridgeRejected) {
        this.setState("rejected");
        this.socket?.close();
        return;
      }
      this.rememberRequestGeneration(message, generation);
      for (const listener of this.listeners) listener(message);
    };
    socket.onclose = () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.pending.splice(0);
      this.requestGenerations.clear();
      this.socket = undefined;
      this.setState("disconnected");
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.pending.splice(0);
      this.requestGenerations.clear();
      this.socket = undefined;
      this.setState("disconnected");
      this.scheduleReconnect();
    };
  }

  onMessage(listener: (message: BridgeMessage) => void) {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  send(message: BridgeMessage) {
    const correlationId = this.correlationId(message);
    if (correlationId && this.requestGenerations.get(correlationId) !== this.generation) return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ ...message, timestamp: new Date().toISOString() }));
      if (correlationId) this.requestGenerations.delete(correlationId);
      return;
    }
    if (message.type !== MessageTypes.IdeHeartbeat) {
      this.pending.push(message);
      if (this.pending.length > 200) this.pending.splice(0, this.pending.length - 200);
    }
  }

  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.requestGenerations.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.watcher?.dispose();
    this.socket?.close();
    this.connectionEmitter.dispose();
  }

  capabilities(): AnyRecord {
    return {
      visualBreakpoints: true,
      debugCommands: true,
      confirmationDialog: true,
      structuredConfirmation: true,
      consentSettings: true,
      webviewPanel: true,
      variableSnapshot: true,
      runToLine: true,
      setVariable: true,
      setVariableMode: "evaluateAssignment",
      conditionalBreakpoints: true,
      hitConditionalBreakpoints: true,
      tracepoints: true,
      adoptSession: true,
      debugSessionTracking: true,
      breakpointHitTracking: true,
      evaluate: true,
      provider: "vscode-debug-api"
    };
  }

  debuggerFeatures(): Record<string, boolean> {
    return {
      breakpointUpdate: true,
      eventStream: true,
      stackPagination: true,
      variableHandles: true,
      nativeSetVariable: true,
      causalDebugStart: true
    };
  }

  workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private resolveBridgeTarget(): { url: string; instanceId?: string } | null {
    if (this.explicitBridgeUrl) return { url: this.explicitBridgeUrl };
    const config = vscode.workspace.getConfiguration("breakpilot");
    const inspected = config.inspect<string>("bridgeUrl");
    const configured = inspected?.workspaceValue ?? inspected?.globalValue;
    if (configured && configured.trim()) return { url: configured.trim() };
    const workspaceRoot = this.workspaceRoot();
    if (workspaceRoot) {
      const bridgeFile = path.join(workspaceRoot, ".breakpilot", "bridge.json");
      try {
        const manifest = JSON.parse(fs.readFileSync(bridgeFile, "utf8")) as { bridgeUrl?: string; instanceId?: string };
        if (manifest.bridgeUrl) return { url: manifest.bridgeUrl, instanceId: manifest.instanceId };
      } catch {
        return null;
      }
    }
    return null;
  }

  private startManifestWatcher() {
    const workspaceRoot = this.workspaceRoot();
    if (!workspaceRoot) return;
    const pattern = new vscode.RelativePattern(workspaceRoot, ".breakpilot/bridge.json");
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

  private restartManifestWatcher() {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.startManifestWatcher();
  }

  private closeSocket() {
    this.generation += 1;
    this.requestGenerations.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.pending.splice(0);
    this.setState("disconnected");
  }

  private scheduleReconnect() {
    if (this.disposed) return;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => this.connect(), 2000);
  }

  private parseMessage(data: unknown): BridgeMessage | null {
    try {
      return JSON.parse(String(data)) as BridgeMessage;
    } catch {
      return null;
    }
  }

  private workspaceMatches(remote: unknown): boolean {
    if (typeof remote !== "string" || !remote) return true;
    const local = this.workspaceRoot();
    if (!local) return false;
    return path.resolve(remote) === path.resolve(local);
  }

  private setState(state: BridgeConnectionState) {
    if (this.state === state) return;
    this.state = state;
    this.connectionEmitter.fire(state);
    if (state === "connected" || state === "disconnected" || state === "rejected") {
      this.emitLocal({
        type: state === "connected" ? MessageTypes.IdeRegistered : MessageTypes.BridgeDisconnected,
        workspaceRoot: this.workspaceRoot(),
        state
      });
    }
  }

  private emitLocal(message: BridgeMessage) {
    for (const listener of this.listeners) listener(message);
  }

  private isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation && !this.disposed;
  }

  private correlationId(message: BridgeMessage): string | undefined {
    return typeof message.requestId === "string"
      ? message.requestId
      : typeof message.confirmationId === "string"
        ? message.confirmationId
        : undefined;
  }

  private rememberRequestGeneration(message: BridgeMessage, generation: number): void {
    const correlationId = this.correlationId(message);
    if (!correlationId) return;
    this.requestGenerations.set(correlationId, generation);
    while (this.requestGenerations.size > 200) {
      const oldest = this.requestGenerations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.requestGenerations.delete(oldest);
    }
  }
}
