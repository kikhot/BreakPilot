import type { ControlGateway } from "../control/ControlGateway.ts";
import type { ToolDefinition, ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";
import { fail } from "../utils/errors.ts";
import type { ProjectRuntimeRegistry } from "./ProjectRuntimeRegistry.ts";

function firstNonblank(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && Boolean(value.trim())
  );
}

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
      const explicit = firstNonblank(args.projectPath, args.workspace);
      const routedArgs = {
        ...args,
        projectPath: explicit ?? runtime.policy.workspace.root
      };
      return await runtime.router.callTool(name, routedArgs);
    } catch (error) {
      return fail(error, "hub");
    }
  }
}
