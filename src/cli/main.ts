import { toolDefinitions } from "../control/toolDefinitions.ts";
import { startHttp } from "../http/controlServer.ts";
import { startStdio } from "../mcp/stdioServer.ts";
import { createRuntime } from "../runtime/createRuntime.ts";
import { loadPolicy } from "../security/PolicyLoader.ts";
import type { AnyRecord } from "../types/json.ts";
import { stableJson } from "../utils/json.ts";
import { toolFromCommand } from "./commands.ts";
import { getJson, postTool } from "./controlClient.ts";
import { parseFlags, stringFlag } from "./flags.ts";
import { help } from "./help.ts";

export function output(value: unknown, pretty = false): void {
  process.stdout.write(`${stableJson(value, pretty)}\n`);
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const [command, maybeSubcommand, ...rest] = argv;
  const subcommand = maybeSubcommand && !maybeSubcommand.startsWith("--") ? maybeSubcommand : undefined;
  const flagTokens = subcommand ? rest : [maybeSubcommand, ...rest].filter(Boolean) as string[];
  const { flags, positional } = parseFlags(flagTokens);
  const pretty = Boolean(flags.pretty);
  const controlUrl = stringFlag(flags, "control-url") || process.env.BREAKPILOT_CONTROL_URL || "http://127.0.0.1:27890";

  if (!command || command === "help" || flags.help) {
    output(help(), true);
    return;
  }

  if (command === "tools") {
    output({ tools: toolDefinitions }, pretty);
    return;
  }

  if (command === "mcp" && subcommand === "serve") {
    const runtime = createRuntime({
      policyPath: stringFlag(flags, "policy"),
      enableIdeBridge: Boolean(flags["ide-bridge-port"] || flags["ide-bridge"]),
      ideBridgePort: stringFlag(flags, "ide-bridge-port")
    });
    if (runtime.ideBridge) {
      const status = runtime.ideBridge.status();
      process.stderr.write(`breakpilot IDE bridge listening on ${status.host}:${status.port}\n`);
    }
    startStdio(runtime.router);
    return;
  }

  if (command === "policy" && subcommand === "print") {
    output(loadPolicy(stringFlag(flags, "policy")), pretty || true);
    return;
  }

  if (command === "serve") {
    const runtime = createRuntime({
      policyPath: stringFlag(flags, "policy"),
      enableIdeBridge: Boolean(flags["ide-bridge-port"] || flags["ide-bridge"]),
      ideBridgePort: stringFlag(flags, "ide-bridge-port")
    });
    const port = stringFlag(flags, "http-port") ?? 27890;
    const host = stringFlag(flags, "host") || "127.0.0.1";
    startHttp(runtime.router, port, host);
    process.stderr.write(`breakpilot HTTP listening on ${host}:${port}\n`);
    if (runtime.ideBridge) {
      const status = runtime.ideBridge.status();
      process.stderr.write(`breakpilot IDE bridge listening on ${status.host}:${status.port}\n`);
    }
    return;
  }

  if (command === "call") {
    const name = subcommand;
    const json = positional.join(" ");
    const args = json ? JSON.parse(json) as AnyRecord : {};
    if (!name) {
      output({ ok: false, error: { message: "Tool name is required for call." } }, true);
      process.exitCode = 1;
      return;
    }
    output(await postTool(String(controlUrl), name, args), pretty);
    return;
  }

  if (command === "daemon" && subcommand === "status") {
    output(await getJson(`${controlUrl}/status`), pretty);
    return;
  }

  const [toolName, args] = toolFromCommand(command, subcommand, flags, positional);
  if (!toolName) {
    output({ ok: false, error: { message: `Unknown command: ${command}` }, help: help() }, true);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await postTool(String(controlUrl), toolName, args ?? {});
    output(result, pretty);
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    const typedError = error as Error;
    output(
      {
        ok: false,
        error: {
          message: `Cannot reach breakpilot daemon at ${controlUrl}. Start it with: breakpilot serve --http-port 27890 --ide-bridge-port 27891`,
          cause: typedError.message
        }
      },
      true
    );
    process.exitCode = 1;
  }
}
