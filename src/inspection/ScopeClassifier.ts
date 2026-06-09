import type { DapScope, DapVariable } from "../types/dap.ts";
import type { DebugLanguage } from "../types/debug.ts";
import type { ScopeCategory } from "../types/inspection.ts";

const focusedCategories = new Set<ScopeCategory>(["arguments", "locals", "receiver"]);

function normalizedName(value: string): string {
  return value.trim().toLowerCase();
}

function variableNames(variables: DapVariable[]): Set<string> {
  return new Set(variables.map((variable) => normalizedName(variable.name)));
}

function classifyByName(scopeName: string): ScopeCategory {
  const name = normalizedName(scopeName);
  if (["locals", "local", "block", "catch"].includes(name)) return "locals";
  if (["arguments", "args", "parameters", "params"].includes(name)) return "arguments";
  if (["closure", "closures"].includes(name)) return "closures";
  if (["globals", "global"].includes(name)) return "globals";
  if (["static", "statics", "static fields"].includes(name)) return "statics";
  if (["module", "modules", "script", "scripts"].includes(name)) return "module";
  if (name.includes("special") || name.includes("function") || name.includes("class")) return "runtime";
  return "other";
}

function classifyPython(scope: DapScope, variables: DapVariable[]): ScopeCategory {
  const name = normalizedName(scope.name);
  if (name === "locals") {
    const names = variableNames(variables);
    if (names.has("self") || names.has("cls")) return "locals";
    return "locals";
  }
  if (name === "globals") return "globals";
  if (name.includes("special") || name.includes("function") || name.includes("class")) return "runtime";
  return classifyByName(scope.name);
}

function classifyNode(scope: DapScope): ScopeCategory {
  const name = normalizedName(scope.name);
  if (["local", "locals", "block", "catch"].includes(name)) return "locals";
  if (name === "closure") return "closures";
  if (name === "global") return "globals";
  if (name === "script" || name === "module") return "module";
  return classifyByName(scope.name);
}

function classifyJava(scope: DapScope): ScopeCategory {
  const name = normalizedName(scope.name);
  if (name.includes("argument") || name === "args") return "arguments";
  if (name.includes("local")) return "locals";
  if (name.includes("static")) return "statics";
  if (name.includes("field") || name.includes("class")) return "runtime";
  return classifyByName(scope.name);
}

export function classifyScope(
  language: DebugLanguage,
  scope: DapScope,
  variables: DapVariable[] = []
): ScopeCategory {
  const normalizedLanguage = normalizedName(language);
  if (normalizedLanguage === "python") return classifyPython(scope, variables);
  if (normalizedLanguage === "node" || normalizedLanguage === "javascript" || normalizedLanguage === "typescript") {
    return classifyNode(scope);
  }
  if (normalizedLanguage === "java") return classifyJava(scope);
  return classifyByName(scope.name);
}

export function variableCategory(variable: DapVariable, fallback: ScopeCategory): ScopeCategory {
  const name = normalizedName(variable.name);
  if (name === "this" || name === "self" || name === "cls") return "receiver";
  if (name === "arguments" || name === "args") return "arguments";
  if (
    name === "__builtins__" ||
    name.includes("special") ||
    name.includes("function") ||
    name.includes("class")
  ) {
    return "runtime";
  }
  return fallback;
}

export function isFocusedCategory(category: ScopeCategory): boolean {
  return focusedCategories.has(category);
}
