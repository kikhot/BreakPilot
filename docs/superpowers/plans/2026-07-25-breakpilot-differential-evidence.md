# BreakPilot Differential Debug Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-authored IDEA-vs-BreakPilot semantic fixture with an executable, hashable, sanitized, lineage-backed differential evidence workflow that is honest about when live IDE infrastructure is unavailable.

**Architecture:** Put evidence code under `src/evidence/` so the repository typechecks it. A capture command writes append-only raw provider-local NDJSON to ignored `.breakpilot/evidence/`, closes and hashes raw artifacts before a deterministic allowlist sanitizer produces committed-safe derivatives, then replay verifies manifest/hash/lineage and extracts a semantic comparison artifact. Offline synthetic replay remains part of CI; live native-IDEA capture is explicit and fails visibly rather than silently passing when infrastructure is absent.

**Tech Stack:** TypeScript 5.9, Node.js >=22.6, built-in `node:crypto`, JSON-RPC stdio MCP clients, existing MCP/Hub endpoints, built-in `node:assert/strict`.

## Global Constraints

- Raw transcripts must live below `.breakpilot/evidence/differential/<runId>/`; `.breakpilot/` is already ignored and raw files must never be added under `test/fixtures` or committed without a separate secret review.
- The normal `npm test` suite runs synthetic sanitizer/hash/lineage/replay tests only. It must never launch an IDEA instance, make a production request, or claim a skipped live capture passed.
- The live command uses an explicit absolute configuration path and reports `EVIDENCE_INFRASTRUCTURE_UNAVAILABLE` non-zero if native IDEA MCP, BreakPilot hub/bridge, or the paused session is unavailable.
- Do not assume IDEA native session ID equals BreakPilot `ideSessionId`; resolve each provider-local identifier from its own prior response via a JSON Pointer placeholder.
- Do not assume the sample application is a Git repository. A manifest must record an unavailable application revision as `null` plus reason, and must bind the source point by a workspace-relative source marker and line-text SHA-256.
- The current source marker must be read and verified before live capture. Do not hard-code a stale `HelloController.java` line based on old fixtures; current code and line text decide the marker.
- Current hub code is one-port (`127.0.0.1:57987` by default, bridge path `/bridge`). Live config must explicitly include its URLs and preflight must surface any mismatch with older `27890/27891` documentation.
- Use only built-in Node libraries; do not add a hash, NDJSON, JSON Pointer, or secret-scanning dependency.
- Sanitization must be deterministic and idempotent, preserve provider field structure and ordered variable path segments, tokenize volatile IDs consistently per run, and fail closed on secrets or unknown sensitive structures.
- Hashes establish file integrity, not independent origin provenance. Manifest/source/session metadata must make provenance limits explicit.
- Use Conventional Commits in the form `<type>(<scope>): <summary>` and do not stage unrelated user changes.

---

## File Structure

- Create `src/evidence/DifferentialEvidenceTypes.ts`: versioned manifest, transcript, scenario, lineage, semantic-artifact, and typed error models.
- Create `src/evidence/DifferentialEvidenceHash.ts`: streaming SHA-256 and stable manifest file digest helpers.
- Create `src/evidence/DifferentialEvidenceSanitizer.ts`: allowlisted deterministic tokenization and secret rejection.
- Create `src/evidence/DifferentialEvidenceReplay.ts`: bundle verification, JSON Pointer lineage resolution, semantic extraction, and mismatch failure.
- Create `src/evidence/DifferentialEvidenceCapture.ts`: stdio MCP client, scenario executor, raw append/hash/sanitize/write pipeline, and explicit infrastructure failure.
- Create `src/evidence/differentialCli.ts`: `capture`, `verify`, and `e2e` process entrypoint.
- Create synthetic fixture directory `test/fixtures/evidence/differential-v1/` with `manifest.json`, sanitized provider transcripts, `SHA256SUMS.json`, `lineage.json`, and `semantic.json`; no raw transcript belongs there.
- Create `test/fixtures/evidence/fake-mcp-server.ts` and `test/fixtures/evidence/hello-controller.scenario.json`.
- Create `test/evidence-sanitizer.test.ts`, `test/evidence-replay.test.ts`, `test/evidence-capture.test.ts`, and `test/evidence-cli.test.ts`.
- Modify `package.json`: explicit evidence scripts.
- Modify `test/differential-debug-contract.test.ts`: consume extractor-generated semantic artifact rather than a hand-authored semantic assertion object.
- Modify `test/fixtures/differential/README.md`, `docs/idea-mcp-vs-breakpilot-debugger.zh-CN.md`, `docs/mcp-tools.md`, and `docs/mcp-tools.zh-CN.md`: document evidence level, live preconditions, and no raw-data policy.

