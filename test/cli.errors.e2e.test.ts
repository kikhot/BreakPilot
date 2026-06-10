/**
 * End-to-end tests for error handling, exit codes and stdout purity (Task 9.2).
 *
 * Runner: node --experimental-strip-types test/cli.errors.e2e.test.ts
 *
 * Each case runs the real CLI entry in a child process via
 *   node --experimental-strip-types src/cli.ts ...
 * and asserts on stdout / stderr / exit code.
 *
 * Covers Requirements:
 * - 4.1 / 4.2   unknown command/option -> exit 1, stderr error, no stdout JSON
 * - 4.3         missing required option (`bp set --session x`) -> exit 1
 * - 4.4         invalid number -> exit 1, stderr error, no stdout JSON
 * - 5.7         control tool `ok:false` / transport failure -> exit 1
 * - 5.9         `call` with invalid JSON -> exit 1, stderr error
 * - 5.10        `call` with no tool -> exit 1
 * - 1.5         help/version paths emit no JSON help blob
 *
 * Plus the design's Correctness Properties:
 * - Property 4  exit-code semantics: help/version -> 0; machine-readable command
 *               with a transport failure -> 1.
 * - Property 7  stdout purity: help/version and parse-error paths never emit a
 *               JSON help blob (no `"ok":`, stdout never starts with `{`).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import fc from "fast-check";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

// A control URL that is guaranteed to refuse connections quickly, so that
// machine-readable commands fail their transport step deterministically and
// fast (no waiting on a real daemon).
const UNREACHABLE_CONTROL_URL = "http://127.0.0.1:59999";

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run the CLI in a child process and resolve with its captured output.
 *
 * A timeout guard kills a command that fails to terminate (which would
 * otherwise hang the suite) and surfaces it as a rejection.
 */
function runCli(args: string[], timeoutMs = 15000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", cliEntry, ...args],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `CLI did not terminate within ${timeoutMs}ms for args: ${args.join(" ")}`
          )
        );
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * A "JSON help blob" is the old machine-readable help payload. Per Property 7 a
 * help/version or parse-error path must:
 * - never contain an `"ok":` field, and
 * - never have stdout that *starts* with `{` (the global help epilog may show an
 *   indented MCP-config JSON example mid-stream, which is fine; a top-level JSON
 *   document would start with `{`).
 */
function stdoutHasNoJsonBlob(stdout: string): boolean {
  if (/"ok"\s*:/.test(stdout)) return false;
  if (stdout.trimStart().startsWith("{")) return false;
  return true;
}

/** Strict purity for parse-error paths, whose stdout must be entirely empty. */
function stdoutIsClean(stdout: string): boolean {
  return !stdout.includes("{") && !stdout.includes('"ok"');
}

// ===========================================================================
// Direct end-to-end error assertions
// ===========================================================================

// --- R4.1 / R4.2: unknown command ----------------------------------------
{
  const result = await runCli(["frobnicate"]);
  assert.equal(result.code, 1, "unknown command should exit 1");
  assert.ok(
    result.stderr.trim().length > 0,
    "unknown command should write a human-readable error to stderr"
  );
  assert.ok(
    stdoutIsClean(result.stdout),
    `unknown command must not emit JSON to stdout (got: ${JSON.stringify(result.stdout)})`
  );
}

// --- R4.5 / R4.2: unknown option under strict mode ------------------------
{
  const result = await runCli(["tools", "--nope"]);
  assert.equal(result.code, 1, "unknown option should exit 1");
  assert.ok(
    result.stderr.trim().length > 0,
    "unknown option should write a human-readable error to stderr"
  );
  assert.ok(
    stdoutIsClean(result.stdout),
    `unknown option must not emit the tools JSON to stdout (got: ${JSON.stringify(result.stdout)})`
  );
}

// --- R4.3: missing required option ----------------------------------------
{
  const result = await runCli(["bp", "set", "--session", "x"]);
  assert.equal(result.code, 1, "`bp set --session x` (missing --file/--line) should exit 1");
  assert.match(
    result.stderr,
    /file/i,
    "missing-required error should mention the missing file option"
  );
  assert.match(
    result.stderr,
    /line/i,
    "missing-required error should mention the missing line option"
  );
  assert.ok(
    stdoutIsClean(result.stdout),
    `missing required option must not emit JSON to stdout (got: ${JSON.stringify(result.stdout)})`
  );
}

// --- R4.4: invalid number (standalone number option) ----------------------
{
  const result = await runCli(["continue", "--thread", "notanumber"]);
  assert.equal(result.code, 1, "invalid --thread number should exit 1");
  assert.ok(
    result.stderr.trim().length > 0,
    "invalid number should write a human-readable error to stderr"
  );
  assert.ok(
    stdoutIsClean(result.stdout),
    `invalid number must not emit JSON to stdout (got: ${JSON.stringify(result.stdout)})`
  );
}

// --- R4.4: invalid number alongside other valid required options ----------
{
  const result = await runCli([
    "bp",
    "set",
    "--session",
    "s",
    "--file",
    "f",
    "--line",
    "notanumber"
  ]);
  assert.equal(result.code, 1, "invalid --line number should exit 1");
  assert.ok(
    result.stderr.trim().length > 0,
    "invalid --line number should write a human-readable error to stderr"
  );
  assert.ok(
    stdoutIsClean(result.stdout),
    `invalid --line must not emit JSON to stdout (got: ${JSON.stringify(result.stdout)})`
  );
}

