/**
 * End-to-end tests for help, version and per-command help (Task 9.1).
 *
 * Runner: node --experimental-strip-types test/cli.help.e2e.test.ts
 *
 * Each case runs the real CLI entry in a child process via
 *   node --experimental-strip-types src/cli.ts ...
 * and asserts on stdout / stderr / exit code.
 *
 * Covers Requirements:
 * - 1.1 / 1.3        global help (--help / -h / help) on stdout, exit 0
 * - 2.1              version (--version / -v) equals package.json.version, exit 0
 * - 3.1 / 3.2        per-command help (bp set --help) lists its options
 * - 3.3              `mcp serve --help` prints help only, never starts stdio
 *
 * Note: Requirement 1.2 (bare `breakpilot` with no args shows global help) is
 * NOT asserted here because the current program prints nothing and exits 0 for
 * the no-args case. This gap is reported separately for the implementation.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

const packageVersion = (
  JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    version: string;
  }
).version;

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run the CLI in a child process and resolve with its captured output.
 *
 * A timeout guard ensures a command that fails to terminate (for example, a
 * `mcp serve` that wrongly started the stdio server) is killed and surfaced as
 * a test failure rather than hanging the whole suite.
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

// ---------------------------------------------------------------------------
// Requirement 1: global help (--help / -h / help)
// ---------------------------------------------------------------------------

for (const helpArgs of [["--help"], ["-h"], ["help"]]) {
  const label = helpArgs.join(" ");
  const result = await runCli(helpArgs);

  assert.equal(result.code, 0, `global help (${label}) should exit 0`);

  // Usage section: yargs prints the script-name usage banner.
  assert.match(
    result.stdout,
    /breakpilot <command> \[options\]/,
    `global help (${label}) should show the usage banner`
  );
  // Commands section heading.
  assert.match(
    result.stdout,
    /Commands:/,
    `global help (${label}) should show a Commands section`
  );
  // Core commands are listed (Requirement 1.3).
  assert.match(
    result.stdout,
    /\bmcp\b/,
    `global help (${label}) should list the mcp command`
  );
  assert.match(
    result.stdout,
    /\bserve\b/,
    `global help (${label}) should list the serve command`
  );
  assert.match(
    result.stdout,
    /\btools\b/,
    `global help (${label}) should list the tools command`
  );
  // `mcp serve` is referenced (epilog example), per Requirement 1.3.
  assert.ok(
    result.stdout.includes("mcp serve"),
    `global help (${label}) should reference "mcp serve"`
  );
  // No JSON help blob is emitted (Requirement 1.5).
  assert.doesNotMatch(
    result.stdout,
    /"ok"\s*:/,
    `global help (${label}) must not emit a JSON help blob`
  );
}

// ---------------------------------------------------------------------------
// Requirement 2: version (--version / -v)
// ---------------------------------------------------------------------------

for (const versionArgs of [["--version"], ["-v"]]) {
  const label = versionArgs.join(" ");
  const result = await runCli(versionArgs);

  assert.equal(result.code, 0, `version (${label}) should exit 0`);
  assert.equal(
    result.stdout.trim(),
    packageVersion,
    `version (${label}) should equal package.json version`
  );
  // No JSON wrapper around the version (Requirement 2.2).
  assert.doesNotMatch(
    result.stdout,
    /[{}]/,
    `version (${label}) should not be wrapped in JSON`
  );
}

// ---------------------------------------------------------------------------
// Requirement 3.1 / 3.2: per-command help for `bp set`
// ---------------------------------------------------------------------------

{
  const result = await runCli(["bp", "set", "--help"]);

  assert.equal(result.code, 0, "`bp set --help` should exit 0");
  assert.match(
    result.stdout,
    /--session\b/,
    "`bp set --help` should list --session"
  );
  assert.match(result.stdout, /--file\b/, "`bp set --help` should list --file");
  assert.match(result.stdout, /--line\b/, "`bp set --help` should list --line");
}

// ---------------------------------------------------------------------------
// Requirement 3.1 / 3.3: `mcp serve --help` shows help, never starts stdio
// ---------------------------------------------------------------------------

{
  // A generous-but-bounded timeout: --help short-circuits, so this must return
  // immediately. If the stdio MCP server wrongly started, runCli would time out
  // and reject, failing the test.
  const result = await runCli(["mcp", "serve", "--help"], 8000);

  assert.equal(result.code, 0, "`mcp serve --help` should exit 0");
  assert.ok(
    result.stdout.includes("mcp serve"),
    "`mcp serve --help` should print the mcp serve help header"
  );
  // The stdio MCP server must not have started: stdout must carry no JSON-RPC
  // protocol traffic.
  assert.doesNotMatch(
    result.stdout,
    /"jsonrpc"/,
    "`mcp serve --help` must not emit MCP protocol traffic"
  );
}

console.log("cli help e2e ok");
