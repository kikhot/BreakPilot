import type { AnyRecord } from "./json.ts";

export interface JsonSchema {
  $schema?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  minItems?: number;
  additionalProperties?: boolean | JsonSchema;
  default?: unknown;
  description?: string;
}

export interface ToolValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

export interface ToolValidationResult {
  value: AnyRecord;
  errors: ToolValidationIssue[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

export interface ToolResponse<TData = unknown> {
  [key: string]: unknown;
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    retrySafe: boolean;
    actionMayHaveApplied: boolean;
    hint?: string;
    diagnostics?: AnyRecord;
  };
}

export interface ToolCallArgs extends AnyRecord {
  sessionId?: string;
}
