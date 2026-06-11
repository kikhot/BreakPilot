/**
 * Property-based test for unknown-resolution context (Task 3.5).
 *
 * Runner: node --experimental-strip-types test/registry-unknown-resolution.property.test.ts
 *
 * Covers the design's Correctness Property 6 (Unknown resolution reports the
 * identifier and the full registered list): for any identifier that is not
 * present in the registry (compared case-insensitively against the registered
 * set), AdapterRegistry.get() throws a BreakPilotError with code
 * UNSUPPORTED_LANGUAGE whose details include the requested identifier and a
 * `supported` array equal to the registry's full list of registered
 * identifiers.
 *
 * Validates: Requirements 2.5
 */

// Feature: pluggable-debug-adapters, Property 6: Unknown resolution reports the identifier and the full registered list

import assert from "node:assert/strict";
import fc from "fast-check";
import { AdapterRegistry } from "../src/debug-adapters/AdapterRegistry.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";

const RUNS = 200;

// A fresh registry carries exactly the default set: python/node/typescript/java.
// We capture its registered identifiers (original case) and a lowercased set to
// filter generated identifiers against, ensuring they are case-insensitively
// disjoint from the registered set (i.e. guaranteed NOT registered).
const referenceRegistry = new AdapterRegistry();
const registeredLower = new Set(
  referenceRegistry.listIdentifiers().map((id) => id.toLowerCase())
);

// Generate identifiers that are non-empty after coercion and not present in the
// registry case-insensitively. We filter against the lowercased registered set.
const unknownIdentifierArb = fc
  .string({ minLength: 1, maxLength: 80 })
  .filter((id) => !registeredLower.has(id.toLowerCase()));

await fc.assert(
  fc.property(unknownIdentifierArb, (identifier) => {
    // Use a fresh registry per run so the property never depends on prior state.
    const registry = new AdapterRegistry();
    const expectedSupported = registry.listIdentifiers();

    // get() on an unregistered identifier must throw.
    let thrown: unknown;
    try {
      registry.get(identifier as never);
      assert.fail(`expected get(${JSON.stringify(identifier)}) to throw`);
    } catch (error) {
      thrown = error;
    }

    // It must be a BreakPilotError with code UNSUPPORTED_LANGUAGE.
    assert.ok(
      thrown instanceof BreakPilotError,
      "error should be a BreakPilotError"
    );
    assert.equal(thrown.code, ErrorCodes.UNSUPPORTED_LANGUAGE);

    // details.language echoes the requested identifier exactly.
    assert.equal(thrown.details.language, identifier);

    // details.supported equals the registry's full registered list.
    assert.deepEqual(thrown.details.supported, expectedSupported);
  }),
  { numRuns: RUNS }
);

console.log("registry unknown-resolution context property tests ok");
