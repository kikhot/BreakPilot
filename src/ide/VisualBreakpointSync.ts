import type { BreakpointRecord } from "../types.ts";
import { IdeBridgeServer } from "./IdeBridgeServer.ts";

export class VisualBreakpointSync {
  bridge?: IdeBridgeServer;

  constructor(bridge?: IdeBridgeServer) {
    this.bridge = bridge;
  }

  syncSet(sessionId: string, workspaceRoot: string, breakpoint: BreakpointRecord): void {
    this.bridge?.broadcast({
      type: "agent_set_breakpoint",
      sessionId,
      workspaceRoot,
      breakpoint
    });
  }

  syncRemove(sessionId: string, breakpointId: string): void {
    this.bridge?.broadcast({
      type: "agent_remove_breakpoint",
      sessionId,
      breakpointId
    });
  }
}
