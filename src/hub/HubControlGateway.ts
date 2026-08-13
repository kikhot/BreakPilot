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
      const hasProjectPath = Object.hasOwn(args, "projectPath");
      const shouldInjectProjectPath =
        !hasProjectPath ||
        (typeof args.projectPath === "string" && !args.projectPath.trim());
      const routedArgs = shouldInjectProjectPath
        ? { ...args, projectPath: runtime.policy.workspace.root }
        : args;
      return await runtime.router.callTool(name, routedArgs);
    } catch (error) {
      return fail(error, "hub");
    }
  }
}
