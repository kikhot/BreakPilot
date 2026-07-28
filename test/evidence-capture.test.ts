import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { captureDifferentialEvidence, sanitizeHashedRawTranscript } from "../src/evidence/DifferentialEvidenceCapture.ts";
import { sha256File, sha256Text } from "../src/evidence/DifferentialEvidenceHash.ts";
import { verifyEvidenceBundle } from "../src/evidence/DifferentialEvidenceReplay.ts";
import { EvidenceVerificationError, validateEvidenceManifestV1, type CaptureConfig } from "../src/evidence/DifferentialEvidenceTypes.ts";

async function fakeConfig(): Promise<CaptureConfig> {
  const root = await mkdtemp(path.join(tmpdir(), "breakpilot-evidence-sample-"));
  await writeFile(path.join(root, "Sample.java"), "class Sample {\n  // marker\n}\n", "utf8");
  const fake = path.resolve("test/fixtures/evidence/fake-mcp-server.ts");
  return {
    schemaVersion: 1,
    sampleRoot: root,
    sourceMarker: { path: "Sample.java", line: 2 },
    outputRoot: path.join(root, ".breakpilot/evidence/differential"),
    hubUrl: "http://127.0.0.1:57987",
    bridgeUrl: "ws://127.0.0.1:57987/bridge",
    providers: {
      idea: { command: process.execPath, args: ["--experimental-strip-types", fake, "idea"] },
      breakpilot: { command: process.execPath, args: ["--experimental-strip-types", fake, "breakpilot"] }
    },
    steps: [
      { id: "context", provider: "idea", method: "tools/call", params: { name: "capture", arguments: { failOnce: true } }, retries: 1 },
      { id: "context", provider: "breakpilot", method: "tools/call", params: { name: "capture", arguments: {} } }
    ],
    lineage: [
      { name: "source.line.idea", provider: "idea", transcript: "", sequence: 4, jsonPointer: "/payload/position/line", transcriptSha256: "" },
      { name: "source.line.breakpilot", provider: "breakpilot", transcript: "", sequence: 2, jsonPointer: "/payload/position/line", transcriptSha256: "" },
      { name: "value.analysis.score.idea", provider: "idea", transcript: "", sequence: 4, jsonPointer: "/payload/values/analysis.score", transcriptSha256: "" },
      { name: "value.analysis.score.breakpilot", provider: "breakpilot", transcript: "", sequence: 2, jsonPointer: "/payload/values/analysis.score", transcriptSha256: "" }
    ]
  };
}

test("capture retains append-only raw attempts and provider-local identities", async () => {
  const config = await fakeConfig();
  const result = await captureDifferentialEvidence(config);
  assert.equal(result.manifest.outcome, "captured");
  const raw = await readFile(path.join(result.directory, "raw", "idea.ndjson"), "utf8");
  assert.match(raw, /"direction":"request"/);
  assert.match(raw, /"direction":"error"/);
  assert.match(raw, /"attempt":2/);
  assert.ok(result.manifest.providers.idea.rawSha256);
  assert.equal(result.manifest.providers.idea.sessionIdentity, "idea-session-from-native-response");
  assert.equal(result.manifest.providers.breakpilot.sessionIdentity, "breakpilot-session-from-native-response");
  await verifyEvidenceBundle(result.directory);

  const rawPath = path.join(result.directory, result.manifest.providers.idea.rawTranscript!);
  await writeFile(rawPath, `${await readFile(rawPath, "utf8")}tampered\n`);
  await assert.rejects(() => verifyEvidenceBundle(result.directory), (error: any) => error?.category === "hash");
});

test("missing native IDEA MCP is an explicit unavailable result", async () => {
  const config = await fakeConfig();
  delete config.providers.idea;
  const result = await captureDifferentialEvidence(config);
  assert.equal(result.manifest.outcome, "infrastructure_unavailable");
  assert.equal(result.error?.code, "EVIDENCE_INFRASTRUCTURE_UNAVAILABLE");
  assert.deepEqual(validateEvidenceManifestV1(result.manifest), []);
});

test("a completed MCP initialization with a failed scenario is not classified as infrastructure unavailable", async () => {
  const config = await fakeConfig();
  config.steps[0]!.retries = 0;
  const result = await captureDifferentialEvidence(config);
  assert.equal(result.manifest.outcome, "failed");
  assert.equal(result.error?.code, "EVIDENCE_VERIFICATION_FAILED");
  assert.deepEqual(validateEvidenceManifestV1(result.manifest), []);
  await assert.rejects(() => access(path.join(result.directory, "raw")));
});

