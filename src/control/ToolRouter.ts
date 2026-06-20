import type { ToolDefinition, ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";
import { DebugSessionManager } from "../sessions/DebugSessionManager.ts";
import { fail } from "../utils/errors.ts";
import { toolDefinitions } from "./toolDefinitions.ts";

type ToolHandler = (args: AnyRecord) => Promise<ToolResponse<unknown>> | ToolResponse<unknown>;

export class ToolRouter {
  manager: DebugSessionManager;
  handlers: Map<string, ToolHandler>;

  constructor(manager: DebugSessionManager) {
    this.manager = manager;
    this.handlers = new Map<string, ToolHandler>([
      ["bp_debug_start", (args: AnyRecord) => this.manager.bpDebugStart(args)],
      ["bp_debug_run_configurations", (args: AnyRecord) => this.manager.bpDebugRunConfigurations(args)],
      ["bp_debug_status", (args: AnyRecord) => this.manager.bpDebugStatus(args)],
      ["bp_debug_control", (args: AnyRecord) => this.manager.bpDebugControl(args)],
      ["bp_debug_run_to_line", (args: AnyRecord) => this.manager.bpDebugRunToLine(args)],
      ["bp_debug_threads", (args: AnyRecord) => this.manager.bpDebugThreads(args)],
      ["bp_debug_call_stack", (args: AnyRecord) => this.manager.bpDebugCallStack(args)],
      ["bp_debug_frame", (args: AnyRecord) => this.manager.bpDebugFrame(args)],
      ["bp_debug_value", (args: AnyRecord) => this.manager.bpDebugValue(args)],
      ["bp_debug_set_value", (args: AnyRecord) => this.manager.bpDebugSetValue(args)],
      ["bp_debug_eval", (args: AnyRecord) => this.manager.bpDebugEval(args)],
      ["bp_debug_context", (args: AnyRecord) => this.manager.bpDebugContext(args)],
      ["bp_debug_set_breakpoint", (args: AnyRecord) => this.manager.bpDebugSetBreakpoint(args)],
      ["bp_debug_list_breakpoints", (args: AnyRecord) => this.manager.bpDebugListBreakpoints(args)],
      ["bp_debug_remove_breakpoint", (args: AnyRecord) => this.manager.bpDebugRemoveBreakpoint(args)]
    ]);
  }

  listTools(): ToolDefinition[] {
    const identifiers = this.manager.adapters.listIdentifiers();
    const clone = structuredClone(toolDefinitions) as ToolDefinition[];
    for (const tool of clone) {
      if (tool.name === "bp_debug_start") {
        const lang = tool.inputSchema?.properties?.language;
        if (lang) {
          lang.enum = identifiers;
        }
      }
    }
    return clone;
  }

  async callTool(name: string, args: AnyRecord = {}): Promise<ToolResponse> {
    const handler = this.handlers.get(name);
    if (!handler) {
      return fail(new Error(`Unknown tool: ${name}`), this.manager.audit.record("unknown_tool", { name }));
    }
    try {
      return await handler(args);
    } catch (error) {
      const typedError = error as Error & { code?: string };
      const auditId = this.manager.audit.record("tool_failed", {
        name,
        message: typedError.message,
        code: typedError.code
      });
      return fail(error, auditId);
    }
  }
}
