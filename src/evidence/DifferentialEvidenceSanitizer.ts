import path from "node:path";

import {
  EvidenceVerificationError,
  type TranscriptEntry,
  type TranscriptProvider
} from "./DifferentialEvidenceTypes.ts";

export const SANITIZER_ID = "breakpilot-differential-v1" as const;
export const SANITIZER_VERSION = 1 as const;

const forbiddenKeys = new Set([
  "authorization", "cookie", "header", "headers", "environment", "env", "token",
  "accesstoken", "apikey", "privatekey", "secret", "password"
]);
const forbiddenKeyParts = /(?:authorization|credential|password|secret|privatekey|apikey|accesstoken|token|cookie)/;
const transcriptKeys = new Set([
  "schemaVersion", "sequence", "timestamp", "provider", "direction", "stepId", "attempt", "payload"
]);
const idKey = /(session|thread|frame|variable|request|process|breakpoint|client|confirmation).*id$|^id$/i;
const portKey = /port$/i;
const pidKey = /^(pid|processId)$/i;
const timestampKey = /^(timestamp|startedAt|updatedAt|createdAt)$/i;
const tokenPattern = /^<(path|port|pid|timestamp|id)-\d+>$/;
const highEntropy = /(?:[A-Za-z0-9+/_-]{40,}={0,2})/;
const dynamicObjectKeys = new Set(["arguments", "options", "params", "values"]);
const allowedKeys = new Set([
  "action", "actionKind", "active", "allThreadsContinued", "allThreadsStopped", "analysis", "arguments",
  "attempt", "availableCategories", "availableScopes", "breakpoint", "breakpointId", "breakpoints", "bytes",
  "capabilities", "category", "clientId", "code", "column", "completeness", "confirmationId", "content",
  "data", "description", "direction", "enabled", "error", "event", "expensive", "expression", "file",
  "filePath", "frameCount", "frameId", "frames", "hitBreakpointIds", "id", "ide", "ideSessionId",
  "indexedVariables", "isCurrent", "isError", "items", "kind", "language", "levels", "limit", "limits",
  "line", "logMessage", "maxDepth", "maxItems", "maxStringLength", "memoryReference", "message", "method",
  "modifiable", "mutationMode", "name", "namedVariables", "newValue", "nextOffset", "normalizedName", "offset",
  "oldValue", "options", "originRequestId", "params", "partial", "path", "pauseChangedAfterDispatch",
  "pauseChangedDuringReadback", "pauseEpoch", "payload", "pid", "port", "position", "presentationError",
  "presentationHint", "profile", "provider", "rawScopes", "reason", "redacted", "ref", "requestId", "result",
  "schemaVersion", "scope", "score", "sequence", "sessionId", "source", "stackFrames", "state", "status",
  "stepId", "stopped", "structuredContent", "temporary", "text", "threadId", "threads", "timestamp", "title",
  "topFrame", "totalFrames", "truncated", "truncationReason", "type", "value", "valuePreview", "values",
  "variable", "variables", "variablesReference", "verified", "warnings", "workspaceRoot"
]);

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
  const dynamicChildren = key !== undefined && dynamicObjectKeys.has(key);
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = pointer(at, childKey);
    const normalizedKey = childKey.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (forbiddenKeys.has(normalizedKey) || forbiddenKeyParts.test(normalizedKey)) {
      throw new EvidenceVerificationError("sanitizer", childPath, "Sensitive evidence field is not permitted.");
    }
    if (!dynamicChildren && !allowedKeys.has(childKey)) {
      throw new EvidenceVerificationError("sanitizer", childPath, "Unreviewed evidence field is not permitted.");
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
    for (const key of Object.keys(entry)) {
      if (!transcriptKeys.has(key)) {
        throw new EvidenceVerificationError("sanitizer", `/${index}/${key}`, "Unreviewed transcript field is not permitted.");
      }
    }
    if (entry.schemaVersion !== 1) throw new EvidenceVerificationError("sanitizer", `/${index}/schemaVersion`, "Transcript schema version is invalid.");
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) {
      throw new EvidenceVerificationError("sanitizer", `/${index}/sequence`, "Transcript sequence is invalid.");
    }
    if (typeof entry.timestamp !== "string" || !entry.timestamp) {
      throw new EvidenceVerificationError("sanitizer", `/${index}/timestamp`, "Transcript timestamp is invalid.");
    }
    if (entry.provider !== provider) {
      throw new EvidenceVerificationError("sanitizer", `/${index}/provider`, "Transcript provider mismatch.");
    }
    if (entry.direction !== "request" && entry.direction !== "response" && entry.direction !== "error") {
      throw new EvidenceVerificationError("sanitizer", `/${index}/direction`, "Transcript direction is invalid.");
    }
    if (typeof entry.stepId !== "string" || !entry.stepId) {
      throw new EvidenceVerificationError("sanitizer", `/${index}/stepId`, "Transcript step id is invalid.");
    }
    if (!Number.isSafeInteger(entry.attempt) || entry.attempt < 1) {
      throw new EvidenceVerificationError("sanitizer", `/${index}/attempt`, "Transcript attempt is invalid.");
    }
    return {
      schemaVersion: entry.schemaVersion,
      sequence: entry.sequence,
      timestamp: sanitizeValue(entry.timestamp, state, `/${index}/timestamp`, "timestamp") as string,
      provider: entry.provider,
      direction: entry.direction,
      stepId: sanitizeValue(entry.stepId, state, `/${index}/stepId`, "stepId") as string,
      attempt: entry.attempt,
      payload: sanitizeValue(entry.payload, state, `/${index}/payload`)
    };
  });
  return { entries: sanitized, tokens: Object.fromEntries(state.values) };
}
