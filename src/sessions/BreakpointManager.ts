import path from "node:path";
import type { DapBreakpoint } from "../types/dap.ts";
import type { BreakpointInput, BreakpointRecord, ProjectBreakpointRecord } from "../types/sessions.ts";
import { makeBreakpointId } from "../utils/ids.ts";

export type ProjectBreakpointInput = BreakpointInput & {
  workspaceRoot: string;
  clientId: string;
  ide: string;
  ideSessionId?: string;
};

export type ProjectBreakpointFilter = {
  workspaceRoot?: string;
  clientId?: string;
  ide?: string;
  file?: string;
};

export type BreakpointSourceReplacement = {
  filePath: string;
  records: BreakpointRecord[];
};

export class BreakpointManager {
  bySession: Map<string, Map<string, BreakpointRecord>>;
  byProject: Map<string, Map<string, ProjectBreakpointRecord>>;

  constructor() {
    this.bySession = new Map();
    this.byProject = new Map();
  }

  add(sessionId: string, breakpoint: BreakpointInput): BreakpointRecord {
    const absolute = path.resolve(breakpoint.file);
    const record: BreakpointRecord = {
      id: breakpoint.id ?? makeBreakpointId(),
      sessionId,
      file: absolute,
      line: Number(breakpoint.line),
      column: breakpoint.column === undefined ? undefined : Number(breakpoint.column),
      condition: breakpoint.condition,
      hitCondition: breakpoint.hitCondition,
      logMessage: breakpoint.logMessage,
      enabled: breakpoint.enabled ?? true,
      temporary: breakpoint.temporary ?? false,
      suspendPolicy: breakpoint.suspendPolicy,
      isLogMessage: breakpoint.isLogMessage,
      isLogStack: breakpoint.isLogStack,
      owner: breakpoint.owner ?? "agent",
      verified: false,
      adapterBreakpointId: undefined,
      createdAt: new Date().toISOString()
    };
    if (!this.bySession.has(sessionId)) this.bySession.set(sessionId, new Map());
    const sessionBreakpoints = this.bySession.get(sessionId);
    if (!sessionBreakpoints) throw new Error(`Breakpoint bucket was not initialized for ${sessionId}`);
    sessionBreakpoints.set(record.id, record);
    return this.#clone(record);
  }

  updateVerification(sessionId: string, file: string, dapBreakpoints: DapBreakpoint[]): BreakpointRecord[] {
    const normalizedFile = path.resolve(file);
    const breakpoints = [...(this.bySession.get(sessionId)?.values() ?? [])]
      .filter((bp) => path.resolve(bp.file) === normalizedFile);
    for (let index = 0; index < breakpoints.length; index += 1) {
      const dap = dapBreakpoints[index];
      if (!dap) continue;
      const breakpoint = breakpoints[index];
      if (!breakpoint) continue;
      breakpoint.verified = Boolean(dap.verified);
      breakpoint.message = dap.message;
      breakpoint.adapterBreakpointId = dap.id;
      breakpoint.line = dap.line ?? breakpoint.line;
      breakpoint.column = dap.column ?? breakpoint.column;
    }
    return breakpoints.map((breakpoint) => this.#clone(breakpoint));
  }

  remove(sessionId: string, breakpointId: string): boolean {
    return this.bySession.get(sessionId)?.delete(breakpointId) ?? false;
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  list(sessionId: string): BreakpointRecord[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])].map((breakpoint) => this.#clone(breakpoint));
  }

  get(sessionId: string, id: string): BreakpointRecord | undefined {
    const breakpoint = this.bySession.get(sessionId)?.get(id);
    return breakpoint ? this.#clone(breakpoint) : undefined;
  }

