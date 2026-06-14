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

import { LocalControlGateway } from "../../control/ControlGateway.ts";
import {
  bridgeContext,
  makeInstanceId,
  removeBridgeManifestForInstance,
  writeBridgeManifest
} from "../../hub/BridgeManifest.ts";
import { startStdio } from "../../mcp/stdioServer.ts";
import { createRuntime } from "../../runtime/createRuntime.ts";
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
          }),
      async (argv) => {
        const policyPath = argv.policy as string | undefined;
        const ideBridgePort = argv["ide-bridge-port"] as number | undefined;
        const ideBridge = argv["ide-bridge"] as boolean | undefined;
        const context = bridgeContext(policyPath);
        const instanceId = makeInstanceId("mcp");
        const runtime = createRuntime({
          policyPath,
          enableIdeBridge: ideBridge !== false,
          ideBridgePort: ideBridgePort ?? 0,
          bridgeInstanceId: instanceId,
          bridgePolicyHash: context.policyHash,
          bridgeLifecycle: "stdio"
        });
        const startedAt = new Date().toISOString();
        if (runtime.ideBridge) {
          await runtime.ideBridge.start();
          const status = runtime.ideBridge.status();
          writeBridgeManifest({
            schemaVersion: 1,
            owner: "mcp",
            instanceId,
            pid: process.pid,
            lifecycle: "stdio",
            workspaceRoot: context.workspaceRoot,
            policyPath: context.policyPath,
            policyHash: context.policyHash,
            bridgeUrl: `ws://${status.host}:${status.port}`,
            startedAt,
            updatedAt: new Date().toISOString()
          });
          process.stderr.write(
            `breakpilot IDE bridge listening on ${status.host}:${status.port}\n`
          );
        }
        attachMcpCleanup({
          cleanup: async (reason) => {
            await runtime.manager.cleanupAll(reason);
            runtime.ideBridge?.stop();
            removeBridgeManifestForInstance(context.workspaceRoot, instanceId);
          }
        });
        startStdio(new LocalControlGateway(runtime.router));
      }
    );
    sub.demandCommand(1);
    return sub;
  });

  return y;
}

function attachMcpCleanup(options: { cleanup(reason: string): Promise<void> }): void {
  let cleaned = false;
  const cleanupOnce = async (reason: string): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await options.cleanup(reason).catch(() => undefined);
  };
  const cleanupAndExit = (code: number, reason: string): void => {
    void cleanupOnce(reason).finally(() => process.exit(code));
  };

  process.stdin.once("end", () => cleanupAndExit(0, "stdio_end"));
  process.stdin.once("close", () => cleanupAndExit(0, "stdio_close"));
  process.once("SIGINT", () => cleanupAndExit(130, "sigint"));
  process.once("SIGTERM", () => cleanupAndExit(143, "sigterm"));
  process.once("beforeExit", () => {
    void cleanupOnce("before_exit");
  });
}
