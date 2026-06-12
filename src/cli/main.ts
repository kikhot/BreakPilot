/**
 * BreakPilot CLI entry orchestration.
 *
 * `runCli` wires the yargs-based command framework together (R8/R9.3):
 *   resolveLocale -> createTranslator -> resolveControlUrl -> createContext ->
 *   buildProgram -> parseAsync.
 *
 * Parse/validation errors are handled by the program's `.fail()` handler
 * (stderr + exit code 1, no JSON help blob); `runCli` does not perform any
 * hand-written command dispatch. The `output()` JSON helper is kept and
 * exported here because it is reused by `context.ts` and the command modules.
 */

import { stableJson } from "../utils/json.ts";
import { createContext, resolveControlUrl } from "./context.ts";
import { createTranslator, resolveLocale } from "./i18n.ts";
import { buildProgram } from "./program.ts";
import { getVersion } from "./version.ts";

/**
 * Write a value to stdout as (optionally pretty) JSON followed by a newline.
 * Reused by the command context and command modules for machine-readable
 * output; behavior is unchanged from the pre-yargs implementation.
 */
export function output(value: unknown, pretty = false): void {
  process.stdout.write(`${stableJson(value, pretty)}\n`);
}

/**
 * Scan argv for the `--control-url` flag, mirroring how `resolveLocale` scans
 * for `--locale`. Supports both `--control-url <value>` and
 * `--control-url=<value>`. Returns `undefined` when the flag is absent so that
 * `resolveControlUrl` can apply the env var / default precedence (R6).
 *
 * This lightweight scan runs before the yargs program is built so the resolved
 * control URL can be baked into the command context.
 */
function scanControlUrl(argv: string[]): string | undefined {
  if (!Array.isArray(argv)) return undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string") continue;
    if (token === "--control-url") {
      const next = argv[i + 1];
      if (typeof next === "string" && !next.startsWith("--")) return next;
      continue;
    }
    if (token.startsWith("--control-url=")) {
      return token.slice("--control-url=".length);
    }
  }
  return undefined;
}

function scanStringOption(argv: string[], name: string): string | undefined {
  if (!Array.isArray(argv)) return undefined;
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string") continue;
    if (token === `--${name}`) {
      const next = argv[i + 1];
      if (typeof next === "string" && !next.startsWith("--")) return next;
      continue;
    }
    if (token.startsWith(prefix)) return token.slice(prefix.length);
  }
  return undefined;
}

/**
 * Build and run the yargs CLI program.
 *
 * The effective locale must be resolved before building the program because
 * command/option descriptions are static strings written at construction time.
 *
 * Behavior:
 * - Bare invocation (no args) prints the global help to stdout and exits 0
 *   (R1.2); this is delegated to yargs by parsing `--help`.
 * - Parse/validation failures are reported by the program's `.fail()` handler
 *   (stderr + exit code 1) which then throws to abort the parse before any
 *   command handler runs. `runCli` catches and swallows that already-reported
 *   failure so nothing is written to stdout (R4.2/R9.3); the exit code is
 *   already set to 1.
 */
export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const locale = resolveLocale(argv);
  const t = createTranslator(locale);
  const controlUrlFlag = scanControlUrl(argv);
  const controlUrl = resolveControlUrl(controlUrlFlag, process.env);
  const policyPath = scanStringOption(argv, "policy");
  const ctx = createContext({
    controlUrl,
    t,
    locale,
    policyPath,
    controlUrlExplicit: Boolean(controlUrlFlag || process.env.BREAKPILOT_CONTROL_URL)
  });
  const program = buildProgram(ctx, getVersion());

  // Bare invocation: show global help on stdout and exit 0 (R1.2). yargs renders
  // the help itself when `--help` is parsed, keeping stdout free of any JSON.
  const effectiveArgv = argv.length === 0 ? ["--help"] : argv;

  try {
    await program.parseAsync(effectiveArgv);
  } catch {
    // The `.fail()` handler already wrote a human-readable error to stderr and
    // set process.exitCode = 1, then threw to prevent the matched command
    // handler from running (and polluting stdout with JSON). Swallow here: do
    // NOT write anything to stdout. Ensure the failure exit code is set.
    if (!process.exitCode) process.exitCode = 1;
  }
}
