// Feature: pluggable-debug-adapters, Property 9: Capability report is complete and propagates unavailability
/**
 * Property-based test for the Capability_Reporter (Task 7.2).
 *
 * Runner: node --experimental-strip-types test/capability-reporter.property.test.ts
 *
 * Property 9 — Capability report is complete and propagates unavailability:
 *   For any set of registered adapters (the four defaults plus arbitrarily many
 *   synthetic adapters with distinct, default-disjoint identifiers),
 *   CapabilityReporter.report() returns EXACTLY one entry per registered
 *   language, each populated with `language`, `displayName`, `supportsAttach`,
 *   and an `availability` result; and for any adapter whose validateEnvironment()
 *   yields `available: false`, the matching report entry is unavailable and
 *   includes that validation's errors.
 *
 * Availability is controlled deterministically with a small synthetic
 * LanguageAdapter subclass that overrides validateEnvironment() to return a
 * chosen ValidationResult, so the property holds regardless of the host
 * toolchain. The AuditLogger is constructed exactly as production code does
 * (`new AuditLogger(policy)`) with a minimal audit-disabled policy, keeping the
 * test hermetic (no file writes).
 *
 * Validates: Requirements 3.3, 3.4, 12.2
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { AdapterRegistry } from "../src/debug-adapters/AdapterRegistry.ts";
import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import type { ValidationResult } from "../src/debug-adapters/types.ts";
import type { DebugLanguage } from "../src/types/debug.ts";
import { CapabilityReporter } from "../src/control/CapabilityReporter.ts";
import { AuditLogger } from "../src/audit/AuditLogger.ts";
import type { BreakPilotPolicy } from "../src/types/policy.ts";

const RUNS = 200;

// Minimal, audit-disabled policy: AuditLogger only reads policy.audit?.enabled
// and policy.audit?.file. Disabling audit makes report() record a no-op,
// keeping the test hermetic (no filesystem writes).
const HERMETIC_POLICY = {
  audit: { enabled: false, file: "" }
} as unknown as BreakPilotPolicy;

// The default identifiers seeded by every fresh registry, lowercased. Synthetic
// identifiers are generated disjoint from these so registration never collides.
const DEFAULTS_LOWER = new Set(
  new AdapterRegistry().listIdentifiers().map((id) => id.toLowerCase())
);

/**
 * Synthetic adapter whose environment validation is fixed at construction time.
 * Lets the property drive `available`/`errors`/`warnings` deterministically
 * without touching the real toolchain.
 */
class SyntheticAdapter extends LanguageAdapter {
  #result: ValidationResult;

  constructor(identifier: string, displayName: string, supportsAttach: boolean, result: ValidationResult) {
    super({
      language: identifier as DebugLanguage,
      adapterId: `synthetic-${identifier}`,
      envCommandName: "BREAKPILOT_TEST_SYNTHETIC",
      displayName,
      fileExtensions: [`.${identifier}`],
      supportsAttach
    });
    this.#result = result;
  }

  override async validateEnvironment(): Promise<ValidationResult> {
    // Return a fresh copy so callers cannot mutate our oracle.
    return {
      available: this.#result.available,
      errors: [...this.#result.errors],
      warnings: [...this.#result.warnings]
    };
  }
}

// A valid, default-disjoint language identifier (Requirement 2.2): non-empty
// after trimming, at most 64 chars, and not one of the four defaults.
const identifierArb = fc
  .string({ minLength: 1, maxLength: 32 })
  .filter((s) => s.trim().length > 0 && !DEFAULTS_LOWER.has(s.toLowerCase()));

const validationResultArb: fc.Arbitrary<ValidationResult> = fc.record({
  available: fc.boolean(),
  errors: fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 4 }),
  warnings: fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 4 })
});

const syntheticSpecArb = fc.record({
  identifier: identifierArb,
  displayName: fc.string({ maxLength: 24 }),
  supportsAttach: fc.boolean(),
  result: validationResultArb
});

// A set of synthetic specs with pairwise-distinct (case-insensitive)
// identifiers, so all registrations succeed without collision.
const syntheticSpecsArb = fc.uniqueArray(syntheticSpecArb, {
  minLength: 0,
  maxLength: 8,
  selector: (spec) => spec.identifier.toLowerCase()
});

await fc.assert(
  fc.asyncProperty(syntheticSpecsArb, async (specs) => {
    const registry = new AdapterRegistry();

    // Register the synthetic adapters alongside the four defaults.
    for (const spec of specs) {
      registry.register(
        new SyntheticAdapter(spec.identifier, spec.displayName, spec.supportsAttach, spec.result)
      );
    }

    const reporter = new CapabilityReporter(registry, new AuditLogger(HERMETIC_POLICY));
    const report = await reporter.report();

    // (1) Completeness: exactly one entry per registered identifier, no extras,
    //     no duplicates (compared case-insensitively).
    const expectedLower = new Set(
      registry.listIdentifiers().map((id) => id.toLowerCase())
    );
    const reportedLanguages = report.map((entry) => entry.language.toLowerCase());
    assert.equal(
      reportedLanguages.length,
      expectedLower.size,
      "report has exactly one entry per registered language (no duplicates)"
    );
    assert.deepEqual(
      new Set(reportedLanguages),
      expectedLower,
      "report languages equal the registered identifier set (case-insensitive)"
    );

    // (2) Shape: every entry is fully populated.
    for (const entry of report) {
      assert.equal(typeof entry.language, "string", "`language` must be a string");
      assert.ok(entry.language.length > 0, "`language` must be non-empty");
      assert.equal(typeof entry.displayName, "string", "`displayName` must be a string");
      assert.equal(typeof entry.supportsAttach, "boolean", "`supportsAttach` must be boolean");
      assert.ok(entry.availability, "`availability` must be present");
      assert.equal(
        typeof entry.availability.available,
        "boolean",
        "`availability.available` must be boolean"
      );
      assert.ok(Array.isArray(entry.availability.errors), "`availability.errors` must be an array");
      assert.ok(Array.isArray(entry.availability.warnings), "`availability.warnings` must be an array");
    }

    // (3) Unavailability propagation: every synthetic adapter we forced to
    //     `available: false` has a matching unavailable entry that includes the
    //     forced errors verbatim.
    const byLanguage = new Map(report.map((entry) => [entry.language.toLowerCase(), entry]));
    for (const spec of specs) {
      if (spec.result.available === false) {
        const entry = byLanguage.get(spec.identifier.toLowerCase());
        assert.ok(entry, `report includes an entry for forced-unavailable "${spec.identifier}"`);
        assert.equal(
          entry.availability.available,
          false,
          `entry for "${spec.identifier}" must be unavailable`
        );
        for (const forcedError of spec.result.errors) {
          assert.ok(
            entry.availability.errors.includes(forcedError),
            `entry for "${spec.identifier}" must include forced error "${forcedError}"`
          );
        }
      }
    }
  }),
  { numRuns: RUNS }
);

console.log("capability reporter completeness and unavailability propagation property tests ok");
