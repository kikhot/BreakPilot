// Feature: pluggable-debug-adapters, Property 8: Validation result shape and availability consistency
/**
 * Property-based test for the Adapter_Contract validation surface (Task 2.5).
 *
 * Runner: node --experimental-strip-types test/adapter-validation.property.test.ts
 *
 * Property 8 — Validation result shape and availability consistency:
 *   For any registered adapter,
 *     - validateEnvironment() resolves to an object with a boolean `available`
 *       and array `errors` / `warnings`;
 *     - getRequiredDependencies() returns entries each with a non-empty `name`;
 *     - whenever `available` is true the `errors` list is empty.
 *
 * Adapters are drawn from the default set (PythonAdapter, NodeAdapter("node"),
 * NodeAdapter("typescript")) and from synthetic LanguageAdapter instances with
 * arbitrary metadata. Availability is varied deterministically by constructing
 * adapters with present vs. absent commands and by toggling the per-adapter
 * environment-variable command override. The test is hermetic: every relevant
 * environment variable is snapshotted before a run and restored afterward.
 *
 * Validates: Requirements 3.1, 3.2
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import {
  LanguageAdapter,
  NodeAdapter,
  PythonAdapter
} from "../src/debug-adapters/LanguageAdapter.ts";
import type { Adapter_Contract } from "../src/debug-adapters/types.ts";
import type { DebugLanguage } from "../src/types/debug.ts";

const RUNS = 200;

// An absolute path that is guaranteed to exist and be a file: the running Node
// binary. Using it as a command exercises the "available: true" branch of the
// base validateEnvironment() (resolveExecutablePath finds an absolute file).
const PRESENT_COMMAND = process.execPath;
// A command that resolves on neither PATH nor as a file -> "available: false".
const MISSING_COMMAND = "breakpilot-definitely-missing-cmd-zzz";

// Environment keys the default and synthetic adapters consult. Snapshotted and
// restored around every property run so the test never leaks env mutations.
const SYNTHETIC_ENV = "BREAKPILOT_SYNTHETIC_ADAPTER_CMD";
const RELEVANT_ENV_KEYS = [
  "BREAKPILOT_PYTHON_ADAPTER",
  "BREAKPILOT_JS_DEBUG_COMMAND",
  "BREAKPILOT_JS_DEBUG_ARGS",
  "BREAKPILOT_JAVA_ADAPTER_COMMAND",
  SYNTHETIC_ENV
];

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// A command-shaped value: absent, a real file, or a bogus name. Whitespace/empty
// values are intentionally excluded from *defaultCommand* because a registered
// adapter declares meaningful dependency names; they ARE exercised as env
// overrides below (where they drive the "override ignored" / unavailable path).
const commandArb = fc.constantFrom<string | undefined>(
  undefined,
  PRESENT_COMMAND,
  MISSING_COMMAND
);

// Override value to assign to the adapter's envCommandName at validation time.
// "UNSET" means leave the variable absent.
const envOverrideArb = fc.constantFrom<string>(
  "UNSET",
  PRESENT_COMMAND,
  MISSING_COMMAND,
  "",
  "   "
);

const syntheticLanguageArb = fc.oneof(
  fc.constantFrom("ruby", "go", "rust", "kotlin", "elixir", "scala"),
  fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0)
);

type AdapterSpec =
  | { kind: "python"; envOverride: string }
  | { kind: "node"; envOverride: string }
  | { kind: "typescript"; envOverride: string }
  | {
      kind: "synthetic";
      language: string;
      displayName: string | undefined;
      defaultCommand: string | undefined;
      supportsAttach: boolean;
      envOverride: string;
    };

const adapterSpecArb: fc.Arbitrary<AdapterSpec> = fc.oneof(
  envOverrideArb.map((envOverride) => ({ kind: "python" as const, envOverride })),
  envOverrideArb.map((envOverride) => ({ kind: "node" as const, envOverride })),
  envOverrideArb.map((envOverride) => ({ kind: "typescript" as const, envOverride })),
  fc.record({
    kind: fc.constant("synthetic" as const),
    language: syntheticLanguageArb,
    displayName: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
    defaultCommand: commandArb,
    supportsAttach: fc.boolean(),
    envOverride: envOverrideArb
  })
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of keys) snapshot.set(key, process.env[key]);
  return snapshot;
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function buildAdapter(spec: AdapterSpec): Adapter_Contract {
  switch (spec.kind) {
    case "python":
      return new PythonAdapter();
    case "node":
      return new NodeAdapter("node");
    case "typescript":
      return new NodeAdapter("typescript");
    case "synthetic":
      return new LanguageAdapter({
        language: spec.language as DebugLanguage,
        adapterId: `synthetic-${spec.language}`,
        defaultCommand: spec.defaultCommand,
        envCommandName: SYNTHETIC_ENV,
        displayName: spec.displayName,
        fileExtensions: [`.${spec.language}`],
        supportsAttach: spec.supportsAttach
      });
  }
}

function envCommandNameFor(spec: AdapterSpec): string {
  switch (spec.kind) {
    case "python":
      return "BREAKPILOT_PYTHON_ADAPTER";
    case "node":
    case "typescript":
      return "BREAKPILOT_JS_DEBUG_COMMAND";
    case "synthetic":
      return SYNTHETIC_ENV;
  }
}

// ---------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------

await fc.assert(
  fc.asyncProperty(adapterSpecArb, async (spec) => {
    const snapshot = snapshotEnv(RELEVANT_ENV_KEYS);
    try {
      // Start from a clean baseline so adapter construction is deterministic
      // (e.g. NodeAdapter reads BREAKPILOT_JS_DEBUG_COMMAND at construction).
      for (const key of RELEVANT_ENV_KEYS) delete process.env[key];

      const adapter = buildAdapter(spec);

      // Apply the env override consulted live by validateEnvironment().
      if (spec.envOverride !== "UNSET") {
        process.env[envCommandNameFor(spec)] = spec.envOverride;
      }

      // getRequiredDependencies(): array whose entries each have a non-empty name.
      const deps = adapter.getRequiredDependencies();
      assert.ok(Array.isArray(deps), "getRequiredDependencies must return an array");
      for (const dep of deps) {
        assert.equal(typeof dep.name, "string", "dependency name must be a string");
        assert.ok(dep.name.trim().length > 0, "dependency name must be non-empty");
      }

      // validateEnvironment(): result-shape invariants.
      const result = await adapter.validateEnvironment();
      assert.equal(typeof result.available, "boolean", "`available` must be boolean");
      assert.ok(Array.isArray(result.errors), "`errors` must be an array");
      assert.ok(Array.isArray(result.warnings), "`warnings` must be an array");

      // Availability consistency: available => no errors.
      if (result.available === true) {
        assert.equal(
          result.errors.length,
          0,
          "an available adapter must report zero errors"
        );
      }
    } finally {
      restoreEnv(snapshot);
    }
  }),
  { numRuns: RUNS }
);

console.log("adapter validation property test ok");
