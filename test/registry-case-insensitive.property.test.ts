// Feature: pluggable-debug-adapters, Property 3: Registry resolution is case-insensitive (round-trip)
/**
 * Property-based test for case-insensitive resolution round-trip (Task 3.2).
 *
 * Runner: node --experimental-strip-types test/registry-case-insensitive.property.test.ts
 *
 * Property 3: Registry resolution is case-insensitive (round-trip).
 *   For any valid language identifier and any case permutation of it, after
 *   registering an adapter under the identifier, AdapterRegistry.get(permutation)
 *   returns that same adapter instance (===).
 *
 * Validates: Requirements 2.1, 2.4, 13.1
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { AdapterRegistry } from "../src/debug-adapters/AdapterRegistry.ts";
import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";

const RUNS = 200;

// A fresh registry pre-registers exactly python/node/typescript/java. Generated
// identifiers must be case-insensitively disjoint from this set so that
// register() does not collide with a default adapter.
const referenceRegistry = new AdapterRegistry();
const defaultLower = new Set(
  referenceRegistry.listIdentifiers().map((id) => id.toLowerCase())
);

// ---------------------------------------------------------------------------
// Synthetic adapter whose metadata.language is the generated identifier.
// adapterId/envCommandName are harmless placeholders; construction performs no
// identifier validation (that happens at register()).
// ---------------------------------------------------------------------------
function makeAdapter(identifier: string): LanguageAdapter {
  return new LanguageAdapter({
    language: identifier,
    adapterId: "synthetic-test-adapter",
    envCommandName: "BREAKPILOT_SYNTHETIC_TEST_ADAPTER"
  });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Letters drive case sensitivity; digits round-trip casing as identity. Use a
// mix so identifiers are realistic while keeping at least one casing-relevant
// character common.
const identifierChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")
);

// A VALID identifier: non-empty, <= 64 chars, contains at least one letter (so
// case permutation is meaningful), and case-insensitively disjoint from the
// default python/node/typescript/java set.
const validIdentifierArb = fc
  .array(identifierChar, { minLength: 1, maxLength: 64 })
  .map((chars) => chars.join(""))
  .filter((id) => /[a-zA-Z]/.test(id))
  .filter((id) => !defaultLower.has(id.toLowerCase()));

// Pair the identifier with a per-character case mask of equal length. Each mask
// bit decides whether to upper- or lower-case the corresponding character,
// yielding an arbitrary case permutation of the identifier.
const identifierWithMaskArb = validIdentifierArb.chain((id) =>
  fc.tuple(
    fc.constant(id),
    fc.array(fc.boolean(), { minLength: id.length, maxLength: id.length })
  )
);

function applyCaseMask(id: string, mask: boolean[]): string {
  let out = "";
  for (let i = 0; i < id.length; i++) {
    const ch = id[i] ?? "";
    const upper = mask[i] ?? false;
    out += upper ? ch.toUpperCase() : ch.toLowerCase();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Property 3: a registered adapter resolves through any case permutation of its
// identifier, returning the exact same instance.
// ---------------------------------------------------------------------------
fc.assert(
  fc.property(identifierWithMaskArb, ([identifier, mask]) => {
    const registry = new AdapterRegistry();
    const adapter = makeAdapter(identifier);
    registry.register(adapter);

    const permutation = applyCaseMask(identifier, mask);

    // The permutation is, by construction, a case-only variant of the
    // registered identifier.
    assert.equal(
      permutation.toLowerCase(),
      identifier.toLowerCase(),
      "permutation must be a case-only variant of the identifier"
    );

    // Resolution must return the exact same instance for the case permutation
    // (Requirements 2.1, 2.4, 13.1).
    assert.ok(
      registry.has(permutation),
      `expected has(${JSON.stringify(permutation)}) to be true`
    );
    assert.strictEqual(
      registry.get(permutation as never),
      adapter,
      `expected get(${JSON.stringify(permutation)}) to return the registered instance`
    );

    // And the original-cased identifier resolves to the same instance too.
    assert.strictEqual(registry.get(identifier as never), adapter);
  }),
  { numRuns: RUNS }
);

console.log("registry case-insensitive resolution round-trip property tests ok");