// --- R5.10: `call` with no tool -------------------------------------------
{
  const result = await runCli(["call"]);
  assert.equal(result.code, 1, "`call` with no tool should exit 1");
  assert.ok(
    result.stderr.trim().length > 0,
    "`call` with no tool should write a human-readable error to stderr"
  );
  assert.ok(
    stdoutIsClean(result.stdout),
    `\`call\` with no tool must not emit a JSON help blob to stdout (got: ${JSON.stringify(result.stdout)})`
  );
}

// --- R5.9: `call` with invalid JSON ---------------------------------------
{
  const result = await runCli(["call", "sometool", "{bad json"]);
  assert.equal(result.code, 1, "`call` with invalid JSON should exit 1");
  assert.match(
    result.stderr,
    /Invalid JSON for call/,
    "`call` with invalid JSON should report a human-readable error on stderr"
  );
  assert.ok(
    stdoutIsClean(result.stdout),
    `\`call\` with invalid JSON must not emit JSON to stdout (got: ${JSON.stringify(result.stdout)})`
  );
}

// ===========================================================================
// Property 4: exit-code semantics
//
// For help/version argv the exit code is 0. For a representative
// machine-readable command that cannot reach the daemon, the transport failure
// yields exit code 1.
//
// Validates: Requirements 4.1, 5.7, 11.4, 11.5
// ===========================================================================

const helpVersionArgvs: string[][] = [
  ["--help"],
  ["-h"],
  ["help"],
  ["--version"],
  ["-v"]
];

// Machine-readable commands that flow through the control plane; with an
// unreachable control URL each fails its transport step -> exit code 1.
const transportFailArgvs: string[][] = [
  ["sessions", "--control-url", UNREACHABLE_CONTROL_URL],
  ["daemon", "status", "--control-url", UNREACHABLE_CONTROL_URL],
  ["bp", "list", "--session", "s", "--control-url", UNREACHABLE_CONTROL_URL]
];

// Parse/validation error argvs (used by Property 7). These must keep stdout
// free of any JSON blob with the error text on stderr only.
const parseErrorArgvs: string[][] = [
  ["frobnicate"],
  ["tools", "--nope"],
  ["bp", "set", "--session", "x"],
  ["continue", "--thread", "notanumber"],
  ["call"]
];

// Pre-execute every distinct argv exactly once and cache the result. The
// properties then assert over generated argvs using the cached result, keeping
// the run deterministic and fast (no repeated subprocess spawns).
const cache = new Map<string, CliResult>();
const allArgvs = [...helpVersionArgvs, ...transportFailArgvs, ...parseErrorArgvs];
for (const argv of allArgvs) {
  cache.set(JSON.stringify(argv), await runCli(argv));
}

function cachedResult(argv: string[]): CliResult {
  const result = cache.get(JSON.stringify(argv));
  if (result === undefined) {
    throw new Error(`no cached result for argv: ${JSON.stringify(argv)}`);
  }
  return result;
}

await fc.assert(
  fc.property(
    fc.constantFrom(...helpVersionArgvs, ...transportFailArgvs),
    (argv) => {
      const result = cachedResult(argv);
      const isHelpVersion = helpVersionArgvs.some(
        (h) => JSON.stringify(h) === JSON.stringify(argv)
      );
      if (isHelpVersion) {
        assert.equal(
          result.code,
          0,
          `help/version (${argv.join(" ")}) should exit 0`
        );
      } else {
        assert.equal(
          result.code,
          1,
          `unreachable machine-readable command (${argv.join(" ")}) should exit 1`
        );
      }
    }
  ),
  { numRuns: 50 }
);

// ===========================================================================
// Property 7: stdout purity on help/version + parse-error paths
//
// For help/version argv, stdout carries the human-readable help/version and NOT
// a JSON help blob. For parse-error argv, stdout carries NO JSON at all and the
// error text appears on stderr only.
//
// Validates: Requirements 1.5, 4.2
// ===========================================================================

await fc.assert(
  fc.property(
    fc.constantFrom(...helpVersionArgvs, ...parseErrorArgvs),
    (argv) => {
      const result = cachedResult(argv);
      assert.ok(
        stdoutHasNoJsonBlob(result.stdout),
        `stdout for (${argv.join(" ")}) must not contain a JSON help blob (got: ${JSON.stringify(result.stdout)})`
      );

      const isParseError = parseErrorArgvs.some(
        (e) => JSON.stringify(e) === JSON.stringify(argv)
      );
      if (isParseError) {
        assert.ok(
          stdoutIsClean(result.stdout),
          `parse-error stdout for (${argv.join(" ")}) must be free of JSON (got: ${JSON.stringify(result.stdout)})`
        );
        assert.ok(
          result.stderr.trim().length > 0,
          `parse-error (${argv.join(" ")}) must write its error to stderr`
        );
      }
    }
  ),
  { numRuns: 50 }
);

console.log("cli errors e2e ok");
