import type { AnyRecord } from "../types/json.ts";
import type { CliFlags } from "./flags.ts";
import {
  numberOrUndefined,
  optionalSplitArgs,
  splitArgs,
  stringArrayFlag,
  stringFlag
} from "./flags.ts";

export type ToolCommand = [string | null, AnyRecord | null];

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
