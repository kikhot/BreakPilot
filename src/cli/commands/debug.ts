/**
 * Debug control CLI commands (R8.2/R8.3, R5.5, R12.1/R12.5).
 *
 * This module registers the debug-domain commands. Task 6.1 implements
 * `launch` and `attach`; tasks 6.2 and 6.3 append the remaining commands
 * (`wait`, `snapshot`, `inspect-variable`, `eval`, `continue`, `step-*`,
 * `disconnect`, `sessions`) to this same `registerDebugCommands` function.
 *
 * Each handler maps the typed yargs argv to a control-plane tool argument
 * object that is DEEPLY EQUAL to the legacy `toolFromCommand` output (the PBT
 * oracle, Property 2 / task 8.1). To preserve exact equivalence:
 * - string flags pass through as `string | undefined` (no defaulting),
 * - `--args` / `--adapter-args` reuse `splitArgs` / `optionalSplitArgs`,
 * - number flags are declared `type: "number"` (so yargs validates invalid
 *   numbers via the fail handler, R4.4) and wrapped with `parseNumber` so the
 *   resulting value matches the oracle exactly.
 *
 * Each command and option carries a `describe` (sourced from the i18n catalog
 * via `ctx.t`) so that local help works (R3.1).
 */

import type { Argv } from "yargs";

import type { CommandContext } from "../context.ts";
import { optionalSplitArgs, parseNumber, splitArgs } from "../flags.ts";

/**
 * Register the debug control commands.
 *
 * Task 6.1 registers `launch` and `attach`. Additional `y.command(...)` blocks
 * are appended here by tasks 6.2 and 6.3.
 *
 * @param y   The yargs instance to register on.
 * @param ctx Shared command context (provides translator, output, runTool).
 * @returns The same yargs instance for chaining.
 */
