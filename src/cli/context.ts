/**
 * Shared command execution context for the BreakPilot CLI.
 *
 * `CommandContext` bundles the resolved control-plane URL, the translator, the
 * active locale, the `output()` JSON helper, and a `runTool()` wrapper that
 * encapsulates the control-plane call + JSON output + exit-code semantics. This
 * lets each yargs command handler stay thin: it only maps argv to tool args and
 * calls `ctx.runTool(...)` (R8.3).
 *
 * The behavior of `runTool` mirrors the existing `main.ts` logic exactly so the
 * machine-readable output and exit codes are preserved (R5.7/R5.8).
 */

import type { AnyRecord } from "../types/json.ts";
import { bridgeContext, manifestForControlUrl, readBridgeManifest } from "../hub/BridgeManifest.ts";
import { postTool } from "./controlClient.ts";
import type { Locale } from "./i18n.ts";
import { output } from "./main.ts";

const DEFAULT_CONTROL_URL = "http://127.0.0.1:27890";

export interface CommandContext {
  /** Control-plane URL resolved by {@link resolveControlUrl}. */
  controlUrl: string;
  /** Translator for help/version copy (English-fallback). */
  t: (key: string) => string;
  /** Active locale. */
  locale: Locale;
  /** Reuses the existing `main.ts` `output()` JSON helper. */
  output: (value: unknown, pretty?: boolean) => void;
  /** Invoke a control-plane tool and emit its JSON result. */
  runTool: (toolName: string, args: AnyRecord, pretty: boolean) => Promise<void>;
  /** Runtime policy path used for hub discovery. */
  policyPath?: string;
  /** Whether the user or environment explicitly selected the control URL. */
  controlUrlExplicit?: boolean;
}

export interface CreateContextOptions {
  controlUrl: string;
  t: (key: string) => string;
  locale: Locale;
  policyPath?: string;
  controlUrlExplicit?: boolean;
}

/**
 * Build the daemon-unreachable error JSON (R5.8).
 *
 * Returns the canonical `{ ok:false, error: { message, cause } }` shape used
 * whenever a control-plane request fails at the transport level. The `message`
 * embeds the start-command hint and `cause` carries the original error message.
 * Shared by {@link createContext}'s `runTool` and the `daemon status` handler so
 * both surfaces emit an identical payload.
 */
export function daemonUnreachableError(
  controlUrl: string,
  cause: string
): { ok: false; error: { message: string; cause: string } } {
  return {
    ok: false,
    error: {
      message: `Cannot reach breakpilot daemon at ${controlUrl}. Start it with: breakpilot serve --http-port 27890 --ide-bridge-port 27891`,
      cause
    }
  };
}

/**
 * Resolve the control-plane URL (R6).
 *
 * Precedence: `--control-url` flag (argv-derived) > `BREAKPILOT_CONTROL_URL`
 * environment variable > the default `http://127.0.0.1:27890`.
 */
export function resolveControlUrl(
  controlUrlFlag: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  if (typeof controlUrlFlag === "string" && controlUrlFlag.length > 0) {
    return controlUrlFlag;
  }
  const fromEnv = env.BREAKPILOT_CONTROL_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  return DEFAULT_CONTROL_URL;
}

/**
 * Build a {@link CommandContext} with a `runTool` bound to the given control
 * URL. `runTool`:
 * - calls the control plane via `postTool`,
 * - prints the JSON result through `output()`,
 * - sets `process.exitCode = 1` when the tool returns `ok: false` (R5.7),
 * - on transport failure, prints a daemon-unreachable hint JSON (including the
 *   start command and the original error cause) and sets exit code 1 (R5.8).
 */
export function createContext(options: CreateContextOptions): CommandContext {
  const { controlUrl, t, locale, policyPath, controlUrlExplicit } = options;

  const runTool = async (toolName: string, args: AnyRecord, pretty: boolean): Promise<void> => {
    const target = resolveControlTarget(controlUrl, policyPath, Boolean(controlUrlExplicit));
    try {
      const result = await postTool(target.controlUrl, toolName, args, target.controlToken);
      output(result, pretty);
      if (result.ok === false) process.exitCode = 1;
    } catch (error) {
      const typedError = error as Error;
      output(daemonUnreachableError(target.controlUrl, typedError.message), true);
      process.exitCode = 1;
    }
  };

  return { controlUrl, t, locale, output, runTool, policyPath, controlUrlExplicit };
}

function resolveControlTarget(
  controlUrl: string,
  policyPath: string | undefined,
  explicit: boolean
): { controlUrl: string; controlToken?: string } {
  if (explicit) {
    const manifest = manifestForControlUrl(controlUrl, policyPath);
    return { controlUrl, controlToken: manifest?.controlToken };
  }
  try {
    const context = bridgeContext(policyPath);
    const manifest = readBridgeManifest(context.workspaceRoot);
    if (manifest?.owner === "daemon" && manifest.controlUrl) {
      return { controlUrl: manifest.controlUrl, controlToken: manifest.controlToken };
    }
  } catch {
    // Fall back to the configured/default control URL.
  }
  const manifest = manifestForControlUrl(controlUrl, policyPath);
  return { controlUrl, controlToken: manifest?.controlToken };
}
