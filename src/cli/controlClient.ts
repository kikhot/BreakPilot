import type { ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";

export async function postTool(controlUrl: string, name: string, args: AnyRecord): Promise<ToolResponse> {
  const response = await fetch(`${controlUrl}/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args })
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as ToolResponse;
  } catch {
    return { ok: false, error: { code: "CLI_PARSE_FAILED", message: text, details: {} }, auditId: "cli" };
  }
}

export async function getJson(url: string): Promise<AnyRecord> {
  const response = await fetch(url);
  return response.json() as Promise<AnyRecord>;
}
