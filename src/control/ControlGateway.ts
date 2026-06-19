import type { ToolDefinition, ToolResponse } from "../types/control.ts";
import type { AnyRecord } from "../types/json.ts";
import type { ToolRouter } from "./ToolRouter.ts";

export interface ControlGateway {
  listTools(): Promise<ToolDefinition[]> | ToolDefinition[];
  callTool(name: string, args?: AnyRecord): Promise<ToolResponse>;
}

export class LocalControlGateway implements ControlGateway {
  private readonly router: ToolRouter;

  constructor(router: ToolRouter) {
    this.router = router;
  }

  listTools(): ToolDefinition[] {
    return this.router.listTools();
  }

  callTool(name: string, args: AnyRecord = {}): Promise<ToolResponse> {
    return this.router.callTool(name, args);
  }
}

export class DaemonControlGateway implements ControlGateway {
  private readonly controlUrl: string;
  private readonly controlToken?: string;

  constructor(controlUrl: string, controlToken?: string) {
    this.controlUrl = controlUrl;
    this.controlToken = controlToken;
  }

  async listTools(): Promise<ToolDefinition[]> {
    const response = await fetch(`${this.controlUrl}/tools/list`, {
      headers: this.#headers()
    });
    const payload = (await response.json()) as { tools?: ToolDefinition[]; error?: { message?: string } };
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Failed to list tools from daemon: HTTP ${response.status}`);
    }
    return payload.tools ?? [];
  }

  async callTool(name: string, args: AnyRecord = {}): Promise<ToolResponse> {
    const response = await fetch(`${this.controlUrl}/tools/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.#headers()
      },
      body: JSON.stringify({ name, arguments: args })
    });
    const text = await response.text();
    try {
      return JSON.parse(text) as ToolResponse;
    } catch {
      return {
        error: {
          code: "DAEMON_PARSE_FAILED",
          message: text || `Daemon returned HTTP ${response.status}`,
          details: { status: response.status }
        }
      };
    }
  }

  async acquireClient(clientId: string, kind = "mcp"): Promise<AnyRecord> {
    return this.#postClient("acquire", { clientId, kind, pid: process.pid });
  }

  async heartbeatClient(clientId: string): Promise<AnyRecord> {
    return this.#postClient("heartbeat", { clientId });
  }

  async releaseClient(clientId: string): Promise<AnyRecord> {
    return this.#postClient("release", { clientId });
  }

  async #postClient(action: "acquire" | "heartbeat" | "release", payload: AnyRecord): Promise<AnyRecord> {
    const response = await fetch(`${this.controlUrl}/clients/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.#headers()
      },
      body: JSON.stringify(payload)
    });
    const parsed = (await response.json()) as AnyRecord;
    if (!response.ok || parsed.error) {
      throw new Error(String((parsed.error as AnyRecord | undefined)?.message ?? `Client lease ${action} failed.`));
    }
    return parsed;
  }

  #headers(): Record<string, string> {
    return this.controlToken ? { authorization: `Bearer ${this.controlToken}` } : {};
  }
}
