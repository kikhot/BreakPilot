/**
 * Daemon-related CLI commands (R8.2/R8.3).
 *
 * Registers:
 * - `serve`: starts the BreakPilot HTTP control daemon via `createRuntime` +
 *   `startHttp`. Listening information is written to **stderr** so stdout is
 *   never polluted (R5.3 keeps machine-readable channels clean).
 * - `daemon status`: fetches `${controlUrl}/status` and prints the JSON result
 *   to stdout (R5.3).
 *
 * Each command and option carries a `describe` (sourced from the i18n catalog
 * via `ctx.t`) so that local help works (R3.1).
 */

import type { Argv } from "yargs";

import { startHttp } from "../../http/controlServer.ts";
import { createRuntime } from "../../runtime/createRuntime.ts";
import type { CommandContext } from "../context.ts";
import { daemonUnreachableError } from "../context.ts";
import { getJson } from "../controlClient.ts";

const DEFAULT_HTTP_PORT = 27890;
const DEFAULT_HOST = "127.0.0.1";

/**
 * Register the `serve` and `daemon status` commands.
 *
 * @param y   The yargs instance to register on.
 * @param ctx Shared command context (provides translator, control URL, output).
 * @returns The same yargs instance for chaining.
 */
export function registerDaemonCommands(y: Argv, ctx: CommandContext): Argv {
  y.command(
    "serve",
    ctx.t("cmd.serve"),
    (b) =>
      b
        .option("http-port", {
          type: "number",
          describe: ctx.t("opt.http-port")
        })
        .option("host", {
          type: "string",
          describe: ctx.t("opt.host")
        })
        .option("ide-bridge-port", {
          type: "number",
          describe: ctx.t("opt.ide-bridge-port")
        })
        .option("ide-bridge", {
          type: "boolean",
          describe: ctx.t("opt.ide-bridge")
        })
        .option("policy", {
          type: "string",
          describe: ctx.t("opt.policy")
        }),
    (argv) => {
      const policyPath = argv.policy as string | undefined;
      const ideBridgePort = argv["ide-bridge-port"] as number | undefined;
      const ideBridge = argv["ide-bridge"] as boolean | undefined;
      const runtime = createRuntime({
        policyPath,
        enableIdeBridge: Boolean(ideBridgePort || ideBridge),
        ideBridgePort
      });
      const port = (argv["http-port"] as number | undefined) ?? DEFAULT_HTTP_PORT;
      const host = (argv.host as string | undefined) || DEFAULT_HOST;
      startHttp(runtime.router, port, host);
      process.stderr.write(`breakpilot HTTP listening on ${host}:${port}\n`);
      if (runtime.ideBridge) {
        const status = runtime.ideBridge.status();
        process.stderr.write(`breakpilot IDE bridge listening on ${status.host}:${status.port}\n`);
      }
    }
  );

  y.command("daemon", ctx.t("cmd.daemon"), (sub) => {
    sub.command(
      "status",
      ctx.t("cmd.daemon status"),
      (b) => b,
      async (argv) => {
        // On success, print the status JSON to stdout honoring --pretty (R5.3).
        // On transport failure, emit the same daemon-unreachable JSON shape that
        // ctx.runTool produces (to stdout, pretty) and exit 1 (R5.8) instead of
        // letting the rejection be swallowed with no output.
        try {
          const status = await getJson(`${ctx.controlUrl}/status`);
          ctx.output(status, Boolean(argv.pretty));
        } catch (error) {
          const typedError = error as Error;
          ctx.output(daemonUnreachableError(ctx.controlUrl, typedError.message), true);
          process.exitCode = 1;
        }
      }
    );
    sub.demandCommand(1);
    return sub;
  });

  return y;
}
