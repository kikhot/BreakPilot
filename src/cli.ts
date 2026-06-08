#!/usr/bin/env -S node --experimental-strip-types
import type { AnyRecord, ToolResponse } from "./types.ts";
import { createRuntime, startHttp, startStdio } from "./server.ts";
import { toolDefinitions } from "./mcp/schemas.ts";
import { loadPolicy } from "./security/PolicyLoader.ts";
import { stableJson } from "./utils/json.ts";

type CliFlagValue = string | boolean;
type CliFlags = Record<string, CliFlagValue | string[] | undefined>;
type ToolCommand = [string | null, AnyRecord | null];

function stringFlag(flags: CliFlags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function stringArrayFlag(flags: CliFlags, key: string): string[] | undefined {
  const value = flags[key];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return undefined;
}

function parseFlags(tokens: string[]): { flags: CliFlags; positional: string[] } {
  const flags: CliFlags = {};
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      const existing = flags[key];
      if (Array.isArray(existing)) {
        existing.push(next);
      } else if (typeof existing === "string") {
        flags[key] = [existing, next];
      } else {
        flags[key] = next;
      }
      i += 1;
    }
  }
  return { flags, positional };
}

function numberOrUndefined(value: CliFlagValue | string[] | undefined): number | undefined {
  if (value === undefined || Array.isArray(value)) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function splitArgs(value: CliFlagValue | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(" ").filter(Boolean);
}

function optionalSplitArgs(value: CliFlagValue | string[] | undefined): string[] | undefined {
  const args = splitArgs(value);
  return args.length > 0 ? args : undefined;
}

function output(value: unknown, pretty = false): void {
  process.stdout.write(`${stableJson(value, pretty)}\n`);
}

async function postTool(controlUrl: string, name: string, args: AnyRecord): Promise<ToolResponse> {
  const response = await fetch(`${controlUrl}/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args })
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as ToolResponse;
  } catch {
    return { ok: false, error: { code: "CLI_PARSE_FAILED", message: text, details: {} }, auditId: "cli" };
  }
}

async function getJson(url: string): Promise<AnyRecord> {
  const response = await fetch(url);
  return response.json() as Promise<AnyRecord>;
}

function toolFromCommand(
  command: string | undefined,
  subcommand: string | undefined,
  flags: CliFlags,
  positional: string[]
): ToolCommand {
  if (command === "launch") {
    return [
      "debug_launch",
      {
        lang: stringFlag(flags, "lang"),
        program: stringFlag(flags, "program"),
        module: stringFlag(flags, "module"),
        args: splitArgs(flags.args),
        cwd: stringFlag(flags, "cwd"),
        mode: stringFlag(flags, "mode"),
        owner: stringFlag(flags, "owner"),
        adapterCommand: stringFlag(flags, "adapter-command"),
        adapterArgs: optionalSplitArgs(flags["adapter-args"]),
        adapterPort: numberOrUndefined(flags["adapter-port"])
      }
    ];
  }
  if (command === "attach") {
    return [
      "debug_attach",
      {
        lang: stringFlag(flags, "lang"),
        host: stringFlag(flags, "host"),
        port: numberOrUndefined(flags.port),
        mode: stringFlag(flags, "mode"),
        owner: stringFlag(flags, "owner"),
        adapterCommand: stringFlag(flags, "adapter-command"),
        adapterArgs: optionalSplitArgs(flags["adapter-args"]),
        adapterPort: numberOrUndefined(flags["adapter-port"]),
        dapHost: stringFlag(flags, "dap-host"),
        dapPort: numberOrUndefined(flags["dap-port"])
      }
    ];
  }
  if (command === "bp" && subcommand === "set") {
    return [
      "set_breakpoint",
      {
        sessionId: stringFlag(flags, "session"),
        file: stringFlag(flags, "file"),
        line: numberOrUndefined(flags.line),
        column: numberOrUndefined(flags.column),
        condition: stringFlag(flags, "condition"),
        hitCondition: stringFlag(flags, "hit-condition"),
        logMessage: stringFlag(flags, "log-message"),
        requireVerified: Boolean(flags["require-verified"])
      }
    ];
  }
  if (command === "bp" && subcommand === "remove") {
    return ["remove_breakpoint", { sessionId: stringFlag(flags, "session"), breakpointId: stringFlag(flags, "id") }];
  }
  if (command === "bp" && subcommand === "list") {
    return ["list_breakpoints", { sessionId: stringFlag(flags, "session") }];
  }
  if (command === "wait") {
    return [
      "wait_for_breakpoint",
      { sessionId: stringFlag(flags, "session"), timeoutMs: numberOrUndefined(flags.timeout) }
    ];
  }
  if (command === "snapshot") {
    return [
      "get_runtime_snapshot",
      {
        sessionId: stringFlag(flags, "session"),
        threadId: numberOrUndefined(flags.thread),
        frameId: numberOrUndefined(flags.frame),
        profile: stringFlag(flags, "profile"),
        includeCategories: stringArrayFlag(flags, "category"),
        includeScopes: stringArrayFlag(flags, "scope"),
        objectFields: stringFlag(flags, "objects"),
        maxDepth: numberOrUndefined(flags.depth),
        maxItems: numberOrUndefined(flags["max-items"]),
        maxStringLength: numberOrUndefined(flags["max-string-length"])
      }
    ];
  }
  if (command === "inspect-variable") {
    return [
      "inspect_variable",
      {
        sessionId: stringFlag(flags, "session"),
        variablesReference: numberOrUndefined(flags.ref),
        start: numberOrUndefined(flags.start),
        count: numberOrUndefined(flags.count),
        objectFields: stringFlag(flags, "objects") ?? "deep",
        maxDepth: numberOrUndefined(flags.depth),
        maxItems: numberOrUndefined(flags["max-items"]),
        maxStringLength: numberOrUndefined(flags["max-string-length"])
      }
    ];
  }
  if (command === "eval") {
    return [
      "evaluate",
      {
        sessionId: stringFlag(flags, "session"),
        expression: positional.join(" "),
        mode: stringFlag(flags, "mode") ?? "readonly",
        timeoutMs: numberOrUndefined(flags.timeout)
      }
    ];
  }
  if (command === "continue") {
    return ["continue_execution", { sessionId: stringFlag(flags, "session"), threadId: numberOrUndefined(flags.thread) }];
  }
  if (command === "step-over") {
    return ["step_over", { sessionId: stringFlag(flags, "session"), threadId: numberOrUndefined(flags.thread) }];
  }
  if (command === "step-into") {
    return ["step_into", { sessionId: stringFlag(flags, "session"), threadId: numberOrUndefined(flags.thread) }];
  }
  if (command === "step-out") {
    return ["step_out", { sessionId: stringFlag(flags, "session"), threadId: numberOrUndefined(flags.thread) }];
  }
  if (command === "disconnect") {
    return [
      "disconnect",
      {
        sessionId: stringFlag(flags, "session"),
        terminateDebuggee: Boolean(flags.terminate)
      }
    ];
  }
  if (command === "sessions") {
    return ["list_sessions", {}];
  }
  if (command === "ide" && subcommand === "status") {
    return ["ide_status", {}];
  }
  if (command === "ide" && subcommand === "sessions") {
    return [
      "list_ide_sessions",
      {
        clientId: stringFlag(flags, "client"),
        workspace: stringFlag(flags, "workspace")
      }
    ];
  }
  if (command === "ide" && subcommand === "adopt") {
    return [
      "adopt_ide_session",
      {
        clientId: stringFlag(flags, "client"),
        ideSessionId: stringFlag(flags, "ide-session"),
        workspace: stringFlag(flags, "workspace"),
        lang: stringFlag(flags, "lang"),
        mode: stringFlag(flags, "mode"),
        owner: stringFlag(flags, "owner")
      }
    ];
  }
  if (command === "ide" && subcommand === "context") {
    return [
      "get_active_breakpoint_context",
      {
        sessionId: stringFlag(flags, "session"),
        clientId: stringFlag(flags, "client"),
        ideSessionId: stringFlag(flags, "ide-session"),
        workspace: stringFlag(flags, "workspace"),
        timeoutMs: numberOrUndefined(flags.timeout),
        frameIndex: numberOrUndefined(flags.frame),
        profile: stringFlag(flags, "profile"),
        objectFields: stringFlag(flags, "objects"),
        maxDepth: numberOrUndefined(flags.depth),
        maxItems: numberOrUndefined(flags["max-items"]),
        maxStringLength: numberOrUndefined(flags["max-string-length"])
      }
    ];
  }
  return [null, null];
}

function help(): AnyRecord {
  return {
    usage: "breakpilot <command> [options]",
    commands: [
      "serve --http-port 27890 --ide-bridge-port 27891",
      "mcp serve",
      "tools",
      "policy print",
      "launch --lang python --program examples/app.py",
      "attach --lang python --host 127.0.0.1 --port 5678",
      "bp set --session sess_001 --file src/app.py --line 42",
      "bp remove --session sess_001 --id bp_001",
      "bp list --session sess_001",
      "wait --session sess_001 --timeout 30000",
      "snapshot --session sess_001 --profile focused --category locals --depth 1 --max-items 10",
      "snapshot --session sess_001 --profile full --depth 3 --max-items 20",
      "inspect-variable --session sess_001 --ref 7 --depth 1 --max-items 20",
      "eval --session sess_001 --mode readonly order.customer.name",
      "continue --session sess_001",
      "step-over --session sess_001",
      "step-into --session sess_001",
      "step-out --session sess_001",
      "disconnect --session sess_001",
      "ide status",
      "ide sessions",
      "ide adopt --ide-session idea_001",
      "ide context --ide-session idea_001 --profile focused"
    ]
  };
}

async function main(): Promise<void> {
  const [command, maybeSubcommand, ...rest] = process.argv.slice(2);
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
    const args = json ? JSON.parse(json) : {};
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

main().catch((error: unknown) => {
  const typedError = error as Error;
  output({ ok: false, error: { message: typedError.message, stack: typedError.stack } }, true);
  process.exit(1);
});