## Interfaces Established By This Plan

```ts
export type TranscriptProvider = "idea" | "breakpilot";
export type TranscriptDirection = "request" | "response" | "error";

export interface TranscriptEntry {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  provider: TranscriptProvider;
  direction: TranscriptDirection;
  stepId: string;
  attempt: number;
  payload: unknown;
}

export interface SourceMarker {
  workspaceRelativePath: string;
  line: number;
  lineSha256: string;
  lineText?: string;
}

export interface EvidenceManifestV1 {
  schemaVersion: 1;
  runId: string;
  harness: { revision: string | null; node: string; platform: string };
  breakpilot: { revision: string | null; hubUrl: string; bridgeUrl: string };
  application: { root: string; revision: string | null; revisionReason?: string; sourceMarker: SourceMarker };
  providers: Record<TranscriptProvider, { serverIdentity?: string; sessionIdentity?: string; transcript: string; sha256: string; bytes: number }>;
  sanitizer: { id: "breakpilot-differential-v1"; version: 1 };
  rawRetention: "retained" | "unavailable";
  outcome: "captured" | "infrastructure_unavailable" | "failed";
}

export interface DifferentialScenarioV1 {
  schemaVersion: 1;
  sampleRoot: string;
  sourceMarker: { path: string; line: number; lineTextSha256?: string };
  providers: Record<TranscriptProvider, CapturedMcpCommand>;
  steps: Array<{ id: string; provider: TranscriptProvider; method: string; params: unknown; retries?: number }>;
}

export interface LineageFileV1 {
  schemaVersion: 1;
  assertions: Array<{ name: string; provider: TranscriptProvider; transcript: string; sequence: number; jsonPointer: string; transcriptSha256: string }>;
}

export class EvidenceVerificationError extends Error {
  readonly code = "EVIDENCE_VERIFICATION_FAILED";
  constructor(readonly category: string, readonly path: string, message: string);
}

export async function captureDifferentialEvidence(config: CaptureConfig): Promise<CaptureResult>;
export async function verifyEvidenceBundle(directory: string): Promise<SemanticDifferentialArtifactV1>;
```

### Task 1: Define Versioned Evidence Artifacts And Integrity Hashes

**Files:**
- Create: `src/evidence/DifferentialEvidenceTypes.ts`
- Create: `src/evidence/DifferentialEvidenceHash.ts`
- Create: `test/evidence-replay.test.ts`

**Interfaces:**
- Consumes: file paths and JSON-compatible manifest/transcript values.
- Produces: lower-case SHA-256 integrity records and typed evidence structures that distinguish retained raw files from unavailable raw data.

- [ ] **Step 1: Write failing hash and manifest tests**

Create `test/evidence-replay.test.ts` beginning with:

```ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256File } from "../src/evidence/DifferentialEvidenceHash.ts";

const directory = await mkdtemp(join(tmpdir(), "breakpilot-evidence-"));
const file = join(directory, "raw.ndjson");
await writeFile(file, "{\\\"sequence\\\":1}\\n");
assert.deepEqual(await sha256File(file), {
  sha256: "1ddca71ad68c294a0f95c6c7e5c5810f3139ac0b5bf0d4a86fb4dd03ef36e69c",
  bytes: 15
});
console.log("evidence hash tests ok");
```

