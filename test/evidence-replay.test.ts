import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256File } from "../src/evidence/DifferentialEvidenceHash.ts";
import { verifyEvidenceBundle } from "../src/evidence/DifferentialEvidenceReplay.ts";
import { validateEvidenceManifestV1 } from "../src/evidence/DifferentialEvidenceTypes.ts";

const fixture = path.resolve("test/fixtures/evidence/differential-v1");

test("streaming hashes report lower-case digest and exact bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "breakpilot-evidence-hash-"));
  const file = path.join(directory, "raw.ndjson");
  await writeFile(file, "{\"sequence\":1}\n");
  assert.deepEqual(await sha256File(file), {
    sha256: "1ddca71ad68c294a0f95c6c7e5c5810f3139ac0b5bf0d4a86fb4dd03ef36e69c",
    bytes: 15
  });
});

test("manifest validation requires an honest unavailable revision and raw status", () => {
  const issues = validateEvidenceManifestV1({ schemaVersion: 1, runId: "x", application: { revision: null }, providers: {}, rawRetention: "unavailable" });
  assert.ok(issues.includes("$.application.revisionReason"));
  assert.ok(issues.includes("$.providers.idea"));
  assert.ok(issues.includes("$.providers.breakpilot"));
});

test("manifest validation rejects invalid outcomes, digests, sanitizer versions, and incomplete raw retention", () => {
  const invalid: any = {
    schemaVersion: 1,
    runId: "run",
    harness: { revision: null, node: "v25", platform: "darwin-arm64" },
    breakpilot: { revision: null, hubUrl: "http://127.0.0.1:57987", bridgeUrl: "ws://127.0.0.1:57987/bridge" },
    application: {
      root: "/sample",
      revision: "abc",
      sourceMarker: { workspaceRelativePath: "Sample.java", line: 2, lineSha256: "0".repeat(64) }
    },
    providers: {
      idea: { transcript: "sanitized/idea.ndjson", sha256: "bad", bytes: -1, serverIdentity: 5, extra: true },
      breakpilot: { transcript: "sanitized/breakpilot.ndjson", sha256: "0".repeat(64), bytes: 12 }
    },
    sanitizer: { id: "unknown", version: 2 },
    rawRetention: "retained",
    outcome: "unknown",
    extra: true
  };
  const issues = validateEvidenceManifestV1(invalid);
  assert.ok(issues.includes("$.outcome"));
  assert.ok(issues.includes("$.sanitizer"));
  assert.ok(issues.includes("$.providers.idea.sha256"));
  assert.ok(issues.includes("$.providers.idea.rawTranscript"));
  assert.ok(issues.includes("$.providers.breakpilot.rawTranscript"));
  assert.ok(issues.includes("$.extra"));
  assert.ok(issues.includes("$.providers.idea.serverIdentity"));
  assert.ok(issues.includes("$.providers.idea.extra"));
});

test("manifest validation checks complete provenance shapes", () => {
  const invalid: any = {
    schemaVersion: 1,
    runId: "run",
    harness: { revision: 5, node: "", platform: 7 },
    breakpilot: { revision: [], hubUrl: 9, bridgeUrl: null },
    application: {
      root: 42,
      revision: {},
      sourceMarker: { workspaceRelativePath: "Sample.java", line: 2, lineSha256: "0".repeat(64) }
    },
    providers: {
      idea: { transcript: "", sha256: "", bytes: 0 },
      breakpilot: { transcript: "", sha256: "", bytes: 0 }
    },
    sanitizer: { id: "breakpilot-differential-v1", version: 1 },
    rawRetention: "unavailable",
    outcome: "failed"
  };
  const issues = validateEvidenceManifestV1(invalid);
  for (const field of [
    "$.harness.revision", "$.harness.node", "$.harness.platform",
    "$.breakpilot.revision", "$.breakpilot.hubUrl", "$.breakpilot.bridgeUrl",
    "$.application.root", "$.application.revision"
  ]) assert.ok(issues.includes(field), field);
});

