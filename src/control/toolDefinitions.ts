import type { JsonSchema, ToolDefinition } from "../types/control.ts";
import { toolOutputSchemas } from "./toolOutputSchemas.ts";

const MAX_LIMIT = 1_000;
const MAX_OFFSET = 1_000_000;
const MAX_ID = 2_147_483_647;
const MAX_TIMEOUT = 600_000;
const MAX_STRING = 1_000_000;

const detail: JsonSchema = {
  type: "string",
  enum: ["compact", "diagnostic"],
  default: "compact"
};
const projectPath: JsonSchema = { type: "string" };
const workspace: JsonSchema = { type: "string" };
const sessionId: JsonSchema = { type: "string" };
const clientId: JsonSchema = { type: "string" };
const ide: JsonSchema = { type: "string", enum: ["vscode", "idea"] };
const timeout: JsonSchema = { type: "integer", minimum: 1, maximum: MAX_TIMEOUT };
const threadId: JsonSchema = { oneOf: [{ type: "integer", minimum: 0, maximum: MAX_ID }, { type: "string" }] };
const frameIndex: JsonSchema = { type: "integer", minimum: 0, maximum: 100_000, default: 0 };
const pauseId: JsonSchema = { type: "integer", minimum: 0 };
const offset: JsonSchema = { type: "integer", minimum: 0, maximum: MAX_OFFSET, default: 0 };
const limit: JsonSchema = { type: "integer", minimum: 1, maximum: MAX_LIMIT };
const depth: JsonSchema = { type: "integer", minimum: 0, maximum: 8 };
const maxString: JsonSchema = { type: "integer", minimum: 1, maximum: MAX_STRING };
const handle: JsonSchema = { type: "string", minLength: 1 };
const filePath: JsonSchema = { type: "string" };
const line: JsonSchema = { type: "integer", minimum: 1, maximum: MAX_ID };
const column: JsonSchema = { type: "integer", minimum: 1, maximum: MAX_ID };
const redactPatterns: JsonSchema = { type: "array", items: { type: "string" } };

function object(properties: Record<string, JsonSchema>, required: string[] = [], oneOf?: JsonSchema[]): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
    ...(oneOf ? { oneOf } : {})
  };
}

const routed = { projectPath, workspace, sessionId, detail };
const selectedFrame = { ...routed, threadId, frameIndex, pauseId };
const variableRead = {
  ...selectedFrame,
  depth: { ...depth, default: 0 },
  limit: { ...limit, default: 20 },
  maxString: { ...maxString, default: 200 },
  redactPatterns
};

