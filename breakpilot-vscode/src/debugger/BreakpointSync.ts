import * as vscode from "vscode";
import { AgentBreakpoint, BridgeMessage, MessageTypes } from "../bridge/MessageProtocol";
import { BridgeClient } from "../bridge/BridgeClient";

export class BreakpointSync {
  private byAgentId = new Map<string, { breakpoint: vscode.SourceBreakpoint; sessionId?: string; workspaceRoot?: string }>();
  private byVsCodeId = new Map<string, string>();
  private agentBreakpoints = new WeakSet<vscode.SourceBreakpoint>();
  private suppressRemovedIds = new Set<string>();

  constructor(private readonly bridge: BridgeClient) {}

  async handle(message: BridgeMessage) {
    if (message.type === MessageTypes.AgentSetBreakpoint && message.breakpoint) {
      await this.addAgentBreakpoint(message.breakpoint, message);
    }
    if (message.type === MessageTypes.AgentRemoveBreakpoint && message.breakpointId) {
      this.removeAgentBreakpoint(message.breakpointId, message);
    }
    if (message.type === MessageTypes.AgentListBreakpoints) {
      this.listBreakpoints(message);
    }
    if (message.type === MessageTypes.AgentClearBreakpoints || message.type === "bridge_disconnected") {
      this.clearAgentBreakpoints(message);
    }
  }

