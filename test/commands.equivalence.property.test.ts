/**
 * Property-based test for parameter-mapping equivalence (Task 8.1).
 *
 * Runner: node --experimental-strip-types test/commands.equivalence.property.test.ts
 *
 * Covers the design's Correctness Property 2 (parameter mapping equivalence):
 * for any valid command + valid flag combination, the NEW yargs handlers
 * produce a control-plane tool name and canonical argument object that is
 * DEEPLY EQUAL to an independent oracle. This guards the CLI-only aliases
 * (`--workspace`, `--file`, and `--ref`) at the control-plane boundary.
 *
 * How it works:
 * - The ORACLE side derives `(command, subcommand, flags, positional)` from the
 *   same argv using the legacy `runCli` slicing and applies the frozen
 *   `toolFromCommand` (see test/fixtures/toolFromCommand.oracle.ts).
 * - The NEW side builds the real program via `buildProgram(ctx, version)` with a
 *   CommandContext whose `runTool` is a recording STUB (captures the tool name +
 *   args instead of doing any network I/O), then `parseAsync(argv)`.
 * - Both must agree, deeply, on tool name and args.
 *
 * Generators only ever emit VALID argv for KNOWN flags, with type-appropriate
 * values, so the parse always succeeds (no `.fail()` path is exercised here).
 *
 * Validates: Requirements 5.5, 12.1, 12.2, 12.3
 */

import assert from "node:assert/strict";
import fc from "fast-check";

import type { AnyRecord } from "../src/types/json.ts";
import type { CommandContext } from "../src/cli/context.ts";
import { createTranslator } from "../src/cli/i18n.ts";
import { buildProgram } from "../src/cli/program.ts";
import { oracleFromArgv } from "./fixtures/toolFromCommand.oracle.ts";

const RUNS = 400;

// ---------------------------------------------------------------------------
// Recording context: a CommandContext whose runTool captures (toolName, args).
// ---------------------------------------------------------------------------

interface Captured {
  toolName: string;
  args: AnyRecord;
}

function makeRecordingContext(sink: { value: Captured | undefined }): CommandContext {
  return {
    controlUrl: "http://127.0.0.1:57987",
    t: createTranslator("en_US"),
    locale: "en_US",
    output: () => {},
    runTool: async (toolName: string, args: AnyRecord): Promise<void> => {
      sink.value = { toolName, args };
    }
  };
}

// ---------------------------------------------------------------------------
// Token generators. All values are lowercase-letter tokens (never numeric,
// never empty, never starting with "-") so that:
//   - string flags pass through verbatim on both sides,
//   - untyped yargs `array` flags are never coerced to numbers,
//   - the legacy `parseFlags` never mistakes a value for a bare flag.
// ---------------------------------------------------------------------------

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
const safeStr = fc.array(fc.constantFrom(...LETTERS), { minLength: 1, maxLength: 6 }).map((a) => a.join(""));
const smallInt = fc.integer({ min: 0, max: 99999 });

/** Optional `--key <string>` -> [] or ["--key", value]. */
const optStr = (key: string): fc.Arbitrary<string[]> =>
  fc.option(safeStr, { nil: undefined }).map((v) => (v === undefined ? [] : [`--${key}`, v]));

/** Optional `--key <number>` -> [] or ["--key", "<n>"]. */
const optNum = (key: string): fc.Arbitrary<string[]> =>
  fc.option(smallInt, { nil: undefined }).map((v) => (v === undefined ? [] : [`--${key}`, String(v)]));

/** Optional bare boolean `--key` -> [] or ["--key"]. */
const optBool = (key: string): fc.Arbitrary<string[]> =>
  fc.boolean().map((b) => (b ? [`--${key}`] : []));

/**
 * Optional space-separated list flag `--key "a b c"`. Always non-empty when
 * present (an empty value would diverge: the legacy parser treats an empty next
 * token as a bare boolean flag).
 */
const optSpaceArgs = (key: string): fc.Arbitrary<string[]> =>
  fc
    .option(fc.array(safeStr, { minLength: 1, maxLength: 3 }), { nil: undefined })
    .map((v) => (v === undefined ? [] : [`--${key}`, v.join(" ")]));

/** Repeated array flag `--key a --key b` -> aggregated by both sides. */
const repeatedFlag = (key: string): fc.Arbitrary<string[]> =>
  fc.array(safeStr, { maxLength: 3 }).map((vals) => vals.flatMap((v) => [`--${key}`, v]));

const flat = (parts: string[][]): string[] => parts.flat();

// ---------------------------------------------------------------------------
// Per-command argv generators (each yields a full argv array).
// ---------------------------------------------------------------------------

const launchCase = fc
  .tuple(
    optStr("lang"),
    optStr("program"),
    optStr("module"),
    optSpaceArgs("args"),
    optStr("cwd"),
    optStr("mode"),
    optStr("owner"),
    optStr("adapter-command"),
    optSpaceArgs("adapter-args"),
    optNum("adapter-port")
  )
  .map((parts) => ["launch", ...flat(parts)]);

const attachCase = fc
  .tuple(
    optStr("lang"),
    optStr("host"),
    optNum("port"),
    optStr("mode"),
    optStr("owner"),
    optStr("adapter-command"),
    optSpaceArgs("adapter-args"),
    optNum("adapter-port"),
    optStr("dap-host"),
    optNum("dap-port")
  )
  .map((parts) => ["attach", ...flat(parts)]);

