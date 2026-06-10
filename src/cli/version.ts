/**
 * Version reader for the BreakPilot CLI (R2).
 *
 * Reads the `version` field from the nearest `package.json`. To stay compatible
 * with both the source layout (`src/cli/version.ts`) and the built layout
 * (`dist/.../cli/version.js`), the lookup walks up from this module's directory
 * until it finds a `package.json`, then loads it via `createRequire`. This
 * avoids any fixed relative-path assumptions that would break in one layout.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJson {
  version?: unknown;
}

const FALLBACK_VERSION = "0.0.0";

let cachedVersion: string | undefined;

/**
 * Walk up the directory tree from `startDir` until a `package.json` is found.
 * Returns the absolute path to the nearest `package.json`, or `undefined` when
 * the filesystem root is reached without a match.
 */
function findNearestPackageJson(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Return the BreakPilot CLI version from the nearest `package.json`.
 *
 * Falls back to {@link FALLBACK_VERSION} if the file cannot be located or read,
 * so that callers (e.g. the yargs `.version()` configuration) always receive a
 * non-empty string. The resolved value is cached after the first read.
 */
export function getVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;

  const here = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = findNearestPackageJson(here);
  if (!packageJsonPath) {
    cachedVersion = FALLBACK_VERSION;
    return cachedVersion;
  }

  try {
    const require = createRequire(import.meta.url);
    const pkg = require(packageJsonPath) as PackageJson;
    cachedVersion =
      typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : FALLBACK_VERSION;
  } catch {
    cachedVersion = FALLBACK_VERSION;
  }
  return cachedVersion;
}
