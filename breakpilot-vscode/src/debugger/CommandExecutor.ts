import * as vscode from "vscode";
import { BridgeClient } from "../bridge/BridgeClient";
import { AnyRecord, BridgeMessage, MessageTypes } from "../bridge/MessageProtocol";
import { DebugSessionTracker } from "./DebugSessionTracker";
import { VariableReader } from "./VariableReader";

export class CommandExecutor {
  constructor(
    private readonly bridge: BridgeClient,
    private readonly tracker: DebugSessionTracker,
    private readonly variableReader: VariableReader
  ) {}

  async handle(message: BridgeMessage) {
    switch (message.type) {
      case MessageTypes.AgentContinue:
        await this.executeDebugCommand(message, "continue", "workbench.action.debug.continue");
        break;
      case MessageTypes.AgentPause:
        await this.executeDebugCommand(message, "pause", "workbench.action.debug.pause");
        break;
      case MessageTypes.AgentStepOver:
        await this.executeDebugCommand(message, "step_over", "workbench.action.debug.stepOver");
        break;
      case MessageTypes.AgentStepInto:
        await this.executeDebugCommand(message, "step_into", "workbench.action.debug.stepInto");
        break;
      case MessageTypes.AgentStepOut:
        await this.executeDebugCommand(message, "step_out", "workbench.action.debug.stepOut");
        break;
      case MessageTypes.AgentRunToLine:
        await this.runToLine(message);
        break;
      case MessageTypes.AgentSetVariable:
        await this.setVariable(message);
        break;
      case MessageTypes.AgentStopDebug:
        await this.stopDebug(message);
        break;
      case MessageTypes.AgentEvaluate:
        await this.evaluate(message);
        break;
    }
  }

  private async executeDebugCommand(message: BridgeMessage, command: string, vscodeCommand: string) {
    const session = this.targetSession(message);
    if (!session) {
      this.sendError(message, command, "IDE_SESSION_NOT_FOUND", "VS Code debug session was not found.");
      return;
    }
    if (vscode.debug.activeDebugSession !== session) {
      this.sendError(
        message,
        command,
        "SESSION_NOT_ACTIVE",
        "VS Code can only continue or step the active debug session from the extension API."
      );
      return;
    }
    try {
      await vscode.commands.executeCommand(vscodeCommand);
      this.sendResult(message, command, { ok: true });
    } catch (error) {
      this.sendError(message, command, "IDE_COMMAND_FAILED", this.errorMessage(error));
    }
  }

  private async stopDebug(message: BridgeMessage) {
    const session = this.targetSession(message);
    if (!session) {
      this.sendError(message, "stop_debug", "IDE_SESSION_NOT_FOUND", "VS Code debug session was not found.");
      return;
    }
    try {
      await vscode.debug.stopDebugging(session);
      this.sendResult(message, "stop_debug", { ok: true });
    } catch (error) {
      this.sendError(message, "stop_debug", "IDE_COMMAND_FAILED", this.errorMessage(error));
    }
  }

  private async evaluate(message: BridgeMessage) {
    const expression = this.expressionFromMessage(message);
    if (!expression) {
      this.sendError(message, "evaluate", "INVALID_ARGUMENT", "Expression is required.");
      return;
    }
    const response = await this.variableReader.evaluate(message.ideSessionId, expression, {
      ...(message.options ?? {}),
      ...(message.payload ?? {}),
      frameId: message.frameId ?? message.options?.frameId ?? message.payload?.frameId,
      threadId: message.threadId ?? message.options?.threadId ?? message.payload?.threadId
    });
    if (response.error) {
      this.sendError(message, "evaluate", "EVALUATE_FAILED", response.error);
      return;
    }
    this.sendResult(message, "evaluate", response.result ?? {});
  }

  private async setVariable(message: BridgeMessage) {
    const response = await this.variableReader.setVariable(message.ideSessionId, message.path, message.newValue, {
      ...(message.options ?? {}),
      ...(message.payload ?? {}),
      frameId: message.frameId ?? message.options?.frameId ?? message.payload?.frameId,
      threadId: message.threadId ?? message.options?.threadId ?? message.payload?.threadId
    });
    if (response.error) {
      this.sendError(message, "set_variable", "SET_VARIABLE_FAILED", response.error);
      return;
    }
    this.sendResult(message, "set_variable", response.result ?? {});
  }

  private async runToLine(message: BridgeMessage) {
    const filePath = typeof message.filePath === "string" ? message.filePath : message.file;
    if (!filePath || !message.line) {
      this.sendError(message, "run_to_line", "INVALID_ARGUMENT", "filePath and line are required.");
      return;
    }
    try {
      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const position = new vscode.Position(Math.max(0, message.line - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      await vscode.commands.executeCommand("editor.debug.action.runToCursor");
      this.sendResult(message, "run_to_line", {
        status: "running",
        position: { filePath, line: message.line }
      });
    } catch (error) {
      this.sendError(message, "run_to_line", "RUN_TO_LINE_FAILED", this.errorMessage(error));
    }
  }

  private targetSession(message: BridgeMessage): vscode.DebugSession | undefined {
    return this.tracker.find(message.ideSessionId);
  }

  private expressionFromMessage(message: BridgeMessage): string | undefined {
    const candidates = [
      message.expression,
      message.payload?.expression,
      message.options?.expression,
      message.result?.expression,
      message.command && message.command !== "evaluate" ? message.command : undefined
    ];
    return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
  }

  private sendResult(message: BridgeMessage, command: string, result: AnyRecord) {
    this.bridge.send({
      type: MessageTypes.IdeCommandResult,
      requestId: message.requestId,
      sessionId: message.sessionId,
      ideSessionId: message.ideSessionId,
      command,
      result
    });
  }

  private sendError(message: BridgeMessage, command: string, code: string, text: string) {
    this.bridge.send({
      type: MessageTypes.IdeCommandResult,
      requestId: message.requestId,
      sessionId: message.sessionId,
      ideSessionId: message.ideSessionId,
      command,
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
