import type { ControlGateway } from "../control/ControlGateway.ts";
import type { ToolDefinition, ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";
import { fail } from "../utils/errors.ts";
import type { ProjectRuntimeRegistry } from "./ProjectRuntimeRegistry.ts";

export class HubControlGateway implements ControlGateway {
  private readonly projects: ProjectRuntimeRegistry;
  private readonly requestProjectPath?: string;

  constructor(projects: ProjectRuntimeRegistry, requestProjectPath?: string) {
    this.projects = projects;
    this.requestProjectPath = requestProjectPath;
  }

  listTools(): ToolDefinition[] {
    return this.projects.getOrCreate(this.requestProjectPath).router.listTools();
  }

  async callTool(name: string, args: AnyRecord = {}): Promise<ToolResponse> {
    try {
      const runtime = this.projects.resolveRuntime(args, this.requestProjectPath);
      const hasProjectSelector =
        (typeof args.projectPath === "string" && Boolean(args.projectPath.trim())) ||
        (typeof args.workspace === "string" && Boolean(args.workspace.trim()));
      const routedArgs = hasProjectSelector
        ? args
        : { ...args, projectPath: runtime.policy.workspace.root };
      return await runtime.router.callTool(name, routedArgs);
    } catch (error) {
      return fail(error, "hub");
    }
  }
}
