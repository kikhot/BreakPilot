import path from "node:path";
import type { BreakpointInput, BreakpointRecord, DapBreakpoint } from "../types.ts";
import { makeBreakpointId } from "../utils/ids.ts";

export class BreakpointManager {
  bySession: Map<string, Map<string, BreakpointRecord>>;

  constructor() {
    this.bySession = new Map();
  }

  add(sessionId: string, breakpoint: BreakpointInput): BreakpointRecord {
    const absolute = path.resolve(breakpoint.file);
    const record = {
      id: breakpoint.id ?? makeBreakpointId(),
      sessionId,
      file: absolute,
      line: Number(breakpoint.line),
      column: breakpoint.column ? Number(breakpoint.column) : undefined,
      condition: breakpoint.condition,
      hitCondition: breakpoint.hitCondition,
      logMessage: breakpoint.logMessage,
      owner: breakpoint.owner ?? "agent",
      verified: false,
      adapterBreakpointId: undefined,
      createdAt: new Date().toISOString()
    };
    if (!this.bySession.has(sessionId)) this.bySession.set(sessionId, new Map());
    const sessionBreakpoints = this.bySession.get(sessionId);
    if (!sessionBreakpoints) throw new Error(`Breakpoint bucket was not initialized for ${sessionId}`);
    sessionBreakpoints.set(record.id, record);
    return record;
  }

  updateVerification(sessionId: string, file: string, dapBreakpoints: DapBreakpoint[]): BreakpointRecord[] {
    const breakpoints = this.list(sessionId).filter((bp) => path.resolve(bp.file) === path.resolve(file));
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
    return breakpoints;
  }

  remove(sessionId: string, breakpointId: string): boolean {
    return this.bySession.get(sessionId)?.delete(breakpointId) ?? false;
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  list(sessionId: string): BreakpointRecord[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])];
  }

  listForSource(sessionId: string, file: string): BreakpointRecord[] {
    return this.list(sessionId).filter((bp) => path.resolve(bp.file) === path.resolve(file));
  }
}
