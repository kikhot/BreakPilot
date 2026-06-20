import type { ToolDefinition } from "../types/control.ts";

const sessionId = {
  type: "string",
  description: "Optional debug session id. If omitted, BreakPilot selects the active or paused session when unambiguous."
} as const;

const projectPath = {
  type: "string",
  description: "Optional project/workspace path used to route the call in a multi-project hub."
} as const;

const clientId = {
  type: "string",
  description: "Optional IDE client id."
} as const;

const ide = {
  type: "string",
  enum: ["vscode", "idea"],
  description: "Optional IDE type used to route project-level IDE breakpoint calls."
} as const;

const timeout = { type: "number", description: "Timeout in milliseconds." } as const;

const threadId = {
  oneOf: [{ type: "number" }, { type: "string" }],
  description: "Optional runtime thread id. IDE providers may expose opaque string ids."
} as const;

const detail = {
  type: "string",
  enum: ["compact", "diagnostic"],
  default: "compact",
  description: "Response detail level. Default compact returns only agent-relevant fields."
} as const;

const owner = {
  type: "string",
  enum: ["agent", "user", "all"],
  description: "Breakpoint owner filter. Defaults are tool-specific."
} as const;

const suspendPolicy = {
  type: "string",
  enum: ["ALL", "THREAD", "NONE"],
  description: "Debugger suspend policy for breakpoint hits."
} as const;

const toolResponseOutputSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: { type: "object" }
      }
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      description: "Present only when non-fatal warnings exist."
    }
  }
} as const;

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "bp_debug_start",
    description: "Start, attach to, or adopt a BreakPilot debug session.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        mode: { type: "string", enum: ["launch", "attach", "ide"], default: "launch" },
        language: { type: "string", description: "Registered debug language identifier." },
        runConfigName: { type: "string", description: "IDE run configuration name to debug when IDE support is available." },
        filePath: { type: "string", description: "Runnable source file path or launch program path." },
        line: { type: "number", description: "Runnable line for IDE debug launch." },
        program: { type: "string", description: "Headless launch program path. Defaults to filePath when provided." },
        module: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: { type: "object" },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "number" },
        clientId,
        ideSessionId: { type: "string" },
        adapterCommand: { type: "string" },
        adapterArgs: { type: "array", items: { type: "string" } },
        dapHost: { type: "string" },
        dapPort: { type: "number" },
        dap: { type: "object" }
      }
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_run_configurations",
    description: "List IDE run configurations or runnable source locations for a project/file.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        clientId,
        ide,
        filePath: { type: "string", description: "Optional source file path. When provided, returns runnable locations in that file." },
        detail
      }
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_status",
    description: "Return compact debugger status, live sessions, and IDE bridge summary.",
    inputSchema: { type: "object", properties: { projectPath } },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_control",
    description: "Control a debug session: pause, resume, wait, step, disconnect, stop, or drain events.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        action: {
          type: "string",
          enum: ["pause", "resume", "wait", "stepOver", "stepInto", "stepOut", "stop", "disconnect", "drainEvents"]
        },
        threadId,
        timeout,
        terminateDebuggee: { type: "boolean", default: false },
        includeFrame: { type: "boolean", default: false },
        detail,
        expand: { type: "string", enum: ["none", "preview", "shallow", "deep"], default: "preview" },
        depth: { type: "number", default: 1 },
        limit: { type: "number", default: 10 },
        maxString: { type: "number", default: 2000 }
      },
      required: ["action"]
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_run_to_line",
    description: "Run the selected debug session to a source line.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        filePath: { type: "string" },
        line: { type: "number", minimum: 1 },
        threadId,
        timeout,
        includeFrame: { type: "boolean", default: false },
        detail
      },
      required: ["filePath", "line"]
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_threads",
    description: "List runtime threads for a debug session.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        offset: { type: "number", default: 0 },
        limit: { type: "number", default: 50 },
        detail
      }
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_call_stack",
    description: "Return the call stack for the active or selected thread.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        threadId,
        offset: { type: "number", default: 0 },
        limit: { type: "number", default: 20 },
        detail
      }
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_frame",
    description: "Return structured variables for a stack frame.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        threadId,
        frameId: { type: "number" },
        frameIndex: { type: "number", default: 0 },
        detail,
        expand: { type: "string", enum: ["none", "preview", "shallow", "deep"], default: "preview" },
        depth: { type: "number", default: 1 },
        limit: { type: "number", default: 20 },
        maxString: { type: "number", default: 2000 }
      }
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_value",
    description: "Read a value by path from the current frame or expand a variable ref.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        threadId,
        frameId: { type: "number" },
        frameIndex: { type: "number", default: 0 },
        path: { type: "array", items: { type: "string" } },
        ref: { type: "number", description: "Opaque variable reference returned by frame/value tools." },
        start: { type: "number", default: 0 },
        count: { type: "number" },
        expand: { type: "string", enum: ["none", "preview", "shallow", "deep"], default: "deep" },
        depth: { type: "number", default: 1 },
        limit: { type: "number", default: 20 },
        detail,
        maxString: { type: "number", default: 2000 }
      }
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_set_value",
    description: "Set a variable value when the runtime provider supports mutation.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        frameIndex: { type: "number", default: 0 },
        path: { type: "array", items: { type: "string" } },
        newValue: { type: "string" },
        detail
      },
      required: ["path", "newValue"]
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_eval",
    description: "Evaluate an expression in the current debug frame.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        expression: { type: "string" },
        mode: { type: "string", enum: ["readonly", "guarded", "unsafe"], default: "readonly" },
        threadId,
        frameId: { type: "number" },
        frameIndex: { type: "number", default: 0 },
        timeout,
        detail
      },
      required: ["expression"]
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_context",
    description: "Return the current paused position, call stack, and top-frame variables.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        timeout,
        expand: { type: "string", enum: ["none", "preview", "shallow", "deep"], default: "preview" },
        depth: { type: "number", default: 1 },
        limit: { type: "number", default: 20 },
        detail
      }
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_set_breakpoint",
    description: "Set an agent-owned source breakpoint. Without sessionId, BreakPilot can route to a project-level IDE client.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        clientId,
        ide,
        breakpointId: { type: "string" },
        filePath: { type: "string" },
        line: { type: "number" },
        column: { type: "number" },
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
      },
      anyOf: [
        { required: ["filePath", "line"] },
        { required: ["breakpointId"] }
      ]
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_list_breakpoints",
    description: "List breakpoints for a debug session or project-level IDE client.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        clientId,
        ide,
        filePath: { type: "string" },
        owner,
        includeDisabled: { type: "boolean", default: true },
        detail
      }
    },
    outputSchema: toolResponseOutputSchema
  },
  {
    name: "bp_debug_remove_breakpoint",
    description: "Remove a breakpoint by breakpointId or filePath + line from a debug session or project-level IDE client.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        clientId,
        ide,
        breakpointId: { type: "string" },
        filePath: { type: "string" },
        line: { type: "number" },
        owner
      }
    },
    outputSchema: toolResponseOutputSchema
  }
];
