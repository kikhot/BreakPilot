import type { JsonSchema } from "../types/control.ts";

const nullableNumberSchema: JsonSchema = {
  oneOf: [{ type: "number" }, { type: "null" }]
};

export const scalarValueSchema: JsonSchema = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" }
  ]
};

const compactVariableNodeProperties: Record<string, JsonSchema> = {
  name: { type: "string" },
  value: { type: "string" },
  path: { type: "array", items: { type: "string" } },
  type: { type: "string" },
  ref: { oneOf: [{ type: "number" }, { type: "string" }] },
  pauseEpoch: { type: "integer", minimum: 0 },
  childrenCount: { type: "integer", minimum: 0 },
  complete: { type: "boolean" },
  truncated: { type: "boolean" },
  modifiable: { type: "boolean" },
  mutationMode: { type: "string", enum: ["native", "evaluateAssignment"] }
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

const runtimeEventMetadataValueSchema: JsonSchema = {
  oneOf: [
    scalarValueSchema,
    { type: "array", items: scalarValueSchema }
  ]
};

export const runtimeEventMetadataSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: runtimeEventMetadataValueSchema,
    description: runtimeEventMetadataValueSchema,
    exitCode: runtimeEventMetadataValueSchema,
    processId: runtimeEventMetadataValueSchema,
    threadName: runtimeEventMetadataValueSchema,
    moduleName: runtimeEventMetadataValueSchema,
    sourceReference: runtimeEventMetadataValueSchema,
    allThreadsStopped: runtimeEventMetadataValueSchema,
    restart: runtimeEventMetadataValueSchema,
    hitBreakpointIds: runtimeEventMetadataValueSchema,
    areas: runtimeEventMetadataValueSchema
  }
};

export const runtimeEventSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sequence: { type: "integer", minimum: 1 },
    timestamp: { type: "string" },
    kind: {
      type: "string",
      enum: [
        "breakpoint",
        "breakpointError",
        "tracepoint",
        "output",
        "stopped",
        "continued",
        "thread",
        "process",
        "invalidated",
        "terminated"
      ]
    },
    sessionId: { type: "string" },
    breakpointId: { type: "string" },
    threadId: { oneOf: [{ type: "number" }, { type: "string" }] },
    position: positionSchema,
    message: { type: "string" },
    category: { type: "string" },
    data: runtimeEventMetadataSchema
  },
  required: ["sequence", "timestamp", "kind", "sessionId"]
};

export const runtimeEventPageSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: { type: "array", items: runtimeEventSchema },
    cursor: { type: "integer", minimum: 0 },
    nextCursor: { type: "integer", minimum: 0 },
    oldestCursor: { type: "integer", minimum: 1 },
    hasMore: { type: "boolean" },
    overflowed: { type: "boolean" },
    droppedCount: { type: "integer", minimum: 0 },
    supportedKinds: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "breakpoint",
          "breakpointError",
          "tracepoint",
          "output",
          "stopped",
          "continued",
          "thread",
          "process",
          "invalidated",
          "terminated"
        ]
      }
    },
    breakpointErrors: { type: "array", items: runtimeEventSchema },
    tracepoints: { type: "array", items: runtimeEventSchema }
  },
  required: [
    "items",
    "cursor",
    "nextCursor",
    "oldestCursor",
    "hasMore",
    "overflowed",
    "droppedCount",
    "supportedKinds",
    "breakpointErrors",
    "tracepoints"
  ]
};

export const frameSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    index: { type: "integer", minimum: 0 },
    id: { oneOf: [{ type: "number" }, { type: "string" }] },
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
    column: { type: "number" },
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
  required: ["sessionId", "language", "mode", "state"]
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
  scalarValue: scalarValueSchema,
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
