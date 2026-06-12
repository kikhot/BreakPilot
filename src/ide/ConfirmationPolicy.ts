import type { AnyRecord } from "../types/json.ts";
import type { EvaluateMode } from "../types/policy.ts";

export type IdeConfirmationActionKind =
  | "safe_inspection"
  | "debug_control"
  | "high_risk"
  | "breakpoint_management";

export type IdeConfirmationRiskLevel = "safe" | "control" | "high";
export type IdeConfirmationRememberScope = "once" | "session" | "project";

export interface IdeConfirmationRequest {
  action: string;
  actionKind: IdeConfirmationActionKind;
  riskLevel: IdeConfirmationRiskLevel;
  title: string;
  description: string;
  rememberScopes: IdeConfirmationRememberScope[];
  expressionPreview?: string;
  sessionName?: string;
  file?: string;
  line?: number;
  payload?: AnyRecord;
}

export function expressionLooksCallable(expression: string): boolean {
  // Conservative UI risk signal: function-like syntax is treated as high risk
  // because adapter-level evaluate may execute user code even in a paused frame.
  return /\b[a-zA-Z_$][\w$]*\s*\(/.test(expression);
}

export function previewExpression(expression: string, maxLength = 160): string {
  const compact = expression.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

export function evaluateConfirmationRequest(
  expression: string,
  mode: EvaluateMode = "readonly",
  context: AnyRecord = {}
): IdeConfirmationRequest {
  const normalizedMode = String(mode || "readonly");
  // Only readonly, non-call expressions get project-level memory. Other modes
  // stay high risk so the IDE can keep a per-request human checkpoint.
  const isReadonlyInspection = normalizedMode === "readonly" && !expressionLooksCallable(expression);
  const expressionPreview = previewExpression(expression);
  if (isReadonlyInspection) {
    return {
      action: "readonly_evaluate",
      actionKind: "safe_inspection",
      riskLevel: "safe",
      title: "Allow BreakPilot to inspect the paused debug state?",
      description: "BreakPilot wants to read a field or expression from the paused frame. Function calls are blocked by policy.",
      rememberScopes: ["once", "project"],
      expressionPreview,
      payload: { ...context, mode: normalizedMode, expression }
    };
  }

  return {
    action: normalizedMode === "unsafe" ? "unsafe_evaluate" : `${normalizedMode}_evaluate`,
    actionKind: "high_risk",
    riskLevel: "high",
    title: "BreakPilot wants to run a high-risk debug action",
    description: "This evaluate request may call code or change runtime state. Review the expression before allowing it.",
    rememberScopes: ["once"],
    expressionPreview,
    payload: { ...context, mode: normalizedMode, expression }
  };
}

export function variableInspectionConfirmationRequest(context: AnyRecord = {}): IdeConfirmationRequest {
  return {
    action: "inspect_variables",
    actionKind: "safe_inspection",
    riskLevel: "safe",
    title: "Allow BreakPilot to inspect the paused debug state?",
    description: "BreakPilot wants to read variables from the paused debug session. This does not continue or modify the program.",
    rememberScopes: ["once", "project"],
    payload: context
  };
}

export function debugControlConfirmationRequest(action: string, context: AnyRecord = {}): IdeConfirmationRequest {
  // Debug control changes the user's live debugging flow, so it can be remembered
  // for this session but should not silently carry across future debug sessions.
  const title =
    action === "stop_debug"
      ? "Allow BreakPilot to stop this debug session?"
      : "Allow BreakPilot to control this debug session?";
  const description =
    action === "stop_debug"
      ? "BreakPilot wants to stop the current debug session. This can discard the paused debugging context."
      : "BreakPilot wants to continue or step the current debug session.";
  return {
    action,
    actionKind: "debug_control",
    riskLevel: "control",
    title,
    description,
    rememberScopes: ["once", "session"],
    payload: context
  };
}
