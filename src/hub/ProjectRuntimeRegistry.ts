import fs from "node:fs";
import path from "node:path";

import type { RuntimeContext } from "../runtime/createRuntime.ts";
import { createRuntime } from "../runtime/createRuntime.ts";
import { IdeBridgeServer } from "../ide/IdeBridgeServer.ts";
import type { AnyRecord } from "../types/json.ts";
import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";

export interface ProjectRuntimeRegistryOptions {
  defaultProjectPath?: string;
  ideBridge?: IdeBridgeServer | null;
}

export interface ProjectSummary {
  projectPath: string;
  registered: boolean;
  hasRuntime: boolean;
  sessions: number;
  ideClients: number;
  ideSessions: number;
}

interface RegisteredProject {
  projectPath: string;
  projectName?: string;
  registeredAt: string;
  updatedAt: string;
}

export class ProjectRuntimeRegistry {
  defaultProjectPath: string;
  ideBridge: IdeBridgeServer | null;
  runtimes: Map<string, RuntimeContext>;
  projects: Map<string, RegisteredProject>;

  constructor(options: ProjectRuntimeRegistryOptions = {}) {
    this.defaultProjectPath = path.resolve(options.defaultProjectPath ?? process.cwd());
    this.ideBridge = options.ideBridge ?? null;
    this.runtimes = new Map();
    this.projects = new Map();
    this.registerProject(this.defaultProjectPath, { projectName: path.basename(this.defaultProjectPath) });
    this.getOrCreate(this.defaultProjectPath);
  }

  registerProject(projectPath: string | undefined, metadata: AnyRecord = {}): void {
    if (!projectPath) return;
    const resolved = path.resolve(projectPath);
    const existing = this.projects.get(resolved);
    const now = new Date().toISOString();
    this.projects.set(resolved, {
      projectPath: resolved,
      projectName: String(metadata.projectName ?? existing?.projectName ?? path.basename(resolved)),
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now
    });
  }

  getOrCreate(projectPath?: string): RuntimeContext {
    const resolved = path.resolve(projectPath ?? this.defaultProjectPath);
    const existing = this.runtimes.get(resolved);
    if (existing) return existing;
    const policyPath = this.#policyPathForProject(resolved);
    const runtime = createRuntime({
      policyPath,
      workspaceRoot: resolved,
      enableIdeBridge: false,
      ideBridge: this.ideBridge
    });
    this.runtimes.set(resolved, runtime);
    this.registerProject(resolved);
    return runtime;
  }

  resolveRuntime(args: AnyRecord = {}, mcpProjectPath?: string): RuntimeContext {
    const explicit = args.projectPath ?? args.workspace ?? mcpProjectPath;
    if (typeof explicit === "string" && explicit.trim()) return this.getOrCreate(explicit);

    if (typeof args.sessionId === "string" && args.sessionId) {
      const matches = [...this.runtimes.values()].filter((runtime) =>
        runtime.manager.sessions.sessions.has(args.sessionId as string)
      );
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        throw new BreakPilotError(ErrorCodes.SESSION_AMBIGUOUS, "Multiple projects contain this debug session id.", {
          sessionId: args.sessionId,
          projects: matches.map((runtime) => runtime.policy.workspace.root)
        });
      }
    }

    const projectPaths = this.#candidateProjectPaths();
    if (projectPaths.length === 0) return this.getOrCreate(this.defaultProjectPath);
    if (projectPaths.length === 1) return this.getOrCreate(projectPaths[0]);
    throw new BreakPilotError(
      ErrorCodes.PROJECT_AMBIGUOUS,
      "Multiple BreakPilot projects are registered. Pass projectPath to choose one.",
      { projects: projectPaths.map((projectPath) => ({ projectPath })) }
    );
  }

  listProjects(): ProjectSummary[] {
    const paths = new Set<string>([
      ...this.projects.keys(),
      ...this.runtimes.keys(),
      ...(this.ideBridge?.registry.list().map((client) => client.workspaceRoot).filter(Boolean) as string[] | undefined ?? [])
    ]);
    return [...paths].sort().map((projectPath) => {
      const runtime = this.runtimes.get(projectPath);
      const ideClients = this.ideBridge?.registry.list().filter((client) => client.workspaceRoot === projectPath) ?? [];
      const ideSessions = this.ideBridge?.registry.listSessions({ workspaceRoot: projectPath }) ?? [];
      return {
        projectPath,
        registered: this.projects.has(projectPath),
        hasRuntime: Boolean(runtime),
        sessions: runtime?.manager.sessions.list().length ?? 0,
        ideClients: ideClients.length,
        ideSessions: ideSessions.length
      };
    });
  }

  hasActiveDebugSessions(): boolean {
    return [...this.runtimes.values()].some((runtime) =>
      runtime.manager.sessions.list().some((session) => session.state !== "terminated" && session.state !== "failed")
    );
  }

  async cleanupAll(reason: string): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.manager.cleanupAll(reason)));
  }

  #candidateProjectPaths(): string[] {
    const paths = new Set<string>(this.projects.keys());
    for (const runtime of this.runtimes.values()) {
      if (runtime.manager.sessions.list().length > 0) paths.add(runtime.policy.workspace.root);
    }
    for (const client of this.ideBridge?.registry.list() ?? []) {
      if (client.workspaceRoot) paths.add(path.resolve(client.workspaceRoot));
    }
    return [...paths].filter(Boolean).sort();
  }

  #policyPathForProject(projectPath: string): string | undefined {
    const yaml = path.join(projectPath, "breakpilot.yaml");
    if (fs.existsSync(yaml)) return yaml;
    const json = path.join(projectPath, "breakpilot.json");
    if (fs.existsSync(json)) return json;
    return undefined;
  }
}
