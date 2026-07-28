import * as vscode from "vscode";
import { BridgeClient } from "./bridge/BridgeClient";
import { MessageTypes } from "./bridge/MessageProtocol";
import { BreakpointSync } from "./debugger/BreakpointSync";
import { CommandExecutor } from "./debugger/CommandExecutor";
import { DebugSessionTracker } from "./debugger/DebugSessionTracker";
import { VariableReader } from "./debugger/VariableReader";
import { ConsentManager } from "./security/ConsentManager";
import { DebugPanelProvider } from "./ui/DebugPanelProvider";

export function activate(context: vscode.ExtensionContext) {
  const bridge = new BridgeClient(context);
  const consent = new ConsentManager(context);
  const tracker = new DebugSessionTracker(bridge, (ideSessionId) => consent.clearSession(ideSessionId));
  const variableReader = new VariableReader(bridge, tracker);
  const breakpoints = new BreakpointSync(bridge);
  const commands = new CommandExecutor(bridge, tracker, variableReader);
  const panel = new DebugPanelProvider(() => {
    bridge.send({
      type: MessageTypes.UserRequestAiAnalysis,
      workspaceRoot: bridge.workspaceRoot()
    });
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("breakpilot.connect", () => bridge.connect()),
    vscode.commands.registerCommand("breakpilot.showPanel", () => panel.show()),
    vscode.commands.registerCommand("breakpilot.resetDecisions", async () => {
      await consent.resetDecisions();
      vscode.window.showInformationMessage("BreakPilot decisions reset for this workspace.");
    }),
    bridge.onMessage(async (message) => {
      await breakpoints.handle(message);
      await commands.handle(message);
      await variableReader.handle(message);
      if (message.type === "agent_request_confirmation") {
        await consent.handleConfirmation(bridge, message);
      }
      if (shouldShowInPanel(message.type)) {
        panel.append(message);
      }
    }),
    bridge.onDidChangeConnectionState((state) => {
      if (state === "connected" || state === "disconnected" || state === "rejected") {
        tracker.invalidateBridgeGeneration();
        if (state === "connected") tracker.resendKnownSessionStates();
      }
      panel.append({
        type: "bridge_connection_state",
        state,
        workspaceRoot: bridge.workspaceRoot()
      });
    }),
    bridge
  );

  tracker.start(context);
  breakpoints.watch(context);
  bridge.connect();
}

export function deactivate() {}

function shouldShowInPanel(type: string): boolean {
  return (
    type.startsWith("bridge_") ||
    type.startsWith("ide_") ||
    type === MessageTypes.IdeBreakpointHit ||
    type === MessageTypes.IdeVariablesSnapshot
  );
}
