/**
 * End-to-end tests for machine-readable output and localization (Task 9.3).
 *
 * Runner: node --experimental-strip-types test/cli.output.e2e.test.ts
 *
 * Each case runs the real CLI entry in a child process via
 *   node --experimental-strip-types src/cli.ts ...
 * and asserts on stdout / stderr / exit code.
 *
 * Covers Requirements:
 * - 5.1    `tools` prints the tool definitions as JSON (honoring --pretty)
 * - 5.2    `policy print` prints the resolved policy as pretty JSON
 * - 5.6    machine-readable JSON output (pretty when requested)
 * - 13.5   `--locale zh_CN` renders Simplified-Chinese help copy
 * - 13.7   yargs framework labels are localized for the active locale
 * - 13.4   an unsupported `--locale` value falls back to English, exit 0
 *
 * Plus the design's Correctness Property:
 * - Property 5  machine-readable stdout is always valid JSON: the stdout of
 *               `tools` / `policy print` / `call` (valid input) and the debug
 *               control commands always parses with JSON.parse. Control-plane
 *               commands are pointed at an unreachable URL so they
 *               deterministically emit the daemon-unreachable JSON (which is
 *               itself valid JSON) without waiting on a real daemon.
 *               Validates: Requirements 5.1, 5.2, 5.5
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
// control-plane commands fail their transport step deterministically and fast
// (no waiting on a real daemon) while still emitting valid daemon-unreachable
// JSON to stdout.
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

// ===========================================================================
// R5.1 / R5.6: `tools --pretty` is valid, pretty JSON listing the tools
// ===========================================================================

{
  const result = await runCli(["tools", "--pretty"]);

  assert.equal(result.code, 0, "`tools --pretty` should exit 0");

  // stdout is valid JSON.
  let parsed: { tools?: Array<{ name?: string }> };
  assert.doesNotThrow(() => {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  }, "`tools --pretty` stdout should be valid JSON");
  parsed = JSON.parse(result.stdout) as typeof parsed;

  // The payload is { tools: [...] } and includes the expected tool names.
  assert.ok(Array.isArray(parsed.tools), "`tools` output should have a tools array");
  const names = parsed.tools!.map((tool) => tool.name);
  assert.ok(
    names.includes("debug_attach"),
    "`tools` output should include the debug_attach tool"
  );
  assert.ok(
    names.includes("set_breakpoint"),
    "`tools` output should include the set_breakpoint tool"
  );

  // Pretty output is multi-line and indented.
  assert.ok(
    result.stdout.includes("\n"),
    "`tools --pretty` should be multi-line"
  );
  assert.ok(
    result.stdout.includes("\n  "),
    "`tools --pretty` should be indented (pretty-printed)"
  );
}

// ===========================================================================
// R5.2 / R5.6: `policy print` is valid, pretty JSON
// ===========================================================================

{
  const result = await runCli(["policy", "print"]);

  assert.equal(result.code, 0, "`policy print` should exit 0");

  assert.doesNotThrow(() => {
    JSON.parse(result.stdout);
  }, "`policy print` stdout should be valid JSON");

  // `policy print` is always pretty-printed (R5.2).
  assert.ok(
    result.stdout.includes("\n  "),
    "`policy print` should be indented (pretty-printed)"
  );
}

// ===========================================================================
// R13.5 / R13.7: `--locale zh_CN` localizes both the help copy and the yargs
// framework labels
// ===========================================================================

{
  const result = await runCli(["--help", "--locale", "zh_CN"]);

  assert.equal(result.code, 0, "`--help --locale zh_CN` should exit 0");

  // Simplified-Chinese help copy from the i18n catalog (usage tagline).
  assert.ok(
    result.stdout.includes("面向 AI 调用的多语言运行时调试器"),
    "zh_CN help should render the Simplified-Chinese usage tagline"
  );
  // A localized command description (the `tools` command).
  assert.ok(
    result.stdout.includes("以 JSON 输出可用的控制平面工具定义"),
    "zh_CN help should render localized command descriptions"
  );
  // yargs framework labels are localized: "命令：" (Commands) and "选项：" (Options).
  assert.ok(
    result.stdout.includes("命令："),
    "zh_CN help should localize the Commands label to 命令："
  );
  assert.ok(
    result.stdout.includes("选项："),
    "zh_CN help should localize the Options label to 选项："
  );
}

// ===========================================================================
// R13.4: an unsupported `--locale` value falls back to English, exit 0
// ===========================================================================

{
  const result = await runCli(["--help", "--locale", "xx"]);

  assert.equal(result.code, 0, "`--help --locale xx` should exit 0 (graceful fallback)");

  // English help copy and framework labels.
  assert.ok(
    result.stdout.includes("AI-callable multi-language runtime debugger"),
    "unsupported locale should fall back to the English usage tagline"
  );
  assert.match(
    result.stdout,
    /Commands:/,
    "unsupported locale should fall back to the English Commands label"
  );
  assert.match(
    result.stdout,
    /Options:/,
    "unsupported locale should fall back to the English Options label"
  );
  // No Simplified-Chinese leaked into the fallback output.
  assert.doesNotMatch(
    result.stdout,
    /命令：/,
    "unsupported locale must not render Simplified-Chinese labels"
  );
}

// ===========================================================================
// Property 5: machine-readable stdout is always valid JSON
//
// The stdout of `tools` / `policy print` / `call` (valid input) and the debug
// control commands always parses with JSON.parse. The local commands need no
// daemon; the control-plane commands are pointed at an unreachable URL so they
// deterministically emit the daemon-unreachable JSON (still valid JSON).
//
// Validates: Requirements 5.1, 5.2, 5.5
// ===========================================================================

// Local machine-readable commands (no daemon required).
const localArgvs: string[][] = [
  ["tools"],
  ["tools", "--pretty"],
  ["policy", "print"]
];

// Control-plane (debug control) commands + `call`; with an unreachable control
// URL each emits the daemon-unreachable JSON to stdout (valid JSON).
const controlArgvs: string[][] = [
  ["sessions", "--control-url", UNREACHABLE_CONTROL_URL],
  ["bp", "list", "--session", "s", "--control-url", UNREACHABLE_CONTROL_URL],
  ["call", "sometool", "{}", "--control-url", UNREACHABLE_CONTROL_URL],
  ["snapshot", "--session", "s", "--control-url", UNREACHABLE_CONTROL_URL]
];

const machineReadableArgvs = [...localArgvs, ...controlArgvs];

// Pre-execute every distinct argv exactly once and cache the result, then let
// the property assert over generated selections using the cached result. This
// keeps the run deterministic and fast (no repeated subprocess spawns).
const cache = new Map<string, CliResult>();
for (const argv of machineReadableArgvs) {
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
  fc.property(fc.constantFrom(...machineReadableArgvs), (argv) => {
    const result = cachedResult(argv);
    assert.doesNotThrow(
      () => JSON.parse(result.stdout),
      `stdout for (${argv.join(" ")}) must be valid JSON (got: ${JSON.stringify(result.stdout)})`
    );
  }),
  { numRuns: 50 }
);

console.log("cli output e2e ok");