const breakpointFields = {
  projectPath,
  workspace,
  sessionId,
  clientId,
  ide,
  breakpointId: { type: "string" } as JsonSchema,
  filePath,
  line,
  column: { oneOf: [column, { type: "null" }] } as JsonSchema,
  condition: { oneOf: [{ type: "string" }, { type: "null" }] } as JsonSchema,
  hitCondition: { oneOf: [{ type: "string" }, { type: "null" }] } as JsonSchema,
  logMessage: { oneOf: [{ type: "string" }, { type: "null" }] } as JsonSchema,
  enabled: { type: "boolean" } as JsonSchema,
  temporary: { type: "boolean" } as JsonSchema,
  suspendPolicy: { type: "string", enum: ["ALL", "THREAD", "NONE"] } as JsonSchema,
  isLogMessage: { type: "boolean" } as JsonSchema,
  isLogStack: { type: "boolean" } as JsonSchema,
  owner: { type: "string", enum: ["agent", "user", "all"] } as JsonSchema,
  requireVerified: { type: "boolean" } as JsonSchema,
  detail
};

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "bp_debug_start",
    description: "Start, attach to, or adopt a debug session.",
    inputSchema: object({
      projectPath,
      workspace,
      mode: { type: "string", enum: ["launch", "attach", "ide"] },
      language: { type: "string" },
      runConfigName: { type: "string" },
      filePath,
      line,
      program: { type: "string" },
      module: { type: "string" },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      env: { type: "object", additionalProperties: { oneOf: [{ type: "string" }, { type: "null" }] } },
      host: { type: "string" },
      port: { type: "integer", minimum: 1, maximum: 65_535 },
      owner: { type: "string" },
      clientId,
      ideSessionId: { type: "string" },
      adapterCommand: { type: "string" },
      adapterArgs: { type: "array", items: { type: "string" } },
      adapterPort: { type: "integer", minimum: 1, maximum: 65_535 },
      dapHost: { type: "string" },
      dapPort: { type: "integer", minimum: 1, maximum: 65_535 },
      dap: { type: "object", additionalProperties: true },
      timeout,
      detail
    }),
    outputSchema: toolOutputSchemas.bp_debug_start
  },
  {
    name: "bp_debug_run_configurations",
    description: "List IDE run configurations or runnable source locations.",
    inputSchema: object({ projectPath, workspace, clientId, ide, filePath, detail }),
    outputSchema: toolOutputSchemas.bp_debug_run_configurations
  },
  {
    name: "bp_debug_status",
    description: "Return de-duplicated debugger and IDE session status.",
    inputSchema: object({ projectPath, workspace, clientId, detail }),
    outputSchema: toolOutputSchemas.bp_debug_status
  },
  {
    name: "bp_debug_control",
    description: "Pause, resume, wait, step, stop, disconnect, or drain events.",
    inputSchema: object({
      ...routed,
      action: { type: "string", enum: ["pause", "resume", "wait", "stepOver", "stepInto", "stepOut", "stop", "disconnect", "drainEvents"] },
      threadId,
      timeout,
      pauseId,
      terminateDebuggee: { type: "boolean", default: false },
      offset,
      cursor: { type: "integer", minimum: 0 },
      limit: { ...limit, default: 10 },
      depth: { ...depth, default: 0 },
      maxString: { ...maxString, default: 200 },
      redactPatterns
    }, ["action"]),
    outputSchema: toolOutputSchemas.bp_debug_control
  },
  {
    name: "bp_debug_run_to_line",
    description: "Run a paused session to a source line and return target proof.",
    inputSchema: object({
      ...routed, filePath, line, column, threadId, timeout, pauseId,
      depth: { ...depth, default: 0 },
      limit: { ...limit, default: 10 },
      maxString: { ...maxString, default: 200 },
      redactPatterns
    }, ["filePath", "line"]),
    outputSchema: toolOutputSchemas.bp_debug_run_to_line
  },
  {
    name: "bp_debug_threads",
    description: "List runtime threads.",
    inputSchema: object({ ...routed, offset, limit: { ...limit, default: 50 } }),
    outputSchema: toolOutputSchemas.bp_debug_threads
  },
  {
    name: "bp_debug_call_stack",
    description: "Return the semantic call stack for a thread.",
    inputSchema: object({ ...routed, threadId, pauseId, offset, limit: { ...limit, default: 20 } }),
    outputSchema: toolOutputSchemas.bp_debug_call_stack
  },
  {
    name: "bp_debug_frame",
    description: "Return semantic variables for a stack frame.",
    inputSchema: object(variableRead),
    outputSchema: toolOutputSchemas.bp_debug_frame
  },
  {
    name: "bp_debug_value",
    description: "Read a value by frame path or expand a pause-scoped handle.",
    inputSchema: object({
      ...selectedFrame,
      path: { type: "array", minItems: 1, items: { type: "string" } },
      handle,
      offset,
      depth: { ...depth, default: 1 },
      limit: { ...limit, default: 20 },
      maxString: { ...maxString, default: 200 },
      redactPatterns
    }, [], [{ type: "object", required: ["path"] }, { type: "object", required: ["handle"] }]),
    outputSchema: toolOutputSchemas.bp_debug_value
  },
  {
    name: "bp_debug_set_value",
    description: "Set a variable by frame path or pause-scoped handle.",
    inputSchema: object({
      ...selectedFrame,
      path: { type: "array", minItems: 1, items: { type: "string" } },
      handle,
      newValue: { type: "string" },
      timeout,
      detail
    }, ["newValue"], [{ type: "object", required: ["path"] }, { type: "object", required: ["handle"] }]),
    outputSchema: toolOutputSchemas.bp_debug_set_value
  },
  {
    name: "bp_debug_eval",
    description: "Evaluate an expression in a paused frame.",
    inputSchema: object({
      ...selectedFrame,
      expression: { type: "string" },
      mode: { type: "string", enum: ["readonly", "guarded", "unsafe"], default: "readonly" },
      context: { type: "string" },
      timeout,
      detail
    }, ["expression"]),
    outputSchema: toolOutputSchemas.bp_debug_eval
  },
  {
    name: "bp_debug_context",
    description: "Return one task-complete snapshot of the current pause.",
    inputSchema: object({
      ...selectedFrame,
      clientId,
      ideSessionId: { type: "string" },
      timeout,
      stackLimit: { ...limit, default: 5 },
      variableLimit: { ...limit, default: 10 },
      depth: { ...depth, default: 0 },
      maxString: { ...maxString, default: 200 },
      redactPatterns,
      detail
    }),
    outputSchema: toolOutputSchemas.bp_debug_context
  },
  {
    name: "bp_debug_set_breakpoint",
    description: "Create or update an agent-visible source breakpoint.",
    inputSchema: object(breakpointFields, [], [
      { type: "object", properties: { breakpointId: { type: "null" } }, required: ["filePath", "line"] },
      { type: "object", required: ["breakpointId"] }
    ]),
    outputSchema: toolOutputSchemas.bp_debug_set_breakpoint
  },
  {
    name: "bp_debug_list_breakpoints",
    description: "List normalized source breakpoints.",
    inputSchema: object({
      projectPath, workspace, sessionId, clientId, ide, filePath,
      owner: { type: "string", enum: ["agent", "user", "all"] },
      includeDisabled: { type: "boolean", default: true },
      detail
    }),
    outputSchema: toolOutputSchemas.bp_debug_list_breakpoints
  },
  {
    name: "bp_debug_remove_breakpoint",
    description: "Remove a breakpoint by id or source location.",
    inputSchema: object({
      projectPath, workspace, sessionId, clientId, ide,
      breakpointId: { type: "string" }, filePath, line,
      owner: { type: "string", enum: ["agent", "user", "all"] },
      detail
    }, [], [
      { type: "object", required: ["breakpointId"] },
      { type: "object", properties: { breakpointId: { type: "null" } }, required: ["filePath", "line"] }
    ]),
    outputSchema: toolOutputSchemas.bp_debug_remove_breakpoint
  }
];
