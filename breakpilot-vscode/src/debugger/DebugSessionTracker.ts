import * as vscode from "vscode";
import { BridgeClient } from "../bridge/BridgeClient";
import { AnyRecord, BridgeMessage, MessageTypes } from "../bridge/MessageProtocol";

type StoredSession = {
  session: vscode.DebugSession;
  ideSessionId: string;
  state: "running" | "paused" | "terminated";
  threadId?: number;
  topFrame?: AnyRecord;
  stopped?: AnyRecord;
  pauseEpoch: number;
  originRequestId?: string;
  pendingOriginRequestId?: string;
  debuggerFeatures: Record<string, boolean>;
};

type DebugStackItem = {
  session?: vscode.DebugSession;
  threadId?: number;
  frameId?: number;
  name?: string;
  source?: vscode.Uri | { uri?: vscode.Uri; path?: string; name?: string };
  range?: vscode.Range;
};

export class DebugSessionTracker {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly epochListeners = new Set<(ideSessionId: string) => void>();

  constructor(
    private readonly bridge: BridgeClient,
    private readonly onSessionTerminated: (ideSessionId: string) => void = () => {}
  ) {}

  start(context: vscode.ExtensionContext) {
    if (vscode.debug.activeDebugSession) {
      this.register(vscode.debug.activeDebugSession);
    }

    context.subscriptions.push(
      vscode.debug.onDidStartDebugSession((session) => this.register(session)),
      vscode.debug.onDidTerminateDebugSession((session) => this.terminate(session)),
      vscode.debug.onDidChangeActiveDebugSession((session) => {
        if (session) this.register(session);
        this.resendKnownSessionStates();
      }),
      vscode.debug.onDidChangeActiveStackItem((item) => {
        void this.handleActiveStackItem(item as DebugStackItem | undefined);
      }),
      vscode.debug.registerDebugAdapterTrackerFactory("*", {
        createDebugAdapterTracker: (session) => {
          this.register(session);
          return {
            onDidSendMessage: (message) => {
              void this.handleAdapterMessage(session, message as AnyRecord);
            }
          };
        }
      })
    );
  }

  find(ideSessionId?: string): vscode.DebugSession | undefined {
    if (ideSessionId) return this.sessions.get(ideSessionId)?.session;
    return vscode.debug.activeDebugSession;
  }

  sessionId(session: vscode.DebugSession): string {
    const rawId = (session as vscode.DebugSession & { id?: string }).id;
    const id = rawId || `${session.name}_${session.type}_${session.workspaceFolder?.uri.fsPath ?? "workspace"}`;
    return `vscode_${this.safeId(id)}`;
  }

  sessionInfo(ideSessionId?: string): StoredSession | undefined {
    if (ideSessionId) return this.sessions.get(ideSessionId);
    const active = vscode.debug.activeDebugSession;
    return active ? this.sessions.get(this.sessionId(active)) : undefined;
  }

  onEpochChanged(listener: (ideSessionId: string) => void): vscode.Disposable {
    this.epochListeners.add(listener);
    return new vscode.Disposable(() => this.epochListeners.delete(listener));
  }

  pauseEpoch(ideSessionId?: string): number | undefined {
    return this.sessionInfo(ideSessionId)?.pauseEpoch;
  }

  armOrigin(ideSessionId: string | undefined, originRequestId: string | undefined): void {
    const info = this.sessionInfo(ideSessionId);
    if (info && originRequestId) info.pendingOriginRequestId = originRequestId;
  }

  async captureTopFrame(session: vscode.DebugSession, threadId?: number, frameId?: number): Promise<AnyRecord> {
    const resolvedThreadId = threadId ?? this.sessionInfo(this.sessionId(session))?.threadId;
    if (resolvedThreadId == null) {
      return frameId != null ? { id: frameId } : {};
    }
    try {
      const response = await session.customRequest("stackTrace", {
        threadId: resolvedThreadId,
        startFrame: 0,
        levels: 1
      });
      const frame = response?.stackFrames?.[0] as AnyRecord | undefined;
      if (frame) return frame;
    } catch {
      // Some adapters reject stackTrace while the selected thread is changing.
    }
    return frameId != null ? { id: frameId } : {};
  }

