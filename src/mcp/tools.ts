import type { AnyRecord, ToolDefinition, ToolResponse } from "../types.ts";
import { DebugSessionManager } from "../sessions/DebugSessionManager.ts";
import { fail } from "../utils/errors.ts";
import { toolDefinitions } from "./schemas.ts";

type ToolHandler = (args: AnyRecord) => Promise<ToolResponse<unknown>> | ToolResponse<unknown>;

export class ToolRouter {
  manager: DebugSessionManager;
  handlers: Map<string, ToolHandler>;

  constructor(manager: DebugSessionManager) {
    this.manager = manager;
    this.handlers = new Map<string, ToolHandler>([
      ["debug_launch", (args: AnyRecord) => this.manager.debugLaunch(args)],
      ["debug_attach", (args: AnyRecord) => this.manager.debugAttach(args)],
      ["set_breakpoint", (args: AnyRecord) => this.manager.setBreakpoint(args)],
      ["wait_for_breakpoint", (args: AnyRecord) => this.manager.waitForBreakpoint(args)],
      ["get_runtime_snapshot", (args: AnyRecord) => this.manager.getRuntimeSnapshot(args)],
      ["evaluate", (args: AnyRecord) => this.manager.evaluate(args)],
      ["continue_execution", (args: AnyRecord) => this.manager.continueExecution(args)],
      ["remove_breakpoint", (args: AnyRecord) => this.manager.removeBreakpoint(args)],
      ["list_sessions", () => this.manager.listSessions()],
      ["list_breakpoints", (args: AnyRecord) => this.manager.listBreakpoints(args)],
      ["step_over", (args: AnyRecord) => this.manager.step(args, "over")],
      ["step_into", (args: AnyRecord) => this.manager.step(args, "into")],
      ["step_out", (args: AnyRecord) => this.manager.step(args, "out")],
      ["disconnect", (args: AnyRecord) => this.manager.disconnect(args)],
      ["ide_status", () => this.manager.ideStatus()]
    ]);
  }

  listTools(): ToolDefinition[] {
    return toolDefinitions;
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
