import type { JsonSchema } from "../types/control.ts";
import {
  breakpointSchema,
  diagnosticsSchema,
  frameSchema,
  positionSchema,
  runtimeEventPageSchema,
  scalarValueSchema,
  sessionSummarySchema,
  successOrErrorSchema,
  warningsSchema
} from "./schemaFragments.ts";

const valueRef: JsonSchema = { $ref: "#/$defs/agentValue" };
const values: JsonSchema = {
  type: "array",
  items: { type: "object", additionalProperties: true }
};
const threadId: JsonSchema = { oneOf: [{ type: "number" }, { type: "string" }] };
const diagnosticFields = {
  diagnostics: diagnosticsSchema,
  warnings: warningsSchema
};

function success(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: { ...properties, ...diagnosticFields },
    required
  };
}

const start = success({
  sessionId: { type: "string" },
  state: { type: "string" },
  startMode: { type: "string", enum: ["launch", "attach", "ide"] },
  target: { type: "object", additionalProperties: true }
}, ["sessionId", "state", "startMode"]);

const runConfigurations = success({
  configurations: { type: "array", items: { type: "object", additionalProperties: true } },
  runPoints: { type: "array", items: positionSchema }
});

const status = success({
  activeSessionId: { type: "string" },
  sessions: { type: "array", items: sessionSummarySchema },
  ideConnected: { type: "boolean" }
}, ["sessions", "ideConnected"]);

const variableGroups: Record<string, JsonSchema> = {
  arguments: values,
  locals: values,
  fields: values,
  scopes: {
    type: "array",
    items: success({ name: { type: "string" }, values }, ["name", "values"])
  }
};

const paused: Record<string, JsonSchema> = {
  reason: { type: "string" },
  at: positionSchema,
  pauseId: { type: "integer", minimum: 0 },
  ...variableGroups,
  incomplete: { type: "array", items: { type: "string" } }
};

const control = success({
  state: { type: "string" },
  ...paused,
  events: runtimeEventPageSchema,
  alreadyStopped: { type: "boolean", enum: [true] }
}, ["state"]);

const runToLine = success({
  state: { type: "string" },
  reached: { type: "boolean" },
  target: positionSchema,
  ...paused,
  message: { type: "string" }
}, ["state", "reached", "target"]);

const threads = success({
  threads: {
    type: "array",
    items: success({
      id: threadId,
      name: { type: "string" },
      current: { type: "boolean", enum: [true] }
    }, ["id", "name"])
  },
  nextOffset: { type: "integer", minimum: 0 }
}, ["threads"]);

const callStack = success({
  threadId,
  frames: { type: "array", items: frameSchema },
  pauseId: { type: "integer", minimum: 0 },
  nextOffset: { type: "integer", minimum: 0 },
  incomplete: { type: "array", items: { type: "string" } }
}, ["threadId", "frames"]);

const frame = success({
  frame: frameSchema,
  ...variableGroups,
  pauseId: { type: "integer", minimum: 0 },
  incomplete: { type: "array", items: { type: "string" } }
}, ["frame"]);

const value = success({ value: valueRef }, ["value"]);

const setValue = success({
  target: { type: "object", additionalProperties: true },
  oldValue: scalarValueSchema,
  newValue: scalarValueSchema,
  applied: { type: "boolean" },
  verified: { type: "boolean" }
}, ["target", "oldValue", "newValue", "applied", "verified"]);

const evaluate = success({
  expression: { type: "string" },
  value: scalarValueSchema,
  type: { type: "string" },
  handle: { type: "string" }
}, ["expression", "value"]);

const context = success({
  state: { type: "string" },
  ...paused,
  stack: { type: "array", items: frameSchema }
}, ["state"]);

const setBreakpoint = success({
  ...(breakpointSchema.properties ?? {}),
  operation: { type: "string", enum: ["created", "updated", "relocated"] },
  changed: { type: "array", items: { type: "string" } },
  lineText: { type: "string" }
}, ["id", "at", "verified", "owner"]);

const listBreakpoints = success({
  breakpoints: { type: "array", items: breakpointSchema }
}, ["breakpoints"]);

const removeBreakpoint = success({
  id: { type: "string" },
  removed: { type: "boolean" },
  protected: { type: "boolean", enum: [true] },
  message: { type: "string" }
}, ["removed"]);

export const toolOutputSchemas: Record<string, JsonSchema> = {
  bp_debug_start: successOrErrorSchema(start),
  bp_debug_run_configurations: successOrErrorSchema(runConfigurations),
  bp_debug_status: successOrErrorSchema(status),
  bp_debug_control: successOrErrorSchema(control),
  bp_debug_run_to_line: successOrErrorSchema(runToLine),
  bp_debug_threads: successOrErrorSchema(threads),
  bp_debug_call_stack: successOrErrorSchema(callStack),
  bp_debug_frame: successOrErrorSchema(frame),
  bp_debug_value: successOrErrorSchema(value, true),
  bp_debug_set_value: successOrErrorSchema(setValue),
  bp_debug_eval: successOrErrorSchema(evaluate),
  bp_debug_context: successOrErrorSchema(context),
  bp_debug_set_breakpoint: successOrErrorSchema(setBreakpoint),
  bp_debug_list_breakpoints: successOrErrorSchema(listBreakpoints),
  bp_debug_remove_breakpoint: successOrErrorSchema(removeBreakpoint)
};

export const bpDebugStartOutputSchema = toolOutputSchemas.bp_debug_start!;
export const bpDebugRunConfigurationsOutputSchema = toolOutputSchemas.bp_debug_run_configurations!;
export const bpDebugStatusOutputSchema = toolOutputSchemas.bp_debug_status!;
export const bpDebugControlOutputSchema = toolOutputSchemas.bp_debug_control!;
export const bpDebugRunToLineOutputSchema = toolOutputSchemas.bp_debug_run_to_line!;
export const bpDebugThreadsOutputSchema = toolOutputSchemas.bp_debug_threads!;
export const bpDebugCallStackOutputSchema = toolOutputSchemas.bp_debug_call_stack!;
export const bpDebugFrameOutputSchema = toolOutputSchemas.bp_debug_frame!;
export const bpDebugValueOutputSchema = toolOutputSchemas.bp_debug_value!;
export const bpDebugSetValueOutputSchema = toolOutputSchemas.bp_debug_set_value!;
export const bpDebugEvalOutputSchema = toolOutputSchemas.bp_debug_eval!;
export const bpDebugContextOutputSchema = toolOutputSchemas.bp_debug_context!;
export const bpDebugSetBreakpointOutputSchema = toolOutputSchemas.bp_debug_set_breakpoint!;
export const bpDebugListBreakpointsOutputSchema = toolOutputSchemas.bp_debug_list_breakpoints!;
export const bpDebugRemoveBreakpointOutputSchema = toolOutputSchemas.bp_debug_remove_breakpoint!;
