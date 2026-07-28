import { readFile } from "node:fs/promises";
import path from "node:path";

import { sha256File } from "./DifferentialEvidenceHash.ts";
import { sanitizeTranscript } from "./DifferentialEvidenceSanitizer.ts";
import {
  EvidenceVerificationError,
  validateEvidenceManifestV1,
  type EvidenceManifestV1,
  type LineageFileV1,
  type SemanticDifferentialArtifactV1,
  type TranscriptEntry,
  type TranscriptProvider
} from "./DifferentialEvidenceTypes.ts";

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readNdjson(filePath: string): Promise<TranscriptEntry[]> {
  const content = await readFile(filePath, "utf8");
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TranscriptEntry);
}

function resolvePointer(value: unknown, jsonPointer: string): unknown {
  if (jsonPointer === "") return value;
  if (!jsonPointer.startsWith("/")) throw new Error("JSON Pointer must start with '/'.");
  let current = value;
  for (const raw of jsonPointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !(key in current)) throw new Error("Pointer does not resolve.");
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stableEntries(entries: TranscriptEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

export function extractSemanticArtifact(
  manifest: EvidenceManifestV1,
  transcripts: Record<TranscriptProvider, TranscriptEntry[]>,
  lineage: LineageFileV1
): SemanticDifferentialArtifactV1 {
  const resolved = new Map<string, unknown>();
  for (const assertion of lineage.assertions) {
    const descriptor = manifest.providers[assertion.provider];
    if (assertion.transcript !== descriptor.transcript || assertion.transcriptSha256 !== descriptor.sha256) {
      throw new EvidenceVerificationError("lineage", assertion.name, "Lineage transcript identity mismatch.");
    }
    const entry = transcripts[assertion.provider].find((candidate) => candidate.sequence === assertion.sequence);
    if (!entry) throw new EvidenceVerificationError("lineage", assertion.name, "Lineage sequence does not exist.");
    try {
      resolved.set(assertion.name, resolvePointer(entry, assertion.jsonPointer));
    } catch {
      throw new EvidenceVerificationError("lineage", assertion.name, "Lineage pointer does not resolve.");
    }
  }

  const values: SemanticDifferentialArtifactV1["values"] = {};
  for (const name of [...resolved.keys()].filter((candidate) => candidate.startsWith("value.") && candidate.endsWith(".idea"))) {
    const key = name.slice("value.".length, -".idea".length);
    const idea = resolved.get(name);
    const breakpilot = resolved.get(`value.${key}.breakpilot`);
    if (breakpilot === undefined || JSON.stringify(idea) !== JSON.stringify(breakpilot)) {
      throw new EvidenceVerificationError("semantic", `value.${key}`, "Provider values differ.");
    }
    values[key] = { idea, breakpilot };
  }
  const ideaLine = resolved.get("source.line.idea");
  const breakpilotLine = resolved.get("source.line.breakpilot");
  if (ideaLine !== manifest.application.sourceMarker.line || breakpilotLine !== ideaLine) {
    throw new EvidenceVerificationError("semantic", "source.line", "Provider stop positions differ.");
  }
  return {
    schemaVersion: 1,
    evidenceLevel: manifest.rawRetention === "retained" ? "captured-replay" : "synthetic-replay",
    source: manifest.application.sourceMarker,
    values
  };
}

export async function verifyEvidenceBundle(directory: string): Promise<SemanticDifferentialArtifactV1> {
  const root = path.resolve(directory);
  const manifest = await readJson<EvidenceManifestV1>(path.join(root, "manifest.json"));
  const issues = validateEvidenceManifestV1(manifest);
  if (issues.length) throw new EvidenceVerificationError("manifest", issues[0]!, "Evidence manifest is invalid.");
  if (manifest.outcome !== "captured") {
    throw new EvidenceVerificationError("manifest", "$.outcome", "Evidence bundle does not contain a successful capture.");
  }

  const transcripts = {} as Record<TranscriptProvider, TranscriptEntry[]>;
  const declaredSanitizedDigests = await readJson<Record<TranscriptProvider, { sha256: string; bytes: number }>>(
    path.join(root, "sanitized", "SHA256SUMS.json")
  );
  for (const provider of ["idea", "breakpilot"] as const) {
    const descriptor = manifest.providers[provider];
    const transcriptPath = path.join(root, descriptor.transcript);
    const digest = await sha256File(transcriptPath);
    if (digest.sha256 !== descriptor.sha256 || digest.bytes !== descriptor.bytes) {
      throw new EvidenceVerificationError("hash", descriptor.transcript, "Sanitized transcript digest mismatch.");
    }
    if (
      declaredSanitizedDigests[provider]?.sha256 !== digest.sha256 ||
      declaredSanitizedDigests[provider]?.bytes !== digest.bytes
    ) {
      throw new EvidenceVerificationError("hash", "sanitized/SHA256SUMS.json", "Sanitized digest index mismatch.");
    }
    const entries = await readNdjson(transcriptPath);
    const resanitized = sanitizeTranscript(provider, entries).entries;
    if (stableEntries(resanitized) !== stableEntries(entries)) {
      throw new EvidenceVerificationError("sanitizer", descriptor.transcript, "Sanitized transcript is not idempotent.");
    }
    transcripts[provider] = entries;
    if (manifest.rawRetention === "retained") {
      if (!descriptor.rawTranscript || !descriptor.rawSha256 || descriptor.rawBytes === undefined) {
        throw new EvidenceVerificationError("manifest", `$.providers.${provider}`, "Retained raw evidence is missing its digest.");
      }
      const rawDigest = await sha256File(path.join(root, descriptor.rawTranscript));
      if (rawDigest.sha256 !== descriptor.rawSha256 || rawDigest.bytes !== descriptor.rawBytes) {
        throw new EvidenceVerificationError("hash", descriptor.rawTranscript, "Raw transcript digest mismatch.");
      }
    }
  }

  const lineage = await readJson<LineageFileV1>(path.join(root, "lineage.json"));
  const artifact = extractSemanticArtifact(manifest, transcripts, lineage);
  const expected = await readJson<SemanticDifferentialArtifactV1>(path.join(root, "semantic.json"));
  if (JSON.stringify(expected) !== JSON.stringify(artifact)) {
    throw new EvidenceVerificationError("semantic", "semantic.json", "Generated semantic artifact mismatch.");
  }
  return artifact;
}
