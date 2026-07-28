import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { captureDifferentialEvidence } from "../src/evidence/DifferentialEvidenceCapture.ts";
import { verifyEvidenceBundle } from "../src/evidence/DifferentialEvidenceReplay.ts";
import { EvidenceVerificationError, type CaptureConfig } from "../src/evidence/DifferentialEvidenceTypes.ts";

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
});

test("source marker mismatch fails before debugger processes start", async () => {
  const config = await fakeConfig();
  config.sourceMarker.lineTextSha256 = "0".repeat(64);
  await assert.rejects(() => captureDifferentialEvidence(config), EvidenceVerificationError);
});
