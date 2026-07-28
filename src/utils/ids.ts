import crypto from "node:crypto";

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function makeAuditId(): string {
  return makeId("audit");
}

export function makeSessionId(): string {
  return makeId("sess");
}

export function makeBreakpointId(): string {
  return makeId("bp");
}
