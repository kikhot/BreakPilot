import type { AnyRecord } from "./json.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: AnyRecord;
  outputSchema?: AnyRecord;
}

export interface ToolResponse<TData = unknown> {
  ok: boolean;
  sessionId?: string;
  data?: TData;
  warnings?: string[];
  auditId: string;
  error?: {
    code: string;
    message: string;
    details: AnyRecord;
  };
}

export interface ToolCallArgs extends AnyRecord {
  sessionId?: string;
}
