/**
 * Property-based test for single-match language inference (Task 5.3).
 *
 * Runner: node --experimental-strip-types test/language-inference-single.property.test.ts
 *
 * Covers the design's Correctness Property 17 (Single-match language inference
 * is correct): for any source file path whose extension maps to exactly one
 * registered adapter through the FileExtensionMap, LanguageResolver — given no
 * explicit language — resolves to that single adapter.
 *
 * The default AdapterRegistry maps disjoint, single-owner extensions
 * (.py → python, .js/.cjs/.mjs → node, .ts → typescript). We generate a random
 * directory prefix + base name + one of these single-mapped extensions (with
 * randomized letter case) and assert the inferred language is the expected
 * owner, both via `program`/"launch" and via `file`/"attach".
 *
 * Validates: Requirements 13.2, 13.3
 */

// Feature: pluggable-debug-adapters, Property 17: Single-match language inference is correct

import assert from "node:assert/strict";
import fc from "fast-check";
import { AdapterRegistry } from "../src/debug-adapters/AdapterRegistry.ts";
import { FileExtensionMap, LanguageResolver } from "../src/sessions/LanguageResolver.ts";

const RUNS = 200;

// Build the set of extensions that the default registry maps to EXACTLY one
// registered adapter, paired with that adapter's expected language. Derived
// entirely from the live registry's declared file extensions (not hardcoded)
// so the property stays correct as defaults evolve; the single-owner filter
// keeps it precisely about Property 17.
const registryForSetup = new AdapterRegistry();
const map = FileExtensionMap.fromRegistry(registryForSetup);
const declaredExtensions = new Set<string>();
for (const id of registryForSetup.listIdentifiers()) {
  for (const ext of registryForSetup.get(id).metadata.fileExtensions ?? []) {
    const normalized = FileExtensionMap.normalizeExtension(ext);
    if (normalized) declaredExtensions.add(normalized);
  }
}

const singleMapped: Array<{ ext: string; language: string }> = [];
for (const ext of declaredExtensions) {
  const matches = map.match(ext);
  if (matches.length === 1) {
    singleMapped.push({ ext, language: matches[0]! });
  }
}
assert.ok(singleMapped.length > 0, "expected at least one single-mapped extension");

// Randomize the case of each character of an extension (incl. the leading dot,
// which is unaffected). Inference must be case-insensitive (13.2).
function randomCase(ext: string, mask: boolean[]): string {
  let out = "";
  for (let i = 0; i < ext.length; i++) {
    const ch = ext[i]!;
    out += mask[i % mask.length] ? ch.toUpperCase() : ch.toLowerCase();
  }
  return out;
}

// A path-safe-ish segment: non-empty, no path separators or dots, so the only
// extension on the path is the one we deliberately append.
const segmentArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => s.replace(/[./\\]/g, "_"))
  .filter((s) => s.trim().length > 0);

// Zero or more directory segments forming a random prefix.
const dirsArb = fc.array(segmentArb, { minLength: 0, maxLength: 4 });

const extChoiceArb = fc.constantFrom(...singleMapped);
const caseMaskArb = fc.array(fc.boolean(), { minLength: 1, maxLength: 6 });

await fc.assert(
  fc.property(
    dirsArb,
    segmentArb,
    extChoiceArb,
    caseMaskArb,
    (dirs, base, choice, mask) => {
      const registry = new AdapterRegistry();
      const resolver = new LanguageResolver(registry);

      const ext = randomCase(choice.ext, mask);
      const fileName = `${base}${ext}`;
      const filePath = [...dirs, fileName].join("/");

      // Via `program` on a launch request.
      const viaProgram = resolver.resolve({ program: filePath, request: "launch" });
      assert.equal(viaProgram.language, choice.language);
      assert.equal(viaProgram.adapter.metadata.language, choice.language);

      // Via `file` on an attach request — inference applies whenever a source
      // path is present, independent of launch/attach.
      const viaFile = resolver.resolve({ file: filePath, request: "attach" });
      assert.equal(viaFile.language, choice.language);
      assert.equal(viaFile.adapter.metadata.language, choice.language);
    }
  ),
  { numRuns: RUNS }
);

console.log("single-match language inference property tests ok");
