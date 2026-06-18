import type { ToolDefinition } from "../types/control.ts";

const sessionId = {
  type: "string",
  description: "Optional debug session id. If omitted, BreakPilot selects the active or paused session when unambiguous."
} as const;

const projectPath = {
  type: "string",
  description: "Optional project/workspace path used to route the call in a multi-project hub."
} as const;

const timeout = { type: "number", description: "Timeout in milliseconds." } as const;

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
        clientId: { type: "string" },
        ideSessionId: { type: "string" },
        adapterCommand: { type: "string" },
        adapterArgs: { type: "array", items: { type: "string" } },
        dapHost: { type: "string" },
        dapPort: { type: "number" },
        dap: { type: "object" }
      }
    }
  },
  {
    name: "bp_debug_status",
    description: "Return debugger status, active sessions, IDE sessions, and supported languages.",
    inputSchema: { type: "object", properties: { projectPath } }
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
        threadId: { type: "number" },
        timeout,
        terminateDebuggee: { type: "boolean", default: false }
      },
      required: ["action"]
    }
  },
  {
    name: "bp_debug_threads",
    description: "List runtime threads for a debug session.",
    inputSchema: { type: "object", properties: { projectPath, sessionId, limit: { type: "number", default: 50 } } }
  },
  {
    name: "bp_debug_call_stack",
    description: "Return the call stack for the active or selected thread.",
    inputSchema: {
      type: "object",
      properties: { projectPath, sessionId, threadId: { type: "number" }, limit: { type: "number", default: 20 } }
    }
  },
  {
    name: "bp_debug_frame",
    description: "Return structured variables for a stack frame.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        threadId: { type: "number" },
        frameId: { type: "number" },
        frameIndex: { type: "number", default: 0 },
        expand: { type: "string", enum: ["none", "preview", "shallow", "deep"], default: "preview" },
        depth: { type: "number", default: 1 },
        limit: { type: "number", default: 20 },
        maxString: { type: "number", default: 2000 }
      }
    }
  },
  {
    name: "bp_debug_value",
    description: "Read a value by path from the current frame or expand a variable ref.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        threadId: { type: "number" },
        frameId: { type: "number" },
        frameIndex: { type: "number", default: 0 },
        path: { type: "array", items: { type: "string" } },
        ref: { type: "number", description: "Opaque variable reference returned by frame/value tools." },
        start: { type: "number", default: 0 },
        count: { type: "number" },
        expand: { type: "string", enum: ["none", "preview", "shallow", "deep"], default: "deep" },
        depth: { type: "number", default: 1 },
        limit: { type: "number", default: 20 },
        maxString: { type: "number", default: 2000 }
      }
    }
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
        newValue: { type: "string" }
      },
      required: ["path", "newValue"]
    }
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
        threadId: { type: "number" },
        frameId: { type: "number" },
        frameIndex: { type: "number", default: 0 },
        timeout
      },
      required: ["expression"]
    }
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
        limit: { type: "number", default: 20 }
      }
    }
  },
  {
    name: "bp_debug_set_breakpoint",
    description: "Set an agent-owned source breakpoint.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        filePath: { type: "string" },
        line: { type: "number" },
        column: { type: "number" },
        condition: { type: "string" },
        hitCondition: { type: "string" },
        logMessage: { type: "string" },
        requireVerified: { type: "boolean", default: false }
      },
      required: ["filePath", "line"]
    }
  },
  {
    name: "bp_debug_list_breakpoints",
    description: "List breakpoints for a debug session.",
    inputSchema: { type: "object", properties: { projectPath, sessionId, filePath: { type: "string" } } }
  },
  {
    name: "bp_debug_remove_breakpoint",
    description: "Remove a breakpoint by breakpointId or filePath + line.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath,
        sessionId,
        breakpointId: { type: "string" },
        filePath: { type: "string" },
        line: { type: "number" }
      }
    }
  }
];
