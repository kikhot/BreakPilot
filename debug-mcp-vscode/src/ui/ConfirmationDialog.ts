import * as vscode from "vscode";
import { BridgeClient } from "../bridge/BridgeClient";
import { BridgeMessage, MessageTypes } from "../bridge/MessageProtocol";

export async function showBreakpointConfirmation(bridge: BridgeClient, message: BridgeMessage) {
  const choice = await vscode.window.showWarningMessage(
    "AI Debugger hit a breakpoint and wants to inspect variables.",
    { modal: true },
    "View Variables",
    "Let AI Analyze",
    "Continue",
    "Step Over",
    "Stop Debug"
  );
  if (!choice) {
    bridge.send({
      type: MessageTypes.UserRejectContinue,
      confirmationId: message.confirmationId,
      sessionId: message.sessionId
    });
    return;
  }
  if (choice === "Continue") {
    bridge.send({
      type: MessageTypes.UserConfirmContinue,
      confirmationId: message.confirmationId,
      sessionId: message.sessionId,
      action: "continue"
    });
    await vscode.commands.executeCommand("workbench.action.debug.continue");
  }
  if (choice === "Step Over") {
    bridge.send({
      type: MessageTypes.UserConfirmContinue,
      confirmationId: message.confirmationId,
      sessionId: message.sessionId,
      action: "step_over"
    });
    await vscode.commands.executeCommand("workbench.action.debug.stepOver");
  }
  if (choice === "Stop Debug") {
    await vscode.commands.executeCommand("workbench.action.debug.stop");
  }
}
