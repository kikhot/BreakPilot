export const SessionOwner = Object.freeze({
  MCP: "mcp",
  IDE: "ide",
  HYBRID: "hybrid"
} as const);

export const SessionState = Object.freeze({
  CREATED: "created",
  INITIALIZING: "initializing",
  RUNNING: "running",
  PAUSED: "paused",
  TERMINATED: "terminated",
  FAILED: "failed"
} as const);
