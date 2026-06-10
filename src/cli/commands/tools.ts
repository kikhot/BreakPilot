/**
 * Tools / policy / call CLI commands (R8.2/R8.3).
 *
 * Registers:
 * - `tools`: prints the available control-plane tool definitions as JSON
 *   (`{ tools: toolDefinitions }`), honoring `--pretty` (R5.1/R5.6).
 * - `policy print`: prints the resolved policy via `loadPolicy(--policy)`. This
 *   command is ALWAYS pretty-printed, matching the pre-refactor behavior
 *   (R5.2/R5.6).
 * - `call <tool> [json]`: invokes a control-plane tool directly. `<tool>` is a
 *   required positional (yargs fails with exit code 1 when missing, R5.10). The
 *   optional `[json]` positional is validated with `safeJsonParse`; invalid JSON
 *   writes a human-readable error to stderr and exits 1 without throwing
 *   (R5.9), while valid JSON (or no JSON) is forwarded via `ctx.runTool` (R5.4).
 *
 * Each command and option carries a `describe` (sourced from the i18n catalog
 * via `ctx.t`) so that local help works (R3.1).
 */

import type { Argv } from "yargs";

import { toolDefinitions } from "../../control/toolDefinitions.ts";
import { loadPolicy } from "../../security/PolicyLoader.ts";
import type { AnyRecord } from "../../types/json.ts";
import { safeJsonParse } from "../../utils/json.ts";
import type { CommandContext } from "../context.ts";

/**
 * Register the `tools`, `policy print`, and `call` commands.
 *
 * @param y   The yargs instance to register on.
 * @param ctx Shared command context (provides translator, output, runTool).
 * @returns The same yargs instance for chaining.
 */
export function registerToolsCommands(y: Argv, ctx: CommandContext): Argv {
  y.command(
    "tools",
    ctx.t("cmd.tools"),
    (b) => b,
    (argv) => {
      ctx.output({ tools: toolDefinitions }, Boolean(argv.pretty));
    }
  );

  y.command("policy", ctx.t("cmd.policy"), (sub) => {
    sub.command(
      "print",
      ctx.t("cmd.policy print"),
      (b) => b,
      (argv) => {
        // Always pretty-print, preserving the pre-refactor behavior (R5.2/R5.6).
        ctx.output(loadPolicy(argv.policy as string | undefined), true);
      }
    );
    sub.demandCommand(1);
    return sub;
  });

  y.command(
    "call <tool> [json]",
    ctx.t("cmd.call"),
    (b) =>
      b
        .positional("tool", { type: "string" })
        .positional("json", { type: "string" }),
    (argv) => {
      let args: AnyRecord = {};
      if (argv.json !== undefined) {
        const parsed = safeJsonParse<AnyRecord>(String(argv.json));
        if (parsed === undefined) {
          // Invalid JSON: human-readable error to stderr, exit 1, no throw (R5.9).
          process.stderr.write(`Invalid JSON for call: ${String(argv.json)}\n`);
          process.exitCode = 1;
          return;
        }
        args = parsed;
      }
      return ctx.runTool(String(argv.tool), args, Boolean(argv.pretty));
    }
  );

  return y;
}
