import * as vscode from "vscode";
import { BridgeClient } from "./bridge/BridgeClient";
import { MessageTypes } from "./bridge/MessageProtocol";
import { BreakpointSync } from "./debugger/BreakpointSync";
import { CommandExecutor } from "./debugger/CommandExecutor";
import { showBreakpointConfirmation } from "./ui/ConfirmationDialog";
import { DebugPanelProvider } from "./ui/DebugPanelProvider";

export function activate(context: vscode.ExtensionContext) {
  const bridge = new BridgeClient(context);
  const breakpoints = new BreakpointSync(bridge);
  const commands = new CommandExecutor();
  const panel = new DebugPanelProvider();

  context.subscriptions.push(
    vscode.commands.registerCommand("breakpilot.connect", () => bridge.connect()),
    vscode.commands.registerCommand("breakpilot.showPanel", () => panel.show()),
    bridge.onMessage(async (message) => {
      await breakpoints.handle(message);
      await commands.handle(message);
      if (message.type === "agent_request_confirmation") {
        await showBreakpointConfirmation(bridge, message);
      }
      if (message.type === MessageTypes.IdeBreakpointHit || message.type === MessageTypes.IdeVariablesSnapshot) {
        panel.append(message);
      }
    }),
    bridge
  );

  breakpoints.watch(context);
  bridge.connect();
}

export function deactivate() {}
