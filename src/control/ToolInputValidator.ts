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

function isObject(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(type: NonNullable<JsonSchema["type"]>, value: unknown): boolean {
  switch (type) {
    case "object":
      return isObject(value);
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
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (isObject(left) || isObject(right)) {
    if (!isObject(left) || !isObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) =>
      key === rightKeys[index] && jsonEqual(left[key], right[key])
    );
  }
  return false;
}

function propertyPath(path: string, property: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
    ? `${path}.${property}`
    : `${path}[${JSON.stringify(property)}]`;
}

function issue(path: string, keyword: string, message: string): ToolValidationIssue {
  return { path, keyword, message };
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

  if (isObject(value)) {
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
        value[property] = propertyResult.value;
        errors.push(...propertyResult.errors);
      } else if (applyDefaults && hasOwn(propertySchema, "default")) {
        const defaultResult = validateNode(
          propertySchema,
          structuredClone(propertySchema.default),
          childPath,
          true
        );
        value[property] = defaultResult.value;
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
        value[property] = propertyResult.value;
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

export function validateToolInput(schema: JsonSchema, input: AnyRecord): ToolValidationResult {
  const result = validateNode(schema, structuredClone(input), "$", true);
  return {
    value: result.value as AnyRecord,
    errors: result.errors
  };
}