const bpSetCase = fc
  .tuple(
    safeStr, // session (required)
    safeStr, // file (required)
    smallInt, // line (required)
    optNum("column"),
    optStr("condition"),
    optStr("hit-condition"),
    optStr("log-message"),
    optBool("require-verified")
  )
  .map(([session, file, line, ...rest]) => [
    "bp",
    "set",
    "--session",
    session as string,
    "--file",
    file as string,
    "--line",
    String(line),
    ...flat(rest as string[][])
  ]);

const bpRemoveCase = fc
  .tuple(optStr("session"), optStr("id"))
  .map((parts) => ["bp", "remove", ...flat(parts)]);

const bpListCase = optStr("session").map((parts) => ["bp", "list", ...parts]);

const waitCase = fc
  .tuple(optStr("session"), optNum("timeout"))
  .map((parts) => ["wait", ...flat(parts)]);

const snapshotCase = fc
  .tuple(
    optStr("session"),
    optNum("thread"),
    optNum("frame"),
    optStr("profile"),
    repeatedFlag("category"),
    repeatedFlag("scope"),
    optStr("objects"),
    optNum("depth"),
    optNum("max-items"),
    optNum("max-string-length")
  )
  .map((parts) => ["snapshot", ...flat(parts)]);

const inspectVariableCase = fc
  .tuple(
    optStr("session"),
    optStr("ref"),
    optNum("start"),
    optNum("count"),
    optStr("objects"),
    optNum("depth"),
    optNum("max-items"),
    optNum("max-string-length")
  )
  .map((parts) => ["inspect-variable", ...flat(parts)]);

// eval: always lead with `--session` so argv[1] starts with "--" (keeping the
// legacy slicing's `subcommand` undefined), with the variadic expression tokens
// trailing after all flags.
const evalCase = fc
  .tuple(safeStr, optStr("mode"), optNum("timeout"), fc.array(safeStr, { maxLength: 4 }))
  .map(([session, modeTokens, timeoutTokens, expression]) => [
    "eval",
    "--session",
    session as string,
    ...(modeTokens as string[]),
    ...(timeoutTokens as string[]),
    ...(expression as string[])
  ]);

const sessionThreadCase = (command: string): fc.Arbitrary<string[]> =>
  fc.tuple(optStr("session"), optNum("thread")).map((parts) => [command, ...flat(parts)]);

const disconnectCase = fc
  .tuple(optStr("session"), optBool("terminate"))
  .map((parts) => ["disconnect", ...flat(parts)]);

const sessionsCase = fc.constant<string[]>(["sessions"]);

const ideStatusCase = fc.constant<string[]>(["ide", "status"]);

const ideSessionsCase = fc
  .tuple(optStr("client"), optStr("workspace"))
  .map((parts) => ["ide", "sessions", ...flat(parts)]);

const ideAdoptCase = fc
  .tuple(
    optStr("client"),
    optStr("ide-session"),
    optStr("workspace"),
    optStr("lang"),
    optStr("mode"),
    optStr("owner")
  )
  .map((parts) => ["ide", "adopt", ...flat(parts)]);

const ideContextCase = fc
  .tuple(
    optStr("session"),
    optStr("client"),
    optStr("ide-session"),
    optStr("workspace"),
    optNum("timeout"),
    optNum("frame"),
    optStr("profile"),
    optStr("objects"),
    optNum("depth"),
    optNum("max-items"),
    optNum("max-string-length")
  )
  .map((parts) => ["ide", "context", ...flat(parts)]);

const argvArb: fc.Arbitrary<string[]> = fc.oneof(
  launchCase,
  attachCase,
  bpSetCase,
  bpRemoveCase,
  bpListCase,
  waitCase,
  snapshotCase,
  inspectVariableCase,
  evalCase,
  sessionThreadCase("continue"),
  sessionThreadCase("step-over"),
  sessionThreadCase("step-into"),
  sessionThreadCase("step-out"),
  disconnectCase,
  sessionsCase,
  ideStatusCase,
  ideSessionsCase,
  ideAdoptCase,
  ideContextCase
);

// ---------------------------------------------------------------------------
// Property 2: parameter mapping equivalence.
// ---------------------------------------------------------------------------

await fc.assert(
  fc.asyncProperty(argvArb, async (argv) => {
    const [oracleTool, oracleArgs] = oracleFromArgv(argv);

    const sink: { value: Captured | undefined } = { value: undefined };
    const ctx = makeRecordingContext(sink);
    const program = buildProgram(ctx, "0.0.0-test");

    process.exitCode = 0;
    await program.parseAsync(argv);

    assert.ok(
      sink.value !== undefined,
      `new handler captured no tool call for argv: ${JSON.stringify(argv)} (exitCode=${String(process.exitCode)})`
    );
    const captured = sink.value as Captured;

    assert.deepEqual(
      captured.toolName,
      oracleTool,
      `tool name mismatch for argv: ${JSON.stringify(argv)}`
    );
    assert.deepEqual(
      captured.args,
      oracleArgs,
      `args mismatch for argv: ${JSON.stringify(argv)}\n new: ${JSON.stringify(captured.args)}\n old: ${JSON.stringify(oracleArgs)}`
    );
  }),
  { numRuns: RUNS }
);

// Restore a clean exit code (the recording stub never sets it, but the yargs
// fail path could have during a failing run; on success this is a no-op).
process.exitCode = 0;
console.log("commands equivalence property tests ok");
