import type { JsonSchema, ToolDefinition } from "../types/control.ts";
import { toolOutputSchemas } from "./toolOutputSchemas.ts";

const MAX_OFFSET = 1_000_000;
const MAX_LIMIT = 1_000;
const MAX_FRAME_INDEX = 100_000;
const MAX_STRING_LENGTH = 1_000_000;
const MAX_SOURCE_POSITION = 2_147_483_647;
const MAX_TIMEOUT_MS = 600_000;

const sessionId: JsonSchema = {
  type: "string",
  description: "Optional debug session id. If omitted, BreakPilot selects the active or paused session when unambiguous."
};

const projectPath: JsonSchema = {
  type: "string",
  description: "Optional project/workspace path used to route the call in a multi-project hub."
};

const workspace: JsonSchema = {
  type: "string",
  description: "CLI-compatible alias for projectPath."
};

const clientId: JsonSchema = {
  type: "string",
  description: "Optional IDE client id."
};

const ide: JsonSchema = {
  type: "string",
  enum: ["vscode", "idea"],
  description: "Optional IDE type used to route project-level IDE breakpoint calls."
};

const timeout: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_TIMEOUT_MS,
  description: "Timeout in milliseconds."
};

const timeoutMs: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_TIMEOUT_MS,
  description: "Compatibility alias for timeout."
};

const threadId: JsonSchema = {
  oneOf: [
    { type: "integer", minimum: 0, maximum: MAX_SOURCE_POSITION },
    { type: "string" }
  ],
  description: "Optional runtime thread id. IDE providers may expose opaque string ids."
};

const detail: JsonSchema = {
  type: "string",
  enum: ["compact", "diagnostic"],
  default: "compact",
  description: "Response detail level. Default compact returns only agent-relevant fields."
};

const owner: JsonSchema = {
  type: "string",
  enum: ["agent", "user", "all"],
  description: "Breakpoint owner filter. Defaults are tool-specific."
};

const suspendPolicy: JsonSchema = {
  type: "string",
  enum: ["ALL", "THREAD", "NONE"],
  description: "Debugger suspend policy for breakpoint hits."
};

const expand: JsonSchema = {
  type: "string",
  enum: ["none", "preview", "shallow", "deep"],
  default: "preview"
};

const file: JsonSchema = {
  type: "string",
  description: "Compatibility alias for filePath."
};

const objectFields: JsonSchema = {
  type: "string",
  description: "Compatibility alias for expand."
};

const maxDepth: JsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: 8,
  description: "Compatibility alias for depth."
};

const expansionDepth: JsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: 8,
  default: 1
};

const maxItems: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_LIMIT,
  description: "Compatibility alias for limit."
};

const maxStringLength: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_STRING_LENGTH,
  description: "Compatibility alias for maxString."
};

const pageOffset: JsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: MAX_OFFSET
};

const pageLimit: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_LIMIT
};

const frameIndex: JsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: MAX_FRAME_INDEX,
  default: 0
};

const frameId: JsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: MAX_SOURCE_POSITION
};

const maxString: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_STRING_LENGTH,
  default: 2000
};

const sourceLine: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_SOURCE_POSITION
};

const sourceColumn: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_SOURCE_POSITION
};

const positiveReference: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_SOURCE_POSITION
};

const networkPort: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: 65_535
};

const redactPatterns: JsonSchema = {
  type: "array",
  items: { type: "string" },
  description: "Additional variable-name patterns to redact from runtime inspection."
};

const breakpointCommonProperties: Record<string, JsonSchema> = {
  projectPath,
  workspace,
  sessionId,
  clientId,
  ide,
  condition: { oneOf: [{ type: "string" }, { type: "null" }] },
  hitCondition: { oneOf: [{ type: "string" }, { type: "null" }] },
  logMessage: { oneOf: [{ type: "string" }, { type: "null" }] },
  enabled: { type: "boolean", default: true },
  temporary: { type: "boolean", default: false },
  suspendPolicy,
  isLogMessage: { type: "boolean", default: false },
  isLogStack: { type: "boolean", default: false },
  owner: { type: "string", enum: ["agent", "user"], default: "agent" },
  requireVerified: { type: "boolean", default: false },
  detail
};

const breakpointLocationInput: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...breakpointCommonProperties,
    filePath: { type: "string" },
    file,
    line: sourceLine,
    column: sourceColumn
  },
  required: ["line"],
  oneOf: [
    { required: ["filePath"] },
    { required: ["file"] }
  ]
};

const breakpointIdInput: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...breakpointCommonProperties,
    breakpointId: { type: "string" }
  },
  required: ["breakpointId"]
};

const valueCommonProperties: Record<string, JsonSchema> = {
  projectPath,
  workspace,
  sessionId,
  threadId,
  frameId,
  frameIndex,
  start: { ...pageOffset, default: 0 },
  count: pageLimit,
  timeout,
  timeoutMs,
  expand: { ...expand, default: "deep" },
  objectFields,
  depth: expansionDepth,
  maxDepth,
  limit: { ...pageLimit, default: 20 },
  maxItems,
  detail,
  maxString,
  maxStringLength,
  redactPatterns
};

