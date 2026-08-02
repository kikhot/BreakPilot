import type { JsonSchema } from "../types/control.ts";

export const scalarValueSchema: JsonSchema = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" }
  ]
};

export const diagnosticsSchema: JsonSchema = {
  type: "object",
  additionalProperties: true
};

export const errorSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    retrySafe: { type: "boolean" },
    actionMayHaveApplied: { type: "boolean" },
    hint: { type: "string" },
    diagnostics: diagnosticsSchema
  },
  required: ["code", "message", "retrySafe", "actionMayHaveApplied"]
};

export const warningsSchema: JsonSchema = {
  type: "array",
  items: { type: "string" }
};

export const positionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    filePath: { type: "string" },
    line: { type: "integer", minimum: 1 },
    column: { type: "integer", minimum: 1 },
    function: { type: "string" }
  },
  required: ["filePath", "line"]
};

export const frameSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    index: { type: "integer", minimum: 0 },
    at: positionSchema,
    summary: { type: "string" }
  },
  required: ["index"],
  oneOf: [
    { type: "object", required: ["at"] },
    { type: "object", required: ["summary"] }
  ]
};

export const agentValueDefinition: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    value: scalarValueSchema,
    type: { type: "string" },
    handle: { type: "string" },
    mutable: { type: "boolean", enum: [true] },
    redacted: { type: "boolean", enum: [true] },
    children: {
      type: "array",
      items: { $ref: "#/$defs/agentValue" }
    },
    nextOffset: { type: "integer", minimum: 0 }
  },
  required: ["name", "value"]
};

export const variableNodeSchema: JsonSchema = {
  $ref: "#/$defs/agentValue",
  $defs: { agentValue: agentValueDefinition }
};

export const scopeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    values: { type: "array", items: variableNodeSchema }
  },
  required: ["name", "values"]
};

export const breakpointSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    at: positionSchema,
    verified: { type: "boolean" },
    owner: { type: "string", enum: ["agent", "user"] },
    condition: { type: "string" },
    hitCondition: { type: "string" },
    logMessage: { type: "string" },
    enabled: { type: "boolean", enum: [false] },
    temporary: { type: "boolean", enum: [true] },
    suspendPolicy: { type: "string", enum: ["THREAD", "NONE"] },
    message: { type: "string" }
  },
  required: ["id", "at", "verified", "owner"]
};

export const sessionSummarySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    ideSessionId: { type: "string" },
    name: { type: "string" },
    state: { type: "string" },
    mode: { type: "string" },
    active: { type: "boolean", enum: [true] }
  },
  required: ["state"]
};

export const runtimeEventSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sequence: { type: "integer", minimum: 1 },
    kind: { type: "string" },
    at: positionSchema,
    breakpointId: { type: "string" },
    threadId: { oneOf: [{ type: "number" }, { type: "string" }] },
    message: { type: "string" },
    category: { type: "string" },
    data: { type: "object", additionalProperties: true }
  },
  required: ["sequence", "kind"]
};

export const runtimeEventPageSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: { type: "array", items: runtimeEventSchema },
    nextCursor: { type: "integer", minimum: 0 },
    dropped: { type: "integer", minimum: 1 }
  },
  required: ["items", "nextCursor"]
};

export const commonSchemas: Record<string, JsonSchema> = {
  error: errorSchema,
  warnings: warningsSchema,
  diagnostics: diagnosticsSchema,
  position: positionSchema,
  frame: frameSchema,
  variableNode: variableNodeSchema,
  scalarValue: scalarValueSchema,
  scope: scopeSchema,
  breakpoint: breakpointSchema,
  sessionSummary: sessionSummarySchema,
  runtimeEventPage: runtimeEventPageSchema
};

export function successOrErrorSchema(success: JsonSchema, includeValues = false): JsonSchema {
  return {
    ...(includeValues ? { $defs: { agentValue: agentValueDefinition } } : {}),
    type: "object",
    oneOf: [
      success,
      {
        type: "object",
        additionalProperties: false,
        properties: {
          error: {
            type: "object",
            required: ["code", "message", "retrySafe", "actionMayHaveApplied"]
          },
          warnings: warningsSchema
        },
        required: ["error"]
      }
    ]
  };
}
