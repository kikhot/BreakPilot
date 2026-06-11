// Feature: pluggable-debug-adapters, Property 16: Command override resolution
/**
 * Property-based test for centralized env-override command resolution (Task 2.6).
 *
 * Runner: node --experimental-strip-types test/adapter-command-override.property.test.ts
 *
 * Property 16: Command override resolution.
 *   For any non-empty (non-whitespace) environment command override, the
 *   resolved adapter command equals the override; for any empty or
 *   whitespace-only override, the resolved command equals the default command
 *   and a warning indicating the override was ignored is produced.
 *
 * Validates: Requirements 10.3, 10.4
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import type { AnyRecord } from "../src/types/json.ts";

const RUNS = 200;

const DEFAULT_COMMAND = "default-adapter-cmd";
const ENV_COMMAND_NAME = "BREAKPILOT_TEST_ADAPTER_OVERRIDE_CMD";

// ---------------------------------------------------------------------------
// Test-only subclass that exposes the protected `resolveAdapterCommand` so the
// property can exercise it directly. Production code is NOT modified.
// ---------------------------------------------------------------------------
class TestAdapter extends LanguageAdapter {
  constructor() {
    super({
      language: "python",
      adapterId: "test-adapter",
      defaultCommand: DEFAULT_COMMAND,
      envCommandName: ENV_COMMAND_NAME
    });
  }

  resolve(args: AnyRecord = {}) {
    return this.resolveAdapterCommand(args);
  }
}

const adapter = new TestAdapter();

/**
 * Hermetically set `process.env[ENV_COMMAND_NAME]` to `value` for the duration
 * of `fn`, then restore the prior value (including the absent case).
 */
function withOverride<T>(value: string, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, ENV_COMMAND_NAME);
  const prior = process.env[ENV_COMMAND_NAME];
  process.env[ENV_COMMAND_NAME] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[ENV_COMMAND_NAME] = prior as string;
    else delete process.env[ENV_COMMAND_NAME];
  }
}

const isIgnoreWarning = (w: string): boolean =>
  w.includes(ENV_COMMAND_NAME) && /ignor/i.test(w);

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Non-empty, non-whitespace overrides: at least one non-whitespace character.
const nonWhitespaceOverride = fc
  .string({ minLength: 1 })
  .filter((s) => s.trim().length > 0);

// Empty or whitespace-only overrides.
const whitespaceOverride = fc.oneof(
  fc.constant(""),
  fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), {
      minLength: 1,
      maxLength: 8
    })
    .map((chars) => chars.join(""))
);

// ---------------------------------------------------------------------------
// Property 16a: a non-whitespace override is used verbatim and produces no
// "override ignored" warning.
// ---------------------------------------------------------------------------
fc.assert(
  fc.property(nonWhitespaceOverride, (override) => {
    const { command, warnings } = withOverride(override, () => adapter.resolve());
    assert.equal(command, override);
    assert.ok(
      !warnings.some(isIgnoreWarning),
      `expected no ignore-warning for non-whitespace override, got: ${JSON.stringify(warnings)}`
    );
  }),
  { numRuns: RUNS }
);

// ---------------------------------------------------------------------------
// Property 16b: an empty/whitespace-only override falls back to the default
// command and produces a warning indicating the override was ignored.
// ---------------------------------------------------------------------------
fc.assert(
  fc.property(whitespaceOverride, (override) => {
    const { command, warnings } = withOverride(override, () => adapter.resolve());
    assert.equal(command, DEFAULT_COMMAND);
    assert.ok(
      warnings.some(isIgnoreWarning),
      `expected an ignore-warning for empty/whitespace override, got: ${JSON.stringify(warnings)}`
    );
  }),
  { numRuns: RUNS }
);

console.log("adapter command-override property tests ok");
