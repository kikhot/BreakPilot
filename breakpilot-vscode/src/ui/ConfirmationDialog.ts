import * as vscode from "vscode";
import { BridgeMessage } from "../bridge/MessageProtocol";

export type ConfirmationChoice = {
  allowed: boolean;
  rememberScope: "once" | "session" | "project";
};

type ConfirmationButton = vscode.MessageItem & {
  allow: boolean;
  rememberScope: "once" | "session" | "project";
};

export async function showConfirmationDialog(message: BridgeMessage): Promise<ConfirmationChoice> {
  const buttons = buttonsForMessage(message);
  const selected = await vscode.window.showWarningMessage(
    buildMessageBody(message),
    {
      modal: true,
      detail: detailText(message)
    },
    ...buttons
  );
  if (!selected || !selected.allow) return { allowed: false, rememberScope: "once" };
  return {
    allowed: true,
    rememberScope: selected.rememberScope
  };
}

function buttonsForMessage(message: BridgeMessage): ConfirmationButton[] {
  const scopes = new Set(message.rememberScopes ?? ["once"]);
  const buttons: ConfirmationButton[] = [
    {
      title: "Allow Once",
      allow: true,
      rememberScope: "once"
    }
  ];
  if (scopes.has("project") && message.riskLevel === "safe") {
    buttons.push({
      title: "Always Allow in This Project",
      allow: true,
      rememberScope: "project"
    });
  }
  if (scopes.has("session") && message.riskLevel === "control") {
    buttons.push({
      title: "Allow for This Debug Session",
      allow: true,
      rememberScope: "session"
    });
  }
  buttons.push({
    title: "Deny",
    isCloseAffordance: true,
    allow: false,
    rememberScope: "once"
  });
  return buttons;
}

function buildMessageBody(message: BridgeMessage): string {
  return message.title ?? fallbackTitle(message.actionKind);
}

function fallbackTitle(actionKind: unknown): string {
  if (actionKind === "safe_inspection") return "Allow BreakPilot to inspect the paused debug state?";
  if (actionKind === "debug_control") return "Allow BreakPilot to control this debug session?";
  if (actionKind === "high_risk") return "BreakPilot wants to run a high-risk debug action";
  return "Allow BreakPilot debug action?";
}

function detailText(message: BridgeMessage): string {
  const lines = [
    message.description ?? "BreakPilot requests permission to run a debug action.",
    "",
    `Action: ${message.action ?? "debug_action"}`,
    `Risk: ${message.riskLevel ?? "control"}`
  ];
  if (message.sessionName) lines.push(`Debug session: ${message.sessionName}`);
  if (message.file) lines.push(`Location: ${message.line ? `${message.file}:${message.line}` : message.file}`);
  if (message.expressionPreview) lines.push(`Expression: ${message.expressionPreview}`);
  return lines.join("\n");
}
