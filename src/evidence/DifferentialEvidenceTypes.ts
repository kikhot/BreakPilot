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
  if (manifest.schemaVersion !== 1) issues.push("$.schemaVersion");
  if (typeof manifest.runId !== "string" || !manifest.runId) issues.push("$.runId");
  if (!manifest.application || typeof manifest.application !== "object") issues.push("$.application");
  else if (manifest.application.revision === null && !manifest.application.revisionReason) {
    issues.push("$.application.revisionReason");
  }
  if (manifest.rawRetention !== "retained" && manifest.rawRetention !== "unavailable") issues.push("$.rawRetention");
  if (manifest.rawRetention === "unavailable" && manifest.providers) {
    for (const provider of ["idea", "breakpilot"] as const) {
      if (manifest.providers[provider]?.rawSha256 || manifest.providers[provider]?.rawTranscript) {
        issues.push(`$.providers.${provider}.rawSha256`);
      }
    }
  }
  if (!manifest.providers?.idea) issues.push("$.providers.idea");
  if (!manifest.providers?.breakpilot) issues.push("$.providers.breakpilot");
  return issues;
}
