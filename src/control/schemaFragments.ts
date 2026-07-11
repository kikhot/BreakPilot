import type { JsonSchema } from "../types/control.ts";

const nullableNumberSchema: JsonSchema = {
  oneOf: [{ type: "number" }, { type: "null" }]
};

const compactVariableNodeProperties: Record<string, JsonSchema> = {
  name: { type: "string" },
  value: { type: "string" },
  path: { type: "array", items: { type: "string" } },
  type: { type: "string" },
  ref: { type: "number" }
};

// JsonSchema intentionally has no $ref support. A bounded schema keeps every
// normalized node closed without creating a circular JavaScript object that
// could not be serialized over MCP/HTTP. Eight levels exceed the default
// runtime inspection depth while keeping the advertised schema compact.
function createVariableNodeSchema(remainingDepth: number): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    ...compactVariableNodeProperties
  };
  if (remainingDepth > 0) {
    properties.children = {
      type: "array",
      items: createVariableNodeSchema(remainingDepth - 1)
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: ["name", "value"]
  };
}

export const errorSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    details: { type: "object", additionalProperties: true }
  },
  required: ["code", "message"]
};

export const warningsSchema: JsonSchema = {
  type: "array",
  items: { type: "string" }
};

export const capabilityLevelSchema: JsonSchema = {
  type: "string",
  enum: ["native", "fallback", "unsupported"]
};

export const providerCapabilitiesSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pause: capabilityLevelSchema,
    stepping: capabilityLevelSchema,
    runToLine: capabilityLevelSchema,
    variableReferences: { type: "string", enum: ["native", "snapshot", "unsupported"] },
    setValue: { type: "string", enum: ["native", "evaluateAssignment", "unsupported"] },
    breakpointUpdate: capabilityLevelSchema,
    conditionalBreakpoints: capabilityLevelSchema,
    hitConditionalBreakpoints: capabilityLevelSchema,
    tracepoints: capabilityLevelSchema,
    eventDrain: capabilityLevelSchema
  },
  required: [
    "pause",
    "stepping",
    "runToLine",
    "variableReferences",
    "setValue",
    "breakpointUpdate",
    "conditionalBreakpoints",
    "hitConditionalBreakpoints",
    "tracepoints",
    "eventDrain"
  ]
};

export const positionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    filePath: { oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
    line: nullableNumberSchema
  },
  required: ["filePath", "line"]
};

export const frameSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    index: { type: "integer", minimum: 0 },
    id: { type: "number" },
    filePath: { oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
    line: nullableNumberSchema,
    function: { type: "string" }
  },
  required: ["index", "id", "filePath", "line", "function"]
};

export const variableNodeSchema: JsonSchema = createVariableNodeSchema(8);

export const scopeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: { type: "string" },
    category: { type: "string" },
    items: { type: "array", items: variableNodeSchema }
  },
  required: ["scope", "items"]
};

export const breakpointSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    breakpointId: { type: "string" },
    filePath: { type: "string" },
    line: { type: "number" },
    verified: { type: "boolean" },
    condition: { oneOf: [{ type: "string" }, { type: "null" }] },
    hitCondition: { oneOf: [{ type: "string" }, { type: "null" }] },
    logMessage: { oneOf: [{ type: "string" }, { type: "null" }] },
    owner: { type: "string" },
    enabled: { type: "boolean" },
    temporary: { type: "boolean" },
    suspendPolicy: { type: "string", enum: ["ALL", "THREAD", "NONE"] },
    isLogMessage: { type: "boolean" },
    isLogStack: { type: "boolean" },
    message: { type: "string" }
  },
  required: ["breakpointId", "filePath", "line", "verified", "owner", "enabled", "temporary"]
};

export const sessionSummarySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    language: { type: "string" },
    mode: { type: "string" },
    state: { type: "string" },
    ideSessionId: { type: "string" },
    providerKind: { type: "string" },
    capabilities: providerCapabilitiesSchema
  },
  required: ["sessionId", "language", "mode", "state", "providerKind", "capabilities"]
};

export const paginationMetadataSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    offset: { type: "integer", minimum: 0 },
    totalCount: { type: "integer", minimum: 0 }
  },
  required: ["offset", "totalCount"]
};

export const commonSchemas: Record<string, JsonSchema> = {
  error: errorSchema,
  warnings: warningsSchema,
  capabilityLevel: capabilityLevelSchema,
  providerCapabilities: providerCapabilitiesSchema,
  position: positionSchema,
  frame: frameSchema,
  variableNode: variableNodeSchema,
  scope: scopeSchema,
  breakpoint: breakpointSchema,
  sessionSummary: sessionSummarySchema,
  pagination: paginationMetadataSchema
};

export function successOrErrorSchema(success: JsonSchema): JsonSchema {
  return {
    type: "object",
    oneOf: [
      success,
      {
        type: "object",
        additionalProperties: false,
        properties: { error: errorSchema, warnings: warningsSchema },
        required: ["error"]
      }
    ]
  };
}
