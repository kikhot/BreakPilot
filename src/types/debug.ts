export type DebugLanguage = "python" | "node" | "typescript" | "java" | string;
export type DebugMode = "headless" | "ide" | "hybrid" | string;
export type RuntimeProviderKind = "dap" | "ide" | string;
export type RuntimeStepKind = "over" | "into" | "out";
export type SessionOwnerValue = "mcp" | "ide" | "hybrid" | string;
export type SessionStateValue =
  | "created"
  | "initializing"
  | "running"
  | "paused"
  | "terminated"
  | "failed"
  | string;
