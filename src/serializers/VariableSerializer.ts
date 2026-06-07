import type {
  DapVariable,
  SerializedVariable,
  SerializedVariableMap,
  VariableKind,
  VariableLimits
} from "../types.ts";
import { DapSession } from "../dap/DapSession.ts";
import { Redactor } from "./Redactor.ts";

function inferKind(variable: DapVariable): VariableKind {
  if (variable.variablesReference && variable.variablesReference > 0) {
    if (variable.indexedVariables !== undefined) return "array";
    return "object";
  }
  const value = String(variable.value ?? "");
  if (value === "true" || value === "false") return "boolean";
  if (/^-?\d+(\.\d+)?$/.test(value)) return "number";
  if (value === "null" || value === "None" || value === "undefined") return "null";
  return "primitive";
}

function truncateString(value: unknown, maxStringLength: number): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= maxStringLength) return value;
  return `${value.slice(0, maxStringLength)}...`;
}

export class VariableSerializer {
  session: DapSession;
  limits: Required<VariableLimits>;
  redactor: Redactor;

  constructor(session: DapSession, limits: Required<VariableLimits>) {
    this.session = session;
    this.limits = limits;
    this.redactor = new Redactor(limits.redactPatterns);
  }

  async serializeVariables(
    variables: DapVariable[],
    depth = 0,
    seen = new Set<number>()
  ): Promise<SerializedVariableMap> {
    const output: SerializedVariableMap = {};
    const limited = variables.slice(0, this.limits.maxItems);
    for (const variable of limited) {
      output[variable.name] = await this.serializeVariable(variable, depth, seen);
    }
    if (variables.length > limited.length) {
      output.__truncated__ = {
        kind: "metadata",
        value: `Showing ${limited.length} of ${variables.length} variables.`,
        truncated: true
      };
    }
    return output;
  }

  async serializeVariable(
    variable: DapVariable,
    depth = 0,
    seen = new Set<number>()
  ): Promise<SerializedVariable> {
    const redacted = this.redactor.shouldRedact(variable.name);
    const kind = inferKind(variable);
    const result: SerializedVariable = {
      name: variable.name,
      type: variable.type ?? "",
      kind,
      valuePreview: redacted
        ? "[REDACTED]"
        : String(truncateString(String(variable.value ?? ""), this.limits.maxStringLength)),
      variablesReference: variable.variablesReference ?? 0,
      truncated: false,
      redacted
    };

    if (redacted) {
      result.value = "[REDACTED]";
      return result;
    }

    if (!variable.variablesReference || variable.variablesReference <= 0) {
      result.value = truncateString(variable.value ?? "", this.limits.maxStringLength);
      return result;
    }

    if (depth >= this.limits.maxDepth) {
      result.truncated = true;
      result.value = {};
      return result;
    }

    if (seen.has(variable.variablesReference)) {
      result.truncated = true;
      result.cycle = true;
      result.value = "[Circular]";
      return result;
    }

    seen.add(variable.variablesReference);
    const children = await this.session.variables(variable.variablesReference, {
      start: 0,
      count: this.limits.maxItems
    });
    result.value = await this.serializeVariables(children, depth + 1, seen);
    seen.delete(variable.variablesReference);
    return result;
  }
}
