import { types } from "node:util";

import { AuditLogger } from "../audit/AuditLogger.ts";
import type {
  JsonSchema,
  ToolDefinition,
  ToolResponse,
  ToolValidationIssue
} from "../types/control.ts";
import { BreakPilotError, ErrorCodes, fail } from "../utils/errors.ts";
import { validateToolOutput } from "./ToolInputValidator.ts";

export type ToolOperationKind = "read" | "control" | "mutation";

const mutationTools = new Set([
  "bp_debug_start",
  "bp_debug_control",
  "bp_debug_run_to_line",
  "bp_debug_set_value",
  "bp_debug_eval",
  "bp_debug_set_breakpoint",
  "bp_debug_remove_breakpoint"
]);

export function operationKindForTool(name: string): ToolOperationKind {
  return mutationTools.has(name) ? "mutation" : "read";
}

function hasOwnError(candidate: ToolResponse): boolean | undefined {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    types.isProxy(candidate)
  ) {
    return undefined;
  }
  try {
    return Object.prototype.hasOwnProperty.call(candidate, "error");
  } catch {
    return undefined;
  }
}

function preciseIssues(
  schema: JsonSchema,
  candidate: ToolResponse,
  fallback: ToolValidationIssue[]
): ToolValidationIssue[] {
  const containsError = hasOwnError(candidate);
  if (containsError === undefined || !schema.oneOf) return fallback;
  const branches = schema.oneOf.filter((branch) =>
    (branch.required ?? []).includes("error") === containsError
  );
  if (branches.length !== 1) return fallback;
  const result = validateToolOutput(branches[0]!, candidate);
  return result.errors.length > 0 ? result.errors : fallback;
}

export class ToolResponseFinalizer {
  private readonly audit: AuditLogger;

  constructor(audit: AuditLogger) {
    this.audit = audit;
  }

  finalize(
    definition: ToolDefinition,
    candidate: ToolResponse,
    operation: ToolOperationKind,
    diagnostic = false
  ): ToolResponse {
    const schema = definition.outputSchema;
    const result = schema
      ? validateToolOutput(schema, candidate)
      : {
          errors: [{
            path: "$",
            keyword: "outputSchema",
            message: "tool definition must publish an output schema"
          }]
        };
    if (result.errors.length === 0) return candidate;

    const validationIssues = schema
      ? preciseIssues(schema, candidate, result.errors)
      : result.errors;
    const issues = validationIssues.map(({ path, keyword }) => ({ path, keyword }));
    const indeterminate = operation !== "read";
    const auditId = this.audit.record("tool_output_contract_violation", {
      tool: definition.name,
      issueCount: issues.length,
      issues
    });
    return fail(new BreakPilotError(
      ErrorCodes.OUTPUT_CONTRACT_VIOLATION,
      "Debugger tool returned a result that violates its published contract.",
      {
        tool: definition.name,
        issues,
        issueCount: issues.length,
        outcome: indeterminate ? "indeterminate" : "failed",
        retrySafe: !indeterminate
      }
    ), auditId, diagnostic);
  }
}
