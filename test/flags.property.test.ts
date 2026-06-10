/**
 * Property-based tests for the list-argument parsing helpers (Task 2.2).
 *
 * Runner: node --experimental-strip-types test/flags.property.test.ts
 *
 * Covers the design's Correctness Property 3 (list parameter parsing is
 * preserved): for any input, `splitArgs` / `optionalSplitArgs` produce output
 * identical to the pre-refactor reference implementation, and repeated
 * (multi-value) flags aggregate into an equivalent array.
 *
 * Validates: Requirements 12.4, 12.5
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { optionalSplitArgs, splitArgs } from "../src/cli/flags.ts";

const RUNS = 1000;

// ---------------------------------------------------------------------------
// Pre-refactor reference oracle
//
// These encode the documented behavior of the hand-written parser BEFORE the
// yargs migration. The production helpers MUST stay equivalent to them.
//   splitArgs(value):
//     - falsy (undefined / false / "") -> []
//     - array                          -> returned as-is
//     - otherwise                      -> String(value).split(" ").filter(Boolean)
//   optionalSplitArgs(value):
//     - undefined when the split result is empty, otherwise the array
// ---------------------------------------------------------------------------

type FlagInput = string | boolean | string[] | undefined;

function referenceSplitArgs(value: FlagInput): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(" ").filter(Boolean);
}

function referenceOptionalSplitArgs(value: FlagInput): string[] | undefined {
  const args = referenceSplitArgs(value);
  return args.length > 0 ? args : undefined;
}

// ---------------------------------------------------------------------------
// Generators: cover every shape the flag value can take.
//   - arbitrary strings (single-value, space-separated, empty, whitespace)
//   - string arrays (multi-value aggregation from repeated flags)
//   - booleans (bare flag / absent value)
//   - undefined (flag not provided)
// ---------------------------------------------------------------------------

const spaceyString = fc.oneof(
  fc.string(),
  // Bias toward space-separated tokens to exercise split/filter behavior.
  fc.array(fc.string(), { maxLength: 6 }).map((parts) => parts.join(" ")),
  fc.constantFrom("", " ", "  ", "a b c", " leading", "trailing ", "a  b")
);

const flagInput: fc.Arbitrary<FlagInput> = fc.oneof(
  spaceyString,
  fc.array(fc.string(), { maxLength: 6 }),
  fc.boolean(),
  fc.constant(undefined)
);

// ---------------------------------------------------------------------------
// Property 3a: splitArgs matches the reference oracle for any input.
// ---------------------------------------------------------------------------

fc.assert(
  fc.property(flagInput, (value) => {
    assert.deepEqual(splitArgs(value), referenceSplitArgs(value));
  }),
  { numRuns: RUNS }
);

// ---------------------------------------------------------------------------
// Property 3b: optionalSplitArgs matches the reference oracle for any input.
// ---------------------------------------------------------------------------

fc.assert(
  fc.property(flagInput, (value) => {
    assert.deepEqual(optionalSplitArgs(value), referenceOptionalSplitArgs(value));
  }),
  { numRuns: RUNS }
);

// ---------------------------------------------------------------------------
// Property 3c: multi-value aggregation. A repeated array-style flag (e.g.
// `--category a --category b`) is passed through as the equivalent array,
// preserving order and contents.
// ---------------------------------------------------------------------------

fc.assert(
  fc.property(fc.array(fc.string(), { maxLength: 8 }), (values) => {
    const result = splitArgs(values);
    assert.deepEqual(result, values);
    // optionalSplitArgs collapses only the empty case to undefined.
    if (values.length === 0) {
      assert.equal(optionalSplitArgs(values), undefined);
    } else {
      assert.deepEqual(optionalSplitArgs(values), values);
    }
  }),
  { numRuns: RUNS }
);

// ---------------------------------------------------------------------------
// Property 3d: relationship invariant between the two helpers holds for any
// input (optionalSplitArgs is splitArgs with the empty result mapped away).
// ---------------------------------------------------------------------------

fc.assert(
  fc.property(flagInput, (value) => {
    const arr = splitArgs(value);
    const opt = optionalSplitArgs(value);
    if (arr.length === 0) {
      assert.equal(opt, undefined);
    } else {
      assert.deepEqual(opt, arr);
    }
  }),
  { numRuns: RUNS }
);

console.log("flags property tests ok");
