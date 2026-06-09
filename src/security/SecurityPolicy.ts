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

  assertEvaluate(expression: string, mode: EvaluateMode = this.policy.evaluate.defaultMode): void {
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
      if (this.policy.evaluate.requireConfirmationForUnsafe) {
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
      const hasCall = /\b[a-zA-Z_$][\w$]*\s*\(/.test(text);
      const hasUnsafeToken = unsafeTokens.some((token) => text.includes(token));
      if (hasCall || hasUnsafeToken) {
        throw new BreakPilotError(
          ErrorCodes.EVALUATE_BLOCKED_BY_POLICY,
          "Readonly evaluate only allows field, property, and index inspection.",
          { expression: text, mode }
        );
      }
    }
  }

  variableLimits(overrides: Partial<VariableLimits> = {}): Required<VariableLimits> {
    return {
      maxDepth: Number(overrides.maxDepth ?? this.policy.variables.maxDepth ?? 3),
      maxItems: Number(overrides.maxItems ?? this.policy.variables.maxItems ?? 50),
      maxStringLength: Number(
        overrides.maxStringLength ?? this.policy.variables.maxStringLength ?? 2000
      ),
      redactPatterns: overrides.redactPatterns ?? this.policy.variables.redactPatterns ?? []
    };
  }
}
