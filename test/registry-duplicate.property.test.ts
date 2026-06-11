// Feature: pluggable-debug-adapters, Property 5: Duplicate registration is rejected and retains the prior adapter
/**
 * Property-based test for duplicate-registration rejection (Task 3.4).
 *
 * Runner: node --experimental-strip-types test/registry-duplicate.property.test.ts
 *
 * Property 5 (Duplicate registration is rejected and retains the prior adapter):
 * for any valid language identifier and any case permutation of it, registering
 * a second, different adapter under the case-insensitively matching identifier
 * throws a `DUPLICATE_LANGUAGE` BreakPilotError that includes the conflicting
 * identifier, and `get()` still resolves to the originally registered adapter
 * (the prior adapter is retained unchanged).
 *
 * Validates: Requirements 2.3
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { AdapterRegistry } from "../src/debug-adapters/AdapterRegistry.ts";
import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import type { DebugLanguage } from "../src/types/debug.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";

const RUNS = 200;

// The default registry already registers exactly these four languages; any
// synthetic identifier we use must be disjoint from them (case-insensitively)
// so the only collision under test is the one we deliberately create.
const DEFAULTS = new Set(["python", "node", "typescript", "java"]);

// Identifier alphabet: letters give meaningful case permutations, digits ensure
// non-letter characters are tolerated. No whitespace so identifiers stay valid.
const IDENTIFIER_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");

/** A valid (non-empty, <=64 char, non-default) language identifier. */
const identifierArb = fc
  .array(fc.constantFrom(...IDENTIFIER_CHARS), { minLength: 1, maxLength: 64 })
  .map((chars) => chars.join(""))
  .filter((id) => id.trim().length > 0 && !DEFAULTS.has(id.toLowerCase()));

/** Build a synthetic, identifiable adapter under a given identifier. */
function makeAdapter(language: string, tag: string): LanguageAdapter {
  return new LanguageAdapter({
    language: language as DebugLanguage,
    adapterId: tag,
    envCommandName: "BREAKPILOT_TEST_ADAPTER"
  });
}

// ---------------------------------------------------------------------------
// Property 5: register A under `identifier`, then attempt to register a
// different adapter B under any case permutation of the same identifier. The
// second registration must throw DUPLICATE_LANGUAGE (including the conflicting
// identifier), and get() must still return A === (never B).
// ---------------------------------------------------------------------------

// An identifier plus a case permutation of it (a boolean per character decides
// upper/lower), so B collides with A case-insensitively but may differ in case.
const collidingPairArb = identifierArb.chain((identifier) =>
  fc
    .array(fc.boolean(), {
      minLength: identifier.length,
      maxLength: identifier.length
    })
    .map((flags) => {
      const permuted = identifier
        .split("")
        .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join("");
      return { identifier, permuted };
    })
);

fc.assert(
  fc.property(
    collidingPairArb,
    ({ identifier, permuted }) => {
      const registry = new AdapterRegistry();

      const adapterA = makeAdapter(identifier, "adapter-A");
      const adapterB = makeAdapter(permuted, "adapter-B");

      // First registration succeeds and is resolvable.
      registry.register(adapterA);
      assert.equal(registry.get(identifier as DebugLanguage), adapterA);

      // Second registration under a case-insensitively matching identifier is
      // rejected with DUPLICATE_LANGUAGE naming the conflicting identifier.
      assert.throws(
        () => registry.register(adapterB),
        (error: unknown) => {
          assert.ok(
            error instanceof BreakPilotError,
            "expected a BreakPilotError"
          );
          assert.equal(error.code, ErrorCodes.DUPLICATE_LANGUAGE);
          // The conflicting identifier (the one we attempted to register) is
          // surfaced both in the structured details and the message.
          assert.equal(error.details.identifier, permuted);
          assert.ok(
            error.message.includes(permuted),
            `error message should include the conflicting identifier ${JSON.stringify(permuted)}`
          );
          return true;
        }
      );

      // The prior adapter is retained unchanged: resolution by the original
      // casing AND by the permuted casing both return A (===), never B.
      assert.equal(registry.get(identifier as DebugLanguage), adapterA);
      assert.equal(registry.get(permuted as DebugLanguage), adapterA);
      assert.notEqual(registry.get(identifier as DebugLanguage), adapterB);

      // The identifier appears exactly once (A's original casing), confirming
      // the registry set was not mutated by the rejected registration.
      const listed = registry
        .listIdentifiers()
        .filter((id) => id.toLowerCase() === identifier.toLowerCase());
      assert.deepEqual(listed, [identifier]);
    }
  ),
  { numRuns: RUNS }
);

console.log("registry duplicate-registration rejection property tests ok");
