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

export interface EvidenceFileDigest {
  sha256: string;
  bytes: number;
}

export interface EvidenceManifestV1 {
  schemaVersion: 1;
  runId: string;
  harness: { revision: string | null; node: string; platform: string };
  breakpilot: { revision: string | null; hubUrl: string; bridgeUrl: string };
  application: {
    root: string;
    revision: string | null;
    revisionReason?: string;
    sourceMarker: SourceMarker;
  };
  providers: Record<TranscriptProvider, {
    serverIdentity?: string;
    sessionIdentity?: string;
    transcript: string;
    sha256: string;
    bytes: number;
    rawTranscript?: string;
    rawSha256?: string;
    rawBytes?: number;
  }>;
  sanitizer: { id: "breakpilot-differential-v1"; version: 1 };
  rawRetention: "retained" | "unavailable";
  outcome: "captured" | "infrastructure_unavailable" | "failed";
}

export interface CapturedMcpCommand {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface DifferentialScenarioV1 {
  schemaVersion: 1;
  sampleRoot: string;
  sourceMarker: { path: string; line: number; lineTextSha256?: string };
  providers: Partial<Record<TranscriptProvider, CapturedMcpCommand>>;
  hubUrl: string;
  bridgeUrl: string;
  steps: Array<{
    id: string;
    provider: TranscriptProvider;
    method: string;
    params: unknown;
    retries?: number;
  }>;
  lineage: LineageAssertionV1[];
}

export interface LineageAssertionV1 {
  name: string;
  provider: TranscriptProvider;
  transcript: string;
  sequence: number;
  jsonPointer: string;
  transcriptSha256: string;
}

export interface LineageFileV1 {
  schemaVersion: 1;
  assertions: LineageAssertionV1[];
}

export interface SemanticDifferentialArtifactV1 {
  schemaVersion: 1;
  evidenceLevel: "synthetic-replay" | "captured-replay";
  source: SourceMarker;
  values: Record<string, { idea: unknown; breakpilot: unknown }>;
}

export interface CaptureConfig extends DifferentialScenarioV1 {
  outputRoot?: string;
}

export interface CaptureResult {
  directory: string;
  manifest: EvidenceManifestV1;
  error?: { code: string; message: string };
}

export class EvidenceVerificationError extends Error {
  readonly code = "EVIDENCE_VERIFICATION_FAILED";
  readonly category: string;
  readonly path: string;

