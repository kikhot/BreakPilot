/**
 * IDE bridge CLI commands (R5.5, R12.1, R8.2/R8.3).
 *
 * Registers a top-level `ide` command with the subcommands `status`,
 * `sessions`, `adopt`, and `context`. The parent uses `demandCommand(1)` so
 * that invoking `ide` without a subcommand fails via the unified `.fail()`
 * handler (exit code 1).
 *
 * Each handler maps the typed yargs argv to a control-plane tool argument
 * object that is DEEPLY EQUAL to the legacy `toolFromCommand` output (the PBT
 * oracle, Property 2 / task 8.1). To preserve exact equivalence:
 * - string flags pass through as `string | undefined` (no defaulting),
 * - number flags are declared `type: "number"` (so yargs validates invalid
 *   numbers via the fail handler, R4.4) and wrapped with `parseNumber` so the
 *   resulting value matches the oracle exactly,
 * - `ide status` produces an empty `{}` argument object (no options).
 *
 * Each command and option carries a `describe` (sourced from the i18n catalog
 * via `ctx.t`) so that local help works (R3.1).
 */

import type { Argv } from "yargs";

import type { CommandContext } from "../context.ts";
import { parseNumber } from "../flags.ts";

/**
 * Register the IDE bridge commands.
 *
 * @param y   The yargs instance to register on.
 * @param ctx Shared command context (provides translator, output, runTool).
 * @returns The same yargs instance for chaining.
 */
export function registerIdeCommands(y: Argv, ctx: CommandContext): Argv {
  y.command("ide", ctx.t("cmd.ide"), (sub) => {
    // status -> ide_status (no options, empty args)
    sub.command(
      "status",
      ctx.t("cmd.ide status"),
      (b) => b,
      (argv) => ctx.runTool("ide_status", {}, Boolean(argv.pretty))
    );

    // sessions -> list_ide_sessions
    sub.command(
      "sessions",
      ctx.t("cmd.ide sessions"),
      (b) =>
        b
          .option("client", { type: "string", describe: ctx.t("opt.client") })
          .option("workspace", { type: "string", describe: ctx.t("opt.workspace") }),
      (argv) =>
        ctx.runTool(
          "list_ide_sessions",
          {
            clientId: argv.client as string | undefined,
            workspace: argv.workspace as string | undefined
          },
          Boolean(argv.pretty)
        )
    );

    // adopt -> adopt_ide_session
    sub.command(
      "adopt",
      ctx.t("cmd.ide adopt"),
      (b) =>
        b
          .option("client", { type: "string", describe: ctx.t("opt.client") })
          .option("ide-session", { type: "string", describe: ctx.t("opt.ide-session") })
          .option("workspace", { type: "string", describe: ctx.t("opt.workspace") })
          .option("lang", { type: "string", describe: ctx.t("opt.lang") })
          .option("mode", { type: "string", describe: ctx.t("opt.mode") })
          .option("owner", { type: "string", describe: ctx.t("opt.owner") }),
      (argv) =>
        ctx.runTool(
          "adopt_ide_session",
          {
            clientId: argv.client as string | undefined,
            ideSessionId: argv["ide-session"] as string | undefined,
            workspace: argv.workspace as string | undefined,
            lang: argv.lang as string | undefined,
            mode: argv.mode as string | undefined,
            owner: argv.owner as string | undefined
          },
          Boolean(argv.pretty)
        )
    );

    // context -> get_active_breakpoint_context
    sub.command(
      "context",
      ctx.t("cmd.ide context"),
      (b) =>
        b
          .option("session", { type: "string", describe: ctx.t("opt.session") })
          .option("client", { type: "string", describe: ctx.t("opt.client") })
          .option("ide-session", { type: "string", describe: ctx.t("opt.ide-session") })
          .option("workspace", { type: "string", describe: ctx.t("opt.workspace") })
          .option("timeout", { type: "number", describe: ctx.t("opt.timeout") })
          .option("frame", { type: "number", describe: ctx.t("opt.frame") })
          .option("profile", { type: "string", describe: ctx.t("opt.profile") })
          .option("objects", { type: "string", describe: ctx.t("opt.objects") })
          .option("depth", { type: "number", describe: ctx.t("opt.depth") })
          .option("max-items", { type: "number", describe: ctx.t("opt.max-items") })
          .option("max-string-length", { type: "number", describe: ctx.t("opt.max-string-length") }),
      (argv) =>
        ctx.runTool(
          "get_active_breakpoint_context",
          {
            sessionId: argv.session as string | undefined,
            clientId: argv.client as string | undefined,
            ideSessionId: argv["ide-session"] as string | undefined,
            workspace: argv.workspace as string | undefined,
            timeoutMs: parseNumber(argv.timeout as number | undefined),
            frameIndex: parseNumber(argv.frame as number | undefined),
            profile: argv.profile as string | undefined,
            objectFields: argv.objects as string | undefined,
            maxDepth: parseNumber(argv.depth as number | undefined),
            maxItems: parseNumber(argv["max-items"] as number | undefined),
            maxStringLength: parseNumber(argv["max-string-length"] as number | undefined)
          },
          Boolean(argv.pretty)
        )
    );

    sub.demandCommand(1);
    return sub;
  });

  return y;
}
