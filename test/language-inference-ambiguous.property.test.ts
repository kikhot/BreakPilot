/**
 * Property-based test for ambiguous extension rejection (Task 5.5).
 *
 * Runner: node --experimental-strip-types test/language-inference-ambiguous.property.test.ts
 *
 * Covers the design's Correctness Property 19 (Ambiguous extension is rejected
 * and lists matches): for any source file path whose extension matches two or
 * more registered adapters, LanguageResolver (given no explicit language)
 * throws a BreakPilotError with code INVALID_ARGUMENT whose details.matches
 * lists exactly the matching language identifiers.
 *
 * The default registry (python/node/typescript/java) declares pairwise-disjoint
 * extensions, so this test deliberately CREATES ambiguity: it builds a fresh
 * AdapterRegistry and registers two-or-more synthetic LanguageAdapter instances
 * that all declare the same generated source-file extension. That shared
 * extension is then offered to the resolver via `program`, which must reject it
 * as ambiguous.
 *
 * Validates: Requirements 13.6
 */

// Feature: pluggable-debug-adapters, Property 19: Ambiguous extension is rejected and lists matches

import assert from "node:assert/strict";
import fc from "fast-check";
import { AdapterRegistry } from "../src/debug-adapters/AdapterRegistry.ts";
import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import { LanguageResolver } from "../src/sessions/LanguageResolver.ts";
import type { Adapter_Contract } from "../src/debug-adapters/types.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";

const RUNS = 200;

// Derive the default set's identifiers and declared extensions from a fresh
// registry so the generators stay correct even if the defaults change. We keep
// generated identifiers disjoint from the defaults (so registration succeeds)
// and the shared extension disjoint from default extensions (so the matches set
// equals exactly our synthetic adapters, with no default adapter sneaking in).
const referenceRegistry = new AdapterRegistry();
const DEFAULTS_LOWER = new Set(
  referenceRegistry.listIdentifiers().map((id) => id.toLowerCase())
);
const DEFAULT_EXTENSIONS_LOWER = new Set<string>();
for (const id of referenceRegistry.listIdentifiers()) {
  for (const ext of referenceRegistry.get(id as never).metadata.fileExtensions ?? []) {
    DEFAULT_EXTENSIONS_LOWER.add(ext.toLowerCase());
  }
}

// A synthetic adapter on the base LanguageAdapter that declares a single source
// file extension. It holds no resources and spawns nothing, so registration and
// resolution stay pure.
function makeAdapter(identifier: string, extension: string): Adapter_Contract {
  return new LanguageAdapter({
    language: identifier as never,
    adapterId: `synthetic-${identifier}`,
    envCommandName: "BREAKPILOT_TEST_SYNTHETIC",
    fileExtensions: [extension]
  });
}

// A lowercase-letters extension (".abc"), disjoint from the default extensions.
// Lowercase + no embedded dots keeps `path.extname("x" + ext)` equal to `ext`.
const lowerAlpha = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split(""));
const extensionArb = fc
  .array(lowerAlpha, { minLength: 1, maxLength: 8 })
  .map((chars) => `.${chars.join("")}`)
  .filter((ext) => !DEFAULT_EXTENSIONS_LOWER.has(ext));

// A valid language identifier (Requirement 2.2): non-empty after trimming and
// at most 64 chars, kept case-insensitively disjoint from the defaults.
const identifierArb = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter(
    (s) =>
      s.trim().length > 0 &&
      s.length <= 64 &&
      !DEFAULTS_LOWER.has(s.toLowerCase())
  );

// Two-or-more pairwise-distinct (case-insensitively) identifiers, so all of the
// synthetic registrations are valid and non-colliding, and the extension is
// genuinely ambiguous (matches >= 2).
const languagesArb = fc.uniqueArray(identifierArb, {
  minLength: 2,
  maxLength: 5,
  selector: (s) => s.toLowerCase()
});

await fc.assert(
  fc.property(extensionArb, languagesArb, (extension, languages) => {
    // Fresh registry per run so the property never depends on prior state.
    const registry = new AdapterRegistry();
    for (const language of languages) {
      registry.register(makeAdapter(language, extension));
    }
    const resolver = new LanguageResolver(registry);

    // Resolving a source path with the shared extension and no explicit
    // language must throw because the extension is ambiguous.
    let thrown: unknown;
    try {
      resolver.resolve({ program: `x${extension}`, request: "launch" });
      assert.fail(
        `expected ambiguous extension "${extension}" to throw`
      );
    } catch (error) {
      thrown = error;
    }

    // It must be a BreakPilotError with code INVALID_ARGUMENT.
    assert.ok(
      thrown instanceof BreakPilotError,
      "error should be a BreakPilotError"
    );
    assert.equal(thrown.code, ErrorCodes.INVALID_ARGUMENT);

    // details.matches must list exactly the matching language identifiers.
    assert.ok(
      Array.isArray(thrown.details.matches),
      "details.matches should be an array"
    );
    assert.deepEqual(
      new Set(thrown.details.matches as string[]),
      new Set(languages),
      "matches (as a set) equals the set of languages declaring the extension"
    );
  }),
  { numRuns: RUNS }
);

console.log("language inference ambiguous-extension rejection property tests ok");
