/**
 * Property-based test for adapter disposal idempotency (Task 2.3).
 *
 * Runner: node --experimental-strip-types test/adapter-disposal.property.test.ts
 *
 * Covers the design's Correctness Property 1 (Disposal is idempotent): for any
 * adapter in any lifecycle state, calling dispose() one or more times leaves the
 * adapter in the `disposed` state, releases all held resources, and never throws
 * on subsequent calls. We exercise the base LanguageAdapter plus the concrete
 * Python, Node, TypeScript, and Java adapters through a randomly generated
 * sequence of lifecycle operations (initialize/dispose, varying counts, before
 * and after disposal).
 *
 * Validates: Requirements 1.2
 */

// Feature: pluggable-debug-adapters, Property 1: Disposal is idempotent

import assert from "node:assert/strict";
import fc from "fast-check";
import {
  LanguageAdapter,
  NodeAdapter,
  PythonAdapter
} from "../src/debug-adapters/LanguageAdapter.ts";
import { JavaAdapter } from "../src/debug-adapters/java/JavaAdapter.ts";
import type { Adapter_Contract, AdapterContext } from "../src/debug-adapters/types.ts";

const RUNS = 200;

// ---------------------------------------------------------------------------
// Adapter factories: cover the base class and every concrete adapter so the
// property holds across all lifecycle implementations.
// ---------------------------------------------------------------------------

const adapterFactories: Array<{ name: string; make: () => Adapter_Contract }> = [
  {
    name: "base",
    make: () =>
      new LanguageAdapter({
        language: "python",
        adapterId: "base-test",
        envCommandName: "BREAKPILOT_TEST_ADAPTER"
      })
  },
  { name: "python", make: () => new PythonAdapter() },
  { name: "node", make: () => new NodeAdapter("node") },
  { name: "typescript", make: () => new NodeAdapter("typescript") },
  { name: "java", make: () => new JavaAdapter() }
];

const adapterArb = fc.constantFrom(...adapterFactories);

// A minimal, valid AdapterContext for initialize(). The base initialize() holds
// no resources, so this never touches the filesystem or spawns processes.
const ctx: AdapterContext = { workspaceRoot: process.cwd(), env: {}, args: {} };

// ---------------------------------------------------------------------------
// Operation sequence: a random interleaving of initialize/dispose. We guarantee
// at least one dispose() so the idempotency contract is always exercised.
// ---------------------------------------------------------------------------

type Op = "initialize" | "dispose";

const opArb = fc.constantFrom<Op>("initialize", "dispose");

const opSequenceArb = fc
  .array(opArb, { minLength: 0, maxLength: 8 })
  // Append extra dispose() calls so the sequence always disposes at least once
  // and frequently disposes repeatedly (the core idempotency case).
  .chain((ops) =>
    fc
      .integer({ min: 1, max: 4 })
      .map((extraDisposes) => [...ops, ...Array<Op>(extraDisposes).fill("dispose")])
  );

// ---------------------------------------------------------------------------
// Property 1: For any adapter and any sequence containing >=1 dispose(), every
// dispose() call resolves without throwing, leaves state === "disposed", and a
// subsequent dispose() remains a no-op that never throws.
// ---------------------------------------------------------------------------

await fc.assert(
  fc.asyncProperty(adapterArb, opSequenceArb, async (factory, ops) => {
    const adapter = factory.make();
    let disposedAtLeastOnce = false;

    for (const op of ops) {
      if (op === "initialize") {
        // initialize() is only valid before disposal; after dispose() the
        // contract rejects re-initialization. That rejection is expected and is
        // NOT part of this property, so we tolerate it here. dispose() itself,
        // tested below, must never throw.
        try {
          await adapter.initialize(ctx);
        } catch {
          // Re-initialization after disposal is a defined error; ignore it.
        }
      } else {
        // dispose() must NEVER throw, in ANY state (Requirement 1.2).
        await adapter.dispose();
        disposedAtLeastOnce = true;
        // After any dispose() the adapter is in the terminal `disposed` state.
        assert.equal(adapter.state, "disposed");
      }
    }

    // Sequence always contains at least one dispose() by construction.
    assert.ok(disposedAtLeastOnce);
    assert.equal(adapter.state, "disposed");

    // One more dispose() after the sequence is still a no-op that never throws
    // and leaves the adapter disposed.
    await adapter.dispose();
    assert.equal(adapter.state, "disposed");
  }),
  { numRuns: RUNS }
);

console.log("adapter disposal idempotency property tests ok");
