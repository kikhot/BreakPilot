/**
 * Independent snapshot of the CLI-to-control mapping used as the ORACLE for
 * the parameter-mapping property test. CLI flag names remain user-friendly,
 * while the resulting control arguments use the canonical agent contract.
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
 * Keep this implementation independent from the production yargs handlers so
 * the property test detects accidental mapping drift.
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
      "bp_debug_start",
      {
        language: stringFlag(flags, "lang"),
        mode: "launch",
        program: stringFlag(flags, "program"),
        module: stringFlag(flags, "module"),
        args: splitArgs(flags.args),
        cwd: stringFlag(flags, "cwd"),
        owner: stringFlag(flags, "owner"),
        adapterCommand: stringFlag(flags, "adapter-command"),
        adapterArgs: optionalSplitArgs(flags["adapter-args"]),
        adapterPort: parseNumber(flags["adapter-port"])
      }
    ];
  }
  if (command === "attach") {
    return [
      "bp_debug_start",
      {
        language: stringFlag(flags, "lang"),
        mode: "attach",
        host: stringFlag(flags, "host"),
        port: parseNumber(flags.port),
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
      "bp_debug_set_breakpoint",
      {
        sessionId: stringFlag(flags, "session"),
        projectPath: stringFlag(flags, "workspace"),
        clientId: stringFlag(flags, "client"),
        ide: stringFlag(flags, "ide"),
        filePath: stringFlag(flags, "file"),
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
    return ["bp_debug_remove_breakpoint", {
      sessionId: stringFlag(flags, "session"),
      projectPath: stringFlag(flags, "workspace"),
      clientId: stringFlag(flags, "client"),
      ide: stringFlag(flags, "ide"),
      breakpointId: stringFlag(flags, "id"),
      filePath: stringFlag(flags, "file"),
      line: parseNumber(flags.line)
    }];
  }
  if (command === "bp" && subcommand === "list") {
    return ["bp_debug_list_breakpoints", {
      sessionId: stringFlag(flags, "session"),
      projectPath: stringFlag(flags, "workspace"),
      clientId: stringFlag(flags, "client"),
      ide: stringFlag(flags, "ide"),
      filePath: stringFlag(flags, "file")
    }];
  }
  if (command === "wait") {
    return [
      "bp_debug_control",
      { sessionId: stringFlag(flags, "session"), action: "wait", timeout: parseNumber(flags.timeout) }
    ];
  }
  if (command === "snapshot") {
    return [
      "bp_debug_frame",
      {
        sessionId: stringFlag(flags, "session"),
        threadId: parseNumber(flags.thread),
        frameIndex: parseNumber(flags.frame),
        depth: parseNumber(flags.depth),
        limit: parseNumber(flags["max-items"]),
        maxString: parseNumber(flags["max-string-length"])
      }
    ];
  }
  if (command === "inspect-variable") {
    return [
      "bp_debug_value",
      {
        sessionId: stringFlag(flags, "session"),
        handle: stringFlag(flags, "ref"),
        offset: parseNumber(flags.start),
        depth: parseNumber(flags.depth),
        limit: parseNumber(flags.count) ?? parseNumber(flags["max-items"]),
        maxString: parseNumber(flags["max-string-length"])
      }
    ];
  }
  if (command === "eval") {
    return [
      "bp_debug_eval",
      {
        sessionId: stringFlag(flags, "session"),
        expression: positional.join(" "),
        mode: stringFlag(flags, "mode") ?? "readonly",
        timeout: parseNumber(flags.timeout)
      }
    ];
  }
  if (command === "continue") {
    return ["bp_debug_control", { sessionId: stringFlag(flags, "session"), action: "resume", threadId: parseNumber(flags.thread) }];
  }
  if (command === "step-over") {
    return ["bp_debug_control", { sessionId: stringFlag(flags, "session"), action: "stepOver", threadId: parseNumber(flags.thread) }];
  }
  if (command === "step-into") {
    return ["bp_debug_control", { sessionId: stringFlag(flags, "session"), action: "stepInto", threadId: parseNumber(flags.thread) }];
  }
  if (command === "step-out") {
    return ["bp_debug_control", { sessionId: stringFlag(flags, "session"), action: "stepOut", threadId: parseNumber(flags.thread) }];
  }
  if (command === "disconnect") {
    return [
      "bp_debug_control",
      {
        sessionId: stringFlag(flags, "session"),
        action: "disconnect",
        terminateDebuggee: Boolean(flags.terminate)
      }
    ];
  }
  if (command === "sessions") {
    return ["bp_debug_status", {}];
  }
  if (command === "ide" && subcommand === "status") {
    return ["bp_debug_status", {}];
  }
  if (command === "ide" && subcommand === "sessions") {
    return [
      "bp_debug_status",
      {
        clientId: stringFlag(flags, "client"),
        projectPath: stringFlag(flags, "workspace")
      }
    ];
  }
  if (command === "ide" && subcommand === "adopt") {
    return [
      "bp_debug_start",
      {
        clientId: stringFlag(flags, "client"),
        ideSessionId: stringFlag(flags, "ide-session"),
        projectPath: stringFlag(flags, "workspace"),
        language: stringFlag(flags, "lang"),
        mode: stringFlag(flags, "mode") ?? "ide",
        owner: stringFlag(flags, "owner")
      }
    ];
  }
  if (command === "ide" && subcommand === "context") {
    return [
      "bp_debug_context",
      {
        sessionId: stringFlag(flags, "session"),
        clientId: stringFlag(flags, "client"),
        ideSessionId: stringFlag(flags, "ide-session"),
        projectPath: stringFlag(flags, "workspace"),
        timeout: parseNumber(flags.timeout),
        frameIndex: parseNumber(flags.frame),
        depth: parseNumber(flags.depth),
        variableLimit: parseNumber(flags["max-items"]),
        maxString: parseNumber(flags["max-string-length"])
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
