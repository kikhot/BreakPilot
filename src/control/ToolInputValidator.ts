import type {
  JsonSchema,
  ToolValidationIssue,
  ToolValidationResult
} from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";

interface NodeValidationResult {
  value: unknown;
  errors: ToolValidationIssue[];
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function setOwn(value: AnyRecord, property: string, propertyValue: unknown): void {
  Object.defineProperty(value, property, {
    value: propertyValue,
    writable: true,
    enumerable: true,
    configurable: true
  });
}

function isRecord(value: unknown): value is AnyRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function matchesType(type: NonNullable<JsonSchema["type"]>, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) =>
      key === rightKeys[index] && jsonEqual(left[key], right[key])
    );
  }
  if (
    (typeof left === "object" && left !== null) ||
    (typeof right === "object" && right !== null)
  ) {
    return false;
  }
  return left === right;
}

function propertyPath(path: string, property: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
    ? `${path}.${property}`
    : `${path}[${JSON.stringify(property)}]`;
}

function issue(path: string, keyword: string, message: string): ToolValidationIssue {
  return { path, keyword, message };
}

function jsonCompatibilityIssue(): ToolValidationIssue {
  return issue("$", "type", "must be a JSON-compatible object");
}

function matchesSchemaWithoutDefaults(
  schema: JsonSchema,
  value: unknown,
  active: WeakSet<object> = new WeakSet()
): boolean {
  if (schema.type && !matchesType(schema.type, value)) return false;
  if (schema.enum && !schema.enum.some((candidate) => jsonEqual(candidate, value))) return false;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.items) {
      if (active.has(value)) return false;
      active.add(value);
      try {
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (
            !descriptor ||
            !("value" in descriptor) ||
            !matchesSchemaWithoutDefaults(schema.items, descriptor.value, active)
          ) {
            return false;
          }
        }
      } finally {
        active.delete(value);
      }
    }
  }

  if (isRecord(value)) {
    if (active.has(value)) return false;
    active.add(value);
    try {
      for (const required of schema.required ?? []) {
        if (!hasOwn(value, required)) return false;
      }
      const properties = schema.properties ?? {};
      for (const property of Object.keys(properties)) {
        const propertySchema = properties[property];
        if (!propertySchema || !hasOwn(value, property)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !matchesSchemaWithoutDefaults(propertySchema, descriptor.value, active)
        ) {
          return false;
        }
      }
      for (const property of Object.keys(value)) {
        if (hasOwn(properties, property)) continue;
        if (schema.additionalProperties === false) return false;
        if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          const descriptor = Object.getOwnPropertyDescriptor(value, property);
          if (
            !descriptor ||
            !("value" in descriptor) ||
            !matchesSchemaWithoutDefaults(schema.additionalProperties, descriptor.value, active)
          ) {
            return false;
          }
        }
      }
    } finally {
      active.delete(value);
    }
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) =>
      matchesSchemaWithoutDefaults(branch, value)
    );
    if (matches.length !== 1) return false;
  }
  return true;
}

