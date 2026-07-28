import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeTranscript } from "../src/evidence/DifferentialEvidenceSanitizer.ts";
import { EvidenceVerificationError, type TranscriptEntry } from "../src/evidence/DifferentialEvidenceTypes.ts";

const entry: TranscriptEntry = {
  schemaVersion: 1,
  sequence: 1,
  timestamp: "2026-07-25T10:11:12.000Z",
  provider: "breakpilot",
  direction: "response",
  stepId: "context",
  attempt: 1,
  payload: {
    path: "/Users/quixote/work/a.java",
    pid: 8123,
    port: 57987,
    sessionId: "s-9",
    variables: [{ path: ["analysis", "score"], value: 28 }]
  }
};

test("sanitization is deterministic, idempotent, and preserves semantic paths", () => {
  const once = sanitizeTranscript("breakpilot", [entry]);
  const twice = sanitizeTranscript("breakpilot", once.entries);
  assert.deepEqual(twice.entries, once.entries);
  assert.deepEqual((once.entries[0]!.payload as any).variables[0].path, ["analysis", "score"]);
  assert.notEqual((once.entries[0]!.payload as any).path, "/Users/quixote/work/a.java");
  assert.equal((once.entries[0]!.payload as any).sessionId, "<id-1>");
});

test("sanitization fails closed without echoing secret values", () => {
  const secret = "Bearer should-never-appear-in-error";
  assert.throws(
    () => sanitizeTranscript("breakpilot", [{ ...entry, payload: { authorization: secret } }]),
    (error: unknown) => {
      assert.ok(error instanceof EvidenceVerificationError);
      assert.doesNotMatch(error.message, /should-never/);
      return true;
    }
  );
  assert.throws(
    () => sanitizeTranscript("breakpilot", [{ ...entry, payload: { "x-api-key": "short-secret" } }]),
    EvidenceVerificationError
  );
});

test("provider identities cannot cross transcript boundaries", () => {
  assert.throws(() => sanitizeTranscript("idea", [entry]), EvidenceVerificationError);
});

test("unknown provider-private fields fail closed", () => {
  assert.throws(
    () => sanitizeTranscript("breakpilot", [{ ...entry, payload: { providerPrivateMetadata: "not-reviewed" } }]),
    (error: unknown) => error instanceof EvidenceVerificationError && error.path === "/0/payload/providerPrivateMetadata"
  );
});

test("unknown transcript fields and compound secret names fail closed", () => {
  assert.throws(
    () => sanitizeTranscript("breakpilot", [{ ...entry, privateKey: "short-private-key" } as any]),
    (error: unknown) => error instanceof EvidenceVerificationError && error.path === "/0/privateKey"
  );
  assert.throws(
    () => sanitizeTranscript("breakpilot", [{ ...entry, payload: { values: { dbPassword: "hunter2" } } }]),
    (error: unknown) => error instanceof EvidenceVerificationError && error.path === "/0/payload/values/dbPassword"
  );
  assert.throws(
    () => sanitizeTranscript("breakpilot", [{ ...entry, payload: { values: { serviceSecret: "shortsecret" } } }]),
    EvidenceVerificationError
  );
  assert.throws(
    () => sanitizeTranscript("breakpilot", [{ ...entry, payload: { values: { tokenValue: "hunter2" } } }]),
    (error: unknown) => error instanceof EvidenceVerificationError && error.path === "/0/payload/values/tokenValue"
  );
});

test("malformed transcript envelopes fail before payload publication", () => {
  assert.throws(
    () => sanitizeTranscript("breakpilot", [{ ...entry, sequence: 0 }]),
    (error: unknown) => error instanceof EvidenceVerificationError && error.path === "/0/sequence"
  );
  assert.throws(
    () => sanitizeTranscript("breakpilot", [{ ...entry, direction: "private" as any }]),
    (error: unknown) => error instanceof EvidenceVerificationError && error.path === "/0/direction"
  );
});