  constructor(category: string, path: string, message: string) {
    super(message);
    this.name = "EvidenceVerificationError";
    this.category = category;
    this.path = path;
  }
}

export function validateEvidenceManifestV1(value: unknown): string[] {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["$"];
  const manifest = value as Partial<EvidenceManifestV1>;
  const record = value as Record<string, unknown>;
  const allowedRoot = new Set([
    "schemaVersion", "runId", "harness", "breakpilot", "application", "providers", "sanitizer", "rawRetention", "outcome"
  ]);
  for (const key of Object.keys(record)) if (!allowedRoot.has(key)) issues.push(`$.${key}`);
  if (manifest.schemaVersion !== 1) issues.push("$.schemaVersion");
  if (typeof manifest.runId !== "string" || !manifest.runId) issues.push("$.runId");
  if (!isEvidenceRecord(manifest.harness)) issues.push("$.harness");
  else {
    rejectUnknownKeys(manifest.harness, new Set(["revision", "node", "platform"]), "$.harness", issues);
    if (!isRevision(manifest.harness.revision)) issues.push("$.harness.revision");
    if (typeof manifest.harness.node !== "string" || !manifest.harness.node) issues.push("$.harness.node");
    if (typeof manifest.harness.platform !== "string" || !manifest.harness.platform) issues.push("$.harness.platform");
  }
  if (!isEvidenceRecord(manifest.breakpilot)) issues.push("$.breakpilot");
  else {
    rejectUnknownKeys(manifest.breakpilot, new Set(["revision", "hubUrl", "bridgeUrl"]), "$.breakpilot", issues);
    if (!isRevision(manifest.breakpilot.revision)) issues.push("$.breakpilot.revision");
    if (typeof manifest.breakpilot.hubUrl !== "string" || !manifest.breakpilot.hubUrl) issues.push("$.breakpilot.hubUrl");
    if (typeof manifest.breakpilot.bridgeUrl !== "string" || !manifest.breakpilot.bridgeUrl) issues.push("$.breakpilot.bridgeUrl");
  }
  if (!isEvidenceRecord(manifest.application)) issues.push("$.application");
  else {
    rejectUnknownKeys(manifest.application, new Set(["root", "revision", "revisionReason", "sourceMarker"]), "$.application", issues);
    if (typeof manifest.application.root !== "string" || !manifest.application.root) issues.push("$.application.root");
    if (!isRevision(manifest.application.revision)) issues.push("$.application.revision");
    if (manifest.application.revisionReason !== undefined && typeof manifest.application.revisionReason !== "string") {
      issues.push("$.application.revisionReason");
    }
    if (manifest.application.revision === null && !manifest.application.revisionReason) {
      issues.push("$.application.revisionReason");
    }
    const marker = manifest.application.sourceMarker;
    if (!isEvidenceRecord(marker)) {
      issues.push("$.application.sourceMarker");
    } else {
      rejectUnknownKeys(marker, new Set(["workspaceRelativePath", "line", "lineSha256", "lineText"]), "$.application.sourceMarker", issues);
    }
    if (!isEvidenceRecord(marker) || typeof marker.workspaceRelativePath !== "string" || !marker.workspaceRelativePath) {
      issues.push("$.application.sourceMarker.workspaceRelativePath");
    }
    if (!isEvidenceRecord(marker) || !Number.isInteger(marker.line) || (marker.line as number) < 1) issues.push("$.application.sourceMarker.line");
    if (!isEvidenceRecord(marker) || typeof marker.lineSha256 !== "string" || !/^[0-9a-f]{64}$/.test(marker.lineSha256)) {
      issues.push("$.application.sourceMarker.lineSha256");
    }
    if (isEvidenceRecord(marker) && marker.lineText !== undefined && typeof marker.lineText !== "string") {
      issues.push("$.application.sourceMarker.lineText");
    }
  }
  if (!(["captured", "infrastructure_unavailable", "failed"] as unknown[]).includes(manifest.outcome)) issues.push("$.outcome");
  if (!isEvidenceRecord(manifest.sanitizer)) issues.push("$.sanitizer");
  else {
    rejectUnknownKeys(manifest.sanitizer, new Set(["id", "version"]), "$.sanitizer", issues);
    if (manifest.sanitizer.id !== "breakpilot-differential-v1" || manifest.sanitizer.version !== 1) issues.push("$.sanitizer");
  }
  if (manifest.rawRetention !== "retained" && manifest.rawRetention !== "unavailable") issues.push("$.rawRetention");
  if (manifest.rawRetention === "unavailable" && manifest.providers) {
    for (const provider of ["idea", "breakpilot"] as const) {
      const descriptor = manifest.providers[provider] as Record<string, unknown> | undefined;
      for (const field of ["rawTranscript", "rawSha256", "rawBytes"] as const) {
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, field)) {
          issues.push(`$.providers.${provider}.${field}`);
        }
      }
    }
  }
  if (!isEvidenceRecord(manifest.providers)) issues.push("$.providers");
  else rejectUnknownKeys(manifest.providers, new Set(["idea", "breakpilot"]), "$.providers", issues);
  for (const provider of ["idea", "breakpilot"] as const) {
    const descriptor = manifest.providers?.[provider];
    if (!isEvidenceRecord(descriptor)) {
      issues.push(`$.providers.${provider}`);
      continue;
    }
    rejectUnknownKeys(
      descriptor,
      new Set(["serverIdentity", "sessionIdentity", "transcript", "sha256", "bytes", "rawTranscript", "rawSha256", "rawBytes"]),
      `$.providers.${provider}`,
      issues
    );
    if (descriptor.serverIdentity !== undefined && typeof descriptor.serverIdentity !== "string") {
      issues.push(`$.providers.${provider}.serverIdentity`);
    }
    if (descriptor.sessionIdentity !== undefined && typeof descriptor.sessionIdentity !== "string") {
      issues.push(`$.providers.${provider}.sessionIdentity`);
    }
    const hasSanitizedEvidence = manifest.outcome === "captured" || Boolean(descriptor.transcript || descriptor.sha256 || descriptor.bytes);
    if (typeof descriptor.transcript !== "string" || (hasSanitizedEvidence && !descriptor.transcript)) {
      issues.push(`$.providers.${provider}.transcript`);
    }
    if (typeof descriptor.sha256 !== "string" || (hasSanitizedEvidence && !/^[0-9a-f]{64}$/.test(descriptor.sha256))) {
      issues.push(`$.providers.${provider}.sha256`);
    }
    if (!Number.isInteger(descriptor.bytes) || descriptor.bytes < 0) issues.push(`$.providers.${provider}.bytes`);
    if (manifest.rawRetention === "retained") {
      if (typeof descriptor.rawTranscript !== "string" || !descriptor.rawTranscript) {
        issues.push(`$.providers.${provider}.rawTranscript`);
      }
      if (typeof descriptor.rawSha256 !== "string" || !/^[0-9a-f]{64}$/.test(descriptor.rawSha256)) {
        issues.push(`$.providers.${provider}.rawSha256`);
      }
      if (!Number.isInteger(descriptor.rawBytes) || (descriptor.rawBytes ?? -1) < 0) {
        issues.push(`$.providers.${provider}.rawBytes`);
      }
    }
  }
  return issues;
}

function isEvidenceRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function rejectUnknownKeys(
  value: object,
  allowed: ReadonlySet<string>,
  base: string,
  issues: string[]
): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${base}.${key}`);
}
