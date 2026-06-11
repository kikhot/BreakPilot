/**
 * Property-based test for unmapped-extension rejection (Task 5.4).
 *
 * Runner: node --experimental-strip-types test/language-inference-unmapped.property.test.ts
 *
 * Covers the design's Correctness Property 18 (Unmapped extension is rejected
 * with context): for any source file path whose extension matches zero
 * registered adapters, LanguageResolver — given no explicit language — throws an
 * UNSUPPORTED_LANGUAGE error that includes the unmatched extension and the list
 * of registered language identifiers.
 *
 * Validates: Requirements 13.5
 */

// Feature: pluggable-debug-adapters, Property 18: Unmapped extension is rejected with context

import assert from "node:assert/strict";
import fc from "fast-check";
import { AdapterRegistry } from "../src/debug-adapters/AdapterRegistry.ts";
import { LanguageResolver } from "../src/sessions/LanguageResolver.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";

const RUNS = 200;

// The set of file extensions handled by the default registry, normalized to
// lowercase with a leading dot (e.g. ".py"). Built directly from the registered
// adapters' declared metadata.fileExtensions so it tracks the defaults
// (.py / .js / .cjs / .mjs / .ts / .java).
function knownExtensions(registry: AdapterRegistry): Set<string> {
  const exts = new Set<string>();
  for (const id of registry.listIdentifiers()) {
    const adapter = registry.get(id as never);
    for (const raw of adapter.metadata.fileExtensions ?? []) {
      const ext = String(raw).trim().toLowerCase();
      if (ext) exts.add(ext.startsWith(".") ? ext : `.${ext}`);
    }
  }
  return exts;
}

const KNOWN = knownExtensions(new AdapterRegistry());

// A random base file name made of path-safe characters with no dots, so the
// extension is unambiguously the trailing ".<ext>" segment.
const baseNameArb = fc
  .stringMatching(/^[A-Za-z0-9_-]+$/)
  .filter((s) => s.length >= 1 && s.length <= 32);

// A random extension (letters/digits, possibly mixed-case) guaranteed NOT to be
// one of the registry's known extensions when normalized to lowercase.
const unknownExtArb = fc
  .stringMatching(/^[A-Za-z0-9]+$/)
  .filter((s) => s.length >= 1 && s.length <= 8)
  .filter((s) => !KNOWN.has(`.${s.toLowerCase()}`));

await fc.assert(
  fc.property(baseNameArb, unknownExtArb, (base, ext) => {
    const registry = new AdapterRegistry();
    const resolver = new LanguageResolver(registry);

    const program = `${base}.${ext}`;
    const normalizedExt = `.${ext.toLowerCase()}`;

    let thrown: unknown;
    try {
      resolver.resolve({ program, request: "launch" });
      assert.fail(`expected resolve to throw for unmapped extension "${normalizedExt}"`);
    } catch (error) {
      thrown = error;
    }

    // It must be a BreakPilotError carrying the UNSUPPORTED_LANGUAGE code.
    assert.ok(thrown instanceof BreakPilotError, "throws a BreakPilotError");
    assert.equal(thrown.code, ErrorCodes.UNSUPPORTED_LANGUAGE);

    // The error context must include the normalized (lowercased) extension...
    assert.equal(thrown.details.extension, normalizedExt);

    // ...and the full list of registered language identifiers.
    assert.deepEqual(thrown.details.supported, registry.listIdentifiers());
  }),
  { numRuns: RUNS }
);

console.log("unmapped-extension rejection property tests ok");
