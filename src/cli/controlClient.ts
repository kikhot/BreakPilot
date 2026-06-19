import type { ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";

export async function postTool(
  controlUrl: string,
  name: string,
  args: AnyRecord,
  controlToken?: string
): Promise<ToolResponse> {
  const response = await fetch(`${controlUrl}/tools/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(controlToken ? { authorization: `Bearer ${controlToken}` } : {})
    },
    body: JSON.stringify({ name, arguments: args })
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as ToolResponse;
  } catch {
    return { error: { code: "CLI_PARSE_FAILED", message: text } };
  }
}

export async function getJson(url: string, controlToken?: string): Promise<AnyRecord> {
  const response = await fetch(url, {
    headers: controlToken ? { authorization: `Bearer ${controlToken}` } : {}
  });
  return response.json() as Promise<AnyRecord>;
}
