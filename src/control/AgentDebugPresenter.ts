import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DetailLevel } from "../types/sessions.ts";
import type { VariableNode, VariableScopeView } from "../types/inspection.ts";
import type { AnyRecord } from "../types/json.ts";
import type { AgentHandleRegistry } from "../runtime/AgentHandleRegistry.ts";

export interface AgentLocation {
  filePath: string;
  line: number;
  column?: number;
  function?: string;
}

export interface AgentValue {
  name: string;
  value: string | number | boolean | null;
  type?: string;
  handle?: string;
  mutable?: true;
  redacted?: true;
  children?: AgentValue[];
  nextOffset?: number;
}

export interface AgentDebugPresenterOptions {
  workspaceRoot: string;
  sessionId: string;
  pauseId: number;
  handles: AgentHandleRegistry;
  detail: DetailLevel;
}

export interface AgentValueProjectionOptions {
  depth?: number;
  limit?: number;
  offset?: number;
  maxString?: number;
}

const providerFrameNames = new Set(["JavaStackFrame", "HiddenStackFramesItem", "XStackFrame"]);
const diagnosticLimits = Object.freeze({
  depth: 8,
  items: 20,
  keys: 20,
  nodes: 200,
  string: 200
});

function boundedDiagnostic(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  budget = { remaining: diagnosticLimits.nodes }
): unknown {
  if (budget.remaining <= 0) return "[truncated]";
  budget.remaining -= 1;
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value.slice(0, diagnosticLimits.string);
  if (depth >= diagnosticLimits.depth) return "[truncated]";
  if (typeof value !== "object" || seen.has(value)) return "[circular]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value.slice(0, diagnosticLimits.items)) {
        const child = boundedDiagnostic(item, depth + 1, seen, budget);
        if (child !== undefined) result.push(child);
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return `[${value.constructor?.name ?? "object"}]`;
    const result: AnyRecord = {};
    for (const key of Object.keys(value).slice(0, diagnosticLimits.keys)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const child = boundedDiagnostic(descriptor.value, depth + 1, seen, budget);
      if (child !== undefined) result[key] = child;
    }
    return result;
  } catch {
    return "[unavailable]";
  } finally {
    seen.delete(value);
  }
}

export class AgentDebugPresenter {
  readonly #workspaceRoot: string;
  readonly #sessionId: string;
  readonly #pauseId: number;
  readonly #handles: AgentHandleRegistry;
  readonly #detail: DetailLevel;

  constructor(options: AgentDebugPresenterOptions) {
    this.#workspaceRoot = path.resolve(options.workspaceRoot);
    this.#sessionId = options.sessionId;
    this.#pauseId = options.pauseId;
    this.#handles = options.handles;
    this.#detail = options.detail;
  }

  location(candidate: AnyRecord | null | undefined): AgentLocation | undefined {
    if (!candidate) return undefined;
    const source = candidate.source as AnyRecord | undefined;
    const rawPath = candidate.filePath ?? source?.path;
    const line = Number(candidate.line);
    if (typeof rawPath !== "string" || !Number.isSafeInteger(line) || line < 1) return undefined;
    const result: AgentLocation = {
      filePath: this.#publicPath(rawPath),
      line
    };
    const column = Number(candidate.column);
    if (Number.isSafeInteger(column) && column >= 1) result.column = column;
    const functionName = this.#functionName(candidate);
    if (functionName) result.function = functionName;
    return result;
  }

  value(node: VariableNode, options: AgentValueProjectionOptions = {}): AgentValue {
    const depth = Math.max(0, Math.floor(options.depth ?? 0));
    const limit = Math.max(1, Math.floor(options.limit ?? 20));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const maxString = Math.max(1, Math.floor(options.maxString ?? 200));
    const result: AgentValue = {
      name: node.name,
      value: this.#boundedScalar(this.#scalar(node), maxString)
    };
    if (node.type) result.type = node.type;
    if (node.ref !== undefined || node.modifiable || node.expandable || Boolean(node.children?.length)) {
      result.handle = this.#handles.register(this.#sessionId, this.#pauseId, {
        providerRef: node.ref,
        parentRef: node.parentRef,
        name: node.name,
        path: node.path,
        modifiable: node.modifiable,
        mutationMode: node.mutationMode
      });
    }
    if (node.modifiable) result.mutable = true;
    if (node.redacted) result.redacted = true;
    if (depth > 0 && node.children?.length) {
      const children = node.children.slice(offset, offset + limit);
      if (children.length) {
        result.children = children.map((child) => this.value(child, {
          depth: depth - 1,
          limit,
          maxString
        }));
      }
      const knownCount = node.childrenCount ?? node.children.length;
      if (offset + children.length < knownCount || node.truncated) {
        result.nextOffset = offset + children.length;
      }
    }
    return result;
  }

  scopes(scopes: VariableScopeView[], options: AgentValueProjectionOptions = {}): AnyRecord {
    const result: AnyRecord = {};
    const unknown: AnyRecord[] = [];
    for (const scope of scopes) {
      const projected = scope.items
        .slice(0, Math.max(1, Math.floor(options.limit ?? 20)))
        .map((node) => this.value(node, options));
      if (projected.length === 0) continue;
      const category = String(scope.category ?? scope.scope).toLowerCase();
      if (category.includes("argument")) {
        result.arguments = [...(result.arguments as AgentValue[] | undefined ?? []), ...projected];
      } else if (category.includes("local") || category === "receiver") {
        result.locals = [...(result.locals as AgentValue[] | undefined ?? []), ...projected];
      } else if (category.includes("field") || category.includes("static")) {
        result.fields = [...(result.fields as AgentValue[] | undefined ?? []), ...projected];
      } else {
        unknown.push({ name: scope.scope, values: projected });
      }
    }
    if (unknown.length) result.scopes = unknown;
    return result;
  }

  withDiagnostics<T extends AnyRecord>(compact: T, diagnostics: AnyRecord): T {
    if (this.#detail !== "diagnostic") return compact;
    return { ...compact, diagnostics: boundedDiagnostic(diagnostics) as AnyRecord };
  }

  #publicPath(rawPath: string): string {
    let candidate = rawPath;
    if (candidate.startsWith("file://")) {
      try {
        candidate = fileURLToPath(candidate);
      } catch {
        return rawPath;
      }
    }
    if (!path.isAbsolute(candidate) || candidate.includes("!/") || candidate.startsWith("jrt:")) {
      return candidate;
    }
    const relative = path.relative(this.#workspaceRoot, candidate);
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/");
    }
    return candidate;
  }

  #functionName(candidate: AnyRecord): string | undefined {
    for (const value of [candidate.function, candidate.displayName, candidate.presentation, candidate.name]) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed || providerFrameNames.has(trimmed)) continue;
      return trimmed;
    }
    return undefined;
  }

  #scalar(node: VariableNode): string | number | boolean | null {
    if (node.raw === null || typeof node.raw === "number" || typeof node.raw === "boolean") {
      return node.raw;
    }
    const preview = node.summary;
    if (node.kind === "null" && preview === "null") return null;
    if (node.kind === "boolean" && (preview === "true" || preview === "false")) return preview === "true";
    if (
      node.kind === "number" &&
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(preview)
    ) {
      const parsed = Number(preview);
      if (Number.isFinite(parsed)) return parsed;
    }
    return preview;
  }

  #boundedScalar(value: string | number | boolean | null, maxString: number): string | number | boolean | null {
    if (typeof value !== "string" || value.length <= maxString) return value;
    return `${value.slice(0, Math.max(0, maxString - 1))}…`;
  }
}
