import {
  serveStdio,
  type ServeStdioOptions,
  type StdioServerHandle
} from "@modelcontextprotocol/server/stdio";

import type { ControlGateway } from "../control/ControlGateway.ts";
import { createBreakPilotMcpServer } from "./serverFactory.ts";

export function startStdio(
  gateway: ControlGateway,
  options: Omit<ServeStdioOptions, "legacy"> = {}
): StdioServerHandle {
  return serveStdio(
    () => createBreakPilotMcpServer(gateway),
    { ...options, legacy: "serve" }
  );
}
