/**
 * Bridge_Compiler — compiles the vendored `JdiDapServer.java` bridge source into
 * a runnable `.class` using the JDK's `javac`, with mtime-based staleness caching
 * (Requirements 5.4, 5.5, 5.6, 5.7).
 *
 * Design reference: `.kiro/specs/pluggable-debug-adapters/design.md`,
 * section "Java adapter" → Bridge_Compiler.
 *
 * Behavior summary:
 * - Compile with `javac --release 21 <sourceFile> -d <outDir>` WHEN no compiled
 *   output exists OR the source mtime is strictly newer than the compiled output
 *   (`JdiDapServer.class`) mtime (Requirements 5.4, 5.6).
 * - Reuse the existing compiled output (no recompile) when the output mtime is
 *   `>=` the source mtime (Requirement 5.5).
 * - On a non-zero `javac` exit OR no produced output, throw
 *   `BreakPilotError(ADAPTER_START_FAILED, ...)` including the compiler
 *   diagnostics, and leave any previously compiled output unchanged
 *   (Requirement 5.7).
 *
 * This module intentionally accepts explicit `javac` / `sourceFile` / `outDir`
 * parameters rather than depending on `BridgeResolver` directly, to avoid tight
 * coupling and import-time ordering constraints. The `JavaAdapter` (Task 12)
 * wires a resolved `BridgeResolver` result into these functions.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BreakPilotError, ErrorCodes } from "../../utils/errors.ts";

/** Name of the compiled bridge artifact produced by `javac`. */
export const COMPILED_CLASS_NAME = "JdiDapServer.class";

/** Inputs for {@link ensureCompiled}. */
export interface CompileOptions {
  /** Absolute path to the `javac` executable (from JDK discovery). */
  javac: string;
  /** Absolute path to the vendored `JdiDapServer.java` source file. */
  sourceFile: string;
  /** Output directory to compile into (will be created if missing). */
  outDir: string;
}

/**
 * Pure staleness decision (Requirement 5.4, 5.5, 5.6).
 *
 * Returns `true` (recompile required) when the compiled class is missing
 * (`classMtimeMs === null`) OR the source mtime is strictly newer than the
 * compiled output mtime. Returns `false` (reuse) when the output mtime is `>=`
 * the source mtime.
 *
 * Exported separately so it is unit- and property-testable in isolation
 * (Property 12) without touching the filesystem or spawning a compiler.
 *
 * @param sourceMtimeMs Modification time of the source file, in epoch ms.
 * @param classMtimeMs  Modification time of the compiled class in epoch ms, or
 *                      `null` when no compiled output exists.
 */
export function needsCompile(sourceMtimeMs: number, classMtimeMs: number | null): boolean {
  if (classMtimeMs === null) return true;
  return sourceMtimeMs > classMtimeMs;
}

/** Return a file's mtime in epoch ms, or `null` if it does not exist. */
function statMtimeMsOrNull(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** Extract a readable string from a Buffer | string | undefined diagnostic stream. */
function streamToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

/**
 * Ensure the vendored bridge source is compiled into `outDir`, recompiling only
 * when stale, and return `outDir` on success.
 *
 * @throws {BreakPilotError} `ADAPTER_START_FAILED` when the source file is
 * missing, when `javac` exits non-zero, or when no compiled output is produced.
 * Previously compiled output is left unchanged on failure.
 */
export function ensureCompiled(options: CompileOptions): string {
  const { javac, sourceFile, outDir } = options;

  const sourceMtimeMs = statMtimeMsOrNull(sourceFile);
  if (sourceMtimeMs === null) {
    throw new BreakPilotError(
      ErrorCodes.ADAPTER_START_FAILED,
      `Java bridge source not found: ${sourceFile}`,
      { sourceFile }
    );
  }

  const compiledClass = path.join(outDir, COMPILED_CLASS_NAME);
  const classMtimeMs = statMtimeMsOrNull(compiledClass);

  // Reuse existing compiled output when it is up to date (Requirement 5.5).
  if (!needsCompile(sourceMtimeMs, classMtimeMs)) {
    return outDir;
  }

  // Recompile (Requirements 5.4, 5.6). Ensure the output directory exists; this
  // does not touch any previously compiled artifact.
  fs.mkdirSync(outDir, { recursive: true });

  let stdout = "";
  let stderr = "";
  try {
    stdout = streamToString(
      execFileSync(javac, ["--release", "21", sourceFile, "-d", outDir], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
    );
  } catch (error) {
    // Non-zero exit (or spawn failure): capture diagnostics and surface them.
    // We do not remove any previously compiled output (Requirement 5.7).
    const err = error as NodeJS.ErrnoException & {
      status?: number | null;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    const diagnostics = [streamToString(err.stdout), streamToString(err.stderr)]
      .filter((part) => part.trim().length > 0)
      .join("\n")
      .trim();
    throw new BreakPilotError(
      ErrorCodes.ADAPTER_START_FAILED,
      `Failed to compile Java bridge (${sourceFile}): javac exited unsuccessfully.` +
        (diagnostics ? `\n${diagnostics}` : ""),
      {
        javac,
        sourceFile,
        outDir,
        exitCode: typeof err.status === "number" ? err.status : null,
        diagnostics
      }
    );
  }

  // Verify the expected artifact was produced (Requirement 5.7). A zero exit
  // without output (e.g. wrong source path semantics) must still be treated as
  // a failure.
  if (statMtimeMsOrNull(compiledClass) === null) {
    const diagnostics = [stdout, stderr]
      .filter((part) => part.trim().length > 0)
      .join("\n")
      .trim();
    throw new BreakPilotError(
      ErrorCodes.ADAPTER_START_FAILED,
      `Java bridge compilation produced no output: expected ${compiledClass}.` +
        (diagnostics ? `\n${diagnostics}` : ""),
      { javac, sourceFile, outDir, expected: compiledClass, diagnostics }
    );
  }

  return outDir;
}

/**
 * Thin object-oriented wrapper around {@link ensureCompiled} for callers that
 * prefer a stateful handle. Holds no resources of its own.
 */
export class BridgeCompiler {
  /**
   * Compile the bridge if stale, reusing existing output otherwise.
   * @returns the output directory on success.
   * @throws {BreakPilotError} `ADAPTER_START_FAILED` on compile failure.
   */
  ensureCompiled(options: CompileOptions): string {
    return ensureCompiled(options);
  }
}
