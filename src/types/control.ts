import type { AnyRecord } from "./json.ts";

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
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
    details?: AnyRecord;
  };
}

export interface ToolCallArgs extends AnyRecord {
  sessionId?: string;
}