Add tests asserting a manifest permits `application.revision:null` only when `revisionReason` is present, and `rawRetention:"unavailable"` never claims a raw digest exists.

- [ ] **Step 2: Run hash tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/evidence-replay.test.ts
```

Expected: FAIL because evidence types and hash helper do not exist.

- [ ] **Step 3: Implement typed artifacts and SHA-256 helpers**

Create `DifferentialEvidenceTypes.ts` with the interfaces in this plan and a `validateEvidenceManifestV1` function that returns safe issue paths, not payload values. Create `DifferentialEvidenceHash.ts` using `createReadStream` plus `createHash("sha256")`; return `{ sha256: digest.toLowerCase(), bytes }`. Add `hashManifestFiles(root, relativePaths)` that rejects absolute or escaping paths before hashing.

- [ ] **Step 4: Run hash and manifest tests**

Run:

```bash
node --experimental-strip-types --test test/evidence-replay.test.ts
npm run typecheck
```

Expected: PASS; a raw-unavailable fixture is structurally honest and every hash uses lower-case SHA-256.

- [ ] **Step 5: Commit artifact foundations**

```bash
git add src/evidence/DifferentialEvidenceTypes.ts src/evidence/DifferentialEvidenceHash.ts test/evidence-replay.test.ts
git commit -m "feat(evidence): define differential artifact integrity"
```

### Task 2: Add Deterministic Fail-Closed Sanitization

**Files:**
- Create: `src/evidence/DifferentialEvidenceSanitizer.ts`
- Create: `test/evidence-sanitizer.test.ts`

**Interfaces:**
- Consumes: provider-labelled raw `TranscriptEntry[]`.
- Produces: sanitized entries plus a stable token map that removes volatile identities but preserves ordered semantic paths.

- [ ] **Step 1: Write failing sanitizer tests**

Create `test/evidence-sanitizer.test.ts`:

```ts
const entries = [{
  schemaVersion: 1, sequence: 1, timestamp: "2026-07-25T10:11:12.000Z",
  provider: "breakpilot", direction: "response", stepId: "context", attempt: 1,
  payload: { path: "/Users/quixote/work/a.java", pid: 8123, port: 57987, sessionId: "s-9", threadId: 18,
    variables: [{ path: ["analysis", "score"], value: 28 }] }
}] as const;
const once = sanitizeTranscript("breakpilot", entries);
const twice = sanitizeTranscript("breakpilot", once.entries);
assert.deepEqual(twice.entries, once.entries);
assert.deepEqual((once.entries[0] as any).payload.variables[0].path, ["analysis", "score"]);
assert.notEqual((once.entries[0] as any).payload.path, "/Users/quixote/work/a.java");
assert.throws(() => sanitizeTranscript("idea", [{ ...entries[0], payload: { authorization: "Bearer abc" } }]), EvidenceVerificationError);
```

Add separate cases for `Authorization`, `token`, environment values, high-entropy secrets, unknown object fields in a protected metadata position, repeated volatile identity token stability, and ordered array preservation.

- [ ] **Step 2: Run sanitizer tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/evidence-sanitizer.test.ts
```

Expected: FAIL because the sanitizer does not exist.

- [ ] **Step 3: Implement allowlisted sanitizer behavior**

Export `SANITIZER_ID = "breakpilot-differential-v1"` and `SANITIZER_VERSION = 1`. Walk only declared JSON-RPC envelope fields plus the known IDEA debugger and BreakPilot compact response fields. Replace absolute paths, port numbers, PIDs, RFC3339 timestamps, session/thread/frame/variable IDs, and opaque references with deterministic tokens allocated by `(category, original)` in encounter order. Reject authorization/header/environment/token/key fields, strings matching the project secret entropy threshold, and unknown fields in sensitive envelopes with `new EvidenceVerificationError("sanitizer", jsonPointer, "Sensitive or unknown evidence field is not permitted.")`. Do not reorder arrays or rewrite nonvolatile semantic `variables[*].path` segments.

- [ ] **Step 4: Run sanitizer tests and typecheck**

Run:

