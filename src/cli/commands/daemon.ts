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

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { Argv } from "yargs";

import { DEFAULT_HUB_HOST, DEFAULT_HUB_PORT, startHub, type HubServerHandle } from "../../hub/HubServer.ts";
import { loadPolicy } from "../../security/PolicyLoader.ts";
import type { CommandContext } from "../context.ts";
import { daemonUnreachableError } from "../context.ts";
import { getJson } from "../controlClient.ts";

const DEFAULT_HTTP_PORT = DEFAULT_HUB_PORT;
interface HubContext {
  workspaceRoot: string;
  policyPath: string;
}

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
        .option("auto-port", {
          type: "boolean",
          describe: ctx.t("opt.auto-port")
        })
        .option("lifecycle", {
          type: "string",
          choices: ["persistent"],
          default: "persistent",
          describe: ctx.t("opt.lifecycle")
        })
        .option("policy", {
          type: "string",
          describe: ctx.t("opt.policy")
        }),
    async (argv) => {
      const policyPath = argv.policy as string | undefined;
      const context = hubContext(policyPath);
      const requestedHttpPort = (argv["http-port"] as number | undefined) ?? DEFAULT_HTTP_PORT;
      const host = (argv.host as string | undefined) || DEFAULT_HUB_HOST;
      let http: HubServerHandle;
      http = await startHubWithPortRules(
        {
          host,
          port: requestedHttpPort,
          defaultProjectPath: context.workspaceRoot,
          onIdle: () => http.close()
        },
        argv["http-port"] !== undefined
      );
      const stopFromSignal = (code: number, reason: string): void => {
        void http.close().finally(() => process.exit(code));
      };
      process.once("SIGINT", () => stopFromSignal(130, "sigint"));
      process.once("SIGTERM", () => stopFromSignal(143, "sigterm"));
      process.stderr.write(`breakpilot hub listening on ${http.url}\n`);
      process.stderr.write(`breakpilot IDE bridge listening on ${http.bridgeUrl}\n`);
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
        let targetUrl = ctx.controlUrl;
        try {
          const target = resolveHubTarget(ctx);
          targetUrl = target.controlUrl;
          const status = await getJson(`${target.controlUrl}/status`, target.controlToken);
          ctx.output(status, Boolean(argv.pretty));
        } catch (error) {
          const typedError = error as Error;
          ctx.output(daemonUnreachableError(targetUrl, typedError.message), true);
          process.exitCode = 1;
        }
      }
    );
    sub.command(
      "stop",
      ctx.t("cmd.daemon stop"),
      (b) => b,
      async (argv) => {
        try {
          const target = resolveHubTarget(ctx);
          const response = await fetch(`${target.controlUrl}/shutdown`, {
            method: "POST"
          });
          const payload = await response.json();
          ctx.output(payload, Boolean(argv.pretty));
          if (!response.ok) process.exitCode = 1;
        } catch (error) {
          const typedError = error as Error;
          ctx.output(daemonUnreachableError(ctx.controlUrl, typedError.message), true);
          process.exitCode = 1;
        }
      }
    );
    sub.command(
      "restart",
      ctx.t("cmd.daemon restart"),
      (b) => b,
      async (argv) => {
        try {
          const target = resolveHubTarget(ctx);
          await fetch(`${target.controlUrl}/shutdown`, { method: "POST" }).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 500));
          const context = hubContext(argv.policy as string | undefined);
          const started = await startDetachedDaemon(context);
          ctx.output(started, Boolean(argv.pretty));
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

function hubContext(policyPath: string | undefined): HubContext {
  const policy = loadPolicy(policyPath);
  return {
    workspaceRoot: policy.workspace.root,
    policyPath: path.resolve(process.env.BREAKPILOT_POLICY || policyPath || "breakpilot.yaml")
  };
}

async function startDetachedDaemon(context: HubContext): Promise<Record<string, unknown>> {
  const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
  const logDir = path.join(context.workspaceRoot, ".breakpilot");
  const logFile = path.join(logDir, "hub.log");
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      cliEntry,
      "serve",
      "--policy",
      context.policyPath
    ],
    {
      cwd: context.workspaceRoot,
      detached: true,
      stdio: ["ignore", out, err],
      env: {
        ...process.env,
        BREAKPILOT_WORKSPACE: context.workspaceRoot
      }
    }
  );
  child.unref();

  const deadline = Date.now() + 10000;
  const url = `http://${DEFAULT_HUB_HOST}:${DEFAULT_HUB_PORT}`;
  while (Date.now() < deadline) {
    const status = await findHealthyHub(url);
    if (status) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for BreakPilot hub to become ready.");
}

async function findHealthyHub(url: string): Promise<Record<string, unknown> | null> {
  try {
    const status = await getJson(`${url}/status`);
    if (status?.server === "breakpilot-hub") return status as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

async function startHubWithPortRules(
  options: Parameters<typeof startHub>[0],
  explicitPort: boolean
): Promise<HubServerHandle> {
  try {
    return await startHub(options);
  } catch (error) {
    if (explicitPort || !isAddressInUse(error)) throw error;
    return startHub({ ...options, port: 0 });
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EADDRINUSE";
}

function resolveHubTarget(ctx: CommandContext): { controlUrl: string; controlToken?: string } {
  return { controlUrl: ctx.controlUrl };
}
