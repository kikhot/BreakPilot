// Feature: pluggable-debug-adapters, Property 21: Tool schema reflects the registry dynamically
/**
 * Property-based test for the dynamic tool schema (Task 6.2).
 *
 * Runner: node --experimental-strip-types test/tool-schema-dynamic.property.test.ts
 *
 * Property 21: Tool schema reflects the registry dynamically.
 *   For any set of registered adapters, ToolRouter.listTools() advertises a
 *   `language` enum for bp_debug_start equal (as a set) to the set of registered
 *   language identifiers, and `language` is NOT a required field. The static
 *   `toolDefinitions` source is never mutated.
 *
 * Validates: Requirements 14.1, 14.2, 14.3
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import { ToolRouter } from "../src/control/ToolRouter.ts";
import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";

const RUNS = 200;

// A fresh registry pre-registers exactly python/node/typescript/java. Generated
// synthetic identifiers must be case-insensitively disjoint from this set so
// register() does not collide with a default adapter (Requirement 2.3).
const defaultLower = new Set(
  new DebugSessionManager({ policy: loadPolicy() }).adapters
    .listIdentifiers()
    .map((id) => id.toLowerCase())
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
const identifierChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")
);

// A VALID identifier: non-empty, <= 64 chars, contains at least one letter, and
// case-insensitively disjoint from the default set.
const validIdentifierArb = fc
  .array(identifierChar, { minLength: 1, maxLength: 64 })
  .map((chars) => chars.join(""))
  .filter((id) => /[a-zA-Z]/.test(id))
  .filter((id) => !defaultLower.has(id.toLowerCase()));

// A set of synthetic adapters with distinct (case-insensitively unique)
// identifiers, disjoint from the defaults. May be empty.
const syntheticIdentifiersArb = fc
  .uniqueArray(validIdentifierArb, {
    minLength: 0,
    maxLength: 8,
    selector: (id) => id.toLowerCase()
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function asSet(values: string[]): Set<string> {
  return new Set(values);
}

function findTool(tools: { name: string; inputSchema: Record<string, unknown> }[], name: string) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name} to be advertised`);
  return tool;
}

function languageEnumOf(tool: { inputSchema: Record<string, unknown> }): unknown {
  const schema = tool.inputSchema as { properties?: Record<string, { enum?: unknown }> };
  return schema.properties?.language?.enum;
}

function requiredOf(tool: { inputSchema: Record<string, unknown> }): string[] {
  const schema = tool.inputSchema as { required?: string[] };
  return schema.required ?? [];
}

// ---------------------------------------------------------------------------
// Property 21
// ---------------------------------------------------------------------------
fc.assert(
  fc.property(syntheticIdentifiersArb, (identifiers) => {
    const manager = new DebugSessionManager({ policy: loadPolicy() });
    const router = new ToolRouter(manager);

    // Register a random set of synthetic adapters into the registry.
    for (const id of identifiers) {
      manager.adapters.register(makeAdapter(id));
    }

    const expected = asSet(manager.adapters.listIdentifiers());
    // The registered set is exactly the defaults plus the synthetic ones.
    assert.equal(
      expected.size,
      defaultLower.size + identifiers.length,
      "registered identifier count should be defaults + synthetics"
    );

    const tools = router.listTools() as unknown as {
      name: string;
      inputSchema: Record<string, unknown>;
    }[];

    const toolName = "bp_debug_start";
    const tool = findTool(tools, toolName);

    // (14.1, 14.2) The language enum, as a set, equals the registered identifiers.
    const enumValue = languageEnumOf(tool);
    assert.ok(Array.isArray(enumValue), `${toolName}.language.enum should be an array`);
    assert.deepEqual(
      asSet(enumValue as string[]),
      expected,
      `${toolName}.language.enum should equal the registered identifier set`
    );

    // (14.3) language is NOT a required field.
    assert.ok(
      !requiredOf(tool).includes("language"),
      `${toolName} must not list "language" as required`
    );

    // The static toolDefinitions source must not be mutated: its language property
    // carries no enum.
    const staticTool = toolDefinitions.find((t) => t.name === toolName);
    assert.ok(staticTool, `static definition for ${toolName} should exist`);
    const staticLanguage = (staticTool!.inputSchema as {
      properties?: Record<string, { enum?: unknown }>;
    }).properties?.language;
    assert.equal(
      staticLanguage?.enum,
      undefined,
      `static toolDefinitions.${toolName}.language must have no enum (not mutated)`
    );
    const staticRequired = (staticTool!.inputSchema as { required?: string[] }).required ?? [];
    assert.ok(
      !staticRequired.includes("language"),
      `static toolDefinitions.${toolName} must not require "language"`
    );
  }),
  { numRuns: RUNS }
);

console.log("dynamic tool schema reflects registry property tests ok");
