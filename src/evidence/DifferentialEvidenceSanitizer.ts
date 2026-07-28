import path from "node:path";

import {
  EvidenceVerificationError,
  type TranscriptEntry,
  type TranscriptProvider
} from "./DifferentialEvidenceTypes.ts";

export const SANITIZER_ID = "breakpilot-differential-v1" as const;
export const SANITIZER_VERSION = 1 as const;

const forbiddenKey = /^(authorization|cookie|headers?|environment|env|token|accessToken|apiKey|privateKey|secret|password)$/i;
const idKey = /(session|thread|frame|variable|request|process|breakpoint|client|confirmation).*id$|^id$/i;
const portKey = /port$/i;
const pidKey = /^(pid|processId)$/i;
const timestampKey = /^(timestamp|startedAt|updatedAt|createdAt)$/i;
const tokenPattern = /^<(path|port|pid|timestamp|id)-\d+>$/;
const highEntropy = /(?:[A-Za-z0-9+/_-]{40,}={0,2})/;

type TokenState = { values: Map<string, string>; counts: Map<string, number> };

function token(state: TokenState, category: string, value: unknown): string {
  const identity = `${category}:${String(value)}`;
  const existing = state.values.get(identity);
  if (existing) return existing;
  const next = (state.counts.get(category) ?? 0) + 1;
  state.counts.set(category, next);
  const assigned = `<${category}-${next}>`;
  state.values.set(identity, assigned);
  return assigned;
}

function pointer(parent: string, key: string | number): string {
  const escaped = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${parent}/${escaped}`;
}

function sanitizeValue(value: unknown, state: TokenState, at: string, key?: string): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (key && portKey.test(key)) return token(state, "port", value);
    if (key && pidKey.test(key)) return token(state, "pid", value);
    if (key && idKey.test(key)) return token(state, "id", value);
    return value;
  }
  if (typeof value === "string") {
    if (tokenPattern.test(value)) return value;
    if (key && timestampKey.test(key)) return token(state, "timestamp", value);
    if (key && idKey.test(key)) return token(state, "id", value);
    if (path.isAbsolute(value)) return token(state, "path", value);
    if (highEntropy.test(value)) throw new EvidenceVerificationError("sanitizer", at, "Sensitive evidence string is not permitted.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => sanitizeValue(item, state, pointer(at, index)));
  if (typeof value !== "object") throw new EvidenceVerificationError("sanitizer", at, "Unsupported evidence value.");
  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = pointer(at, childKey);
    if (forbiddenKey.test(childKey)) {
      throw new EvidenceVerificationError("sanitizer", childPath, "Sensitive evidence field is not permitted.");
    }
    output[childKey] = sanitizeValue(child, state, childPath, childKey);
  }
  return output;
}

export function sanitizeTranscript(
  provider: TranscriptProvider,
  entries: readonly TranscriptEntry[]
): { entries: TranscriptEntry[]; tokens: Record<string, string> } {
  const state: TokenState = { values: new Map(), counts: new Map() };
  const sanitized = entries.map((entry, index) => {
    if (entry.provider !== provider) {
      throw new EvidenceVerificationError("sanitizer", `/${index}/provider`, "Transcript provider mismatch.");
    }
    return {
      ...entry,
      timestamp: sanitizeValue(entry.timestamp, state, `/${index}/timestamp`, "timestamp") as string,
      payload: sanitizeValue(entry.payload, state, `/${index}/payload`)
    };
  });
  return { entries: sanitized, tokens: Object.fromEntries(state.values) };
}
