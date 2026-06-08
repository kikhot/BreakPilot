import * as vscode from "vscode";
import { AgentBreakpoint, BridgeMessage, MessageTypes } from "../bridge/MessageProtocol";
import { BridgeClient } from "../bridge/BridgeClient";

export class BreakpointSync {
  private byAgentId = new Map<string, vscode.SourceBreakpoint>();

  constructor(private readonly bridge: BridgeClient) {}

  async handle(message: BridgeMessage) {
    if (message.type === MessageTypes.AgentSetBreakpoint && message.breakpoint) {
      await this.addAgentBreakpoint(message.breakpoint);
    }
    if (message.type === MessageTypes.AgentRemoveBreakpoint && message.breakpointId) {
      this.removeAgentBreakpoint(message.breakpointId);
    }
  }

  watch(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.debug.onDidChangeBreakpoints((event) => {
        for (const removed of event.removed) {
          const agentId = [...this.byAgentId.entries()].find(([, bp]) => bp === removed)?.[0];
          if (agentId) {
            this.byAgentId.delete(agentId);
            this.bridge.send({
              type: MessageTypes.IdeBreakpointRemoved,
              breakpointId: agentId
            });
          }
        }
      })
    );
  }

  private async addAgentBreakpoint(breakpoint: AgentBreakpoint) {
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
    this.byAgentId.set(breakpoint.id, sourceBreakpoint);
    this.bridge.send({
      type: MessageTypes.IdeBreakpointAdded,
      breakpointId: breakpoint.id,
      breakpoint
    });
  }

  private removeAgentBreakpoint(agentId: string) {
    const breakpoint = this.byAgentId.get(agentId);
    if (!breakpoint) return;
    vscode.debug.removeBreakpoints([breakpoint]);
    this.byAgentId.delete(agentId);
  }
}
