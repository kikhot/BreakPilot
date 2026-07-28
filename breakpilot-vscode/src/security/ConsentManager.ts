import * as vscode from "vscode";
import { BridgeClient } from "../bridge/BridgeClient";
import { BridgeMessage, MessageTypes } from "../bridge/MessageProtocol";
import { ConfirmationChoice, showConfirmationDialog } from "../ui/ConfirmationDialog";

type SafeInspectionsMode = "ask_once_per_project" | "always_ask" | "always_allow_trusted_projects";
type DebugControlsMode = "ask_once_per_session" | "always_ask";

const SAFE_ACTIONS_KEY = "breakpilot.allowedSafeInspectionActions";

export class ConsentManager {
  private readonly sessionAllowedActions = new Map<string, Set<string>>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async handleConfirmation(bridge: BridgeClient, message: BridgeMessage) {
    const autoScope = this.automaticRememberScope(message);
    if (autoScope) {
      this.sendAllow(bridge, message, autoScope);
      return;
    }

    const choice = await showConfirmationDialog(message);
    if (!choice.allowed) {
      this.sendReject(bridge, message);
      return;
    }

    await this.remember(message, choice.rememberScope);
    this.sendAllow(bridge, message, choice.rememberScope);
  }

  clearSession(ideSessionId: string) {
    this.sessionAllowedActions.delete(ideSessionId);
  }

  async resetDecisions() {
    this.sessionAllowedActions.clear();
    await this.context.workspaceState.update(SAFE_ACTIONS_KEY, []);
  }

  private automaticRememberScope(message: BridgeMessage): string | null {
    const action = message.action;
    if (!action) return null;
    const risk = message.riskLevel ?? "control";
    if (risk === "safe") return this.safeInspectionScope(action);
    if (risk === "control") return this.debugControlScope(message.ideSessionId, action);
    if (risk === "high") return this.highRiskAllowlistScope(message);
    return null;
  }

  private safeInspectionScope(action: string): string | null {
    const mode = this.config<SafeInspectionsMode>("safeInspectionsMode", "ask_once_per_project");
    if (mode === "always_ask") return null;
    if (mode === "always_allow_trusted_projects") return this.trustedProject() ? "project" : null;
    return this.safeInspectionAllowed(action) ? "project" : null;
  }

  private debugControlScope(ideSessionId: string | undefined, action: string): string | null {
    const mode = this.config<DebugControlsMode>("debugControlsMode", "ask_once_per_session");
    if (mode === "always_ask" || !ideSessionId) return null;
    return this.sessionAllowedActions.get(ideSessionId)?.has(action) ? "session" : null;
  }

  private highRiskAllowlistScope(message: BridgeMessage): string | null {
    if (!this.config<boolean>("allowPersistentHighRiskApprovals", false)) return null;
    if (this.config<boolean>("allowlistTrustedProjectsOnly", true) && !this.trustedProject()) return null;

    const action = message.action ?? "";
    if (this.config<string[]>("allowedActions", ["readonly_evaluate"]).includes(action)) return "project";

    const expression = this.expressionForAllowlist(message);
    return this.config<string[]>("allowedExpressionPatterns", []).some((pattern) => this.patternMatches(pattern, expression))
      ? "project"
      : null;
  }

  private async remember(message: BridgeMessage, scope: string) {
    const action = message.action;
    if (!action) return;
    if (scope === "project" && message.riskLevel === "safe") {
      const existing = new Set(this.context.workspaceState.get<string[]>(SAFE_ACTIONS_KEY, []));
      existing.add(action);
      await this.context.workspaceState.update(SAFE_ACTIONS_KEY, [...existing]);
      return;
    }
    if (scope === "session") {
      const key = message.ideSessionId;
      if (!key) return;
      const allowed = this.sessionAllowedActions.get(key) ?? new Set<string>();
      allowed.add(action);
      this.sessionAllowedActions.set(key, allowed);
    }
  }

  private safeInspectionAllowed(action: string): boolean {
    return this.context.workspaceState.get<string[]>(SAFE_ACTIONS_KEY, []).includes(action);
  }

  private trustedProject(): boolean {
    return this.config<boolean>("trustedProject", false);
  }

  private expressionForAllowlist(message: BridgeMessage): string {
    const payloadExpression = message.payload?.expression;
    if (typeof payloadExpression === "string") return payloadExpression;
    return message.expressionPreview ?? "";
  }

  private patternMatches(pattern: string, value: string): boolean {
    if (!pattern || !value) return false;
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return value.includes(pattern);
    }
  }

  private config<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration("breakpilot").get<T>(key, fallback);
  }

  private sendAllow(bridge: BridgeClient, message: BridgeMessage, rememberScope: string) {
    bridge.send({
      type: MessageTypes.UserConfirmContinue,
      confirmationId: message.confirmationId,
      sessionId: message.sessionId,
      ideSessionId: message.ideSessionId,
      pauseEpoch: message.expectedPauseEpoch,
      originRequestId: message.originRequestId,
      action: message.action ?? "allow",
      rememberScope
    });
  }

  private sendReject(bridge: BridgeClient, message: BridgeMessage) {
    bridge.send({
      type: MessageTypes.UserRejectContinue,
      confirmationId: message.confirmationId,
      sessionId: message.sessionId,
      ideSessionId: message.ideSessionId,
      pauseEpoch: message.expectedPauseEpoch,
      originRequestId: message.originRequestId
    });
  }
}

export type { ConfirmationChoice };