```bash
node --experimental-strip-types --test test/evidence-sanitizer.test.ts
npm run typecheck
```

Expected: PASS; repeated sanitizer execution produces byte-equivalent serialized JSON.

- [ ] **Step 5: Commit sanitization**

```bash
git add src/evidence/DifferentialEvidenceSanitizer.ts test/evidence-sanitizer.test.ts
git commit -m "feat(evidence): sanitize debugger transcripts safely"
```

### Task 3: Verify Replay, Lineage, And Generated Semantic Artifacts Offline

**Files:**
- Create: `src/evidence/DifferentialEvidenceReplay.ts`
- Create: `test/fixtures/evidence/differential-v1/manifest.json`
- Create: `test/fixtures/evidence/differential-v1/sanitized/idea.ndjson`
- Create: `test/fixtures/evidence/differential-v1/sanitized/breakpilot.ndjson`
- Create: `test/fixtures/evidence/differential-v1/sanitized/SHA256SUMS.json`
- Create: `test/fixtures/evidence/differential-v1/lineage.json`
- Create: `test/fixtures/evidence/differential-v1/semantic.json`
- Modify: `test/evidence-replay.test.ts`
- Modify: `test/differential-debug-contract.test.ts`

**Interfaces:**
- Consumes: a sanitized evidence bundle, optional raw artifacts, and exact JSON Pointer lineage assertions.
- Produces: `SemanticDifferentialArtifactV1`, or an `EVIDENCE_VERIFICATION_FAILED` that identifies category/path without echoing sensitive data.

- [ ] **Step 1: Write failing replay and mismatch tests**

Append to `test/evidence-replay.test.ts`:

```ts
const artifact = await verifyEvidenceBundle("test/fixtures/evidence/differential-v1");
assert.equal(artifact.source.workspaceRelativePath, "src/main/java/com/example/demo/HelloController.java");
assert.equal(artifact.values["analysis.score"].idea, 28);
assert.equal(artifact.values["analysis.score"].breakpilot, 28);

await writeFile(join(copy, "sanitized", "idea.ndjson"), "tampered\\n");
await assert.rejects(() => verifyEvidenceBundle(copy), (error: Error & { code?: string }) =>
  error.code === "EVIDENCE_VERIFICATION_FAILED"
);
```

Add cases for invalid raw digest when raw retention is `retained`, a lineage sequence/JSON Pointer that resolves nowhere, non-idempotent sanitized data, and IDEA/BreakPilot semantic mismatch.

