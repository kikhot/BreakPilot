#!/usr/bin/env node
/**
 * Copy vendored, non-TypeScript debug-adapter assets into the compiled `dist/`
 * tree so they ship with `breakpilot-cli` and resolve at runtime.
 *
 * `tsc` only emits the `.ts` sources; the Java adapter additionally relies on a
 * vendored `JdiDapServer.java` bridge source (Requirement 5.1). The published
 * bin runs from `dist/src/...`, so the bridge resolver's primary candidate is
 * `dist/src/debug-adapters/java/JdiDapServer.java`. This script mirrors the
 * vendored `.java` sources under `src/debug-adapters` into that compiled
 * location so the file is present both for runtime resolution and packaging
 * (Requirement 12.3). The TypeScript build (tsconfig/dist) is unaffected.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(repoRoot, "src");
const distSrcRoot = join(repoRoot, "dist", "src");

/** Recursively collect files under `dir` whose name matches one of `extensions`. */
async function collect(dir, extensions) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collect(full, extensions)));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      found.push(full);
    }
  }
  return found;
}

const assets = await collect(join(srcRoot, "debug-adapters"), [".java"]);

for (const absolute of assets) {
  const rel = relative(srcRoot, absolute);
  const destination = join(distSrcRoot, rel);
  await mkdir(dirname(destination), { recursive: true });
  await cp(absolute, destination);
  console.log(`copied ${["src", ...rel.split(sep)].join("/")} -> dist/src/${rel.split(sep).join("/")}`);
}

if (assets.length === 0) {
  console.log("copy-bridge-assets: no .java assets found to copy");
}