function incompatibleValueIssue(
  schema: JsonSchema | undefined,
  value: unknown,
  path: string
): ToolValidationIssue {
  if (schema?.type && !matchesType(schema.type, value)) {
    return issue(path, "type", `must be ${schema.type}`);
  }
  if (schema?.enum && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
    return issue(path, "enum", `must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (
    schema?.oneOf &&
    schema.oneOf.filter((branch) => matchesSchemaWithoutDefaults(branch, value)).length !== 1
  ) {
    return issue(path, "oneOf", "must match exactly one schema in oneOf");
  }
  return jsonCompatibilityIssue();
}

function childSchema(schema: JsonSchema | undefined, property: string): JsonSchema | undefined {
  const properties = schema?.properties;
  if (properties && hasOwn(properties, property)) return properties[property];
  const additionalProperties = schema?.additionalProperties;
  return additionalProperties && typeof additionalProperties === "object"
    ? additionalProperties
    : undefined;
}

function preflightCloneSafety(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): ToolValidationIssue | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (value instanceof Map) {
    for (const [key, entryValue] of Map.prototype.entries.call(value)) {
      const keyIssue = preflightCloneSafety(key, seen);
      if (keyIssue) return keyIssue;
      const valueIssue = preflightCloneSafety(entryValue, seen);
      if (valueIssue) return valueIssue;
    }
  } else if (value instanceof Set) {
    for (const entryValue of Set.prototype.values.call(value)) {
      const valueIssue = preflightCloneSafety(entryValue, seen);
      if (valueIssue) return valueIssue;
    }
  }

  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return jsonCompatibilityIssue();
    if (typeof key === "symbol" || !descriptor.enumerable) continue;
    if (!("value" in descriptor)) return jsonCompatibilityIssue();
    const childIssue = preflightCloneSafety(descriptor.value, seen);
    if (childIssue) return childIssue;
  }
  return undefined;
}

function isStructuredCloneable(value: object): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function preflightJsonValue(
  schema: JsonSchema | undefined,
  value: unknown,
  path: string,
  active: WeakSet<object>
): ToolValidationIssue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : jsonCompatibilityIssue();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return jsonCompatibilityIssue();
  }
  if (typeof value !== "object") {
    return jsonCompatibilityIssue();
  }

  if (active.has(value)) return jsonCompatibilityIssue();
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return incompatibleValueIssue(schema, value, path);
      }

      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key === "symbol")) return jsonCompatibilityIssue();
      const indexKeys = (ownKeys as string[]).filter((key) => key !== "length");
      if (indexKeys.length !== value.length) return jsonCompatibilityIssue();

      const itemSchema = schema?.items;
      for (let index = 0; index < value.length; index += 1) {
        const property = String(index);
        if (!hasOwn(value, property)) return jsonCompatibilityIssue();
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          return jsonCompatibilityIssue();
        }
        const childIssue = preflightJsonValue(
          itemSchema,
          descriptor.value,
          `${path}[${index}]`,
          active
        );
        if (childIssue) return childIssue;
      }
      return undefined;
    }

    if (!isRecord(value)) {
      const safetyIssue = preflightCloneSafety(value);
      if (safetyIssue) return safetyIssue;
      if (!isStructuredCloneable(value)) return jsonCompatibilityIssue();
      return incompatibleValueIssue(schema, value, path);
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) return jsonCompatibilityIssue();
    const properties = (ownKeys as string[]).sort();
    for (const property of properties) {
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return jsonCompatibilityIssue();
      }
      const childIssue = preflightJsonValue(
        childSchema(schema, property),
        descriptor.value,
        propertyPath(path, property),
        active
      );
      if (childIssue) return childIssue;
    }
    return undefined;
  } finally {
    active.delete(value);
  }
}

function validateNode(
  schema: JsonSchema,
  input: unknown,
  path: string,
  applyDefaults: boolean
): NodeValidationResult {
  let value = input;
  const errors: ToolValidationIssue[] = [];

  if (schema.type && !matchesType(schema.type, value)) {
    return {
      value,
      errors: [issue(path, "type", `must be ${schema.type}`)]
    };
  }

  if (schema.enum && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
    errors.push(issue(path, "enum", `must be one of ${JSON.stringify(schema.enum)}`));
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(issue(path, "minimum", `must be >= ${schema.minimum}`));
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(issue(path, "maximum", `must be <= ${schema.maximum}`));
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(issue(path, "minItems", `must contain at least ${schema.minItems} items`));
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const itemResult = validateNode(schema.items, value[index], `${path}[${index}]`, applyDefaults);
        value[index] = itemResult.value;
        errors.push(...itemResult.errors);
      }
    }
  }

  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const required of [...(schema.required ?? [])].sort()) {
      if (!hasOwn(value, required)) {
        errors.push(issue(propertyPath(path, required), "required", "is required"));
      }
    }

    for (const property of Object.keys(properties).sort()) {
      const propertySchema = properties[property];
      if (!propertySchema) continue;
      const childPath = propertyPath(path, property);
      if (hasOwn(value, property)) {
        const propertyResult = validateNode(propertySchema, value[property], childPath, applyDefaults);
        setOwn(value, property, propertyResult.value);
        errors.push(...propertyResult.errors);
      } else if (applyDefaults && hasOwn(propertySchema, "default")) {
        const defaultResult = validateNode(
          propertySchema,
          structuredClone(propertySchema.default),
          childPath,
          true
        );
        setOwn(value, property, defaultResult.value);
        errors.push(...defaultResult.errors);
      }
    }

    const additionalProperties = schema.additionalProperties;
    const unknownProperties = Object.keys(value)
      .filter((property) => !hasOwn(properties, property))
      .sort();
    for (const property of unknownProperties) {
      const childPath = propertyPath(path, property);
      if (additionalProperties === false) {
        errors.push(issue(childPath, "additionalProperties", "is not allowed"));
      } else if (additionalProperties && typeof additionalProperties === "object") {
        const propertyResult = validateNode(
          additionalProperties,
          value[property],
          childPath,
          applyDefaults
        );
        setOwn(value, property, propertyResult.value);
        errors.push(...propertyResult.errors);
      }
    }
  }

  const branches = schema.oneOf;
  if (branches) {
    const matches: number[] = [];
    for (const [index, branch] of branches.entries()) {
      const branchResult = validateNode(
        branch,
        structuredClone(value),
        path,
        false
      );
      if (branchResult.errors.length === 0) matches.push(index);
    }

    const selectedIndex = matches[0];
    const selectedBranch = selectedIndex === undefined ? undefined : branches[selectedIndex];
    if (matches.length !== 1 || !selectedBranch) {
      errors.push(issue(path, "oneOf", "must match exactly one schema in oneOf"));
    } else if (applyDefaults) {
      const branchResult = validateNode(
        selectedBranch,
        structuredClone(value),
        path,
        true
      );
      value = branchResult.value;
      errors.push(...branchResult.errors);
    }
  }

  return { value, errors };
}

export function validateToolInput(schema: JsonSchema, input: unknown): ToolValidationResult {
  let compatibilityIssue: ToolValidationIssue | undefined;
  try {
    compatibilityIssue = preflightJsonValue(schema, input, "$", new WeakSet());
  } catch {
    compatibilityIssue = jsonCompatibilityIssue();
  }
  if (compatibilityIssue) {
    return {
      value: {},
      errors: [compatibilityIssue]
    };
  }

  let clonedInput: unknown;
  try {
    clonedInput = structuredClone(input);
  } catch {
    return {
      value: {},
      errors: [jsonCompatibilityIssue()]
    };
  }

  const result = validateNode(schema, clonedInput, "$", true);
  return {
    value: result.value as AnyRecord,
    errors: result.errors
  };
}
