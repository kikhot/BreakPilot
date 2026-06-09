import type { DapStackFrame } from "./dap.ts";
import type { DebugLanguage } from "./debug.ts";
import type { AnyRecord } from "./json.ts";

export interface VariableLimits {
  maxDepth: number;
  maxItems: number;
  maxStringLength: number;
  redactPatterns?: string[];
}

export type SnapshotProfile = "focused" | "locals" | "full" | "custom" | string;
export type ObjectFieldsMode = "none" | "preview" | "shallow" | "deep" | string;
export type ScopeCategory =
  | "arguments"
  | "locals"
  | "receiver"
  | "closures"
  | "globals"
  | "statics"
  | "module"
  | "runtime"
  | "other"
  | string;

export type VariableKind =
  | "primitive"
  | "object"
  | "array"
  | "boolean"
  | "number"
  | "null"
  | "metadata";

export interface SerializedVariable {
  name: string;
  type?: string;
  kind: VariableKind;
  valuePreview?: string;
  value?: unknown;
  variablesReference?: number;
  truncated: boolean;
  redacted?: boolean;
  cycle?: boolean;
  presentationError?: string;
}

export type SerializedVariableMap = Record<string, SerializedVariable | {
  kind: "metadata";
  value: string;
  truncated: boolean;
}>;

export interface ScopeMetadata {
  rawName: string;
  category: ScopeCategory;
  included: boolean;
  expensive: boolean;
  variablesReference: number;
}

export interface RuntimeSnapshot {
  sessionId: string;
  source: "headless" | "ide";
  language: DebugLanguage;
  profile?: SnapshotProfile;
  threadId: number | null;
  frameId: number | null;
  stackFrames: DapStackFrame[];
  variables: Record<string, {
    name: string;
    category?: ScopeCategory;
    rawScopes?: string[];
    expensive: boolean;
    variables: SerializedVariableMap;
  }>;
  availableCategories?: ScopeCategory[];
  omittedCategories?: ScopeCategory[];
  availableScopes?: string[];
  omittedScopes?: string[];
  scopeMetadata?: ScopeMetadata[];
  limits: Pick<Required<VariableLimits>, "maxDepth" | "maxItems" | "maxStringLength">;
}

export interface InspectVariableResult extends AnyRecord {
  variablesReference?: number;
  start?: number;
  count?: number;
  variables?: SerializedVariableMap;
  snapshot?: RuntimeSnapshot | AnyRecord;
}
