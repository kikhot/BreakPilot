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
export type RuntimeReference = number | string;
export type RuntimeMutationMode = "native" | "evaluateAssignment";
export type RuntimeStackFrame = Omit<DapStackFrame, "id"> & { id: RuntimeReference };
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
  variablesReference?: RuntimeReference;
  pauseEpoch?: number;
  childrenCount?: number;
  complete?: boolean;
  modifiable?: boolean;
  mutationMode?: RuntimeMutationMode;
  truncated: boolean;
  redacted?: boolean;
  cycle?: boolean;
  presentationError?: string;
}

export interface VariableNode {
  name: string;
  label: string;
  type?: string;
  kind: VariableKind;
  summary: string;
  raw?: unknown;
  path?: string[];
  ref?: RuntimeReference;
  parentRef?: RuntimeReference;
  pauseEpoch?: number;
  childrenCount?: number;
  complete?: boolean;
  modifiable?: boolean;
  mutationMode?: RuntimeMutationMode;
  expandable: boolean;
  truncated: boolean;
  redacted?: boolean;
  cycle?: boolean;
  children?: VariableNode[];
}

export interface VariableScopeView {
  scope: string;
  category?: ScopeCategory;
  rawScopes?: string[];
  expensive?: boolean;
  items: VariableNode[];
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
  variablesReference: RuntimeReference;
}

export interface RuntimeSnapshot {
  sessionId: string;
  source: "headless" | "ide";
  language: DebugLanguage;
  profile?: SnapshotProfile;
  threadId: number | null;
  frameId: RuntimeReference | null;
  threads?: AnyRecord[];
  partial?: boolean;
  stackFrames: RuntimeStackFrame[];
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
  variablesReference?: RuntimeReference;
  start?: number;
  count?: number;
  variables?: SerializedVariableMap;
  snapshot?: RuntimeSnapshot | AnyRecord;
}
