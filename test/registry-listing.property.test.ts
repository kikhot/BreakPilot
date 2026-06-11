/**
 * Property-based test for listing completeness and resolution preservation
 * (Task 3.6).
 *
 * Runner: node --experimental-strip-types test/registry-listing.property.test.ts
 *
 * Covers the design's Correctness Property 7 (Listing completeness and
 * resolution preservation): for any sequence of valid, distinct registrations,
 * listIdentifiers() equals exactly the set of registered identifiers (compared
 * case-insensitively), and after each new registration every previously
 * registered adapter still resolves to its original instance.
 *
 * Empty-registry note: AdapterRegistry's constructor always pre-registers the
 * default set (python/node/typescript/java), so there is no public mechanism to
 * construct a strictly empty registry. Per the task guidance, we therefore
 * verify the empty-case substitute: a fresh registry's listIdentifiers() equals
 * EXACTLY the four defaults as a case-insensitive set (no more, no fewer, no
 * duplicates). The `[]`-when-empty branch of listIdentifiers() is exercised by
 * implementation review (it iterates the backing maps) rather than via a public
 * empty constructor.
 *
 * Validates: Requirements 2.6, 12.5
 */

// Feature: pluggable-debug-adapters, Property 7: Listing completeness and resolution preservation

import assert from "node:assert/strict";
import fc from "fast-check";
import { AdapterRegistry } from "../src/debug-adapters/AdapterRegistry.ts";
import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import type { Adapter_Contract } from "../src/debug-adapters/types.ts";

const RUNS = 200;

// The default set seeded by every fresh registry, lowercased for comparison.
const DEFAULTS_LOWER = new Set(
  new AdapterRegistry().listIdentifiers().map((id) => id.toLowerCase())
);

// A synthetic adapter built on the base LanguageAdapter. Its metadata.language
// is the identifier the registry keys off of. Holds no resources and spawns
// nothing, so registration/resolution stays pure.
function makeAdapter(identifier: string): Adapter_Contract {
  return new LanguageAdapter({
    language: identifier as never,
    adapterId: `synthetic-${identifier}`,
    envCommandName: "BREAKPILOT_TEST_SYNTHETIC"
  });
}

// A valid language identifier (Requirement 2.2): non-empty after trimming and
// at most 64 chars. We also keep it case-insensitively disjoint from the four
// defaults so every generated registration is guaranteed to succeed.
const identifierArb = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter(
    (s) =>
      s.trim().length > 0 &&
      s.length <= 64 &&
      !DEFAULTS_LOWER.has(s.toLowerCase())
  );

// A sequence of pairwise-distinct (case-insensitively) identifiers, so the
// registrations are all valid and non-colliding.
const distinctIdentifiersArb = fc.uniqueArray(identifierArb, {
  minLength: 0,
  maxLength: 8,
  selector: (s) => s.toLowerCase()
});

await fc.assert(
  fc.property(distinctIdentifiersArb, (ids) => {
    const registry = new AdapterRegistry();

    // Empty-case substitute: a fresh registry lists exactly the four defaults
    // (case-insensitive set, no duplicates).
    const baseline = registry.listIdentifiers();
    assert.equal(baseline.length, DEFAULTS_LOWER.size, "no duplicate baseline ids");
    assert.deepEqual(
      new Set(baseline.map((id) => id.toLowerCase())),
      DEFAULTS_LOWER
    );

    // Track the set of registered identifiers (lowercased) and every registered
    // adapter's original-case identifier + instance, so we can assert listing
    // completeness and resolution preservation after each registration.
    const expectedLower = new Set(baseline.map((id) => id.toLowerCase()));
    const registered: Array<{ id: string; instance: Adapter_Contract }> = [];
    for (const id of baseline) {
      registered.push({ id, instance: registry.get(id as never) });
    }

    for (const id of ids) {
      const adapter = makeAdapter(id);
      registry.register(adapter);
      expectedLower.add(id.toLowerCase());
      registered.push({ id, instance: adapter });

      // (a) listIdentifiers() as a case-insensitive set equals exactly the set
      //     of all identifiers registered so far, with no duplicates.
      const listed = registry.listIdentifiers();
      assert.equal(
        listed.length,
        expectedLower.size,
        "listing has no duplicate identifiers"
      );
      assert.deepEqual(
        new Set(listed.map((x) => x.toLowerCase())),
        expectedLower,
        "listing equals the registered identifier set (case-insensitive)"
      );

      // (b) Every previously registered adapter still resolves to its ORIGINAL
      //     instance (===), unchanged by the new registration (Requirement 12.5).
      for (const entry of registered) {
        assert.equal(
          registry.get(entry.id as never),
          entry.instance,
          `resolution preserved for "${entry.id}"`
        );
      }
    }
  }),
  { numRuns: RUNS }
);

console.log("registry listing completeness and resolution preservation property tests ok");
