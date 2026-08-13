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

import { DaemonControlGateway } from "../../control/ControlGateway.ts";
import { DEFAULT_HUB_HOST, DEFAULT_HUB_PORT, startHub, type HubServerHandle } from "../../hub/HubServer.ts";
import { startStdio } from "../../mcp/stdioServer.ts";
import { loadPolicy } from "../../security/PolicyLoader.ts";
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
        const policy = loadPolicy(policyPath);
        const hub = await ensureHub(policy.workspace.root);
        const gateway = new DaemonControlGateway(hub.url);
        const stdio = startStdio(gateway);
        attachMcpCleanup({
          cleanup: () => closeMcpResources(stdio, hub)
        });
      }
    );
    sub.demandCommand(1);
    return sub;
  });

  return y;
}

export async function closeMcpResources(
  stdio: Pick<ReturnType<typeof startStdio>, "close">,
  hub: { owned: boolean; handle?: Pick<HubServerHandle, "close"> }
): Promise<void> {
  await stdio.close().catch(() => undefined);
  if (hub.owned) await hub.handle?.close().catch(() => undefined);
}

async function ensureHub(defaultProjectPath: string): Promise<{ url: string; owned: boolean; handle?: HubServerHandle }> {
  const url = `http://${DEFAULT_HUB_HOST}:${DEFAULT_HUB_PORT}`;
  if (await isHealthyHub(url)) return { url, owned: false };
  const handle = await startHub({
    host: DEFAULT_HUB_HOST,
    port: DEFAULT_HUB_PORT,
    defaultProjectPath,
    idleTimeoutMs: 0
  });
  process.stderr.write(`breakpilot hub listening on ${handle.url}\n`);
  return { url: handle.url, owned: true, handle };
}

async function isHealthyHub(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/status`);
    if (!response.ok) return false;
    const payload = await response.json() as { server?: string };
    return payload.server === "breakpilot-hub";
  } catch {
    return false;
  }
}

function attachMcpCleanup(options: { cleanup(reason: string): Promise<void> }): void {
  let cleanupPromise: Promise<void> | undefined;
  const cleanupOnce = (reason: string): Promise<void> => {
    cleanupPromise ??= options.cleanup(reason).catch(() => undefined);
    return cleanupPromise;
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
