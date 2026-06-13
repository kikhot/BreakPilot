import * as vscode from "vscode";
import { AgentBreakpoint, BridgeMessage, MessageTypes } from "../bridge/MessageProtocol";
import { BridgeClient } from "../bridge/BridgeClient";

export class BreakpointSync {
  private byAgentId = new Map<string, { breakpoint: vscode.SourceBreakpoint; sessionId?: string; workspaceRoot?: string }>();

  constructor(private readonly bridge: BridgeClient) {}

  async handle(message: BridgeMessage) {
    if (message.type === MessageTypes.AgentSetBreakpoint && message.breakpoint) {
      await this.addAgentBreakpoint(message.breakpoint, message);
    }
    if (message.type === MessageTypes.AgentRemoveBreakpoint && message.breakpointId) {
      this.removeAgentBreakpoint(message.breakpointId);
    }
    if (message.type === MessageTypes.AgentClearBreakpoints || message.type === "bridge_disconnected") {
      this.clearAgentBreakpoints(message);
    }
  }

  watch(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.debug.onDidChangeBreakpoints((event) => {
        for (const removed of event.removed) {
          const agentId = [...this.byAgentId.entries()].find(([, entry]) => entry.breakpoint === removed)?.[0];
          if (agentId) {
            this.byAgentId.delete(agentId);
            this.bridge.send({
              type: MessageTypes.IdeBreakpointRemoved,
              breakpointId: agentId
            });
          }
        }
      }),
      new vscode.Disposable(() => this.clearAgentBreakpoints({ type: "dispose" }))
    );
  }

  private async addAgentBreakpoint(breakpoint: AgentBreakpoint, message: BridgeMessage) {
    const uri = vscode.Uri.file(breakpoint.file);
    const location = new vscode.Location(
      uri,
      new vscode.Position(Math.max(0, breakpoint.line - 1), Math.max(0, (breakpoint.column ?? 1) - 1))
    );
    const sourceBreakpoint = new vscode.SourceBreakpoint(
      location,
      true,
      breakpoint.condition,
      undefined,
      undefined
    );
    vscode.debug.addBreakpoints([sourceBreakpoint]);
    this.byAgentId.set(breakpoint.id, {
      breakpoint: sourceBreakpoint,
      sessionId: message.sessionId,
      workspaceRoot: message.workspaceRoot
    });
    this.bridge.send({
      type: MessageTypes.IdeBreakpointAdded,
      breakpointId: breakpoint.id,
      breakpoint
    });
  }

  private removeAgentBreakpoint(agentId: string) {
    const entry = this.byAgentId.get(agentId);
    if (!entry) return;
    vscode.debug.removeBreakpoints([entry.breakpoint]);
    this.byAgentId.delete(agentId);
  }

  private clearAgentBreakpoints(message: BridgeMessage) {
    const removed: vscode.SourceBreakpoint[] = [];
    for (const [agentId, entry] of this.byAgentId.entries()) {
      if (message.sessionId && entry.sessionId !== message.sessionId) continue;
      if (message.workspaceRoot && entry.workspaceRoot && entry.workspaceRoot !== message.workspaceRoot) continue;
      removed.push(entry.breakpoint);
      this.byAgentId.delete(agentId);
    }
    if (removed.length > 0) vscode.debug.removeBreakpoints(removed);
  }
}
