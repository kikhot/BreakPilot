/**
 * yargs program builder for the BreakPilot CLI (R8.1).
 *
 * `buildProgram` centralizes the yargs configuration: `scriptName`, `usage`,
 * locale, help/version (with `h`/`v` aliases), epilog, strict parsing,
 * `exitProcess(false)`, and `showHelpOnFail(false)`. It also declares the
 * global options that every command must accept under `.strict()`
 * (`--control-url`, `--pretty`, `--policy`, `--locale`) and reserves the
 * registration call sites for the per-domain command modules.
 *
 * Notes:
 * - `--locale` is declared as a free-form string WITHOUT `choices` so that an
 *   unsupported value falls back to English via `resolveLocale` instead of
 *   triggering a parse error (R13.4). The option exists here only for help
 *   documentation and to satisfy `.strict()`; the effective locale is resolved
 *   earlier, before the program is built.
 * - The `.fail()` handler is wired here via {@link failHandler}; the `runCli`
 *   orchestration lives in `main.ts`.
 */

import yargs from "yargs";
import type { Argv } from "yargs";

import { registerBreakpointCommands } from "./commands/breakpoints.ts";
import { registerDaemonCommands } from "./commands/daemon.ts";
import { registerDebugCommands } from "./commands/debug.ts";
import { registerIdeCommands } from "./commands/ide.ts";
import { registerMcpCommands } from "./commands/mcp.ts";
import { registerToolsCommands } from "./commands/tools.ts";
import type { CommandContext } from "./context.ts";
import { SUPPORTED_LOCALES } from "./i18n.ts";

/**
 * Unified yargs failure handler (R4.1/R4.2/R4.3/R4.4/R9.3).
 *
 * Invoked by yargs when argument parsing or validation fails (unknown command,
 * unknown option under `.strict()`, missing required option, invalid number,
 * etc.). It:
 * - writes a single human-readable error line to **stderr** (using `msg`, or
 *   the thrown error's message when `msg` is null) — never a JSON help blob to
 *   stdout (R4.1/R4.2/R4.3/R4.4),
 * - sets `process.exitCode = 1`,
 * - **re-throws** so that `parseAsync` rejects. This is critical: under
 *   `exitProcess(false)` yargs would otherwise continue and invoke the matched
 *   command handler, which could emit machine-readable JSON to stdout and
 *   violate R4.2 (no JSON on stdout for failures). Throwing aborts the parse
 *   before any handler runs; `runCli` catches and swallows the already-reported
 *   failure so nothing is written to stdout (R9.3).
 * - does NOT call `process.exit`; the exit code is handled uniformly upstream.
 *
 * Help/version requests do not flow through `.fail()`, so this throw never
 * affects the `--help`/`--version` paths.
 *
 * @param msg The yargs-provided error message (may be null when `err` is set).
 * @param err The underlying error, when yargs surfaces one.
 * @param _y  The yargs instance (unused; help is intentionally not printed).
 */
export function failHandler(msg: string | null, err: Error | undefined, _y: Argv): never {
  const message = msg ?? err?.message ?? "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw err ?? new Error(message);
}

/**
 * Global yargs `.check()` that rejects invalid numeric option values (R4.4).
 *
 * yargs v18 coerces a non-numeric value supplied to a `type: "number"` option
 * into `NaN` rather than failing the parse. Left unchecked, the command handler
 * would still run (with the value silently dropped), bypassing the strict
 * validation contract. This check scans the parsed argv for any `NaN` number
 * (including inside arrays) and throws a human-readable error, which yargs
 * routes through `.fail()` (stderr + exit code 1, no stdout JSON). Valid
 * numbers and non-number options pass through untouched.
 *
 * @param argv The parsed yargs argv.
 * @returns `true` when all numeric options are valid.
 * @throws Error naming the offending option when a NaN is detected.
 */
export function checkNumericOptions(argv: Record<string, unknown>): true {
  for (const [key, value] of Object.entries(argv)) {
    if (key === "_" || key === "$0") continue;
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (typeof candidate === "number" && Number.isNaN(candidate)) {
        throw new Error(`Invalid numeric value for option --${key}`);
      }
    }
  }
  return true;
}

/**
 * Build the yargs program for the BreakPilot CLI.
 *
 * @param ctx     Shared command context (provides the translator and locale).
 * @param version Version string used by `.version()` (from `getVersion()`).
 * @returns The configured yargs instance, ready for `parseAsync`.
 */
export function buildProgram(ctx: CommandContext, version: string): Argv {
  const y = yargs()
    .scriptName("breakpilot")
    .usage(ctx.t("usage"))
    .locale(ctx.locale) // en_US / zh_CN are passed straight to yargs (R13.2/R13.7)
    .help("help")
    .alias("h", "help") // R1.1
    .version("version", version)
    .alias("v", "version") // R2.1
    .epilog(ctx.t("epilog")) // R1.4
    .strict() // R4.5
    .exitProcess(false) // R4.6
    .showHelpOnFail(false) // do not dump help to stdout on failure (R4.2)
    .fail(failHandler) // R4.1/R4.3/R4.4: human-readable error to stderr, exit code 1
    // Global numeric validation (R4.4): yargs v18 coerces a non-numeric value
    // for a `type: "number"` option to NaN instead of failing. Scan the parsed
    // argv for any NaN produced by such coercion and route it through `.fail()`
    // (which writes a human-readable error to stderr and aborts before any
    // handler runs). Valid numbers are unaffected.
    .check(checkNumericOptions)
    // Global options: declared so they are accepted by every command under
    // `.strict()` and documented in help output.
    .option("control-url", {
      type: "string",
      describe: ctx.t("opt.control-url")
    })
    .option("pretty", {
      type: "boolean",
      default: false,
      describe: ctx.t("opt.pretty")
    })
    .option("policy", {
      type: "string",
      describe: ctx.t("opt.policy")
    })
    .option("locale", {
      // Free-form string (no `choices`): unsupported values fall back to
      // English via resolveLocale rather than erroring (R13.4). The supported
      // values are surfaced in the description for documentation only.
      type: "string",
      describe: `${ctx.t("opt.locale")} [${SUPPORTED_LOCALES.join(", ")}]`
    });

  registerDaemonCommands(y, ctx);
  registerMcpCommands(y, ctx);
  registerToolsCommands(y, ctx);
  registerDebugCommands(y, ctx);
  registerBreakpointCommands(y, ctx);
  registerIdeCommands(y, ctx);

  return y;
}
