// Feature: pluggable-debug-adapters, Property 2: Feature query is total
/**
 * Property-based test for the total feature query (Task 2.4).
 *
 * Runner: node --experimental-strip-types test/adapter-feature-query.property.test.ts
 *
 * Property 2 (Feature query is total): for any string capability name,
 * `supportsFeature(name)` returns a boolean and never throws; for any name not
 * in the adapter's supported set (including unrecognized names), it returns
 * false.
 *
 * Validates: Requirements 1.5
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { NodeAdapter, PythonAdapter } from "../src/debug-adapters/LanguageAdapter.ts";

const RUNS = 1000;

// ---------------------------------------------------------------------------
// Adapters under test. Both Python and Node extend BaseLanguageAdapter and use
// its default supported-feature set. TypeScript is a NodeAdapter variant.
// ---------------------------------------------------------------------------

const adapters = [
  { name: "python", adapter: new PythonAdapter() },
  { name: "node", adapter: new NodeAdapter() },
  { name: "typescript", adapter: new NodeAdapter("typescript") }
] as const;

// ---------------------------------------------------------------------------
// Oracle: the documented base supported-feature set (design Adapter_Contract /
// BaseLanguageAdapter). "attach" is included only when the adapter reports
// attach support. This is intentionally an independent restatement of the
// contract, not a peek at the production private set.
// ---------------------------------------------------------------------------

const BASE_FEATURES = [
  "launch",
  "breakpoints",
  "conditionalBreakpoints",
  "evaluate",
  "stepping",
  "stackTrace",
  "scopes",
  "variables",
  "disconnect"
] as const;

const KNOWN_FEATURE_NAMES = new Set<string>([...BASE_FEATURES, "attach"]);

function expectedSupportedSet(adapter: { supportsAttach(): boolean }): Set<string> {
  const set = new Set<string>(BASE_FEATURES);
  if (adapter.supportsAttach()) set.add("attach");
  return set;
}

// ---------------------------------------------------------------------------
// Generators: cover arbitrary strings (random unicode), known feature names,
// and near-miss/unrecognized tokens.
// ---------------------------------------------------------------------------

// Arbitrary strings spanning the full unicode code-point range (fast-check v4
// exposes this via the `unit` option rather than the removed helper).
const unicodeString = fc.string({ unit: "binary" });

const anyName = fc.oneof(
  fc.string(),
  unicodeString,
  fc.constantFrom("launch", "attach", "breakpoints"),
  fc.constantFrom(...KNOWN_FEATURE_NAMES),
  // Case/format near-misses that must NOT match the case-sensitive set.
  fc.constantFrom("Launch", "ATTACH", "BreakPoints", "", " ", "unknown", "hotReload")
);

/** A name guaranteed to be outside any adapter's supported set. */
const outsideName = unicodeString.filter((name) => !KNOWN_FEATURE_NAMES.has(name));

// ---------------------------------------------------------------------------
// Property 2a: totality — supportsFeature never throws and always returns a
// boolean for any string name, across every adapter.
// ---------------------------------------------------------------------------

fc.assert(
  fc.property(anyName, (name) => {
    for (const { adapter } of adapters) {
      const result = adapter.supportsFeature(name);
      assert.equal(
        typeof result,
        "boolean",
        `supportsFeature(${JSON.stringify(name)}) returned a non-boolean`
      );
    }
  }),
  { numRuns: RUNS }
);

// ---------------------------------------------------------------------------
// Property 2b: any name outside the adapter's supported set (including
// unrecognized names) returns exactly false.
// ---------------------------------------------------------------------------

fc.assert(
  fc.property(outsideName, (name) => {
    for (const { adapter } of adapters) {
      // Defensive: the generator already excludes known names, but assert the
      // precondition relative to this adapter's own supported set.
      assert.equal(expectedSupportedSet(adapter).has(name), false);
      assert.equal(
        adapter.supportsFeature(name),
        false,
        `supportsFeature(${JSON.stringify(name)}) should be false for unsupported/unrecognized name`
      );
    }
  }),
  { numRuns: RUNS }
);

// ---------------------------------------------------------------------------
// Property 2c: consistency with the documented set — for any known feature
// name, the result matches set membership for that adapter (supported ->
// true, otherwise false). This confirms "false when unsupported" too.
// ---------------------------------------------------------------------------

fc.assert(
  fc.property(fc.constantFrom(...KNOWN_FEATURE_NAMES), (name) => {
    for (const { adapter } of adapters) {
      const expected = expectedSupportedSet(adapter).has(name);
      assert.equal(
        adapter.supportsFeature(name),
        expected,
        `supportsFeature(${JSON.stringify(name)}) disagreed with the documented support set`
      );
    }
  }),
  { numRuns: RUNS }
);

console.log("adapter feature-query property tests ok");