const valuePathInput: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...valueCommonProperties,
    path: { type: "array", minItems: 1, items: { type: "string" } }
  },
  required: ["path"]
};

const valueRefInput: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...valueCommonProperties,
    ref: {
      ...positiveReference,
      description: "Opaque variable reference returned by frame/value tools."
    }
  },
  required: ["ref"]
};

const valueVariablesReferenceInput: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...valueCommonProperties,
    variablesReference: {
      ...positiveReference,
      description: "Compatibility alias for ref."
    }
  },
  required: ["variablesReference"]
};

const breakpointRemoveCommonProperties: Record<string, JsonSchema> = {
  projectPath,
  workspace,
  sessionId,
  clientId,
  ide,
  owner
};

const breakpointRemoveIdInput: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...breakpointRemoveCommonProperties,
    breakpointId: { type: "string" }
  },
  required: ["breakpointId"]
};

const breakpointRemoveLocationInput: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...breakpointRemoveCommonProperties,
    filePath: { type: "string" },
    file,
    line: sourceLine
  },
  required: ["line"],
  oneOf: [
    { required: ["filePath"] },
    { required: ["file"] }
  ]
};

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "bp_debug_start",
    description: "Start, attach to, or adopt a BreakPilot debug session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectPath,
        workspace,
        mode: { type: "string", enum: ["launch", "attach", "ide"] },
        language: { type: "string", description: "Registered debug language identifier." },
        lang: { type: "string", description: "CLI-compatible alias for language." },
        runConfigName: { type: "string", description: "IDE run configuration name to debug when IDE support is available." },
        filePath: { type: "string", description: "Runnable source file path or launch program path." },
        file,
        line: { ...sourceLine, description: "Runnable line for IDE debug launch." },
        program: { type: "string", description: "Headless launch program path. Defaults to filePath when provided." },
        module: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: {
          type: "object",
          additionalProperties: { oneOf: [{ type: "string" }, { type: "null" }] }
        },
        host: { type: "string" },
        port: networkPort,
        owner: { type: "string" },
        clientId,
        ideSessionId: { type: "string" },
        adapterCommand: { type: "string" },
        adapterArgs: { type: "array", items: { type: "string" } },
        adapterPort: networkPort,
        dapHost: { type: "string" },
        dapPort: networkPort,
        dap: { type: "object", additionalProperties: true },
        timeout,
        timeoutMs
      }
    },
    outputSchema: toolOutputSchemas.bp_debug_start
  },
  {
    name: "bp_debug_run_configurations",
    description: "List IDE run configurations or runnable source locations for a project/file.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectPath,
        workspace,
        clientId,
        ide,
        filePath: { type: "string", description: "Optional source file path. When provided, returns runnable locations in that file." },
        file,
        detail
      }
    },
    outputSchema: toolOutputSchemas.bp_debug_run_configurations
  },
  {
    name: "bp_debug_status",
    description: "Return compact debugger status, live sessions, and IDE bridge summary.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { projectPath, workspace, clientId, detail }
    },
    outputSchema: toolOutputSchemas.bp_debug_status
  },
  {
    name: "bp_debug_control",
    description: "Control a debug session: pause, resume, wait, step, disconnect, stop, or drain events.",
    inputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            projectPath,
            workspace,
            sessionId,
            action: { type: "string", enum: ["drainEvents"] },
            cursor: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: 256 }
          },
          required: ["action"]
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            projectPath,
            workspace,
            sessionId,
            action: {
              type: "string",
              enum: ["pause", "resume", "wait", "stepOver", "stepInto", "stepOut", "stop", "disconnect"]
            },
            threadId,
            timeout,
            timeoutMs,
            terminateDebuggee: { type: "boolean", default: false },
            includeFrame: { type: "boolean", default: false },
            detail,
            expand,
            objectFields,
            depth: expansionDepth,
            maxDepth,
            limit: { ...pageLimit, default: 10 },
            maxItems,
            maxString,
            maxStringLength,
            redactPatterns
          },
          required: ["action"]
        }
      ]
    },
    outputSchema: toolOutputSchemas.bp_debug_control
  },
  {
    name: "bp_debug_run_to_line",
    description: "Run the selected debug session to a source line.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectPath,
        workspace,
        sessionId,
        filePath: { type: "string" },
        file,
        line: sourceLine,
        threadId,
        timeout,
        timeoutMs,
        includeFrame: { type: "boolean", default: false },
        detail
      },
      required: ["line"],
      oneOf: [
        { required: ["filePath"] },
        { required: ["file"] }
      ]
    },
    outputSchema: toolOutputSchemas.bp_debug_run_to_line
  },
  {
    name: "bp_debug_threads",
    description: "List runtime threads for a debug session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectPath,
        workspace,
        sessionId,
        offset: { ...pageOffset, default: 0 },
        limit: { ...pageLimit, default: 50 },
        detail
      }
    },
    outputSchema: toolOutputSchemas.bp_debug_threads
  },
  {
    name: "bp_debug_call_stack",
    description: "Return the call stack for the active or selected thread.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectPath,
        workspace,
        sessionId,
        threadId,
        offset: { ...pageOffset, default: 0 },
        limit: { ...pageLimit, default: 20 },
        detail
      }
    },
    outputSchema: toolOutputSchemas.bp_debug_call_stack
  },
  {
    name: "bp_debug_frame",
    description: "Return structured variables for a stack frame.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectPath,
        workspace,
        sessionId,
        threadId,
        frameId,
        frameIndex,
        timeout,
        timeoutMs,
        detail,
        expand,
        objectFields,
        depth: expansionDepth,
        maxDepth,
        limit: { ...pageLimit, default: 20 },
        maxItems,
        maxString,
        maxStringLength,
        redactPatterns
      }
    },
    outputSchema: toolOutputSchemas.bp_debug_frame
  },
  {
    name: "bp_debug_value",
    description: "Read a value by path from the current frame or expand a variable ref.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...valueCommonProperties,
        path: { type: "array", minItems: 1, items: { type: "string" } },
        ref: {
          ...positiveReference,
          description: "Opaque variable reference returned by frame/value tools."
        },
        variablesReference: {
          ...positiveReference,
          description: "Compatibility alias for ref."
        }
      },
      oneOf: [valuePathInput, valueRefInput, valueVariablesReferenceInput]
    },
    outputSchema: toolOutputSchemas.bp_debug_value
  },
  {
    name: "bp_debug_set_value",
    description: "Set a variable value when the runtime provider supports mutation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectPath,
        workspace,
        sessionId,
        threadId,
        frameId,
        frameIndex,
        path: { type: "array", minItems: 1, items: { type: "string" } },
        newValue: { type: "string" },
        timeout,
        timeoutMs,
        expand,
        objectFields,
        depth: expansionDepth,
        maxDepth,
        limit: { ...pageLimit, default: 20 },
        maxItems,
        maxString,
        maxStringLength,
        redactPatterns,
        detail
      },
      required: ["path", "newValue"]
    },
    outputSchema: toolOutputSchemas.bp_debug_set_value
  },
  {
    name: "bp_debug_eval",
    description: "Evaluate an expression in the current debug frame.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectPath,
        workspace,
        sessionId,
        expression: { type: "string" },
        mode: { type: "string", enum: ["readonly", "guarded", "unsafe"], default: "readonly" },
        threadId,
        frameId,
        frameIndex,
        context: { type: "string" },
        timeout,
        timeoutMs,
        detail
      },
      required: ["expression"]
    },
    outputSchema: toolOutputSchemas.bp_debug_eval
  },
  {
    name: "bp_debug_context",
    description: "Return the current paused position, call stack, and top-frame variables.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectPath,
        workspace,
        sessionId,
        threadId,
        frameId,
        clientId,
        ideSessionId: { type: "string" },
        timeout,
        timeoutMs,
        frameIndex,
        profile: { type: "string" },
        objectFields,
        maxDepth,
        maxItems,
        maxStringLength,
        expand,
        depth: expansionDepth,
        limit: { ...pageLimit, default: 20 },
        maxString,
        redactPatterns,
        detail
      }
    },
    outputSchema: toolOutputSchemas.bp_debug_context
  },
  {
    name: "bp_debug_set_breakpoint",
    description: "Set an agent-owned source breakpoint. Without sessionId, BreakPilot can route to a project-level IDE client.",
    inputSchema: {
      oneOf: [breakpointLocationInput, breakpointIdInput]
    },
    outputSchema: toolOutputSchemas.bp_debug_set_breakpoint
  },
  {
    name: "bp_debug_list_breakpoints",
    description: "List breakpoints for a debug session or project-level IDE client.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectPath,
        workspace,
        sessionId,
        clientId,
        ide,
        filePath: { type: "string" },
        file,
        owner,
        includeDisabled: { type: "boolean", default: true },
        detail
      }
    },
    outputSchema: toolOutputSchemas.bp_debug_list_breakpoints
  },
  {
    name: "bp_debug_remove_breakpoint",
    description: "Remove a breakpoint by breakpointId or filePath + line from a debug session or project-level IDE client.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...breakpointRemoveCommonProperties,
        breakpointId: { type: "string" },
        filePath: { type: "string" },
        file,
        line: sourceLine
      },
      oneOf: [breakpointRemoveIdInput, breakpointRemoveLocationInput]
    },
    outputSchema: toolOutputSchemas.bp_debug_remove_breakpoint
  }
];