test("unavailable manifests reject missing sanitized fields and every raw artifact field", () => {
  const invalid: any = {
    schemaVersion: 1,
    runId: "run",
    harness: { revision: null, node: "v25", platform: "darwin-arm64" },
    breakpilot: { revision: null, hubUrl: "http://127.0.0.1:57987", bridgeUrl: "ws://127.0.0.1:57987/bridge" },
    application: {
      root: "/sample",
      revision: null,
      revisionReason: "capture did not start",
      sourceMarker: { workspaceRelativePath: "Sample.java", line: 2, lineSha256: "0".repeat(64) }
    },
    providers: {
      idea: { transcript: "", bytes: 0, rawBytes: 0 },
      breakpilot: { transcript: "", sha256: "", bytes: 0 }
    },
    sanitizer: { id: "breakpilot-differential-v1", version: 1 },
    rawRetention: "unavailable",
    outcome: "infrastructure_unavailable"
  };
  const issues = validateEvidenceManifestV1(invalid);
  assert.ok(issues.includes("$.providers.idea.sha256"));
  assert.ok(issues.includes("$.providers.idea.rawBytes"));
});

test("offline replay verifies hashes, lineage, and provider semantics", async () => {
  const artifact = await verifyEvidenceBundle(fixture);
  assert.equal(artifact.source.workspaceRelativePath, "src/main/java/com/example/demo/controller/HelloController.java");
  assert.equal(artifact.values["analysis.score"]?.idea, 28);
  assert.equal(artifact.values["analysis.score"]?.breakpilot, 28);
});

test("offline replay rejects a changed transcript before interpreting it", async () => {
  const copy = await mkdtemp(path.join(tmpdir(), "breakpilot-evidence-tamper-"));
  await cp(fixture, copy, { recursive: true });
  const file = path.join(copy, "sanitized", "idea.ndjson");
  await writeFile(file, `${await readFile(file, "utf8")}tampered\n`);
  await assert.rejects(() => verifyEvidenceBundle(copy), (error: any) => error?.code === "EVIDENCE_VERIFICATION_FAILED");
});

test("offline replay rejects broken lineage and semantic artifacts", async () => {
  const lineageCopy = await mkdtemp(path.join(tmpdir(), "breakpilot-evidence-lineage-"));
  await cp(fixture, lineageCopy, { recursive: true });
  const lineagePath = path.join(lineageCopy, "lineage.json");
  const lineage = JSON.parse(await readFile(lineagePath, "utf8"));
  lineage.assertions[0].jsonPointer = "/payload/missing";
  await writeFile(lineagePath, JSON.stringify(lineage));
  await assert.rejects(() => verifyEvidenceBundle(lineageCopy), (error: any) => error?.category === "lineage");

  const semanticCopy = await mkdtemp(path.join(tmpdir(), "breakpilot-evidence-semantic-"));
  await cp(fixture, semanticCopy, { recursive: true });
  const semanticPath = path.join(semanticCopy, "semantic.json");
  const semantic = JSON.parse(await readFile(semanticPath, "utf8"));
  semantic.values["analysis.score"].idea = 99;
  await writeFile(semanticPath, JSON.stringify(semantic));
  await assert.rejects(() => verifyEvidenceBundle(semanticCopy), (error: any) => error?.category === "semantic");
});

test("offline replay rejects transcript paths outside the evidence root", async () => {
  const copy = await mkdtemp(path.join(tmpdir(), "breakpilot-evidence-path-"));
  await cp(fixture, copy, { recursive: true });
  const manifestPath = path.join(copy, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.providers.idea.transcript = "../outside.ndjson";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    () => verifyEvidenceBundle(copy),
    (error: any) => error?.category === "path" && error?.path === "$.providers.idea.transcript"
  );
});
