/**
 * Property-based test for non-unique resolution never defaulting (Task 5.6).
 *
 * Runner: node --experimental-strip-types test/language-no-resolution.property.test.ts
 *
 * Covers the design's Correctness Property 20 (No unique resolution always
 * throws and never defaults): for any request that does not uniquely resolve a
 * language — no explicit language and no source path, an explicit-language
 * field that is empty/whitespace-only (treated as absent) with no source, or an
 * attach request lacking an inferable source — LanguageResolver.resolve()
 * throws a BreakPilotError with code INVALID_ARGUMENT and NEVER returns a
 * default adapter (e.g. python).
 *
 * Validates: Requirements 13.4, 13.7, 13.8
 */

// Feature: pluggable-debug-adapters, Property 20: No unique resolution always throws and never defaults

import assert from "node:assert/strict";
import fc from "fast-check";
import { AdapterRegistry } from "../src/debug-adapters/AdapterRegistry.ts";
import { LanguageResolver } from "../src/sessions/LanguageResolver.ts";
import type { LanguageResolveInput, ResolveRequestKind } from "../src/sessions/LanguageResolver.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";

const RUNS = 200;

// Whitespace-only / empty strings that the resolver treats as "no explicit
// language" (LanguageResolver.#firstNonEmptyString trims before checking).
const blankStringArb = fc.constantFrom("", " ", "   ", "\t", "\n", " \t\n ");

// A request kind, randomized so both launch and attach are exercised.
const requestKindArb: fc.Arbitrary<ResolveRequestKind> = fc.constantFrom("launch", "attach");

// Build an input that cannot uniquely resolve a language. Each variant leaves
// the resolver with no explicit language AND no inferable source path:
//   (a) explicit-language fields entirely absent, no source path;
//   (b) explicit-language fields present but blank/whitespace-only, no source;
//   (c) attach request lacking any inferable source.
// We also randomize whether the blank fields and absent source are expressed as
// undefined-vs-omitted so the input space is covered broadly.
const unresolvableInputArb: fc.Arbitrary<LanguageResolveInput> = fc.record({
  request: requestKindArb,
  // lang/language are either omitted (undefined) or present-but-blank.
  lang: fc.option(blankStringArb, { nil: undefined }),
  language: fc.option(blankStringArb, { nil: undefined }),
  // program/file are either omitted (undefined) or present-but-blank, so no
  // source path is ever inferable.
  program: fc.option(blankStringArb, { nil: undefined }),
  file: fc.option(blankStringArb, { nil: undefined })
});

await fc.assert(
  fc.property(unresolvableInputArb, (input) => {
    // Fresh registry per run so the property never depends on prior state and
    // carries the real default set (python/node/typescript/java) that a buggy
    // implementation might wrongly default to.
    const registry = new AdapterRegistry();
    const resolver = new LanguageResolver(registry);

    let thrown: unknown;
    let returned: unknown;
    try {
      // Must NEVER return a (default) adapter for an unresolvable request.
      returned = resolver.resolve(input);
    } catch (error) {
      thrown = error;
    }

    assert.equal(
      returned,
      undefined,
      `resolve() must never return for an unresolvable request; got ${JSON.stringify(returned)}`
    );

    assert.ok(
      thrown instanceof BreakPilotError,
      "error should be a BreakPilotError"
    );
    assert.equal(
      thrown.code,
      ErrorCodes.INVALID_ARGUMENT,
      `expected INVALID_ARGUMENT, got ${String((thrown as BreakPilotError).code)}`
    );
  }),
  { numRuns: RUNS }
);

console.log("language no-resolution (never defaults) property tests ok");
