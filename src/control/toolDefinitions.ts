import type { JsonSchema, ToolDefinition } from "../types/control.ts";
import { toolOutputSchemas } from "./toolOutputSchemas.ts";

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

const timeout: JsonSchema = { type: "number", description: "Timeout in milliseconds." };

const timeoutMs: JsonSchema = {
  type: "number",
  description: "Compatibility alias for timeout."
};

const threadId: JsonSchema = {
  oneOf: [{ type: "number" }, { type: "string" }],
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
  type: "number",
  minimum: 0,
  maximum: 8,
  description: "Compatibility alias for depth."
};

const expansionDepth: JsonSchema = {
  type: "number",
  minimum: 0,
  maximum: 8,
  default: 1
};

const maxItems: JsonSchema = {
  type: "number",
  description: "Compatibility alias for limit."
};

const maxStringLength: JsonSchema = {
  type: "number",
  description: "Compatibility alias for maxString."
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
    line: { type: "number", minimum: 1 },
    column: { type: "number" }
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
        line: { type: "number", description: "Runnable line for IDE debug launch." },
        program: { type: "string", description: "Headless launch program path. Defaults to filePath when provided." },
        module: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: {
          type: "object",
          additionalProperties: { oneOf: [{ type: "string" }, { type: "null" }] }
        },
        host: { type: "string" },
        port: { type: "number" },
        owner: { type: "string" },
        clientId,
        ideSessionId: { type: "string" },
        adapterCommand: { type: "string" },
        adapterArgs: { type: "array", items: { type: "string" } },
        adapterPort: { type: "number" },
        dapHost: { type: "string" },
        dapPort: { type: "number" },
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
      additionalProperties: false,
      properties: {
        projectPath,
        workspace,
        sessionId,
        action: {
          type: "string",
          enum: ["pause", "resume", "wait", "stepOver", "stepInto", "stepOut", "stop", "disconnect", "drainEvents"]
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
        limit: { type: "number", default: 10 },
        maxItems,
        maxString: { type: "number", default: 2000 },
        maxStringLength,
        redactPatterns
      },
      required: ["action"]
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
        line: { type: "number", minimum: 1 },
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
        offset: { type: "number", default: 0 },
        limit: { type: "number", default: 50 },
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
        offset: { type: "number", default: 0 },
        limit: { type: "number", default: 20 },
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
        frameId: { type: "number" },
        frameIndex: { type: "number", default: 0 },
        timeout,
        timeoutMs,
        detail,
        expand,
        objectFields,
        depth: expansionDepth,
        maxDepth,
        limit: { type: "number", default: 20 },
        maxItems,
        maxString: { type: "number", default: 2000 },
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
        projectPath,
        workspace,
        sessionId,
        threadId,
        frameId: { type: "number" },
        frameIndex: { type: "number", default: 0 },
        path: { type: "array", items: { type: "string" } },
        ref: { type: "number", description: "Opaque variable reference returned by frame/value tools." },
        variablesReference: { type: "number", description: "Compatibility alias for ref." },
        start: { type: "number", default: 0 },
        count: { type: "number" },
        timeout,
        timeoutMs,
        expand: { ...expand, default: "deep" },
        objectFields,
        depth: expansionDepth,
        maxDepth,
        limit: { type: "number", default: 20 },
        maxItems,
        detail,
        maxString: { type: "number", default: 2000 },
        maxStringLength,
        redactPatterns
      }
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
        frameId: { type: "number" },
        frameIndex: { type: "number", default: 0 },
        path: { type: "array", items: { type: "string" } },
        newValue: { type: "string" },
        timeout,
        timeoutMs,
        expand,
        objectFields,
        depth: expansionDepth,
        maxDepth,
        limit: { type: "number", default: 20 },
        maxItems,
        maxString: { type: "number", default: 2000 },
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
        frameId: { type: "number" },
        frameIndex: { type: "number", default: 0 },
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
        frameId: { type: "number" },
        clientId,
        ideSessionId: { type: "string" },
        timeout,
        timeoutMs,
        frameIndex: { type: "number", default: 0 },
        profile: { type: "string" },
        objectFields,
        maxDepth,
        maxItems,
        maxStringLength,
        expand,
        depth: expansionDepth,
        limit: { type: "number", default: 20 },
        maxString: { type: "number", default: 2000 },
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
        projectPath,
        workspace,
        sessionId,
        clientId,
        ide,
        breakpointId: { type: "string" },
        filePath: { type: "string" },
        file,
        line: { type: "number" },
        owner
      }
    },
    outputSchema: toolOutputSchemas.bp_debug_remove_breakpoint
  }
];
