import type { JsonSchema } from "../types/control.ts";
import {
  breakpointSchema,
  frameSchema,
  positionSchema,
  providerCapabilitiesSchema,
  runtimeEventPageSchema,
  scalarValueSchema,
  scopeSchema,
  sessionSummarySchema,
  successOrErrorSchema,
  variableNodeSchema,
  warningsSchema
} from "./schemaFragments.ts";

const nullableStringSchema: JsonSchema = {
  oneOf: [{ type: "string" }, { type: "null" }]
};

const nullableThreadIdSchema: JsonSchema = {
  oneOf: [{ type: "number" }, { type: "string" }, { type: "null" }]
};

const nullablePositionSchema: JsonSchema = {
  oneOf: [positionSchema, { type: "null" }]
};

const runToLineRequestedPositionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    filePath: { type: "string" },
    line: { type: "integer", minimum: 1 },
    column: { type: "integer", minimum: 1 }
  },
  required: ["filePath", "line"]
};

const providerPayloadSchema: JsonSchema = {
  type: "object",
  additionalProperties: true
};

const providerPayloadArraySchema: JsonSchema = {
  type: "array",
  items: providerPayloadSchema
};

const threadSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { oneOf: [{ type: "number" }, { type: "string" }] },
    name: { type: "string" },
    state: { type: "string" },
    isCurrent: { type: "boolean" },
    frameCount: { type: "integer", minimum: 0 },
    partial: { type: "boolean" }
  },
  required: ["id", "name", "state", "isCurrent", "frameCount"]
};

const ideSessionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ideSessionId: { type: "string" },
    name: { type: "string" },
    state: { type: "string" },
    active: { type: "boolean" },
    position: nullablePositionSchema,
    providerKind: { type: "string" },
    capabilities: providerCapabilitiesSchema
  },
  required: ["ideSessionId", "state", "active", "position"]
};

const eventsSchema = runtimeEventPageSchema;

const variableNodeProperties = variableNodeSchema.properties ?? {};
const breakpointProperties = breakpointSchema.properties ?? {};
const sessionSummaryProperties = sessionSummarySchema.properties ?? {};

export const startSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...sessionSummaryProperties,
    startMode: { type: "string", enum: ["launch", "attach", "ide"] },
    warnings: warningsSchema
  },
  required: [
    "sessionId",
    "language",
    "mode",
    "state",
    "startMode",
    "providerKind",
    "capabilities"
  ]
};

export const runConfigurationsSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    filePath: { type: "string" },
    configurations: providerPayloadArraySchema,
    runPoints: providerPayloadArraySchema,
    warnings: warningsSchema
  }
};

export const statusSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    activeSessionId: nullableStringSchema,
    sessions: { type: "array", items: sessionSummarySchema },
    ideConnected: { type: "boolean" },
    ideSessions: { type: "array", items: ideSessionSchema },
    warnings: warningsSchema
  },
  required: ["activeSessionId", "sessions", "ideConnected", "ideSessions"]
};

export const controlSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string" },
    reason: nullableStringSchema,
    position: nullablePositionSchema,
    frame: frameSchema,
    variables: { type: "array", items: scopeSchema },
    events: eventsSchema,
    alreadyStopped: { type: "boolean" },
    warnings: warningsSchema
  },
  required: ["status"]
};

export const runToLineSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["paused", "stopped", "timeout"] },
    targetReached: { type: "boolean" },
    requestedPosition: runToLineRequestedPositionSchema,
    resolvedPosition: runToLineRequestedPositionSchema,
    position: positionSchema,
    frame: providerPayloadSchema,
    variables: providerPayloadArraySchema,
    temporaryBreakpointId: { type: "string" },
    cleanedUp: { type: "boolean" },
    cleanupRequired: { type: "boolean" },
    message: { type: "string" },
    warnings: warningsSchema
  },
  required: ["status", "targetReached", "requestedPosition", "cleanedUp"]
};

export const threadsSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    threads: { type: "array", items: threadSchema },
    offset: { type: "integer", minimum: 0 },
    totalCount: { type: "integer", minimum: 0 },
    warnings: warningsSchema
  },
  required: ["threads", "offset", "totalCount"]
};

export const callStackSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    threadId: nullableThreadIdSchema,
    frames: { type: "array", items: frameSchema },
    offset: { type: "integer", minimum: 0 },
    totalFrames: { type: "integer", minimum: 0 },
    pauseEpoch: { type: "integer", minimum: 0 },
    completeness: { type: "string", enum: ["complete", "partial", "unknown"] },
    partial: { type: "boolean" },
    nextOffset: { type: "integer", minimum: 0 },
    truncationReason: {
      type: "string",
      enum: ["limit", "provider", "timeout", "noSuspendContext"]
    },
    warnings: warningsSchema
  },
  required: ["threadId", "frames", "offset", "completeness", "partial"]
};

export const frameSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    threadId: nullableThreadIdSchema,
    frame: { oneOf: [frameSchema, { type: "null" }] },
    variables: { type: "array", items: scopeSchema },
    warnings: warningsSchema
  },
  required: ["threadId", "frame", "variables"]
};

export const valueSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...variableNodeProperties,
    items: { type: "array", items: variableNodeSchema },
    result: providerPayloadSchema,
    warnings: warningsSchema
  }
};

const setValueSuccessCommonProperties: Record<string, JsonSchema> = {
  oldValue: scalarValueSchema,
  newValue: { type: "string" },
  applied: { type: "boolean" },
  verified: { type: "boolean" },
  mutationMode: { type: "string", enum: ["native", "evaluateAssignment"] },
  result: providerPayloadSchema,
  warnings: warningsSchema
};

const setValuePathSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...setValueSuccessCommonProperties,
    path: { type: "array", minItems: 1, items: { type: "string" } }
  },
  required: ["path", "oldValue", "newValue", "applied", "verified", "mutationMode"]
};

const setValueRefSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...setValueSuccessCommonProperties,
    ref: { oneOf: [{ type: "number" }, { type: "string" }] }
  },
  required: ["ref", "oldValue", "newValue", "applied", "verified", "mutationMode"]
};

export const setValueSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...setValueSuccessCommonProperties,
    path: { type: "array", minItems: 1, items: { type: "string" } },
    ref: { oneOf: [{ type: "number" }, { type: "string" }] }
  },
  oneOf: [setValuePathSuccessSchema, setValueRefSuccessSchema]
};

export const evalSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    expression: { type: "string" },
    value: scalarValueSchema,
    type: { type: "string" },
    result: providerPayloadSchema,
    warnings: warningsSchema
  },
  required: ["expression"]
};

export const contextSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string" },
    position: nullablePositionSchema,
    frames: { type: "array", items: frameSchema },
    variables: { type: "array", items: scopeSchema },
    warnings: warningsSchema
  },
  required: ["status", "position", "frames", "variables"]
};

const setBreakpointCreateSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...breakpointProperties,
    lineText: { type: "string" },
    warnings: warningsSchema
  },
  required: breakpointSchema.required
};

const setBreakpointUpdateSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...breakpointProperties,
    operation: { type: "string", enum: ["updated", "relocated"] },
    previous: breakpointSchema,
    current: breakpointSchema,
    changedFields: {
      type: "array",
      items: {
        type: "string",
        enum: ["filePath", "line", "column", "condition", "hitCondition", "logMessage", "enabled"]
      }
    },
    rollbackApplied: { type: "boolean" },
    warnings: warningsSchema
  },
  required: [...(breakpointSchema.required ?? []), "operation", "previous", "current", "changedFields"]
};

export const setBreakpointSuccessSchema: JsonSchema = {
  type: "object",
  oneOf: [setBreakpointCreateSuccessSchema, setBreakpointUpdateSuccessSchema]
};

export const listBreakpointsSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    breakpoints: { type: "array", items: breakpointSchema },
    totalCount: { type: "integer", minimum: 0 },
    enabledCount: { type: "integer", minimum: 0 },
    source: { type: "string" },
    warnings: warningsSchema
  },
  required: ["breakpoints", "totalCount"]
};

export const removeBreakpointSuccessSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    breakpointId: { type: "string" },
    removed: { type: "boolean" },
    protected: { type: "boolean" },
    message: { type: "string" },
    warnings: warningsSchema
  },
  required: ["removed"]
};

export const bpDebugStartOutputSchema = successOrErrorSchema(startSuccessSchema);
export const bpDebugRunConfigurationsOutputSchema = successOrErrorSchema(runConfigurationsSuccessSchema);
export const bpDebugStatusOutputSchema = successOrErrorSchema(statusSuccessSchema);
export const bpDebugControlOutputSchema = successOrErrorSchema(controlSuccessSchema);
export const bpDebugRunToLineOutputSchema = successOrErrorSchema(runToLineSuccessSchema);
export const bpDebugThreadsOutputSchema = successOrErrorSchema(threadsSuccessSchema);
export const bpDebugCallStackOutputSchema = successOrErrorSchema(callStackSuccessSchema);
export const bpDebugFrameOutputSchema = successOrErrorSchema(frameSuccessSchema);
export const bpDebugValueOutputSchema = successOrErrorSchema(valueSuccessSchema);
export const bpDebugSetValueOutputSchema = successOrErrorSchema(setValueSuccessSchema);
export const bpDebugEvalOutputSchema = successOrErrorSchema(evalSuccessSchema);
export const bpDebugContextOutputSchema = successOrErrorSchema(contextSuccessSchema);
export const bpDebugSetBreakpointOutputSchema = successOrErrorSchema(setBreakpointSuccessSchema);
export const bpDebugListBreakpointsOutputSchema = successOrErrorSchema(listBreakpointsSuccessSchema);
export const bpDebugRemoveBreakpointOutputSchema = successOrErrorSchema(removeBreakpointSuccessSchema);

export const toolOutputSchemas: Record<string, JsonSchema> = {
  bp_debug_start: bpDebugStartOutputSchema,
  bp_debug_run_configurations: bpDebugRunConfigurationsOutputSchema,
  bp_debug_status: bpDebugStatusOutputSchema,
  bp_debug_control: bpDebugControlOutputSchema,
  bp_debug_run_to_line: bpDebugRunToLineOutputSchema,
  bp_debug_threads: bpDebugThreadsOutputSchema,
  bp_debug_call_stack: bpDebugCallStackOutputSchema,
  bp_debug_frame: bpDebugFrameOutputSchema,
  bp_debug_value: bpDebugValueOutputSchema,
  bp_debug_set_value: bpDebugSetValueOutputSchema,
  bp_debug_eval: bpDebugEvalOutputSchema,
  bp_debug_context: bpDebugContextOutputSchema,
  bp_debug_set_breakpoint: bpDebugSetBreakpointOutputSchema,
  bp_debug_list_breakpoints: bpDebugListBreakpointsOutputSchema,
  bp_debug_remove_breakpoint: bpDebugRemoveBreakpointOutputSchema
};
