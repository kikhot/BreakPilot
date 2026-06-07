import * as vscode from "vscode";
import { BridgeMessage, MessageTypes } from "../bridge/MessageProtocol";

export class CommandExecutor {
  async handle(message: BridgeMessage) {
    if (message.type === MessageTypes.AgentContinue) {
      await vscode.commands.executeCommand("workbench.action.debug.continue");
    }
    if (message.type === "agent_step_over") {
      await vscode.commands.executeCommand("workbench.action.debug.stepOver");
    }
    if (message.type === "agent_step_into") {
      await vscode.commands.executeCommand("workbench.action.debug.stepInto");
    }
    if (message.type === "agent_step_out") {
      await vscode.commands.executeCommand("workbench.action.debug.stepOut");
    }
  }
}
