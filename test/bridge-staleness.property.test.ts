/**
 * Property-based test for the Java bridge recompilation staleness decision
 * (Task 11.4).
 *
 * Runner: node --experimental-strip-types test/bridge-staleness.property.test.ts
 *
 * Covers the design's Correctness Property 12 (Bridge recompilation decision is
 * exactly determined by staleness): for any pair of source and compiled-output
 * modification times, `needsCompile` returns `true` (recompile) if and only if
 * the compiled output is missing (`classMtimeMs === null`) OR the source mtime
 * is strictly newer than the output mtime; otherwise it returns `false` (reuse).
 *
 * This tests the PURE `needsCompile` function in isolation — no filesystem and
 * no compiler are involved.
 *
 * Validates: Requirements 5.4, 5.5, 5.6
 */

// Feature: pluggable-debug-adapters, Property 12: Bridge recompilation decision is exactly determined by staleness

import assert from "node:assert/strict";
import fc from "fast-check";
import { needsCompile } from "../src/debug-adapters/java/BridgeCompiler.ts";

const RUNS = 200;

// Non-negative integer source mtimes (epoch ms are never negative).
const sourceMtimeArb = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

// The compiled-class mtime is either null (no compiled output exists) or a
// random integer mtime.
const classMtimeArb = fc.oneof(
  fc.constant<number | null>(null),
  fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
);

// Property: needsCompile is exactly the staleness predicate.
await fc.assert(
  fc.property(sourceMtimeArb, classMtimeArb, (sourceMtimeMs, classMtimeMs) => {
    const expected = classMtimeMs === null || sourceMtimeMs > classMtimeMs;
    assert.equal(
      needsCompile(sourceMtimeMs, classMtimeMs),
      expected,
      `needsCompile(${sourceMtimeMs}, ${String(classMtimeMs)}) should be ${expected}`
    );
  }),
  { numRuns: RUNS }
);

// Explicit boundary cases pinning the exact semantics of the decision.

// Equal mtimes → reuse (output is up to date; Requirement 5.5).
assert.equal(needsCompile(1_000, 1_000), false, "equal mtimes → reuse (false)");

// Source exactly 1 ms newer than the output → recompile (Requirements 5.4, 5.6).
assert.equal(needsCompile(1_001, 1_000), true, "source 1ms newer → recompile (true)");

// Output strictly newer than source → reuse (Requirement 5.5).
assert.equal(needsCompile(1_000, 1_001), false, "class newer → reuse (false)");

// Missing compiled output (null) → recompile regardless of source mtime
// (Requirement 5.4).
assert.equal(needsCompile(0, null), true, "class null → recompile (true)");
assert.equal(needsCompile(1_000, null), true, "class null → recompile (true)");

console.log("bridge recompilation staleness decision property tests ok");