export function registerDebugCommands(y: Argv, ctx: CommandContext): Argv {
  // launch -> debug_launch
  y.command(
    "launch",
    ctx.t("cmd.launch"),
    (b) =>
      b
        .option("lang", { type: "string", describe: ctx.t("opt.lang") })
        .option("program", { type: "string", describe: ctx.t("opt.program") })
        .option("module", { type: "string", describe: ctx.t("opt.module") })
        .option("args", { type: "string", describe: ctx.t("opt.args") })
        .option("cwd", { type: "string", describe: ctx.t("opt.cwd") })
        .option("mode", { type: "string", describe: ctx.t("opt.mode") })
        .option("owner", { type: "string", describe: ctx.t("opt.owner") })
        .option("adapter-command", { type: "string", describe: ctx.t("opt.adapter-command") })
        .option("adapter-args", { type: "string", describe: ctx.t("opt.adapter-args") })
        .option("adapter-port", { type: "number", describe: ctx.t("opt.adapter-port") }),
    (argv) =>
      ctx.runTool(
        "debug_launch",
        {
          lang: argv.lang as string | undefined,
          program: argv.program as string | undefined,
          module: argv.module as string | undefined,
          args: splitArgs(argv.args as string | undefined),
          cwd: argv.cwd as string | undefined,
          mode: argv.mode as string | undefined,
          owner: argv.owner as string | undefined,
          adapterCommand: argv["adapter-command"] as string | undefined,
          adapterArgs: optionalSplitArgs(argv["adapter-args"] as string | undefined),
          adapterPort: parseNumber(argv["adapter-port"] as number | undefined)
        },
        Boolean(argv.pretty)
      )
  );

  // attach -> debug_attach
  y.command(
    "attach",
    ctx.t("cmd.attach"),
    (b) =>
      b
        .option("lang", { type: "string", describe: ctx.t("opt.lang") })
        .option("host", { type: "string", describe: ctx.t("opt.host") })
        .option("port", { type: "number", describe: ctx.t("opt.port") })
        .option("mode", { type: "string", describe: ctx.t("opt.mode") })
        .option("owner", { type: "string", describe: ctx.t("opt.owner") })
        .option("adapter-command", { type: "string", describe: ctx.t("opt.adapter-command") })
        .option("adapter-args", { type: "string", describe: ctx.t("opt.adapter-args") })
        .option("adapter-port", { type: "number", describe: ctx.t("opt.adapter-port") })
        .option("dap-host", { type: "string", describe: ctx.t("opt.dap-host") })
        .option("dap-port", { type: "number", describe: ctx.t("opt.dap-port") }),
    (argv) =>
      ctx.runTool(
        "debug_attach",
        {
          lang: argv.lang as string | undefined,
          host: argv.host as string | undefined,
          port: parseNumber(argv.port as number | undefined),
          mode: argv.mode as string | undefined,
          owner: argv.owner as string | undefined,
          adapterCommand: argv["adapter-command"] as string | undefined,
          adapterArgs: optionalSplitArgs(argv["adapter-args"] as string | undefined),
          adapterPort: parseNumber(argv["adapter-port"] as number | undefined),
          dapHost: argv["dap-host"] as string | undefined,
          dapPort: parseNumber(argv["dap-port"] as number | undefined)
        },
        Boolean(argv.pretty)
      )
  );

  // snapshot -> get_runtime_snapshot
  y.command(
    "snapshot",
    ctx.t("cmd.snapshot"),
    (b) =>
      b
        .option("session", { type: "string", describe: ctx.t("opt.session") })
        .option("thread", { type: "number", describe: ctx.t("opt.thread") })
        .option("frame", { type: "number", describe: ctx.t("opt.frame") })
        .option("profile", { type: "string", describe: ctx.t("opt.profile") })
        .option("category", { type: "array", describe: ctx.t("opt.category") })
        .option("scope", { type: "array", describe: ctx.t("opt.scope") })
        .option("objects", { type: "string", describe: ctx.t("opt.objects") })
        .option("depth", { type: "number", describe: ctx.t("opt.depth") })
        .option("max-items", { type: "number", describe: ctx.t("opt.max-items") })
        .option("max-string-length", { type: "number", describe: ctx.t("opt.max-string-length") }),
    (argv) =>
      ctx.runTool(
        "get_runtime_snapshot",
        {
          sessionId: argv.session as string | undefined,
          threadId: parseNumber(argv.thread as number | undefined),
          frameId: parseNumber(argv.frame as number | undefined),
          profile: argv.profile as string | undefined,
          includeCategories: argv.category as string[] | undefined,
          includeScopes: argv.scope as string[] | undefined,
          objectFields: argv.objects as string | undefined,
          maxDepth: parseNumber(argv.depth as number | undefined),
          maxItems: parseNumber(argv["max-items"] as number | undefined),
          maxStringLength: parseNumber(argv["max-string-length"] as number | undefined)
        },
        Boolean(argv.pretty)
      )
  );

  // inspect-variable -> inspect_variable
  y.command(
    "inspect-variable",
    ctx.t("cmd.inspect-variable"),
    (b) =>
      b
        .option("session", { type: "string", describe: ctx.t("opt.session") })
        .option("ref", { type: "number", describe: ctx.t("opt.ref") })
        .option("start", { type: "number", describe: ctx.t("opt.start") })
        .option("count", { type: "number", describe: ctx.t("opt.count") })
        .option("objects", { type: "string", describe: ctx.t("opt.objects") })
        .option("depth", { type: "number", describe: ctx.t("opt.depth") })
        .option("max-items", { type: "number", describe: ctx.t("opt.max-items") })
        .option("max-string-length", { type: "number", describe: ctx.t("opt.max-string-length") }),
    (argv) =>
      ctx.runTool(
        "inspect_variable",
        {
          sessionId: argv.session as string | undefined,
          variablesReference: parseNumber(argv.ref as number | undefined),
          start: parseNumber(argv.start as number | undefined),
          count: parseNumber(argv.count as number | undefined),
          objectFields: (argv.objects as string | undefined) ?? "deep",
          maxDepth: parseNumber(argv.depth as number | undefined),
          maxItems: parseNumber(argv["max-items"] as number | undefined),
          maxStringLength: parseNumber(argv["max-string-length"] as number | undefined)
        },
        Boolean(argv.pretty)
      )
  );

  // eval [expression..] -> evaluate
  y.command(
    "eval [expression..]",
    ctx.t("cmd.eval"),
    (b) =>
      b
        .positional("expression", { type: "string", array: true })
        .option("session", { type: "string", describe: ctx.t("opt.session") })
        .option("mode", { type: "string", describe: ctx.t("opt.mode") })
        .option("timeout", { type: "number", describe: ctx.t("opt.timeout") }),
    (argv) =>
      ctx.runTool(
        "evaluate",
        {
          sessionId: argv.session as string | undefined,
          expression: ((argv.expression as string[] | undefined) ?? []).join(" "),
          mode: (argv.mode as string | undefined) ?? "readonly",
          timeoutMs: parseNumber(argv.timeout as number | undefined)
        },
        Boolean(argv.pretty)
      )
  );

  // wait -> wait_for_breakpoint
  y.command(
    "wait",
    ctx.t("cmd.wait"),
    (b) =>
      b
        .option("session", { type: "string", describe: ctx.t("opt.session") })
        .option("timeout", { type: "number", describe: ctx.t("opt.timeout") }),
    (argv) =>
      ctx.runTool(
        "wait_for_breakpoint",
        {
          sessionId: argv.session as string | undefined,
          timeoutMs: parseNumber(argv.timeout as number | undefined)
        },
        Boolean(argv.pretty)
      )
  );

  // continue -> continue_execution
  y.command(
    "continue",
    ctx.t("cmd.continue"),
    (b) =>
      b
        .option("session", { type: "string", describe: ctx.t("opt.session") })
        .option("thread", { type: "number", describe: ctx.t("opt.thread") }),
    (argv) =>
      ctx.runTool(
        "continue_execution",
        {
          sessionId: argv.session as string | undefined,
          threadId: parseNumber(argv.thread as number | undefined)
        },
        Boolean(argv.pretty)
      )
  );

  // step-over -> step_over
  y.command(
    "step-over",
    ctx.t("cmd.step-over"),
    (b) =>
      b
        .option("session", { type: "string", describe: ctx.t("opt.session") })
        .option("thread", { type: "number", describe: ctx.t("opt.thread") }),
    (argv) =>
      ctx.runTool(
        "step_over",
        {
          sessionId: argv.session as string | undefined,
          threadId: parseNumber(argv.thread as number | undefined)
        },
        Boolean(argv.pretty)
      )
  );

  // step-into -> step_into
  y.command(
    "step-into",
    ctx.t("cmd.step-into"),
    (b) =>
      b
        .option("session", { type: "string", describe: ctx.t("opt.session") })
        .option("thread", { type: "number", describe: ctx.t("opt.thread") }),
    (argv) =>
      ctx.runTool(
        "step_into",
        {
          sessionId: argv.session as string | undefined,
          threadId: parseNumber(argv.thread as number | undefined)
        },
        Boolean(argv.pretty)
      )
  );

  // step-out -> step_out
  y.command(
    "step-out",
    ctx.t("cmd.step-out"),
    (b) =>
      b
        .option("session", { type: "string", describe: ctx.t("opt.session") })
        .option("thread", { type: "number", describe: ctx.t("opt.thread") }),
    (argv) =>
      ctx.runTool(
        "step_out",
        {
          sessionId: argv.session as string | undefined,
          threadId: parseNumber(argv.thread as number | undefined)
        },
        Boolean(argv.pretty)
      )
  );

  // disconnect -> disconnect
  y.command(
    "disconnect",
    ctx.t("cmd.disconnect"),
    (b) =>
      b
        .option("session", { type: "string", describe: ctx.t("opt.session") })
        .option("terminate", { type: "boolean", describe: ctx.t("opt.terminate") }),
    (argv) =>
      ctx.runTool(
        "disconnect",
        {
          sessionId: argv.session as string | undefined,
          terminateDebuggee: Boolean(argv.terminate)
        },
        Boolean(argv.pretty)
      )
  );

  // sessions -> list_sessions
  y.command(
    "sessions",
    ctx.t("cmd.sessions"),
    (b) => b,
    (argv) => ctx.runTool("list_sessions", {}, Boolean(argv.pretty))
  );

  return y;
}