  watch(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.debug.onDidChangeBreakpoints((event) => {
        for (const removed of event.removed) {
          if (this.suppressRemovedIds.delete(removed.id)) continue;
          const agentId = [...this.byAgentId.entries()].find(([, entry]) => entry.breakpoint === removed)?.[0];
          if (agentId) {
            const entry = this.byAgentId.get(agentId);
            this.byAgentId.delete(agentId);
            this.byVsCodeId.delete(removed.id);
            this.bridge.send({
              type: MessageTypes.IdeBreakpointRemoved,
              breakpointId: agentId,
              removed: true,
              breakpoint: entry ? this.toAgentBreakpoint(entry.breakpoint, agentId, "agent") : undefined
            });
          } else if (removed instanceof vscode.SourceBreakpoint) {
            this.bridge.send({
              type: MessageTypes.IdeBreakpointRemoved,
              breakpointId: removed.id,
              removed: true,
              breakpoint: this.toAgentBreakpoint(removed, removed.id, "user")
            });
          }
        }
        for (const added of event.added) {
          if (!(added instanceof vscode.SourceBreakpoint)) continue;
          if (this.agentBreakpoints.has(added)) continue;
          this.bridge.send({
            type: MessageTypes.IdeBreakpointAdded,
            breakpointId: added.id,
            breakpoint: this.toAgentBreakpoint(added, added.id, "user")
          });
        }
        for (const changed of event.changed) {
          if (!(changed instanceof vscode.SourceBreakpoint)) continue;
          const agentId = this.byVsCodeId.get(changed.id);
          this.bridge.send({
            type: MessageTypes.IdeBreakpointChanged,
            breakpointId: agentId ?? changed.id,
            breakpoint: this.toAgentBreakpoint(changed, agentId ?? changed.id, agentId ? "agent" : "user")
          });
        }
      }),
      new vscode.Disposable(() => this.clearAgentBreakpoints({ type: "dispose" }))
    );
  }

  private async addAgentBreakpoint(breakpoint: AgentBreakpoint, message: BridgeMessage) {
    const uri = vscode.Uri.file(breakpoint.file);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      this.sendBreakpointAddedError(message, breakpoint, "WORKSPACE_VIOLATION", "File was not found in the VS Code local filesystem.");
      return;
    }
    const location = new vscode.Location(
      uri,
      new vscode.Position(Math.max(0, breakpoint.line - 1), Math.max(0, (breakpoint.column ?? 1) - 1))
    );
    const sourceBreakpoint = new vscode.SourceBreakpoint(
      location,
      true,
      breakpoint.condition,
      breakpoint.hitCondition,
      breakpoint.logMessage
    );
    this.agentBreakpoints.add(sourceBreakpoint);
    const existing = this.byAgentId.get(breakpoint.id);
    if (existing) {
      this.byAgentId.delete(breakpoint.id);
      this.byVsCodeId.delete(existing.breakpoint.id);
      this.suppressRemovedIds.add(existing.breakpoint.id);
      vscode.debug.removeBreakpoints([existing.breakpoint]);
    }
    try {
      vscode.debug.addBreakpoints([sourceBreakpoint]);
    } catch (error) {
      this.sendBreakpointAddedError(message, breakpoint, "BREAKPOINT_NOT_VERIFIED", this.errorMessage(error));
      return;
    }
    this.byAgentId.set(breakpoint.id, {
      breakpoint: sourceBreakpoint,
      sessionId: message.sessionId,
      workspaceRoot: message.workspaceRoot
    });
    this.byVsCodeId.set(sourceBreakpoint.id, breakpoint.id);
    this.bridge.send({
      type: MessageTypes.IdeBreakpointAdded,
      requestId: message.requestId,
      sessionId: message.sessionId,
      ideSessionId: message.ideSessionId,
      breakpointId: breakpoint.id,
      breakpoint: {
        ...breakpoint,
        verified: true,
        adapterBreakpointId: sourceBreakpoint.id
      }
    });
  }

  private removeAgentBreakpoint(agentId: string, message: BridgeMessage) {
    const entry = this.byAgentId.get(agentId);
    let removed = false;
    if (entry) {
      this.suppressRemovedIds.add(entry.breakpoint.id);
      try {
        vscode.debug.removeBreakpoints([entry.breakpoint]);
        this.byAgentId.delete(agentId);
        this.byVsCodeId.delete(entry.breakpoint.id);
        removed = true;
      } catch {
        this.suppressRemovedIds.delete(entry.breakpoint.id);
      }
    }
    this.bridge.send({
      type: MessageTypes.IdeBreakpointRemoved,
      requestId: message.requestId,
      sessionId: message.sessionId,
      ideSessionId: message.ideSessionId,
      breakpointId: agentId,
      removed
    });
  }

  private clearAgentBreakpoints(message: BridgeMessage) {
    const removed: vscode.SourceBreakpoint[] = [];
    for (const [agentId, entry] of this.byAgentId.entries()) {
      if (message.sessionId && entry.sessionId !== message.sessionId) continue;
      if (message.workspaceRoot && entry.workspaceRoot && entry.workspaceRoot !== message.workspaceRoot) continue;
      removed.push(entry.breakpoint);
      this.suppressRemovedIds.add(entry.breakpoint.id);
      this.byAgentId.delete(agentId);
      this.byVsCodeId.delete(entry.breakpoint.id);
    }
    if (removed.length > 0) vscode.debug.removeBreakpoints(removed);
  }

  private listBreakpoints(message: BridgeMessage) {
    const breakpoints = vscode.debug.breakpoints
      .filter((breakpoint): breakpoint is vscode.SourceBreakpoint => breakpoint instanceof vscode.SourceBreakpoint)
      .map((breakpoint) => {
        const agentId = this.byVsCodeId.get(breakpoint.id);
        return this.toAgentBreakpoint(breakpoint, agentId ?? breakpoint.id, agentId ? "agent" : "user");
      });
    this.bridge.send({
      type: MessageTypes.IdeBreakpointsSnapshot,
      requestId: message.requestId,
      sessionId: message.sessionId,
      ideSessionId: message.ideSessionId,
      result: { breakpoints }
    });
  }

  private toAgentBreakpoint(
    breakpoint: vscode.SourceBreakpoint,
    id: string,
    owner: "agent" | "user"
  ): AgentBreakpoint {
    return {
      id,
      file: breakpoint.location.uri.fsPath,
      line: breakpoint.location.range.start.line + 1,
      column: breakpoint.location.range.start.character + 1,
      condition: breakpoint.condition,
      hitCondition: breakpoint.hitCondition,
      logMessage: breakpoint.logMessage,
      owner,
      enabled: breakpoint.enabled,
      verified: true
    };
  }

  private sendBreakpointAddedError(message: BridgeMessage, breakpoint: AgentBreakpoint, code: string, text: string) {
    this.bridge.send({
      type: MessageTypes.IdeBreakpointAdded,
      requestId: message.requestId,
      sessionId: message.sessionId,
      ideSessionId: message.ideSessionId,
      breakpointId: breakpoint.id,
      breakpoint,
      error: {
        code,
        message: text
      }
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