test("post-capture verification failures produce an explicit failed manifest", async () => {
  const config = await fakeConfig();
  (config.steps[1]!.params as any).arguments.returnUnknown = true;
  const result = await captureDifferentialEvidence(config);
  assert.equal(result.manifest.outcome, "failed");
  assert.equal(result.error?.code, "EVIDENCE_VERIFICATION_FAILED");
  const written = JSON.parse(await readFile(path.join(result.directory, "manifest.json"), "utf8"));
  assert.equal(written.outcome, "failed");
  await assert.rejects(() => access(path.join(result.directory, "raw")));
});

test("source marker mismatch fails before debugger processes start", async () => {
  const config = await fakeConfig();
  config.sourceMarker.lineTextSha256 = "0".repeat(64);
  await assert.rejects(() => captureDifferentialEvidence(config), EvidenceVerificationError);
});

test("raw capture cannot be redirected outside the ignored evidence tree", async () => {
  const config = await fakeConfig();
  config.outputRoot = path.join(config.sampleRoot, "unsafe-output");
  await assert.rejects(
    () => captureDifferentialEvidence(config),
    (error: unknown) => error instanceof EvidenceVerificationError && error.path === "$.outputRoot"
  );
});

test("raw capture evidence tree must belong to the sample workspace", async () => {
  const config = await fakeConfig();
  const foreign = await mkdtemp(path.join(tmpdir(), "breakpilot-evidence-foreign-"));
  config.outputRoot = path.join(foreign, ".breakpilot/evidence/differential");
  await assert.rejects(
    () => captureDifferentialEvidence(config),
    (error: unknown) => error instanceof EvidenceVerificationError && error.path === "$.outputRoot"
  );
  assert.deepEqual(await readdir(foreign), []);
});

test("raw capture rejects an evidence root symlink outside the sample workspace", async () => {
  const config = await fakeConfig();
  const foreign = await mkdtemp(path.join(tmpdir(), "breakpilot-evidence-symlink-"));
  await symlink(foreign, path.join(config.sampleRoot, ".breakpilot"));
  await assert.rejects(
    () => captureDifferentialEvidence(config),
    (error: unknown) => error instanceof EvidenceVerificationError && error.path === "$.outputRoot"
  );
  assert.deepEqual(await readdir(foreign), []);
});

test("capture rejects obsolete split-port hub and bridge configuration", async () => {
  const config = await fakeConfig();
  config.bridgeUrl = "ws://127.0.0.1:27891/bridge";
  await assert.rejects(
    () => captureDifferentialEvidence(config),
    (error: unknown) => error instanceof EvidenceVerificationError && error.path === "$.bridgeUrl"
  );
});

test("sanitized evidence is derived from the exact hashed raw bytes", () => {
  const raw = `${JSON.stringify({
    schemaVersion: 1,
    sequence: 1,
    timestamp: "2026-07-25T10:11:12.000Z",
    provider: "idea",
    direction: "response",
    stepId: "context",
    attempt: 1,
    payload: { position: { line: 2 }, values: { score: 28 } }
  })}\n`;
  const digest = { sha256: sha256Text(raw), bytes: Buffer.byteLength(raw) };
  assert.equal(sanitizeHashedRawTranscript("idea", raw, digest)[0]?.payload instanceof Object, true);
  assert.throws(
    () => sanitizeHashedRawTranscript("idea", `${raw} `, digest),
    (error: unknown) => error instanceof EvidenceVerificationError && error.category === "hash"
  );
});

test("replay rejects a sanitized transcript paired with different retained raw evidence", async () => {
  const result = await captureDifferentialEvidence(await fakeConfig());
  const sanitizedPath = path.join(result.directory, "sanitized", "idea.ndjson");
  const entries = (await readFile(sanitizedPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  entries.at(-1).payload.message = "injected but allowlisted";
  await writeFile(sanitizedPath, `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`);
  const digest = await sha256File(sanitizedPath);

  const manifestPath = path.join(result.directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.providers.idea.sha256 = digest.sha256;
  manifest.providers.idea.bytes = digest.bytes;
  await writeFile(manifestPath, JSON.stringify(manifest));

  const digestIndexPath = path.join(result.directory, "sanitized", "SHA256SUMS.json");
  const digestIndex = JSON.parse(await readFile(digestIndexPath, "utf8"));
  digestIndex.idea = digest;
  await writeFile(digestIndexPath, JSON.stringify(digestIndex));

  const lineagePath = path.join(result.directory, "lineage.json");
  const lineage = JSON.parse(await readFile(lineagePath, "utf8"));
  for (const assertion of lineage.assertions) {
    if (assertion.provider === "idea") assertion.transcriptSha256 = digest.sha256;
  }
  await writeFile(lineagePath, JSON.stringify(lineage));

  await assert.rejects(
    () => verifyEvidenceBundle(result.directory),
    (error: any) => error?.category === "sanitizer" && error?.path === "raw/idea.ndjson"
  );
});
