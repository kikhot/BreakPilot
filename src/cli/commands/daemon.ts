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

import { startHttp, type ControlServerHandle } from "../../http/controlServer.ts";
import { ClientLeaseManager } from "../../http/ClientLeaseManager.ts";
import { createRuntime } from "../../runtime/createRuntime.ts";
import {
  type BridgeManifest,
  type BridgeContext,
  bridgeDir,
  bridgeContext,
  makeControlToken,
  makeInstanceId,
  manifestForControlUrl,
  readBridgeManifest,
  removeBridgeManifestForInstance,
  writeBridgeManifest
} from "../../hub/BridgeManifest.ts";
import type { CommandContext } from "../context.ts";
import { daemonUnreachableError } from "../context.ts";
import { getJson } from "../controlClient.ts";
import { getVersion } from "../version.ts";

const DEFAULT_HTTP_PORT = 27890;
const DEFAULT_HOST = "127.0.0.1";
type DaemonLifecycle = "persistent";

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
      const context = bridgeContext(policyPath);
      const httpPortExplicit = argv["http-port"] !== undefined;
      const bridgePortExplicit = argv["ide-bridge-port"] !== undefined;
      const lifecycle: DaemonLifecycle = "persistent";
      if (!httpPortExplicit && !bridgePortExplicit) {
        const existing = await findHealthyDaemon(context.workspaceRoot, context.policyHash);
        if (existing) {
          process.stderr.write(
            `breakpilot daemon already running at ${existing.controlUrl}; IDE bridge ${existing.bridgeUrl ?? "disabled"}\n`
          );
          return;
        }
      }
      const requestedBridgePort = argv["ide-bridge-port"] as number | undefined;
      const ideBridge = argv["ide-bridge"] as boolean | undefined;
      const enableIdeBridge = ideBridge !== false;
      const requestedHttpPort = (argv["http-port"] as number | undefined) ?? DEFAULT_HTTP_PORT;
      const host = (argv.host as string | undefined) || DEFAULT_HOST;
      const startedAt = new Date().toISOString();
      const instanceId = makeInstanceId();
      const controlToken = makeControlToken();
      const runtime = createRuntime({
        policyPath,
        enableIdeBridge,
        ideBridgePort: requestedBridgePort,
        bridgeInstanceId: instanceId,
        bridgePolicyHash: context.policyHash,
        bridgeLifecycle: lifecycle
      });
      let httpHandle: ControlServerHandle | null = null;
      let shuttingDown = false;
      const shutdown = async (closeHttp: boolean, reason = "shutdown"): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        leaseManager.stop();
        await runtime.manager.cleanupAll(reason);
        runtime.ideBridge?.stop();
        if (closeHttp && httpHandle) await httpHandle.close().catch(() => undefined);
        removeBridgeManifestForInstance(context.workspaceRoot, instanceId);
      };
      const leaseManager = new ClientLeaseManager({
        lifecycle,
        onInactive: () => shutdown(true, "mcp_clients_inactive")
      });

      if (runtime.ideBridge) {
        await startBridgeWithPortRules(runtime.ideBridge, bridgePortExplicit);
      }
      let manifest: BridgeManifest | null = null;
      const http = await startHttpWithPortRules(
        runtime.router,
        requestedHttpPort,
        host,
        httpPortExplicit,
        {
          controlToken,
          status: () => ({
            ok: true,
            server: "breakpilot",
            instanceId,
            lifecycle,
            pid: process.pid,
            version: getVersion(),
            workspaceRoot: context.workspaceRoot,
            policyPath: context.policyPath,
            policyHash: context.policyHash,
            controlUrl: manifest?.controlUrl,
            bridgeUrl: manifest?.bridgeUrl,
            ideBridge: runtime.ideBridge?.status() ?? { enabled: false, clients: [] },
            clients: runtime.ideBridge?.status().clients ?? [],
            sessions: runtime.ideBridge?.status().sessions ?? [],
            startedAt,
            updatedAt: new Date().toISOString()
          }),
          clients: leaseManager,
          onShutdown: () => shutdown(false, "daemon_shutdown")
        }
      );
      httpHandle = http;
      manifest = {
        schemaVersion: 1,
        owner: "daemon",
        instanceId,
        pid: process.pid,
        lifecycle,
        workspaceRoot: context.workspaceRoot,
        policyPath: context.policyPath,
        policyHash: context.policyHash,
        controlUrl: http.url,
        bridgeUrl: runtime.ideBridge
          ? `ws://${runtime.ideBridge.status().host}:${runtime.ideBridge.status().port}`
          : undefined,
        controlToken,
        startedAt,
        updatedAt: new Date().toISOString()
      };
      writeBridgeManifest(manifest);
      const stopFromSignal = (code: number, reason: string): void => {
        void shutdown(true, reason).finally(() => process.exit(code));
      };
      process.once("SIGINT", () => stopFromSignal(130, "sigint"));
      process.once("SIGTERM", () => stopFromSignal(143, "sigterm"));
      process.stderr.write(`breakpilot HTTP listening on ${http.url}\n`);
      if (manifest.bridgeUrl) process.stderr.write(`breakpilot IDE bridge listening on ${manifest.bridgeUrl}\n`);
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
          const target = await resolveDaemonTarget(ctx, argv.policy as string | undefined);
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
          const target = await resolveDaemonTarget(ctx, argv.policy as string | undefined);
          if (!target.controlToken) {
            ctx.output(daemonUnreachableError(target.controlUrl, "No matching daemon control token was found."), true);
            process.exitCode = 1;
            return;
          }
          const response = await fetch(`${target.controlUrl}/shutdown`, {
            method: "POST",
            headers: { authorization: `Bearer ${target.controlToken}` }
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
          const target = await resolveDaemonTarget(ctx, argv.policy as string | undefined);
          if (target.controlToken) {
            await fetch(`${target.controlUrl}/shutdown`, {
              method: "POST",
              headers: { authorization: `Bearer ${target.controlToken}` }
            }).catch(() => undefined);
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          const context = bridgeContext(argv.policy as string | undefined);
          const started = await startDetachedDaemon(context);
          ctx.output({ ok: true, data: started }, Boolean(argv.pretty));
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

async function startDetachedDaemon(context: BridgeContext): Promise<BridgeManifest> {
  const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
  const logFile = path.join(bridgeDir(context.workspaceRoot), "daemon.log");
  fs.mkdirSync(bridgeDir(context.workspaceRoot), { recursive: true });
  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      cliEntry,
      "serve",
      "--auto-port",
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
  while (Date.now() < deadline) {
    const manifest = await findHealthyDaemon(context.workspaceRoot, context.policyHash);
    if (manifest) return manifest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for BreakPilot daemon to become ready.");
}

async function findHealthyDaemon(
  workspaceRoot: string,
  policyHash: string
): Promise<BridgeManifest | null> {
  const manifest = readBridgeManifest(workspaceRoot);
  if (manifest?.owner !== "daemon" || !manifest.controlUrl || manifest.policyHash !== policyHash) return null;
  try {
    const status = await getJson(`${manifest.controlUrl}/status`, manifest.controlToken);
    if (status?.server === "breakpilot") return manifest;
  } catch {
    return null;
  }
  return null;
}

async function startBridgeWithPortRules(
  bridge: { start(): Promise<void>; stop(): void; port: number },
  explicitPort: boolean
): Promise<void> {
  try {
    await bridge.start();
  } catch (error) {
    if (explicitPort || !isAddressInUse(error)) throw error;
    bridge.stop();
    bridge.port = 0;
    await bridge.start();
  }
}

async function startHttpWithPortRules(
  router: Parameters<typeof startHttp>[0],
  port: number,
  host: string,
  explicitPort: boolean,
  options: Parameters<typeof startHttp>[3]
): ReturnType<typeof startHttp> {
  try {
    return await startHttp(router, port, host, options);
  } catch (error) {
    if (explicitPort || !isAddressInUse(error)) throw error;
    return startHttp(router, 0, host, options);
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EADDRINUSE";
}

async function resolveDaemonTarget(
  ctx: CommandContext,
  policyPath: string | undefined
): Promise<{ controlUrl: string; controlToken?: string }> {
  if (ctx.controlUrlExplicit) {
    const manifest = manifestForControlUrl(ctx.controlUrl, policyPath);
    return { controlUrl: ctx.controlUrl, controlToken: manifest?.controlToken };
  }
  const context = bridgeContext(policyPath);
  const manifest = readBridgeManifest(context.workspaceRoot);
  if (manifest?.owner === "mcp") {
    throw new Error("Current BreakPilot bridge is a stdio MCP instance; close the MCP client instead of using daemon commands.");
  }
  if (manifest?.owner === "daemon" && manifest.controlUrl) {
    return { controlUrl: manifest.controlUrl, controlToken: manifest.controlToken };
  }
  const fallbackManifest = manifestForControlUrl(ctx.controlUrl, policyPath);
  return {
    controlUrl: fallbackManifest?.controlUrl ?? ctx.controlUrl,
    controlToken: fallbackManifest?.controlToken
  };
}