- [ ] **Step 2: Run replay tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/evidence-replay.test.ts
```

Expected: FAIL because replay, fixture, and generated semantic artifact do not exist.

- [ ] **Step 3: Implement offline replay and fixture generation**

`verifyEvidenceBundle(directory)` must validate manifest shape, read NDJSON without executing any request, verify raw hashes only if raw files are present and retention says `retained`, verify sanitized hashes always, rerun sanitizer and compare serialized entries, resolve every lineage pointer against the indicated sanitized entry, and construct the semantic artifact. Compare provider positions/frame method/value keys symmetrically; a mismatch throws `EvidenceVerificationError("semantic", pointer, "Provider values differ.")`. Write the synthetic fixture through a small checked-in generator helper in the test itself or a documented `src/evidence` export; do not hand-edit a semantic shape that replay cannot regenerate.

Update `test/differential-debug-contract.test.ts` to call `verifyEvidenceBundle` and assert its generated artifact, while retaining the legacy fixture only as a documented historical baseline until a reviewed live promotion occurs.

- [ ] **Step 4: Run replay and differential regression tests**

Run:

```bash
node --experimental-strip-types --test test/evidence-replay.test.ts test/differential-debug-contract.test.ts
npm run typecheck
```

Expected: PASS; changing a byte, sanitizer result, pointer, or semantic value is detected offline.

- [ ] **Step 5: Commit replayable evidence**

```bash
git add src/evidence/DifferentialEvidenceReplay.ts test/fixtures/evidence/differential-v1 test/evidence-replay.test.ts test/differential-debug-contract.test.ts
git commit -m "feat(evidence): verify replayable debugger evidence"
```

### Task 4: Add Explicit Live Capture With Honest Infrastructure Failure

**Files:**
- Create: `src/evidence/DifferentialEvidenceCapture.ts`
- Create: `test/fixtures/evidence/fake-mcp-server.ts`
- Create: `test/fixtures/evidence/hello-controller.scenario.json`
- Create: `test/evidence-capture.test.ts`
- Modify: `src/utils/errors.ts`

**Interfaces:**
- Consumes: an absolute ignored live-capture config that specifies native IDEA MCP command, BreakPilot MCP command/hub URL, bridge URL, source marker, and provider-local scenario steps.
- Produces: raw append-only transcript files, raw hashes computed before sanitization, a manifest, sanitized/replayable artifacts, or an explicit unavailable result without semantic success.

- [ ] **Step 1: Write failing capture tests**

Create `test/evidence-capture.test.ts` using `fake-mcp-server.ts`:

```ts
const result = await captureDifferentialEvidence(fakeConfig({ retries: 1 }));
assert.equal(result.manifest.outcome, "captured");
const raw = await readFile(join(result.directory, "raw", "idea.ndjson"), "utf8");
assert.match(raw, /"direction":"request"/);
assert.match(raw, /"direction":"error"/);
assert.match(raw, /"attempt":2/);
assert.ok(result.manifest.providers.idea.sha256);
assert.equal(result.manifest.providers.idea.sessionIdentity, "idea-session-from-native-response");
assert.notEqual(result.manifest.providers.idea.sessionIdentity, result.manifest.providers.breakpilot.sessionIdentity);

const unavailable = await captureDifferentialEvidence(fakeConfig({ nativeIdeaCommand: undefined }));
assert.equal(unavailable.manifest.outcome, "infrastructure_unavailable");
assert.equal(unavailable.error?.code, "EVIDENCE_INFRASTRUCTURE_UNAVAILABLE");
```

Add a source-marker mismatch case that fails before either child process starts.

- [ ] **Step 2: Run capture tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/evidence-capture.test.ts
```

Expected: FAIL because capture and the fake stdio server do not exist.

- [ ] **Step 3: Implement capture transaction and provider-local templates**

Create a minimal `StdioMcpClient` around `child_process.spawn` and line-delimited JSON-RPC. For each scenario step, append one `TranscriptEntry` before sending its request and append response/error/retry entries in strict sequence. Support a `${provider.stepId:/json/pointer}` string template resolver that only reads earlier entries from the same provider; reject cross-provider identity interpolation.

Before spawning clients, read source marker path/line from `sampleRoot`, calculate its SHA-256, and compare expected marker. Detect application Git revision with `git -C <sampleRoot> rev-parse HEAD`; on failure set `{ revision:null, revisionReason:"not a git repository" }`. Close raw writers, hash raw files, then sanitize; only after successful replay write final `manifest.json`, `lineage.json`, and `semantic.json` atomically. On missing executable, failed MCP initialize, missing paused session, wrong hub/bridge configuration, or unavailable provider, return a result with `outcome:"infrastructure_unavailable"`, set `EVIDENCE_INFRASTRUCTURE_UNAVAILABLE`, and do not write a semantic success artifact.

- [ ] **Step 4: Run capture and replay tests**

Run:

```bash
node --experimental-strip-types --test test/evidence-capture.test.ts test/evidence-replay.test.ts
npm run typecheck
```

Expected: PASS; raw hashes predate sanitization and an unavailable environment is visibly unsuccessful.

- [ ] **Step 5: Commit capture support**

```bash
git add src/evidence/DifferentialEvidenceCapture.ts test/fixtures/evidence/fake-mcp-server.ts test/fixtures/evidence/hello-controller.scenario.json test/evidence-capture.test.ts src/utils/errors.ts
git commit -m "feat(evidence): capture differential debugger transcripts"
```

### Task 5: Add CLI Commands, Documentation, And Live Acceptance Procedure

