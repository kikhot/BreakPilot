import { readFile } from "node:fs/promises";
import path from "node:path";

import { captureDifferentialEvidence } from "./DifferentialEvidenceCapture.ts";
import { verifyEvidenceBundle } from "./DifferentialEvidenceReplay.ts";
import type { CaptureConfig } from "./DifferentialEvidenceTypes.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredAbsolute(name: string): string {
  const value = option(name);
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} requires an absolute path.`);
  return value;
}

async function main(): Promise<number> {
  const verb = process.argv[2];
  if (verb === "verify") {
    const artifact = await verifyEvidenceBundle(requiredAbsolute("--evidence-dir"));
    process.stdout.write(`${JSON.stringify({ outcome: "verified", evidenceLevel: artifact.evidenceLevel, source: artifact.source })}\n`);
    return 0;
  }
  if (verb === "capture" || verb === "e2e") {
    let config: CaptureConfig;
    try {
      config = JSON.parse(await readFile(requiredAbsolute("--config"), "utf8")) as CaptureConfig;
    } catch {
      process.stderr.write(`${JSON.stringify({ outcome: "infrastructure_unavailable", code: "EVIDENCE_INFRASTRUCTURE_UNAVAILABLE", message: "Capture configuration is unavailable." })}\n`);
      return 2;
    }
    const result = await captureDifferentialEvidence(config);
    const output = {
      outcome: result.manifest.outcome,
      directory: result.directory,
      ...(result.error ? { code: result.error.code, message: result.error.message } : {})
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return result.manifest.outcome === "captured" ? 0 : 2;
  }
  process.stderr.write("Usage: differentialCli.ts <capture|verify|e2e> [options]\n");
  return 2;
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  const typed = error as Error & { code?: string };
  process.stderr.write(`${JSON.stringify({ outcome: "failed", code: typed.code ?? "EVIDENCE_VERIFICATION_FAILED", message: typed.message })}\n`);
  process.exitCode = 1;
});
