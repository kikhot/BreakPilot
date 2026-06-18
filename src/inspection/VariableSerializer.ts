import type {
  ObjectFieldsMode,
  SerializedVariable,
  SerializedVariableMap,
  VariableNode,
  VariableKind,
  VariableLimits
} from "../types/inspection.ts";
import type { DapVariable } from "../types/dap.ts";
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

function variableSummary(variable: DapVariable, maxStringLength: number): string {
  return String(truncateString(String(variable.value ?? ""), maxStringLength));
}

export class VariableSerializer {
  session: DapSession;
  limits: Required<VariableLimits>;
  redactor: Redactor;
  objectFields: ObjectFieldsMode;

  constructor(
    session: DapSession,
    limits: Required<VariableLimits>,
    options: { objectFields?: ObjectFieldsMode } = {}
  ) {
    this.session = session;
    this.limits = limits;
    this.redactor = new Redactor(limits.redactPatterns);
    this.objectFields = options.objectFields ?? "deep";
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

  async serializeVariableNodes(
    variables: DapVariable[],
    depth = 0,
    seen = new Set<number>(),
    parentRef?: number,
    parentPath: string[] = []
  ): Promise<VariableNode[]> {
    const limited = variables.slice(0, this.limits.maxItems);
    const nodes: VariableNode[] = [];
    for (const variable of limited) {
      nodes.push(await this.serializeVariableNode(variable, depth, seen, parentRef, parentPath));
    }
    if (variables.length > limited.length) {
      nodes.push({
        name: "__truncated__",
        label: `Showing ${limited.length} of ${variables.length} variables.`,
        kind: "metadata",
        summary: `Showing ${limited.length} of ${variables.length} variables.`,
        path: [...parentPath, "__truncated__"],
        expandable: false,
        truncated: true
      });
    }
    return nodes;
  }

  async serializeVariableNode(
    variable: DapVariable,
    depth = 0,
    seen = new Set<number>(),
    parentRef?: number,
    parentPath: string[] = []
  ): Promise<VariableNode> {
    const redacted = this.redactor.shouldRedact(variable.name);
    const kind = inferKind(variable);
    const ref = variable.variablesReference && variable.variablesReference > 0 ? variable.variablesReference : undefined;
    const summary = redacted ? "[REDACTED]" : variableSummary(variable, this.limits.maxStringLength);
    const path = [...parentPath, variable.name];
    const raw = ref || redacted ? undefined : truncateString(variable.value ?? "", this.limits.maxStringLength);
    const node: VariableNode = {
      name: variable.name,
      label: `${variable.name} = ${summary}`,
      type: variable.type ?? "",
      kind,
      summary,
      ref,
      parentRef,
      path,
      expandable: Boolean(ref),
      truncated: false,
      redacted
    };
    if (raw !== undefined) node.raw = raw;

    if (redacted || !ref) return node;

    if (this.objectFields === "none" || this.objectFields === "preview") {
      node.truncated = true;
      return node;
    }

    const maxDepth = this.objectFields === "shallow" ? 1 : this.limits.maxDepth;
    if (depth >= maxDepth) {
      node.truncated = true;
      node.children = [];
      return node;
    }

    if (seen.has(ref)) {
      node.truncated = true;
      node.cycle = true;
      node.summary = "[Circular]";
      node.raw = undefined;
      node.children = [];
      return node;
    }

    seen.add(ref);
    const children = await this.session.variables(ref, {
      start: 0,
      count: this.limits.maxItems
    });
    node.children = await this.serializeVariableNodes(children, depth + 1, seen, ref, path);
    seen.delete(ref);
    return node;
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

    if (this.objectFields === "none" || this.objectFields === "preview") {
      result.truncated = true;
      return result;
    }

    const maxDepth = this.objectFields === "shallow" ? 1 : this.limits.maxDepth;
    if (depth >= maxDepth) {
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