**Files:**
- Create: `src/evidence/differentialCli.ts`
- Create: `test/evidence-cli.test.ts`
- Modify: `package.json`
- Modify: `test/fixtures/differential/README.md`
- Modify: `docs/idea-mcp-vs-breakpilot-debugger.zh-CN.md`
- Modify: `docs/mcp-tools.md`
- Modify: `docs/mcp-tools.zh-CN.md`

**Interfaces:**
- Consumes: `capture --config <absolute-json>`, `verify --evidence-dir <absolute-dir>`, and `e2e --config <absolute-json>`.
- Produces: conventional process exit codes and a short structured JSON result suitable for a human or agent to distinguish verified evidence from unavailable infrastructure.

- [ ] **Step 1: Write failing CLI tests**

Create `test/evidence-cli.test.ts`:

```ts
const verify = await runNode(["src/evidence/differentialCli.ts", "verify", "--evidence-dir", fixtureDir]);
assert.equal(verify.code, 0);
assert.match(verify.stdout, /"outcome":"verified"/);

const unavailable = await runNode(["src/evidence/differentialCli.ts", "e2e", "--config", missingConfig]);
assert.notEqual(unavailable.code, 0);
assert.match(unavailable.stdout + unavailable.stderr, /EVIDENCE_INFRASTRUCTURE_UNAVAILABLE/);
```

- [ ] **Step 2: Run CLI tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/evidence-cli.test.ts
```

Expected: FAIL because the CLI and package scripts do not exist.

- [ ] **Step 3: Implement CLI and documented commands**

Implement argument parsing with exactly three verbs and required absolute paths. Add scripts:

```json
{
  "evidence:differential:capture": "node --experimental-strip-types src/evidence/differentialCli.ts capture",
  "evidence:differential:verify": "node --experimental-strip-types src/evidence/differentialCli.ts verify",
  "test:e2e:idea-differential": "node --experimental-strip-types src/evidence/differentialCli.ts e2e"
}
```

Document this real acceptance flow: start a configured BreakPilot one-port hub and bridge, configure an explicit native IDEA MCP stdio command plus BreakPilot endpoint, pause the current Spring Boot sample at its preflight-verified source marker, then run:

```bash
npm run test:e2e:idea-differential -- --config /absolute/ignored/differential-config.json
```

The docs must say the fixture is synthetic unless its manifest says `outcome:"captured"` and raw hashes/lineage verified. Explain that a raw digest proves integrity of the local file, not independent origin. Never document the obsolete two-port endpoint as a requirement.

- [ ] **Step 4: Run CLI and complete offline verification**

Run:

```bash
node --experimental-strip-types --test test/evidence-cli.test.ts
npm run evidence:differential:verify -- --evidence-dir "$PWD/test/fixtures/evidence/differential-v1"
npm test
npm run typecheck
npm run build
```

Expected: PASS; the explicit unavailable live configuration returns non-zero and cannot be mistaken for a verified capture.

- [ ] **Step 5: Commit CLI and operating documentation**

```bash
git add src/evidence/differentialCli.ts test/evidence-cli.test.ts package.json test/fixtures/differential/README.md docs/idea-mcp-vs-breakpilot-debugger.zh-CN.md docs/mcp-tools.md docs/mcp-tools.zh-CN.md
git commit -m "feat(evidence): add differential capture commands"
```

## Final Verification

- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run evidence:differential:verify -- --evidence-dir "$PWD/test/fixtures/evidence/differential-v1"`.
- [ ] Verify the raw capture directory is inside ignored `.breakpilot/` and is absent from `git status --short`.
- [ ] Verify tampering with a raw/sanitized digest, lineage pointer, or semantic value fails offline replay without printing the secret/raw value.
- [ ] Run the live command only when explicit native-IDEA MCP and BreakPilot configuration is available; if unavailable, retain the non-zero infrastructure result as an honest acceptance record rather than marking the item complete.
- [ ] Inspect `git status --short` and `git diff --cached --stat` before every commit; leave unrelated changes unstaged.
