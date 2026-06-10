/**
 * Frozen snapshot of the legacy `src/cli/commands.ts::toolFromCommand` mapping
 * and the hand-written flag-parsing helpers it depended on, used as the ORACLE
 * for the parameter-mapping equivalence property test (Property 2 / task 8.1).
 *
 * This file is an intentional COPY (not an import) of the pre-yargs behavior so
 * the oracle stays frozen and independent of any future edits to the production
 * `commands.ts` / `flags.ts` (which are slated for removal once the migration
 * is complete). The logic below mirrors:
 *   - `src/cli/flags.ts`: `parseFlags`, `stringFlag`, `stringArrayFlag`,
 *     `parseNumber`, `splitArgs`, `optionalSplitArgs`
 *   - `src/cli/commands.ts`: `toolFromCommand`
 *   - the argv-slicing performed by the legacy `runCli` (commit b3025e2) to
 *     derive `(command, subcommand, flags, positional)` from a raw argv array.
 *
 * DO NOT "modernize" or refactor this file: its whole purpose is to encode the
 * old behavior verbatim as the source of truth for the equivalence check.
 */

// ---------------------------------------------------------------------------
// Frozen flag helpers (copied from the pre-refactor src/cli/flags.ts)
// ---------------------------------------------------------------------------

type CliFlagValue = string | boolean;
type CliFlags = Record<string, CliFlagValue | string[] | undefined>;

type AnyRecord = Record<string, unknown>;

export type ToolCommand = [string | null, AnyRecord | null];

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

function parseNumber(value: CliFlagValue | number | string[] | undefined): number | undefined {
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

// ---------------------------------------------------------------------------
// Frozen tool mapping (copied from the pre-refactor src/cli/commands.ts)
// ---------------------------------------------------------------------------

export function toolFromCommand(
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
        adapterPort: parseNumber(flags["adapter-port"])
      }
    ];
  }
  if (command === "attach") {
    return [
      "debug_attach",
      {
        lang: stringFlag(flags, "lang"),
        host: stringFlag(flags, "host"),
        port: parseNumber(flags.port),
        mode: stringFlag(flags, "mode"),
        owner: stringFlag(flags, "owner"),
        adapterCommand: stringFlag(flags, "adapter-command"),
        adapterArgs: optionalSplitArgs(flags["adapter-args"]),
        adapterPort: parseNumber(flags["adapter-port"]),
        dapHost: stringFlag(flags, "dap-host"),
        dapPort: parseNumber(flags["dap-port"])
      }
    ];
  }
  if (command === "bp" && subcommand === "set") {
    return [
      "set_breakpoint",
      {
        sessionId: stringFlag(flags, "session"),
        file: stringFlag(flags, "file"),
        line: parseNumber(flags.line),
        column: parseNumber(flags.column),
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
      { sessionId: stringFlag(flags, "session"), timeoutMs: parseNumber(flags.timeout) }
    ];
  }
  if (command === "snapshot") {
    return [
      "get_runtime_snapshot",
      {
        sessionId: stringFlag(flags, "session"),
        threadId: parseNumber(flags.thread),
        frameId: parseNumber(flags.frame),
        profile: stringFlag(flags, "profile"),
        includeCategories: stringArrayFlag(flags, "category"),
        includeScopes: stringArrayFlag(flags, "scope"),
        objectFields: stringFlag(flags, "objects"),
        maxDepth: parseNumber(flags.depth),
        maxItems: parseNumber(flags["max-items"]),
        maxStringLength: parseNumber(flags["max-string-length"])
      }
    ];
  }
  if (command === "inspect-variable") {
    return [
      "inspect_variable",
      {
        sessionId: stringFlag(flags, "session"),
        variablesReference: parseNumber(flags.ref),
        start: parseNumber(flags.start),
        count: parseNumber(flags.count),
        objectFields: stringFlag(flags, "objects") ?? "deep",
        maxDepth: parseNumber(flags.depth),
        maxItems: parseNumber(flags["max-items"]),
        maxStringLength: parseNumber(flags["max-string-length"])
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
        timeoutMs: parseNumber(flags.timeout)
      }
    ];
  }
  if (command === "continue") {
    return ["continue_execution", { sessionId: stringFlag(flags, "session"), threadId: parseNumber(flags.thread) }];
  }
  if (command === "step-over") {
    return ["step_over", { sessionId: stringFlag(flags, "session"), threadId: parseNumber(flags.thread) }];
  }
  if (command === "step-into") {
    return ["step_into", { sessionId: stringFlag(flags, "session"), threadId: parseNumber(flags.thread) }];
  }
  if (command === "step-out") {
    return ["step_out", { sessionId: stringFlag(flags, "session"), threadId: parseNumber(flags.thread) }];
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
        timeoutMs: parseNumber(flags.timeout),
        frameIndex: parseNumber(flags.frame),
        profile: stringFlag(flags, "profile"),
        objectFields: stringFlag(flags, "objects"),
        maxDepth: parseNumber(flags.depth),
        maxItems: parseNumber(flags["max-items"]),
        maxStringLength: parseNumber(flags["max-string-length"])
      }
    ];
  }
  return [null, null];
}

// ---------------------------------------------------------------------------
// Frozen argv slicing (copied from the legacy runCli, commit b3025e2)
// ---------------------------------------------------------------------------

/**
 * Reproduce EXACTLY how the legacy `runCli` derived
 * `(command, subcommand, flags, positional)` from a raw argv array, then apply
 * the frozen `toolFromCommand` mapping.
 *
 * Legacy slicing:
 *   const [command, maybeSubcommand, ...rest] = argv;
 *   const subcommand = maybeSubcommand && !maybeSubcommand.startsWith("--")
 *     ? maybeSubcommand : undefined;
 *   const flagTokens = subcommand ? rest : [maybeSubcommand, ...rest].filter(Boolean);
 *   const { flags, positional } = parseFlags(flagTokens);
 */
export function oracleFromArgv(argv: string[]): ToolCommand {
  const [command, maybeSubcommand, ...rest] = argv;
  const subcommand =
    maybeSubcommand && !maybeSubcommand.startsWith("--") ? maybeSubcommand : undefined;
  const flagTokens = subcommand
    ? rest
    : ([maybeSubcommand, ...rest].filter(Boolean) as string[]);
  const { flags, positional } = parseFlags(flagTokens);
  return toolFromCommand(command, subcommand, flags, positional);
}
