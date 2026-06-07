import type { ToolDefinition } from "../types.ts";

const sessionId = {
  type: "string",
  description: "Debug session id returned by debug_launch or debug_attach."
} as const;

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "debug_launch",
    description: "Launch a target program through a Debug Adapter Protocol adapter.",
    inputSchema: {
      type: "object",
      properties: {
        lang: { type: "string", enum: ["python", "node", "typescript", "java"] },
        program: { type: "string" },
        module: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: { type: "object" },
        mode: { type: "string", enum: ["headless", "ide", "hybrid"], default: "headless" },
        owner: { type: "string", enum: ["mcp", "ide", "hybrid"], default: "mcp" },
        adapterCommand: { type: "string" },
        adapterArgs: { type: "array", items: { type: "string" } },
        dap: { type: "object", description: "Raw adapter-specific launch arguments." }
      },
      required: ["lang"]
    }
  },
  {
    name: "debug_attach",
    description: "Attach to a target runtime through a DAP adapter.",
    inputSchema: {
      type: "object",
      properties: {
        lang: { type: "string", enum: ["python", "node", "typescript", "java"] },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "number" },
        mode: { type: "string", enum: ["headless", "ide", "hybrid"], default: "headless" },
        owner: { type: "string", enum: ["mcp", "ide", "hybrid"], default: "mcp" },
        adapterCommand: { type: "string" },
        adapterArgs: { type: "array", items: { type: "string" } },
        dapHost: { type: "string", description: "Connect directly to an existing DAP server." },
        dapPort: { type: "number", description: "Existing DAP server port." },
        dap: { type: "object", description: "Raw adapter-specific attach arguments." }
      },
      required: ["lang"]
    }
  },
  {
    name: "set_breakpoint",
    description: "Set an agent-owned line breakpoint and optionally sync it to an IDE.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId,
        file: { type: "string" },
        line: { type: "number" },
        column: { type: "number" },
        condition: { type: "string" },
        hitCondition: { type: "string" },
        logMessage: { type: "string" },
        requireVerified: { type: "boolean", default: false }
      },
      required: ["sessionId", "file", "line"]
    }
  },
  {
    name: "wait_for_breakpoint",
    description: "Wait until the target runtime stops at a breakpoint or step event.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId,
        timeoutMs: { type: "number", default: 30000 }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "get_runtime_snapshot",
    description: "Read stack, scopes, locals, arguments, and object fields from the current stopped frame.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId,
        threadId: { type: "number" },
        frameId: { type: "number" },
        frameIndex: { type: "number", default: 0 },
        maxDepth: { type: "number", default: 3 },
        maxItems: { type: "number", default: 50 },
        maxStringLength: { type: "number", default: 2000 }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "evaluate",
    description: "Evaluate an expression in the current debug frame with policy-controlled risk modes.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId,
        expression: { type: "string" },
        mode: { type: "string", enum: ["readonly", "guarded", "unsafe"], default: "readonly" },
        threadId: { type: "number" },
        frameId: { type: "number" },
        timeoutMs: { type: "number", default: 1000 }
      },
      required: ["sessionId", "expression"]
    }
  },
  {
    name: "continue_execution",
    description: "Continue a paused runtime thread.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId,
        threadId: { type: "number" }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "remove_breakpoint",
    description: "Remove an agent-owned breakpoint.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId,
        breakpointId: { type: "string" }
      },
      required: ["sessionId", "breakpointId"]
    }
  },
  {
    name: "list_sessions",
    description: "List active debug sessions.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "list_breakpoints",
    description: "List breakpoints for a session.",
    inputSchema: {
      type: "object",
      properties: { sessionId },
      required: ["sessionId"]
    }
  },
  {
    name: "step_over",
    description: "Step over in the current thread.",
    inputSchema: {
      type: "object",
      properties: { sessionId, threadId: { type: "number" } },
      required: ["sessionId"]
    }
  },
  {
    name: "step_into",
    description: "Step into in the current thread.",
    inputSchema: {
      type: "object",
      properties: { sessionId, threadId: { type: "number" } },
      required: ["sessionId"]
    }
  },
  {
    name: "step_out",
    description: "Step out in the current thread.",
    inputSchema: {
      type: "object",
      properties: { sessionId, threadId: { type: "number" } },
      required: ["sessionId"]
    }
  },
  {
    name: "disconnect",
    description: "Disconnect a debug session and clear agent breakpoints.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId,
        terminateDebuggee: { type: "boolean", default: false },
        restart: { type: "boolean", default: false }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "ide_status",
    description: "Return IDE Bridge status and connected IDE clients.",
    inputSchema: { type: "object", properties: {} }
  }
];
