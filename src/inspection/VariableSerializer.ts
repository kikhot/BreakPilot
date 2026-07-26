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

function stringWasTruncated(value: unknown, maxStringLength: number): boolean {
  return typeof value === "string" && value.length > maxStringLength;
}

function variableSummary(variable: DapVariable, maxStringLength: number): string {
  return String(truncateString(String(variable.value ?? ""), maxStringLength));
}

function declaredChildrenCount(variable: DapVariable): number | undefined {
  const named = typeof variable.namedVariables === "number" ? variable.namedVariables : undefined;
  const indexed = typeof variable.indexedVariables === "number" ? variable.indexedVariables : undefined;
  return named === undefined && indexed === undefined ? undefined : (named ?? 0) + (indexed ?? 0);
}

function isReadOnly(variable: DapVariable): boolean {
  const attributes = variable.presentationHint?.attributes;
  return Array.isArray(attributes) && attributes.includes("readOnly");
}

function applyChildCompleteness(
  target: { complete?: boolean; truncated: boolean },
  returnedCount: number,
  exposedLimit: number,
  declaredCount: number | undefined,
  omittedReturnedChild = false,
  childEvidence: { knownIncomplete: boolean; unknown: boolean } = {
    knownIncomplete: false,
    unknown: false
  }
): void {
  if (target.truncated) {
    target.complete = false;
    return;
  }
  if (childEvidence.knownIncomplete) {
    target.complete = false;
    target.truncated = true;
    return;
  }
  if (
    returnedCount > exposedLimit ||
    omittedReturnedChild ||
    (declaredCount !== undefined && returnedCount < declaredCount)
  ) {
    target.complete = false;
    target.truncated = true;
    return;
  }
  if (childEvidence.unknown) {
    delete target.complete;
    return;
  }
  if (declaredCount !== undefined) target.complete = true;
}

function childCompletenessEvidence(
  children: Array<{ complete?: boolean; truncated: boolean }>
): { knownIncomplete: boolean; unknown: boolean } {
  let unknown = false;
  for (const child of children) {
    if (child.truncated || child.complete === false) {
      return { knownIncomplete: true, unknown: false };
    }
    if (child.complete !== true) unknown = true;
  }
  return { knownIncomplete: false, unknown };
}

interface SerializedVariableMapExposure {
  variables: SerializedVariableMap;
  omittedReturnedChild: boolean;
}

function defineMapEntry(
  map: SerializedVariableMap,
  name: string,
  value: SerializedVariableMap[string]
): void {
  Object.defineProperty(map, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
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
    return (await this.#serializeVariableMapExposure(variables, depth, seen)).variables;
  }

  async #serializeVariableMapExposure(
    variables: DapVariable[],
    depth = 0,
    seen = new Set<number>()
  ): Promise<SerializedVariableMapExposure> {
    const output: SerializedVariableMap = {};
    const limited = variables.slice(0, this.limits.maxItems);
    let omittedReturnedChild = variables.length > limited.length;
    for (const variable of limited) {
      if (Object.prototype.hasOwnProperty.call(output, variable.name)) omittedReturnedChild = true;
      defineMapEntry(output, variable.name, await this.serializeVariable(variable, depth, seen));
    }
    if (variables.length > limited.length) {
      if (Object.prototype.hasOwnProperty.call(output, "__truncated__")) omittedReturnedChild = true;
      defineMapEntry(output, "__truncated__", {
        kind: "metadata",
        value: `Showing ${limited.length} of ${variables.length} variables.`,
        truncated: true
      });
    }
    return { variables: output, omittedReturnedChild };
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
    const valueTruncated = !redacted && stringWasTruncated(variable.value ?? "", this.limits.maxStringLength);
    const kind = inferKind(variable);
    const ref = variable.variablesReference && variable.variablesReference > 0 ? variable.variablesReference : undefined;
    const summary = redacted ? "[REDACTED]" : variableSummary(variable, this.limits.maxStringLength);
    const path = [...parentPath, variable.name];
    const raw = ref || redacted ? undefined : truncateString(variable.value ?? "", this.limits.maxStringLength);
    const childrenCount = declaredChildrenCount(variable);
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
      truncated: valueTruncated,
      ...(valueTruncated ? { complete: false } : !ref ? { complete: true } : {}),
      ...(childrenCount === undefined ? {} : { childrenCount }),
      ...(isReadOnly(variable) ? { modifiable: false } : {}),
      ...(this.session.capabilities?.supportsSetVariable === true ? { mutationMode: "native" as const } : {}),
      redacted
    };
    if (raw !== undefined) node.raw = raw;

    if (redacted || !ref) return node;

    if (this.objectFields === "none" || this.objectFields === "preview") {
      node.truncated = true;
      node.complete = false;
      return node;
    }

    const maxDepth = this.objectFields === "shallow" ? 1 : this.limits.maxDepth;
    if (depth >= maxDepth) {
      node.truncated = true;
      node.complete = false;
      node.children = [];
      return node;
    }

    if (seen.has(ref)) {
      node.truncated = true;
      node.complete = false;
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
    applyChildCompleteness(
      node,
      children.length,
      this.limits.maxItems,
      childrenCount,
      false,
      childCompletenessEvidence(node.children)
    );
    seen.delete(ref);
    return node;
  }

  async serializeVariable(
    variable: DapVariable,
    depth = 0,
    seen = new Set<number>()
  ): Promise<SerializedVariable> {
    const redacted = this.redactor.shouldRedact(variable.name);
    const valueTruncated = !redacted && stringWasTruncated(variable.value ?? "", this.limits.maxStringLength);
    const kind = inferKind(variable);
    const result: SerializedVariable = {
      name: variable.name,
      type: variable.type ?? "",
      kind,
      valuePreview: redacted
        ? "[REDACTED]"
        : String(truncateString(String(variable.value ?? ""), this.limits.maxStringLength)),
      variablesReference: variable.variablesReference ?? 0,
      truncated: valueTruncated,
      ...(valueTruncated ? { complete: false } : !variable.variablesReference ? { complete: true } : {}),
      ...(declaredChildrenCount(variable) === undefined ? {} : { childrenCount: declaredChildrenCount(variable) }),
      ...(isReadOnly(variable) ? { modifiable: false } : {}),
      ...(this.session.capabilities?.supportsSetVariable === true ? { mutationMode: "native" as const } : {}),
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
      result.complete = false;
      return result;
    }

    const maxDepth = this.objectFields === "shallow" ? 1 : this.limits.maxDepth;
    if (depth >= maxDepth) {
      result.truncated = true;
      result.complete = false;
      result.value = {};
      return result;
    }

    if (seen.has(variable.variablesReference)) {
      result.truncated = true;
      result.complete = false;
      result.cycle = true;
      result.value = "[Circular]";
      return result;
    }

    seen.add(variable.variablesReference);
    const children = await this.session.variables(variable.variablesReference, {
      start: 0,
      count: this.limits.maxItems
    });
    const exposure = await this.#serializeVariableMapExposure(children, depth + 1, seen);
    result.value = exposure.variables;
    const childrenCount = declaredChildrenCount(variable);
    applyChildCompleteness(
      result,
      children.length,
      this.limits.maxItems,
      childrenCount,
      exposure.omittedReturnedChild,
      childCompletenessEvidence(Object.values(exposure.variables))
    );
    seen.delete(variable.variablesReference);
    return result;
  }
}
