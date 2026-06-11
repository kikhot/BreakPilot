// Feature: pluggable-debug-adapters, Property 4: Invalid identifiers are rejected without mutating the registry
/**
 * Property-based test for invalid-identifier rejection without mutation (Task 3.3).
 *
 * Runner: node --experimental-strip-types test/registry-invalid-identifier.property.test.ts
 *
 * Property 4: Invalid identifiers are rejected without mutating the registry.
 *   For any identifier that is empty, whitespace-only, or longer than 64
 *   characters, AdapterRegistry.register() throws a BreakPilotError with code
 *   INVALID_LANGUAGE_IDENTIFIER that contains the rejected identifier, and the
 *   set of registered identifiers is unchanged.
 *
 * Validates: Requirements 2.2
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { AdapterRegistry } from "../src/debug-adapters/AdapterRegistry.ts";
import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";

const RUNS = 200;

// ---------------------------------------------------------------------------
// Synthetic adapter whose metadata.language is the (invalid) generated
// identifier. Construction never validates the identifier; rejection happens at
// register(). adapterId/envCommandName are harmless placeholders.
// ---------------------------------------------------------------------------
function makeAdapter(identifier: string): LanguageAdapter {
  return new LanguageAdapter({
    language: identifier,
    adapterId: "synthetic-test-adapter",
    envCommandName: "BREAKPILOT_SYNTHETIC_TEST_ADAPTER"
  });
}

// ---------------------------------------------------------------------------
// Generators for the three invalid-identifier classes (Requirement 2.2):
//   - empty string
//   - whitespace-only strings
//   - strings longer than 64 characters
// Each class is guaranteed to be rejected by the registry's validation.
// ---------------------------------------------------------------------------

const emptyIdentifier = fc.constant("");

const whitespaceOnlyIdentifier = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), {
    minLength: 1,
    maxLength: 16
  })
  .map((chars) => chars.join(""));

const overLongIdentifier = fc
  .string({ minLength: 65, maxLength: 200 })
  // Ensure length-based rejection regardless of trimming: pad to >64 with a
  // stable non-whitespace prefix so the only rejection reason is length.
  .map((s) => `x${s}`)
  .filter((s) => s.length > 64);

const invalidIdentifier = fc.oneof(
  emptyIdentifier,
  whitespaceOnlyIdentifier,
  overLongIdentifier
);

// ---------------------------------------------------------------------------
// Property 4: register() rejects an invalid identifier with an
// INVALID_LANGUAGE_IDENTIFIER error that includes the rejected identifier, and
// leaves the registered-identifier set unchanged.
// ---------------------------------------------------------------------------
fc.assert(
  fc.property(invalidIdentifier, (identifier) => {
    const registry = new AdapterRegistry();
    const before = registry.listIdentifiers();

    let thrown: unknown;
    try {
      registry.register(makeAdapter(identifier));
      assert.fail(
        `expected register() to throw for invalid identifier ${JSON.stringify(identifier)}`
      );
    } catch (error) {
      thrown = error;
    }

    // It must be a BreakPilotError with the INVALID_LANGUAGE_IDENTIFIER code.
    assert.ok(
      thrown instanceof BreakPilotError,
      `expected a BreakPilotError, got ${String(thrown)}`
    );
    assert.equal((thrown as BreakPilotError).code, ErrorCodes.INVALID_LANGUAGE_IDENTIFIER);

    // The error must carry the rejected identifier (in details and message).
    assert.deepEqual((thrown as BreakPilotError).details.identifier, identifier);
    assert.ok(
      (thrown as BreakPilotError).message.includes(JSON.stringify(identifier)),
      `expected message to include the rejected identifier, got: ${(thrown as BreakPilotError).message}`
    );

    // The set of registered identifiers must be unchanged.
    const after = registry.listIdentifiers();
    assert.deepEqual(after, before);
    assert.ok(!registry.has(identifier));
  }),
  { numRuns: RUNS }
);

console.log("registry invalid-identifier rejection property tests ok");
