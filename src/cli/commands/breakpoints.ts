/**
 * Breakpoint CLI commands (R7.1/R7.2, R4.3, R3.2, R8.2/R8.3, R5.5, R12.1).
 *
 * Registers a top-level `breakpoint` command with `aliases: ["bp"]` so that
 * both `breakpoint set` and `bp set` work identically (R7.1/R7.2). The parent
 * command exposes `set`, `remove`, and `list` subcommands and uses
 * `demandCommand(1)` so that invoking `bp`/`breakpoint` without a subcommand
 * fails via the unified `.fail()` handler (exit code 1).
 *
 * Each handler maps the typed yargs argv to a control-plane tool argument
 * object that is DEEPLY EQUAL to the `toolFromCommand` output (the PBT
 * oracle, Property 2 / task 8.1). To preserve exact equivalence:
 * - string flags pass through as `string | undefined` (no defaulting),
 * - `--line` / `--column` are declared `type: "number"` (so yargs validates
 *   invalid numbers via the fail handler, R4.4) and wrapped with `parseNumber`,
 * - `--require-verified` is coerced with `Boolean(...)`.
 *
 * `set` uses `.demandOption(["session", "file", "line"])` so that missing
 * required options fail with exit code 1 (R4.3), and local help
 * (`bp set --help`) lists `--session`/`--file`/`--line` (R3.2).
 *
 * Each command and option carries a `describe` (sourced from the i18n catalog
 * via `ctx.t`) so that local help works (R3.1).
 */

import type { Argv } from "yargs";

import type { CommandContext } from "../context.ts";
import { parseNumber } from "../flags.ts";

/**
 * Register the breakpoint commands.
 *
 * @param y   The yargs instance to register on.
 * @param ctx Shared command context (provides translator, output, runTool).
 * @returns The same yargs instance for chaining.
 */
export function registerBreakpointCommands(y: Argv, ctx: CommandContext): Argv {
  y.command(["breakpoint", "bp"], ctx.t("cmd.breakpoint"), (sub) => {
    // set -> bp_debug_set_breakpoint
    sub.command(
      "set",
      ctx.t("cmd.breakpoint set"),
      (b) =>
        b
          .option("session", { type: "string", describe: ctx.t("opt.session") })
          .option("workspace", { type: "string", describe: ctx.t("opt.workspace") })
          .option("client", { type: "string", describe: ctx.t("opt.client") })
          .option("ide", { type: "string", choices: ["vscode", "idea"] as const, describe: ctx.t("opt.ide") })
          .option("file", { type: "string", describe: ctx.t("opt.file") })
          .option("line", { type: "number", describe: ctx.t("opt.line") })
          .option("column", { type: "number", describe: ctx.t("opt.column") })
          .option("condition", { type: "string", describe: ctx.t("opt.condition") })
          .option("hit-condition", { type: "string", describe: ctx.t("opt.hit-condition") })
          .option("log-message", { type: "string", describe: ctx.t("opt.log-message") })
          .option("require-verified", { type: "boolean", describe: ctx.t("opt.require-verified") })
          .demandOption(["file", "line"]),
      (argv) =>
        ctx.runTool(
          "bp_debug_set_breakpoint",
          {
            sessionId: argv.session as string | undefined,
            projectPath: argv.workspace as string | undefined,
            clientId: argv.client as string | undefined,
            ide: argv.ide as string | undefined,
            filePath: argv.file as string | undefined,
            line: parseNumber(argv.line as number | undefined),
            column: parseNumber(argv.column as number | undefined),
            condition: argv.condition as string | undefined,
            hitCondition: argv["hit-condition"] as string | undefined,
            logMessage: argv["log-message"] as string | undefined,
            requireVerified: Boolean(argv["require-verified"])
          },
          Boolean(argv.pretty)
        )
    );

    // remove -> bp_debug_remove_breakpoint
    sub.command(
      "remove",
      ctx.t("cmd.breakpoint remove"),
      (b) =>
        b
          .option("session", { type: "string", describe: ctx.t("opt.session") })
          .option("workspace", { type: "string", describe: ctx.t("opt.workspace") })
          .option("client", { type: "string", describe: ctx.t("opt.client") })
          .option("ide", { type: "string", choices: ["vscode", "idea"] as const, describe: ctx.t("opt.ide") })
          .option("id", { type: "string", describe: ctx.t("opt.id") })
          .option("file", { type: "string", describe: ctx.t("opt.file") })
          .option("line", { type: "number", describe: ctx.t("opt.line") }),
      (argv) =>
        ctx.runTool(
          "bp_debug_remove_breakpoint",
          {
            sessionId: argv.session as string | undefined,
            projectPath: argv.workspace as string | undefined,
            clientId: argv.client as string | undefined,
            ide: argv.ide as string | undefined,
            breakpointId: argv.id as string | undefined,
            filePath: argv.file as string | undefined,
            line: parseNumber(argv.line as number | undefined)
          },
          Boolean(argv.pretty)
        )
    );

    // list -> bp_debug_list_breakpoints
    sub.command(
      "list",
      ctx.t("cmd.breakpoint list"),
      (b) => b
        .option("session", { type: "string", describe: ctx.t("opt.session") })
        .option("workspace", { type: "string", describe: ctx.t("opt.workspace") })
        .option("client", { type: "string", describe: ctx.t("opt.client") })
        .option("ide", { type: "string", choices: ["vscode", "idea"] as const, describe: ctx.t("opt.ide") })
        .option("file", { type: "string", describe: ctx.t("opt.file") }),
      (argv) =>
        ctx.runTool(
          "bp_debug_list_breakpoints",
          {
            sessionId: argv.session as string | undefined,
            projectPath: argv.workspace as string | undefined,
            clientId: argv.client as string | undefined,
            ide: argv.ide as string | undefined,
            filePath: argv.file as string | undefined
          },
          Boolean(argv.pretty)
        )
    );

    sub.demandCommand(1);
    return sub;
  });

  return y;
}
