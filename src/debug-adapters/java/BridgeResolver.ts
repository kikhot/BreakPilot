import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BreakPilotError, ErrorCodes } from "../../utils/errors.ts";

/**
 * Resolution helpers for the vendored Java Debug Interface (JDI) bridge.
 *
 * The Java adapter debugs targets through a single-file `JdiDapServer.java`
 * bridge compiled on demand with `javac`. Before it can compile or run that
 * bridge it must (a) locate a JDK toolchain (`javac` + `java`) and (b) know
 * where the vendored bridge source lives and where compiled output should go.
 *
 * This module owns exactly that resolution and nothing else. It performs no
 * compilation and spawns no processes, so importing it is side-effect free and
 * safe even before the bridge source has been vendored (Task 11.5). Every
 * resolver accepts an explicit `env` so callers (and tests) can resolve against
 * a controlled environment instead of `process.env`.
 *
 * Design reference: `.kiro/specs/pluggable-debug-adapters/design.md`,
 * "Java adapter" → "Bridge_Resolver" (Requirements 5.2, 5.3).
 */

/** Environment shape consumed by the resolvers (a subset of `process.env`). */
export type ResolverEnv = Record<string, string | undefined>;

/**
 * A located JDK toolchain.
 *
 * `checked` records which discovery sources were examined while locating the
 * toolchain, so callers and error messages can explain what was inspected:
 * - `javaHome` is true when `JAVA_HOME` was set and its `bin` directory checked.
 * - `path` is true when the directories on `PATH` were scanned (this only
 *   happens when `JAVA_HOME` did not yield an executable `javac`).
 */
export interface JdkToolchain {
  /** Absolute path to the resolved `javac` executable. */
  javac: string;
  /** Absolute path to the resolved `java` executable. */
  java: string;
  /** Which discovery sources were examined during resolution. */
  checked: { javaHome: boolean; path: boolean };
}

const isWindows = process.platform === "win32";

/** Platform-specific executable names. */
const JAVAC_EXE = isWindows ? "javac.exe" : "javac";
const JAVA_EXE = isWindows ? "java.exe" : "java";

/** Vendored bridge source file name (resolved in this module's directory). */
const BRIDGE_SOURCE_FILE = "JdiDapServer.java";

/** Subdirectory (relative to the bridge dir) that holds compiled output. */
const BRIDGE_OUTPUT_DIR = "out";

/** Environment override naming a directory that holds the bridge source. */
const BRIDGE_DIR_ENV = "BREAKPILOT_JDI_BRIDGE_DIR";

/** Absolute path to the directory containing this module. */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** True when `candidate` exists and is a regular file. */
function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Read the non-empty, trimmed `BREAKPILOT_JDI_BRIDGE_DIR` override, if any. */
function bridgeDirOverride(env: ResolverEnv): string | undefined {
  const override = env[BRIDGE_DIR_ENV]?.trim();
  return override ? path.resolve(override) : undefined;
}

/** Split a `PATH`/`Path` value into individual directory entries. */
function pathEntries(env: ResolverEnv): string[] {
  // Windows uses `Path`/`PATH` interchangeably; prefer whichever is populated.
  const raw = env.PATH ?? env.Path ?? "";
  return raw.split(path.delimiter).filter((dir) => dir.length > 0);
}

