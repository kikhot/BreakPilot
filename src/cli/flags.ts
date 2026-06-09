export type CliFlagValue = string | boolean;
export type CliFlags = Record<string, CliFlagValue | string[] | undefined>;

export function stringFlag(flags: CliFlags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

export function stringArrayFlag(flags: CliFlags, key: string): string[] | undefined {
  const value = flags[key];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return undefined;
}

export function parseFlags(tokens: string[]): { flags: CliFlags; positional: string[] } {
  const flags: CliFlags = {};
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      const existing = flags[key];
      if (Array.isArray(existing)) {
        existing.push(next);
      } else if (typeof existing === "string") {
        flags[key] = [existing, next];
      } else {
        flags[key] = next;
      }
      i += 1;
    }
  }
  return { flags, positional };
}

export function numberOrUndefined(value: CliFlagValue | string[] | undefined): number | undefined {
  if (value === undefined || Array.isArray(value)) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function splitArgs(value: CliFlagValue | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(" ").filter(Boolean);
}

export function optionalSplitArgs(value: CliFlagValue | string[] | undefined): string[] | undefined {
  const args = splitArgs(value);
  return args.length > 0 ? args : undefined;
}
