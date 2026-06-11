// Feature: pluggable-debug-adapters, Property 11: JDK discovery prefers JAVA_HOME then PATH and requires an executable javac
/**
 * Property-based test for JDK toolchain discovery (Task 11.2).
 *
 * Runner: node --experimental-strip-types test/jdk-discovery.property.test.ts
 *
 * Property 11: JDK discovery prefers JAVA_HOME then PATH and requires an
 *   executable javac.
 *   For any synthetic JAVA_HOME/PATH layout, `BridgeResolver.resolveJdk()`
 *   reports the toolchain as located if and only if an executable `javac`
 *   exists in `JAVA_HOME/bin` or one of the `PATH` directories, and when both
 *   contain one it selects the `JAVA_HOME` toolchain.
 *
 * Validates: Requirements 5.2
 *
 * Hermetic: a synthetic environment is injected via the explicit `env`
 * parameter of `resolveJdk` and synthetic `javac`/`java` stubs are created
 * under `os.tmpdir()`. The real `process.env`/`PATH` is never mutated, and all
 * temp directories are removed after the run.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { BridgeResolver } from "../src/debug-adapters/java/BridgeResolver.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";

const RUNS = 200;

// Mirror the resolver's platform-specific executable names so on-disk stubs and
// expected paths line up exactly with what `resolveJdk` looks for.
const isWindows = process.platform === "win32";
const JAVAC_EXE = isWindows ? "javac.exe" : "javac";
const JAVA_EXE = isWindows ? "java.exe" : "java";

// Root sandbox for every synthetic directory created during this run.
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-jdk-discovery-"));
let dirCounter = 0;

/** Create a fresh, unique directory inside the sandbox. */
function freshDir(label: string): string {
  const dir = path.join(baseDir, `${label}-${dirCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write an executable stub file at `target` (mode 0o755). */
function writeExecutable(target: string): void {
  fs.writeFileSync(target, isWindows ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
  // Ensure the executable bit survives umask masking on the write above.
  fs.chmodSync(target, 0o755);
}

// ---------------------------------------------------------------------------
// Scenario generator
//
// A scenario describes a synthetic JAVA_HOME state plus an ordered list of PATH
// directories, each of which may or may not contain an executable `javac`.
// ---------------------------------------------------------------------------
type JavaHomeState = "unset" | "set-no-javac" | "set-with-javac";

interface Scenario {
  javaHome: JavaHomeState;
  pathDirs: { hasJavac: boolean }[];
}

const scenarioArb = fc.record({
  javaHome: fc.constantFrom<JavaHomeState>("unset", "set-no-javac", "set-with-javac"),
  pathDirs: fc.array(fc.record({ hasJavac: fc.boolean() }), { maxLength: 4 })
});

/**
 * Materialize a scenario on disk and build the synthetic environment that will
 * be injected into `resolveJdk`. Returns everything the assertions need.
 */
function materialize(scenario: Scenario): {
  env: Record<string, string | undefined>;
  javaHomeDir: string | undefined;
  pathDirsActual: string[];
} {
  let javaHomeDir: string | undefined;
  let javaHomeEnv: string | undefined;

  if (scenario.javaHome !== "unset") {
    javaHomeDir = freshDir("java_home");
    javaHomeEnv = javaHomeDir;
    if (scenario.javaHome === "set-with-javac") {
      const binDir = path.join(javaHomeDir, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      writeExecutable(path.join(binDir, JAVAC_EXE));
      writeExecutable(path.join(binDir, JAVA_EXE));
    }
  }

  const pathDirsActual = scenario.pathDirs.map((spec) => {
    const dir = freshDir("path_entry");
    if (spec.hasJavac) {
      // PATH entries hold `javac` directly (not under a `bin/` subdir).
      writeExecutable(path.join(dir, JAVAC_EXE));
      writeExecutable(path.join(dir, JAVA_EXE));
    }
    return dir;
  });

  const env: Record<string, string | undefined> = {
    JAVA_HOME: javaHomeEnv,
    PATH: pathDirsActual.join(path.delimiter)
  };

  return { env, javaHomeDir, pathDirsActual };
}

// ---------------------------------------------------------------------------
// Property 11
// ---------------------------------------------------------------------------
try {
  fc.assert(
    fc.property(scenarioArb, (scenario) => {
      const { env, javaHomeDir, pathDirsActual } = materialize(scenario);

      const locatedViaJavaHome = scenario.javaHome === "set-with-javac";
      const firstPathWithJavac = scenario.pathDirs.findIndex((spec) => spec.hasJavac);
      const locatedViaPath = !locatedViaJavaHome && firstPathWithJavac !== -1;

      if (locatedViaJavaHome) {
        // JAVA_HOME has javac: it is selected (and wins even when PATH also has
        // one), the PATH scan never runs, and the javac path is under JAVA_HOME.
        const toolchain = BridgeResolver.resolveJdk(env);
        const expectedJavac = path.join(javaHomeDir as string, "bin", JAVAC_EXE);
        assert.equal(toolchain.javac, expectedJavac);
        assert.ok(
          toolchain.javac.startsWith((javaHomeDir as string) + path.sep),
          `expected resolved javac to live under JAVA_HOME (${javaHomeDir}), got ${toolchain.javac}`
        );
        assert.equal(toolchain.checked.javaHome, true);
        assert.equal(toolchain.checked.path, false);
      } else if (locatedViaPath) {
        // No JAVA_HOME javac, but a PATH dir has one: the first such dir wins.
        const toolchain = BridgeResolver.resolveJdk(env);
        const expectedJavac = path.join(pathDirsActual[firstPathWithJavac]!, JAVAC_EXE);
        assert.equal(toolchain.javac, expectedJavac);
        assert.equal(toolchain.checked.path, true);
        // JAVA_HOME is recorded as checked only when it was set.
        assert.equal(toolchain.checked.javaHome, scenario.javaHome !== "unset");
      } else {
        // Neither source yields an executable javac: discovery fails.
        assert.throws(
          () => BridgeResolver.resolveJdk(env),
          (error: unknown) =>
            error instanceof BreakPilotError &&
            error.code === ErrorCodes.ADAPTER_START_FAILED
        );
      }
    }),
    { numRuns: RUNS }
  );

  console.log("jdk-discovery property tests ok");
} finally {
  fs.rmSync(baseDir, { recursive: true, force: true });
}
