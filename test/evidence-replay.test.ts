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
  assert.deepEqual(validateEvidenceManifestV1({ schemaVersion: 1, runId: "x", application: { revision: null }, providers: {}, rawRetention: "unavailable" }), [
    "$.application.revisionReason", "$.providers.idea", "$.providers.breakpilot"
  ]);
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
