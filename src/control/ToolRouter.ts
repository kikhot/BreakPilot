import type { ToolDefinition, ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";
import { DebugSessionManager } from "../sessions/DebugSessionManager.ts";
import { BreakPilotError, ErrorCodes, fail, toErrorPayload } from "../utils/errors.ts";
import { validateToolInput } from "./ToolInputValidator.ts";
import { operationKindForTool, ToolResponseFinalizer } from "./ToolResponseFinalizer.ts";
import { toolDefinitions } from "./toolDefinitions.ts";

type ToolHandler = (args: AnyRecord) => Promise<ToolResponse<unknown>> | ToolResponse<unknown>;

export class ToolRouter {
  manager: DebugSessionManager;
  handlers: Map<string, ToolHandler>;
  definitions: Map<string, ToolDefinition>;
  finalizer: ToolResponseFinalizer;

  constructor(manager: DebugSessionManager) {
    this.manager = manager;
    this.finalizer = new ToolResponseFinalizer(manager.audit);
    this.definitions = new Map(toolDefinitions.map((definition) => [definition.name, definition]));
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
        for (const property of ["language", "lang"]) {
          const language = tool.inputSchema?.properties?.[property];
          if (language) language.enum = identifiers;
        }
      }
    }
    return clone;
  }

  async callTool(name: string, args: unknown = {}): Promise<ToolResponse> {
    const handler = this.handlers.get(name);
    if (!handler) {
      return fail(new Error(`Unknown tool: ${name}`), this.manager.audit.record("unknown_tool", { name }));
    }
    const definition = this.definitions.get(name);
    if (!definition) {
      return fail(
        new Error(`Missing tool definition: ${name}`),
        this.manager.audit.record("tool_failed", { name, message: `Missing tool definition: ${name}` })
      );
    }
    const operation = operationKindForTool(name);
    try {
      const validation = validateToolInput(this.#validationSchema(definition), args);
      if (validation.errors.length > 0) {
        throw new BreakPilotError(
          ErrorCodes.INVALID_ARGUMENT,
          `Invalid arguments for ${name}.`,
          { issues: validation.errors }
        );
      }
      const candidate = await handler(validation.value);
      return this.finalizer.finalize(definition, candidate, operation);
    } catch (error) {
      const errorPayload = toErrorPayload(error);
      const auditId = this.manager.audit.record("tool_failed", {
        name,
        message: errorPayload.message,
        code: errorPayload.code
      });
      return this.finalizer.finalize(definition, fail(error, auditId), operation);
    }
  }

  #validationSchema(definition: ToolDefinition): ToolDefinition["inputSchema"] {
    if (definition.name !== "bp_debug_start") return definition.inputSchema;
    const schema = structuredClone(definition.inputSchema);
    for (const property of ["language", "lang"]) {
      const language = schema.properties?.[property];
      if (language) language.enum = this.manager.adapters.listIdentifiers();
    }
    return schema;
  }
}