  private register(session: vscode.DebugSession) {
    const ideSessionId = this.sessionId(session);
    if (this.sessions.has(ideSessionId)) return;
    this.sessions.set(ideSessionId, {
      session,
      ideSessionId,
      state: "running",
      pauseEpoch: 0,
      originRequestId: this.originFromSession(session),
      debuggerFeatures: {
        breakpointUpdate: true,
        eventStream: true,
        stackPagination: true,
        variableHandles: true,
        nativeSetVariable: false,
        causalDebugStart: true
      }
    });
  }

  private terminate(session: vscode.DebugSession) {
    const ideSessionId = this.sessionId(session);
    const info = this.sessions.get(ideSessionId);
    if (info) {
      info.state = "terminated";
      this.advanceEpoch(info);
    }
    this.onSessionTerminated(ideSessionId);
    this.bridge.send(this.sessionMessage(MessageTypes.IdeSessionTerminated, session, "terminated"));
    this.sessions.delete(ideSessionId);
  }

  private async handleActiveStackItem(item: DebugStackItem | undefined) {
    if (!item?.session) return;
    const session = item.session;
    this.register(session);
    const topFrame = "frameId" in item ? this.frameFromStackItem(item) : await this.captureTopFrame(session, item.threadId);
    this.markPaused(session, {
      reason: "pause",
      threadId: item.threadId,
      description: "VS Code debug session selected a paused stack frame.",
      topFrame
    });
  }

  private async handleAdapterMessage(session: vscode.DebugSession, message: AnyRecord) {
    if (message.type === "response" && message.command === "initialize" && message.success !== false) {
      const info = this.sessions.get(this.sessionId(session));
      if (info) {
        const body = (message.body ?? {}) as AnyRecord;
        info.debuggerFeatures.nativeSetVariable = body.supportsSetVariable === true;
        this.bridge.send(this.sessionMessage(MessageTypes.IdeSessionStarted, session, info.state, info.stopped));
      }
      return;
    }
    if (message.type !== "event") return;
    const event = String(message.event ?? "");
    const body = (message.body ?? {}) as AnyRecord;
    if (event === "stopped") {
      const threadId = this.numberValue(body.threadId);
      const topFrame = await this.captureTopFrame(session, threadId);
      const stopped = {
        ...body,
        reason: body.reason ?? "breakpoint",
        threadId,
        description: body.description ?? "VS Code debug session paused.",
        topFrame
      };
      this.markPaused(session, stopped);
      this.sendDebugEvent(session, "stopped", {
        threadId,
        position: this.positionFromFrame(topFrame),
        data: {
          reason: stopped.reason,
          description: stopped.description,
          allThreadsStopped: body.allThreadsStopped,
          hitBreakpointIds: body.hitBreakpointIds
        }
      });
      if ((body.reason ?? "breakpoint") === "breakpoint") {
        this.bridge.send({
          ...this.sessionMessage(MessageTypes.IdeBreakpointHit, session, "paused", stopped),
          reason: String(stopped.reason ?? "breakpoint"),
          description: String(stopped.description ?? "Paused on breakpoint.")
        });
      }
      return;
    }
    if (event === "continued") {
      this.markRunning(session, body);
      this.sendDebugEvent(session, "continued", {
        threadId: this.numberValue(body.threadId),
        data: { allThreadsStopped: body.allThreadsContinued }
      });
      return;
    }
    if (event === "output") {
      this.sendDebugEvent(session, "output", {
        category: typeof body.category === "string" ? body.category : undefined,
        message: typeof body.output === "string" ? body.output : undefined
      });
      return;
    }
    if (event === "thread" || event === "process" || event === "invalidated") {
      this.sendDebugEvent(session, event === "invalidated" ? "invalidated" : event, {
        threadId: this.numberValue(body.threadId),
        data: body
      });
      return;
    }
    if (event === "terminated" || event === "exited") {
      this.terminate(session);
    }
  }

  private markPaused(session: vscode.DebugSession, stopped: AnyRecord) {
    const ideSessionId = this.sessionId(session);
    const info = this.sessions.get(ideSessionId);
    if (!info) return;
    info.state = "paused";
    this.advanceEpoch(info);
    info.threadId = this.numberValue(stopped.threadId);
    info.topFrame = stopped.topFrame as AnyRecord | undefined;
    info.stopped = stopped;
    this.bridge.send(this.sessionMessage(MessageTypes.IdeSessionPaused, session, "paused", stopped));
    info.pendingOriginRequestId = undefined;
  }