  listForSource(sessionId: string, file: string): BreakpointRecord[] {
    const normalizedFile = path.resolve(file);
    return [...(this.bySession.get(sessionId)?.values() ?? [])]
      .filter((bp) => path.resolve(bp.file) === normalizedFile)
      .map((breakpoint) => this.#clone(breakpoint));
  }

  listSource(sessionId: string, filePath: string): BreakpointRecord[] {
    return this.listForSource(sessionId, filePath);
  }

  replaceSource(sessionId: string, filePath: string, records: BreakpointRecord[]): void {
    this.replaceSources(sessionId, [{ filePath, records }]);
  }

  replaceSources(sessionId: string, replacements: BreakpointSourceReplacement[]): void {
    const prepared = this.#prepareSourceReplacements(sessionId, replacements);
    if (prepared.length === 0) return;

    const selectedSources = new Set(prepared.map((replacement) => replacement.filePath));
    const existing = this.bySession.get(sessionId);
    if (existing) {
      for (const replacement of prepared) {
        for (const record of replacement.records) {
          const conflicting = existing.get(record.id);
          if (conflicting && !selectedSources.has(path.resolve(conflicting.file))) {
            throw new Error(`Breakpoint ${record.id} belongs to an unselected source.`);
          }
        }
      }
    }

    // Clone every current record before building the final map. No stored map is
    // modified until all input and existing data has passed cloning/preflight.
    const finalSession = new Map<string, BreakpointRecord>(
      [...(existing?.entries() ?? [])].map(([id, breakpoint]) => [id, this.#clone(breakpoint)])
    );
    for (const [id, breakpoint] of finalSession.entries()) {
      if (selectedSources.has(path.resolve(breakpoint.file))) finalSession.delete(id);
    }
    for (const replacement of prepared) {
      for (const record of replacement.records) {
        finalSession.set(record.id, record);
      }
    }

    this.bySession.set(sessionId, finalSession);
  }

  addProject(breakpoint: ProjectBreakpointInput): ProjectBreakpointRecord {
    const record: ProjectBreakpointRecord = {
      id: breakpoint.id ?? makeBreakpointId(),
      workspaceRoot: path.resolve(breakpoint.workspaceRoot),
      clientId: breakpoint.clientId,
      ide: breakpoint.ide,
      ideSessionId: breakpoint.ideSessionId,
      file: path.resolve(breakpoint.file),
      line: Number(breakpoint.line),
      column: breakpoint.column ? Number(breakpoint.column) : undefined,
      condition: breakpoint.condition,
      hitCondition: breakpoint.hitCondition,
      logMessage: breakpoint.logMessage,
      enabled: breakpoint.enabled ?? true,
      temporary: breakpoint.temporary ?? false,
      suspendPolicy: breakpoint.suspendPolicy,
      isLogMessage: breakpoint.isLogMessage,
      isLogStack: breakpoint.isLogStack,
      owner: breakpoint.owner ?? "agent",
      verified: false,
      adapterBreakpointId: undefined,
      createdAt: new Date().toISOString()
    };
    const key = this.#projectKey(record.workspaceRoot, record.clientId);
    if (!this.byProject.has(key)) this.byProject.set(key, new Map());
    const projectBreakpoints = this.byProject.get(key);
    if (!projectBreakpoints) throw new Error(`Project breakpoint bucket was not initialized for ${key}`);
    projectBreakpoints.set(record.id, record);
    return record;
  }

  updateProject(
    breakpointId: string,
    patch: Partial<Pick<ProjectBreakpointRecord, "verified" | "message" | "adapterBreakpointId" | "ideBreakpointId" | "line" | "column">>
  ): ProjectBreakpointRecord | undefined {
    const breakpoint = this.findProject(breakpointId);
    if (!breakpoint) return undefined;
    Object.assign(breakpoint, patch);
    return breakpoint;
  }

  findProject(breakpointId: string): ProjectBreakpointRecord | undefined {
    for (const breakpoints of this.byProject.values()) {
      const breakpoint = breakpoints.get(breakpointId);
      if (breakpoint) return breakpoint;
    }
    return undefined;
  }

  removeProject(breakpointId: string): boolean {
    for (const breakpoints of this.byProject.values()) {
      if (breakpoints.delete(breakpointId)) return true;
    }
    return false;
  }

  clearProjectForClient(clientId: string): void {
    for (const key of [...this.byProject.keys()]) {
      if (key.endsWith(`\0${clientId}`)) this.byProject.delete(key);
    }
  }

  listProject(filter: ProjectBreakpointFilter = {}): ProjectBreakpointRecord[] {
    const workspaceRoot = filter.workspaceRoot ? path.resolve(filter.workspaceRoot) : undefined;
    const file = filter.file ? path.resolve(filter.file) : undefined;
    return [...this.byProject.values()]
      .flatMap((breakpoints) => [...breakpoints.values()])
      .filter((breakpoint) => {
        if (workspaceRoot && path.resolve(breakpoint.workspaceRoot) !== workspaceRoot) return false;
        if (filter.clientId && breakpoint.clientId !== filter.clientId) return false;
        if (filter.ide && breakpoint.ide !== filter.ide) return false;
        if (file && path.resolve(breakpoint.file) !== file) return false;
        return true;
      });
  }

  #projectKey(workspaceRoot: string, clientId: string): string {
    return `${path.resolve(workspaceRoot)}\0${clientId}`;
  }

  #clone<T extends BreakpointRecord>(breakpoint: T): T {
    return structuredClone(breakpoint);
  }

  #prepareSourceReplacements(
    sessionId: string,
    replacements: BreakpointSourceReplacement[]
  ): Array<{ filePath: string; records: BreakpointRecord[] }> {
    const prepared: Array<{ filePath: string; records: BreakpointRecord[] }> = [];
    const sources = new Set<string>();
    const ids = new Set<string>();

    for (const replacement of replacements) {
      const filePath = path.resolve(replacement.filePath);
      if (sources.has(filePath)) throw new Error(`Source replacement was duplicated for ${filePath}.`);
      sources.add(filePath);

      const records = replacement.records.map((record) => {
        const clone = this.#clone(record);
        if (!clone.id) throw new Error("Breakpoint replacement requires an id.");
        if (ids.has(clone.id)) throw new Error(`Breakpoint replacement id was duplicated: ${clone.id}.`);
        ids.add(clone.id);
        clone.sessionId = sessionId;
        clone.file = filePath;
        return clone;
      });
      prepared.push({ filePath, records });
    }
    return prepared;
  }
}