/** Locate an executable by name on the directories in `PATH`. */
function findOnPath(exeName: string, env: ResolverEnv): string | undefined {
  for (const dir of pathEntries(env)) {
    const candidate = path.join(dir, exeName);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the `java` executable that pairs with a located `javac`.
 *
 * Prefers the `java` sitting in the same `bin` directory as `javac` (a normal
 * JDK layout); failing that, falls back to a `PATH` scan. If neither yields an
 * executable, returns the same-directory candidate as a best effort so the
 * caller still has a concrete path (the JDK that provided `javac` is expected
 * to provide `java` alongside it).
 */
function resolveJavaFor(javacPath: string, env: ResolverEnv): string {
  const sibling = path.join(path.dirname(javacPath), JAVA_EXE);
  if (isFile(sibling)) return sibling;
  return findOnPath(JAVA_EXE, env) ?? sibling;
}

/**
 * Locate a JDK toolchain.
 *
 * Discovery order (Requirement 5.2):
 * 1. `JAVA_HOME` — its `bin/javac` is treated as the toolchain only when that
 *    `javac` exists and is a file.
 * 2. The directories on `PATH` — the first directory containing an executable
 *    `javac` wins.
 *
 * A toolchain counts as located ONLY when an executable `javac` is found; the
 * matching `java` is resolved alongside it. If neither source yields a `javac`,
 * throws `ADAPTER_START_FAILED` stating that a JDK is required and naming which
 * of `JAVA_HOME` / `PATH` were checked and found to lack `javac`
 * (Requirement 5.3).
 *
 * @param env Environment to resolve against; defaults to `process.env`.
 */
export function resolveJdk(env: ResolverEnv = process.env): JdkToolchain {
  const checked = { javaHome: false, path: false };

  const javaHome = env.JAVA_HOME?.trim();
  if (javaHome) {
    checked.javaHome = true;
    const javacPath = path.join(javaHome, "bin", JAVAC_EXE);
    if (isFile(javacPath)) {
      return { javac: javacPath, java: resolveJavaFor(javacPath, env), checked };
    }
  }

  checked.path = true;
  const javacOnPath = findOnPath(JAVAC_EXE, env);
  if (javacOnPath) {
    return { javac: javacOnPath, java: resolveJavaFor(javacOnPath, env), checked };
  }

  throw new BreakPilotError(
    ErrorCodes.ADAPTER_START_FAILED,
    buildMissingJdkMessage(javaHome, checked),
    {
      language: "java",
      requiredDependency: "javac (JDK 21+)",
      checked,
      javaHome: javaHome ?? null
    }
  );
}

/** Compose the "no JDK found" error message from what was actually checked. */
function buildMissingJdkMessage(
  javaHome: string | undefined,
  checked: { javaHome: boolean; path: boolean }
): string {
  const places: string[] = [];
  if (checked.javaHome) places.push(`JAVA_HOME (${javaHome})`);
  else places.push("JAVA_HOME (not set)");
  if (checked.path) places.push("PATH");

  return (
    `A JDK is required to debug Java but no executable \`${JAVAC_EXE}\` was found. ` +
    `Checked ${places.join(" and ")} and found no \`${JAVAC_EXE}\`. ` +
    `Set JAVA_HOME to a JDK 21+ installation, or add \`${JAVAC_EXE}\` to PATH.`
  );
}

/**
 * Resolve the directory that holds the vendored bridge source.
 *
 * Honors the `BREAKPILOT_JDI_BRIDGE_DIR` override; otherwise uses this module's
 * own directory.
 */
function resolveBridgeDir(env: ResolverEnv = process.env): string {
  return bridgeDirOverride(env) ?? moduleDir;
}

/**
 * Resolve the absolute path to the vendored `JdiDapServer.java`.
 *
 * Resolution honors `BREAKPILOT_JDI_BRIDGE_DIR`, then this module's directory,
 * then (when running from a compiled `dist/` build) the parallel `src/`
 * location. The first candidate that exists on disk is returned; if none exist
 * yet (the source may not be vendored until Task 11.5), the primary expected
 * path is returned so callers can compile/report against it. This never throws
 * and performs no I/O beyond existence checks.
 *
 * @param env Environment to resolve against; defaults to `process.env`.
 */
export function resolveBridgeSource(env: ResolverEnv = process.env): string {
  // An explicit override is authoritative: the bridge source is expected there,
  // and we do not silently fall back to a vendored copy that might shadow it.
  const override = bridgeDirOverride(env);
  if (override) return path.join(override, BRIDGE_SOURCE_FILE);

  // Without an override, the source lives next to this module. When running
  // from a compiled `dist/` build, the `.java` source ships under `src/`, so
  // prefer the module-local copy and fall back to the parallel `src/` path.
  const primary = path.join(moduleDir, BRIDGE_SOURCE_FILE);
  const candidates: string[] = [primary];

  const distSegment = `${path.sep}dist${path.sep}`;
  if (moduleDir.includes(distSegment)) {
    const srcDir = moduleDir.replace(distSegment, `${path.sep}src${path.sep}`);
    candidates.push(path.join(srcDir, BRIDGE_SOURCE_FILE));
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return primary;
}

/**
 * Resolve the directory where compiled bridge classes are written.
 *
 * This is an `out/` directory under the resolved bridge directory (honoring the
 * `BREAKPILOT_JDI_BRIDGE_DIR` override). The directory is not created here; the
 * Bridge_Compiler owns creation and compilation.
 *
 * @param env Environment to resolve against; defaults to `process.env`.
 */
export function resolveBridgeOutputDir(env: ResolverEnv = process.env): string {
  return path.join(resolveBridgeDir(env), BRIDGE_OUTPUT_DIR);
}

/**
 * Grouped resolver surface, mirroring the reference project's JDI resolver
 * shape. Callers may use either the named functions or this object.
 */
export const BridgeResolver = Object.freeze({
  resolveJdk,
  resolveBridgeSource,
  resolveBridgeOutputDir
});
