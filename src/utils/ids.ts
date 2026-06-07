const counters = new Map<string, number>();

export function makeId(prefix: string): string {
  const next = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, next);
  const stamp = Date.now().toString(36);
  return `${prefix}_${stamp}_${String(next).padStart(4, "0")}`;
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