  private markRunning(session: vscode.DebugSession, _body: AnyRecord = {}) {
    const ideSessionId = this.sessionId(session);
    const info = this.sessions.get(ideSessionId);
    if (info) {
      info.state = "running";
      info.stopped = undefined;
      this.advanceEpoch(info);
    }
    this.bridge.send(this.sessionMessage(MessageTypes.IdeSessionResumed, session, "running"));
  }

  private resendKnownSessionStates() {
    for (const info of this.sessions.values()) {
      const type =
        info.state === "paused"
          ? MessageTypes.IdeSessionPaused
          : info.state === "terminated"
            ? MessageTypes.IdeSessionTerminated
            : MessageTypes.IdeSessionStarted;
      this.bridge.send(this.sessionMessage(type, info.session, info.state, info.stopped));
    }
  }

  private sessionMessage(
    type: string,
    session: vscode.DebugSession,
    state: string,
    stopped?: AnyRecord
  ): BridgeMessage {
    const ideSessionId = this.sessionId(session);
    const info = this.sessions.get(ideSessionId);
    const topFrame = (stopped?.topFrame as AnyRecord | undefined) ?? info?.topFrame ?? {};
    const threadId = this.numberValue(stopped?.threadId) ?? info?.threadId;
    return {
      type,
      ideSessionId,
      workspaceRoot: session.workspaceFolder?.uri.fsPath ?? this.bridge.workspaceRoot(),
      name: session.name,
      language: this.language(session),
      state,
      active: vscode.debug.activeDebugSession === session,
      threadId,
      topFrame,
      stopped: stopped
        ? {
            reason: stopped.reason ?? "breakpoint",
            threadId,
            description: stopped.description ?? "VS Code debug session paused.",
            topFrame
          }
        : undefined,
      debuggerProtocolVersion: 2,
      debuggerFeatures: info?.debuggerFeatures ?? this.bridge.debuggerFeatures(),
      pauseEpoch: info?.pauseEpoch ?? 0,
      originRequestId: info?.pendingOriginRequestId ?? info?.originRequestId
    };
  }

  private advanceEpoch(info: StoredSession): void {
    info.pauseEpoch += 1;
    for (const listener of this.epochListeners) listener(info.ideSessionId);
  }

  private originFromSession(session: vscode.DebugSession): string | undefined {
    const value = session.configuration?.__breakpilotOriginRequestId;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private sendDebugEvent(session: vscode.DebugSession, kind: string, event: AnyRecord): void {
    const info = this.sessions.get(this.sessionId(session));
    if (!info) return;
    this.bridge.send({
      type: MessageTypes.IdeDebugEvent,
      ideSessionId: info.ideSessionId,
      pauseEpoch: info.pauseEpoch,
      event: { kind, ...event }
    });
  }

  private positionFromFrame(frame: AnyRecord): AnyRecord | undefined {
    const source = frame.source as AnyRecord | undefined;
    const filePath = typeof source?.path === "string" ? source.path : undefined;
    const line = this.numberValue(frame.line);
    return filePath || line ? { filePath, line } : undefined;
  }

  private frameFromStackItem(item: DebugStackItem): AnyRecord {
    const uri = this.sourceUri(item.source);
    return {
      id: item.frameId,
      name: item.name ?? "Stack Frame",
      line: item.range ? item.range.start.line + 1 : undefined,
      column: item.range ? item.range.start.character + 1 : undefined,
      source: uri
        ? {
            name: uri.fsPath.split(/[\\/]/).pop(),
            path: uri.fsPath
          }
        : undefined
    };
  }

  private sourceUri(source: DebugStackItem["source"]): vscode.Uri | undefined {
    if (!source) return undefined;
    if (source instanceof vscode.Uri) return source;
    if (source.uri instanceof vscode.Uri) return source.uri;
    if (typeof source.path === "string") return vscode.Uri.file(source.path);
    return undefined;
  }

  private language(session: vscode.DebugSession): string {
    const configured = session.configuration?.type;
    return typeof configured === "string" && configured ? configured : session.type;
  }

  private numberValue(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  private safeId(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]/g, "_");
  }
}
