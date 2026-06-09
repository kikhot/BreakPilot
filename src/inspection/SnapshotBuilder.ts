import type {
  ObjectFieldsMode,
  RuntimeSnapshot,
  ScopeCategory,
  SnapshotProfile,
  VariableLimits
} from "../types/inspection.ts";
import type { DapVariable } from "../types/dap.ts";
import type { AnyRecord } from "../types/json.ts";
import { DapSession } from "../dap/DapSession.ts";
import { VariableSerializer } from "./VariableSerializer.ts";
import { classifyScope, isFocusedCategory, variableCategory } from "./ScopeClassifier.ts";

function asArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function profileFromOptions(options: AnyRecord): SnapshotProfile {
  if (options.profile) return String(options.profile);
  if (asArray(options.includeCategories).length > 0 || asArray(options.includeScopes).length > 0) return "custom";
  return "focused";
}

function objectFieldsFor(profile: SnapshotProfile, requested?: ObjectFieldsMode): ObjectFieldsMode {
  if (requested) return requested;
  if (profile === "full") return "deep";
  if (profile === "locals") return "none";
  return "preview";
}

function includedCategoriesFor(profile: SnapshotProfile, requested: string[]): Set<ScopeCategory> {
  if (profile === "full") return new Set();
  if (requested.length > 0) return new Set(requested);
  return new Set(["arguments", "locals", "receiver"]);
}

function shouldIncludeCategory(
  profile: SnapshotProfile,
  category: ScopeCategory,
  includedCategories: Set<ScopeCategory>
): boolean {
  if (profile === "full") return true;
  if (profile === "focused") return isFocusedCategory(category);
  if (profile === "locals") return isFocusedCategory(category);
  return includedCategories.has(category);
}

function addVariable(
  target: Record<string, DapVariable>,
  variable: DapVariable,
  fallbackName: string
): void {
  let name = variable.name || fallbackName;
  if (!target[name]) {
    target[name] = variable;
    return;
  }
  let index = 2;
  while (target[`${name}#${index}`]) index += 1;
  name = `${name}#${index}`;
  target[name] = { ...variable, name };
}

export class RuntimeSnapshotBuilder {
  session: DapSession;
  limits: Required<VariableLimits>;

  constructor(session: DapSession, limits: Required<VariableLimits>) {
    this.session = session;
    this.limits = limits;
  }

  async build(options: AnyRecord = {}): Promise<RuntimeSnapshot> {
    const profile = profileFromOptions(options);
    const includeCategories = asArray(options.includeCategories);
    const includeScopes = new Set(asArray(options.includeScopes));
    const includedCategories = includedCategoriesFor(profile, includeCategories);
    const objectFields = objectFieldsFor(profile, options.objectFields ?? options.objects);
    const threadId = options.threadId ?? this.session.threadId;
    const stack = await this.session.stackTrace(threadId, options.levels ?? 20);
    const frame = options.frameId
      ? { id: options.frameId }
      : stack.stackFrames[options.frameIndex ?? 0];
    const serializer = new VariableSerializer(this.session, this.limits, { objectFields });
    const scopes = frame?.id ? await this.session.scopes(frame.id) : [];
    const grouped: Record<string, Record<string, DapVariable>> = {};
    const groupMeta: Record<string, { rawScopes: string[]; expensive: boolean }> = {};
    const scopeMetadata: RuntimeSnapshot["scopeMetadata"] = [];
    const availableScopes: string[] = [];
    const omittedScopes: string[] = [];
    const availableCategories: ScopeCategory[] = [];
    const omittedCategories: ScopeCategory[] = [];

    for (const scope of scopes) {
      const scopeVariables = await this.session.variables(scope.variablesReference, {
        start: 0,
        count: this.limits.maxItems
      });
      const scopeCategory = classifyScope(this.session.language, scope, scopeVariables);
      const rawIncluded = profile === "full" || includeScopes.has(scope.name);
      const categoryIncluded = shouldIncludeCategory(profile, scopeCategory, includedCategories);
      const scopeIncluded = rawIncluded || categoryIncluded;

      availableScopes.push(scope.name);
      availableCategories.push(scopeCategory);
      if (!scopeIncluded) {
        omittedScopes.push(scope.name);
        omittedCategories.push(scopeCategory);
      }

      scopeMetadata.push({
        rawName: scope.name,
        category: scopeCategory,
        included: scopeIncluded,
        expensive: Boolean(scope.expensive),
        variablesReference: scope.variablesReference
      });

      if (!scopeIncluded) continue;

      for (const variable of scopeVariables) {
        const category = rawIncluded && !categoryIncluded
          ? scopeCategory
          : variableCategory(variable, scopeCategory);
        if (!rawIncluded && !shouldIncludeCategory(profile, category, includedCategories)) continue;
        if (!grouped[category]) grouped[category] = {};
        if (!groupMeta[category]) groupMeta[category] = { rawScopes: [], expensive: false };
        if (!groupMeta[category].rawScopes.includes(scope.name)) groupMeta[category].rawScopes.push(scope.name);
        groupMeta[category].expensive ||= Boolean(scope.expensive);
        addVariable(grouped[category], variable, scope.name);
        availableCategories.push(category);
      }
    }

    const variables: RuntimeSnapshot["variables"] = {};
    for (const [category, categoryVariables] of Object.entries(grouped)) {
      const rawScopes = groupMeta[category]?.rawScopes ?? [];
      variables[category] = {
        name: category,
        category,
        rawScopes,
        expensive: Boolean(groupMeta[category]?.expensive),
        variables: await serializer.serializeVariables(Object.values(categoryVariables))
      };
    }

    return {
      sessionId: this.session.sessionId,
      source: "headless",
      language: this.session.language,
      profile,
      threadId: stack.threadId,
      frameId: frame?.id ?? null,
      stackFrames: stack.stackFrames,
      variables,
      availableCategories: unique(availableCategories),
      omittedCategories: unique(omittedCategories),
      availableScopes: unique(availableScopes),
      omittedScopes: unique(omittedScopes),
      scopeMetadata,
      limits: {
        maxDepth: this.limits.maxDepth,
        maxItems: this.limits.maxItems,
        maxStringLength: this.limits.maxStringLength
      }
    };
  }
}
