import path from "node:path";
import type { VariableLimits } from "../types/inspection.ts";
import type { AnyRecord } from "../types/json.ts";
import type { BreakPilotPolicy, EvaluateMode } from "../types/policy.ts";
import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";
import { assertInsideWorkspace } from "../utils/path.ts";

export class SecurityPolicy {
  policy: BreakPilotPolicy;

  constructor(policy: BreakPilotPolicy) {
    this.policy = policy;
  }

  workspaceRoot(): string {
    return this.policy.workspace.root;
  }

  assertWorkspacePath(filePath: string): string {
    return assertInsideWorkspace(
      this.policy.workspace.root,
      path.resolve(this.policy.workspace.root, filePath),
      Boolean(this.policy.workspace.allowOutsideWorkspace)
    );
  }

  assertHostPort(host: string | undefined, port: number | string, operation = "attach"): void {
    const normalizedHost = host || "127.0.0.1";
    const normalizedPort = Number(port);
    const allowedHosts = this.policy.network.allowedHosts ?? [];
    const allowedPorts = this.policy.network.allowedPorts ?? [];
    if (!allowedHosts.includes(normalizedHost)) {
      throw new BreakPilotError(
        ErrorCodes.DEBUG_PORT_NOT_ALLOWED,
        `Host is not allowed for ${operation}: ${normalizedHost}`,
        { host: normalizedHost, allowedHosts }
      );
    }
    if (!allowedPorts.includes(normalizedPort)) {
      throw new BreakPilotError(
        ErrorCodes.DEBUG_PORT_NOT_ALLOWED,
        `Port is not allowed for ${operation}: ${normalizedPort}`,
        { port: normalizedPort, allowedPorts }
      );
    }
  }

  assertNotProduction(args: { env?: NodeJS.ProcessEnv | AnyRecord } = {}): void {
    if (!this.policy.runtime?.forbidProduction) return;
    const env = {
      ...process.env,
      ...(args.env || {})
    };
    const markers = [
      env.NODE_ENV,
      env.APP_ENV,
      env.ENV,
      env.RAILS_ENV,
      env.SPRING_PROFILES_ACTIVE
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    if (markers.some((value) => value.includes("prod"))) {
      throw new BreakPilotError(
        ErrorCodes.POLICY_VIOLATION,
        "Production-like environment is blocked by policy.",
        { markers }
      );
    }
  }

  assertEvaluate(
    expression: string,
    mode: EvaluateMode = this.policy.evaluate.defaultMode,
    options: { ideConfirmationAvailable?: boolean } = {}
  ): void {
    const text = String(expression || "");
    if (!text.trim()) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "Expression is required.");
    }
    if (text.length > 500) {
      throw new BreakPilotError(
        ErrorCodes.EVALUATE_BLOCKED_BY_POLICY,
        "Expression is too long for policy.",
        { maxLength: 500 }
      );
    }
    if (mode === "unsafe") {
      // Headless/DAP providers cannot collect interactive IDE consent, so unsafe
      // evaluate remains blocked there. IDE providers may proceed only to the
      // structured confirmation flow; the expression is not executed yet.
      if (this.policy.evaluate.requireConfirmationForUnsafe && !options.ideConfirmationAvailable) {
        throw new BreakPilotError(
          ErrorCodes.EVALUATE_BLOCKED_BY_POLICY,
          "Unsafe evaluate requires explicit user confirmation through the IDE bridge.",
          { mode }
        );
      }
      return;
    }
    if (mode === "readonly") {
      const unsafeTokens = [
        "=",
        "++",
        "--",
        "=>",
        "import ",
        "require(",
        "new ",
        "delete ",
        "await ",
        ";"
      ];
      const callCheck = readonlyCallCheck(text);
      const hasUnsafeToken = unsafeTokens.some((token) => text.includes(token));
      if (!callCheck.allowed || hasUnsafeToken) {
        throw new BreakPilotError(
          ErrorCodes.EVALUATE_BLOCKED_BY_POLICY,
          "Readonly evaluate only allows field, property, and index inspection.",
          { expression: text, mode, suggestedExpression: callCheck.suggestedExpression }
        );
      }
    }
  }

  variableLimits(overrides: Partial<VariableLimits> = {}): Required<VariableLimits> {
    const boundedInteger = (value: unknown, configuredMaximum: unknown, minimum: number): number => {
      const rawMaximum = Number(configuredMaximum);
      const maximum = Number.isFinite(rawMaximum)
        ? Math.max(minimum, Math.floor(rawMaximum))
        : minimum;
      const rawValue = value === undefined ? maximum : Number(value);
      if (!Number.isFinite(rawValue)) return maximum;
      return Math.min(maximum, Math.max(minimum, Math.floor(rawValue)));
    };
    return {
      maxDepth: boundedInteger(overrides.maxDepth, this.policy.variables.maxDepth ?? 3, 0),
      maxItems: boundedInteger(overrides.maxItems, this.policy.variables.maxItems ?? 50, 1),
      maxStringLength: boundedInteger(
        overrides.maxStringLength,
        this.policy.variables.maxStringLength ?? 2000,
        1
      ),
      redactPatterns: overrides.redactPatterns ?? this.policy.variables.redactPatterns ?? []
    };
  }
}

function readonlyCallCheck(expression: string): { allowed: boolean; suggestedExpression?: string } {
  const suggestedExpression = expression.replace(/\.([a-zA-Z_$][\w$]*)\s*\(\s*\)/g, ".$1");
  const callMatches = [...expression.matchAll(/([.]?)([a-zA-Z_$][\w$]*)\s*\(([^()]*)\)/g)];
  if (callMatches.length === 0) return { allowed: true };
  const blockedMemberNames = new Set([
    "add",
    "append",
    "clear",
    "close",
    "connect",
    "continue",
    "delete",
    "disconnect",
    "execute",
    "notify",
    "open",
    "put",
    "read",
    "remove",
    "resume",
    "run",
    "save",
    "send",
    "set",
    "sleep",
    "start",
    "stop",
    "update",
    "wait",
    "write"
  ]);
  const allowed = callMatches.every((match) => {
    const dot = match[1];
    const name = match[2] ?? "";
    const args = match[3] ?? "";
    if (dot !== ".") return false;
    if (args.trim() !== "") return false;
    return !blockedMemberNames.has(name);
  });
  return { allowed, suggestedExpression: suggestedExpression === expression ? undefined : suggestedExpression };
}
