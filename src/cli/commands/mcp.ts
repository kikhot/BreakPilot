/**
 * MCP (Model Context Protocol) CLI commands (R8.2/R8.3/R9).
 *
 * Registers:
 * - `mcp serve`: starts the stdio MCP server via `createRuntime` + `startStdio`.
 *   stdout carries ONLY MCP protocol traffic (R9.1); any diagnostic info (such
 *   as the IDE bridge listening notice) is written to **stderr** (R9.2).
 *
 * Because yargs `.help()` short-circuits before the handler runs,
 * `mcp serve --help` prints help and never invokes the handler, so `startStdio`
 * is never called (R3.3). No work that could start the stdio server is done at
 * builder time.
 *
 * Each command and option carries a `describe` (sourced from the i18n catalog
 * via `ctx.t`) so that local help works (R3.1).
 */

import type { Argv } from "yargs";

import { DaemonControlGateway, LocalControlGateway } from "../../control/ControlGateway.ts";
import { ensureDaemon } from "../../hub/HubManifest.ts";
import { startStdio } from "../../mcp/stdioServer.ts";
import { createRuntime } from "../../runtime/createRuntime.ts";
import { makeId } from "../../utils/ids.ts";
import type { CommandContext } from "../context.ts";

/**
 * Register the `mcp` parent command and its `serve` subcommand.
 *
 * @param y   The yargs instance to register on.
 * @param ctx Shared command context (provides translator).
 * @returns The same yargs instance for chaining.
 */
export function registerMcpCommands(y: Argv, ctx: CommandContext): Argv {
  y.command("mcp", ctx.t("cmd.mcp"), (sub) => {
    sub.command(
      "serve",
      ctx.t("cmd.mcp serve"),
      (b) =>
        b
          .option("policy", {
            type: "string",
            describe: ctx.t("opt.policy")
          })
          .option("ide-bridge-port", {
            type: "number",
            describe: ctx.t("opt.ide-bridge-port")
          })
          .option("ide-bridge", {
            type: "boolean",
            describe: ctx.t("opt.ide-bridge")
          })
          .option("runtime", {
            type: "string",
            choices: ["auto", "daemon", "standalone"],
            default: "auto",
            describe: ctx.t("opt.runtime")
          })
          .option("ensure-daemon", {
            type: "boolean",
            default: true,
            describe: ctx.t("opt.ensure-daemon")
          }),
      async (argv) => {
        const policyPath = argv.policy as string | undefined;
        const runtimeMode = String(argv.runtime ?? "auto");
        const ideBridgePort = argv["ide-bridge-port"] as number | undefined;
        const ideBridge = argv["ide-bridge"] as boolean | undefined;
        if (runtimeMode !== "standalone") {
          if (ideBridgePort || ideBridge) {
            process.stderr.write(
              "breakpilot mcp serve ignores --ide-bridge options outside --runtime standalone; using daemon hub.\n"
            );
          }
          const ensure = runtimeMode === "auto" && argv["ensure-daemon"] !== false;
          const manifest = await ensureDaemon({
            policyPath,
            controlUrl: ctx.controlUrlExplicit ? ctx.controlUrl : undefined,
            ensure,
            lifecycle: "managed"
          });
          const gateway = new DaemonControlGateway(manifest.controlUrl, manifest.controlToken);
          await attachMcpClientLease(gateway);
          startStdio(gateway);
          return;
        }
        const runtime = createRuntime({
          policyPath,
          enableIdeBridge: Boolean(ideBridgePort || ideBridge),
          ideBridgePort
        });
        if (runtime.ideBridge) {
          await runtime.ideBridge.start();
          const status = runtime.ideBridge.status();
          process.stderr.write(
            `breakpilot IDE bridge listening on ${status.host}:${status.port}\n`
          );
        }
        startStdio(new LocalControlGateway(runtime.router));
      }
    );
    sub.demandCommand(1);
    return sub;
  });

  return y;
}

async function attachMcpClientLease(gateway: DaemonControlGateway): Promise<void> {
  const clientId = makeId("mcp");
  await gateway.acquireClient(clientId, "mcp");
  const heartbeat = setInterval(() => {
    void gateway.heartbeatClient(clientId).catch(() => undefined);
  }, 5000);
  heartbeat.unref?.();

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    await gateway.releaseClient(clientId).catch(() => undefined);
  };
  const releaseAndExit = (code: number): void => {
    void release().finally(() => process.exit(code));
  };

  process.stdin.once("end", () => releaseAndExit(0));
  process.stdin.once("close", () => releaseAndExit(0));
  process.once("SIGINT", () => releaseAndExit(130));
  process.once("SIGTERM", () => releaseAndExit(143));
  process.once("beforeExit", () => {
    void release();
  });
}
