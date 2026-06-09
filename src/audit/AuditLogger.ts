import fs from "node:fs";
import path from "node:path";
import type { AnyRecord } from "../types/json.ts";
import type { BreakPilotPolicy } from "../types/policy.ts";
import { makeAuditId } from "../utils/ids.ts";

export class AuditLogger {
  enabled: boolean;
  file?: string;

  constructor(policy: BreakPilotPolicy) {
    this.enabled = Boolean(policy.audit?.enabled);
    this.file = policy.audit?.file;
  }

  record(type: string, payload: AnyRecord = {}): string {
    const auditId = makeAuditId();
    const entry = {
      auditId,
      type,
      timestamp: new Date().toISOString(),
      ...payload
    };
    if (this.enabled && this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    }
    return auditId;
  }
}
