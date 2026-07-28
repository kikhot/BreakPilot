import * as vscode from "vscode";
import { BridgeClient } from "../bridge/BridgeClient";
import { AnyRecord, BridgeMessage, MessageTypes } from "../bridge/MessageProtocol";
import { DebugSessionTracker } from "./DebugSessionTracker";
import { VariableReader } from "./VariableReader";
import { StackReader } from "./StackReader";

export class CommandExecutor {
  constructor(
    private readonly bridge: BridgeClient,
    private readonly tracker: DebugSessionTracker,
    private readonly variableReader: VariableReader
  ) {}

  async handle(message: BridgeMessage) {
    switch (message.type) {
      case MessageTypes.AgentStartDebug:
        await this.startDebug(message);
        break;
      case MessageTypes.AgentRequestStack:
        await this.readStack(message);
        break;
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
      case MessageTypes.AgentListRunConfigurations:
        await this.listRunConfigurations(message);
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
      this.tracker.armOrigin(message.ideSessionId, message.originRequestId ?? message.requestId);
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
    }, message.ref);
    if (response.error) {
      const code = response.error === "STALE_RUNTIME_HANDLE" || response.error === "VARIABLE_NOT_MUTABLE"
        ? response.error
        : "SET_VARIABLE_FAILED";
      this.sendError(message, "set_variable", code, response.error);
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

  private async listRunConfigurations(message: BridgeMessage) {
    if (message.filePath || message.file) {
      this.bridge.send({
        type: MessageTypes.IdeRunConfigurationsSnapshot,
        requestId: message.requestId,
        sessionId: message.sessionId,
        ideSessionId: message.ideSessionId,
        originRequestId: message.originRequestId,
        pauseEpoch: message.expectedPauseEpoch,
        result: {
          filePath: message.filePath ?? message.file,
          runPoints: []
        }
      });
      return;
    }
    const configurations = vscode.workspace
      .getConfiguration("launch")
      .get<AnyRecord[]>("configurations", [])
      .map((configuration) => ({
        name: String(configuration.name ?? ""),
        description: String(configuration.type ?? "VS Code Debug Configuration"),
        supportsDynamicLaunchOverrides: false
      }))
      .filter((configuration) => configuration.name.length > 0);
    this.bridge.send({
      type: MessageTypes.IdeRunConfigurationsSnapshot,
      requestId: message.requestId,
      sessionId: message.sessionId,
      ideSessionId: message.ideSessionId,
      originRequestId: message.originRequestId,
      pauseEpoch: message.expectedPauseEpoch,
      result: { configurations }
    });
  }

  private async startDebug(message: BridgeMessage) {
    const configurations = vscode.workspace.getConfiguration("launch").get<AnyRecord[]>("configurations", []);
    const runConfigName = typeof message.runConfigName === "string" ? message.runConfigName : undefined;
    const selected = runConfigName
      ? configurations.find((configuration) => configuration.name === runConfigName)
      : configurations[0];
    if (!selected) {
      this.sendError(message, "start_debug", "RUN_CONFIG_NOT_FOUND", "VS Code launch configuration was not found.");
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const configuration: vscode.DebugConfiguration = {
      ...selected,
      type: String(selected.type ?? ""),
      name: String(selected.name ?? runConfigName ?? "BreakPilot"),
      request: String(selected.request ?? "launch"),
      __breakpilotOriginRequestId: message.originRequestId ?? message.requestId
    };
    const started = await vscode.debug.startDebugging(folder, configuration);
    if (!started) {
      this.sendError(message, "start_debug", "IDE_COMMAND_FAILED", "VS Code rejected the debug start request.");
    }
  }

  private async readStack(message: BridgeMessage) {
    const session = this.targetSession(message);
    const pauseEpoch = this.tracker.pauseEpoch(message.ideSessionId);
    if (!session || pauseEpoch === undefined) {
      this.sendError(message, "request_stack", "IDE_SESSION_NOT_FOUND", "VS Code debug session was not found.");
      return;
    }
    if (message.expectedPauseEpoch !== pauseEpoch) {
      this.sendError(message, "request_stack", "STALE_RUNTIME_HANDLE", "Stack request belongs to another paused state.");
      return;
    }
    const threadId = typeof message.threadId === "number" ? message.threadId : this.tracker.sessionInfo(message.ideSessionId)?.threadId;
    if (threadId === undefined) {
      this.sendError(message, "request_stack", "INVALID_ARGUMENT", "A paused thread is required.");
      return;
    }
    try {
      const page = await new StackReader(session).read(threadId, message.offset ?? 0, message.limit ?? 20, pauseEpoch);
      this.bridge.send({
        type: MessageTypes.IdeStackSnapshot,
        requestId: message.requestId,
        sessionId: message.sessionId,
        ideSessionId: message.ideSessionId,
        originRequestId: message.originRequestId,
        pauseEpoch,
        result: page
      });
    } catch (error) {
      this.sendError(message, "request_stack", "STACK_READ_FAILED", this.errorMessage(error));
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
      originRequestId: message.originRequestId,
      pauseEpoch: message.expectedPauseEpoch,
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
      originRequestId: message.originRequestId,
      pauseEpoch: message.expectedPauseEpoch,
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
