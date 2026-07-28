import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";

import type { EvidenceFileDigest } from "./DifferentialEvidenceTypes.ts";

export async function sha256File(filePath: string): Promise<EvidenceFileDigest> {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => {
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: hash.digest("hex").toLowerCase(), bytes };
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").toLowerCase();
}

export async function hashManifestFiles(root: string, relativePaths: string[]): Promise<Record<string, EvidenceFileDigest>> {
  const normalizedRoot = path.resolve(root);
  const result: Record<string, EvidenceFileDigest> = {};
  for (const relativePath of relativePaths) {
    if (path.isAbsolute(relativePath)) throw new Error("Evidence paths must be relative.");
    const absolute = path.resolve(normalizedRoot, relativePath);
    if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}${path.sep}`)) {
      throw new Error("Evidence path escapes its bundle.");
    }
    result[relativePath] = await sha256File(absolute);
  }
  return result;
}
