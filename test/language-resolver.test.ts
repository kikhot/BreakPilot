/**
 * Unit tests for LanguageResolver and FileExtensionMap (Task 5.1).
 *
 * Runner: node --experimental-strip-types test/language-resolver.test.ts
 *
 * Covers the Requirement 13 resolution strategy: explicit case-insensitive
 * resolution (13.1), single-match inference (13.2/13.3), zero-match
 * UNSUPPORTED_LANGUAGE with context (13.5), ambiguous INVALID_ARGUMENT with
 * matches (13.6), no-source INVALID_ARGUMENT for launch (13.4) and attach
 * (13.8), and the absence of any silent default (13.7).
 */

import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/debug-adapters/AdapterRegistry.ts";
import { LanguageAdapter } from "../src/debug-adapters/LanguageAdapter.ts";
import { FileExtensionMap, LanguageResolver } from "../src/sessions/LanguageResolver.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";

function makeResolver(registry = new AdapterRegistry()): {
  registry: AdapterRegistry;
  resolver: LanguageResolver;
} {
  return { registry, resolver: new LanguageResolver(registry) };
}

// (13.1) Explicit language resolves case-insensitively.
{
  const { resolver } = makeResolver();
  const result = resolver.resolve({ lang: "PyThOn", request: "launch" });
  assert.equal(result.language, "python");
  assert.equal(result.adapter.metadata.language, "python");
}

// Explicit language via the `language` spelling also works.
{
  const { resolver } = makeResolver();
  const result = resolver.resolve({ language: "Java", request: "attach" });
  assert.equal(result.language, "java");
}

// Explicit unknown language surfaces UNSUPPORTED_LANGUAGE from the registry.
{
  const { resolver } = makeResolver();
  assert.throws(
    () => resolver.resolve({ lang: "cobol", request: "launch" }),
    (err: unknown) =>
      err instanceof BreakPilotError && err.code === ErrorCodes.UNSUPPORTED_LANGUAGE
  );
}

// (13.2/13.3) Single-match inference from a source program path.
{
  const { resolver } = makeResolver();
  assert.equal(resolver.resolve({ program: "src/app.py", request: "launch" }).language, "python");
  assert.equal(resolver.resolve({ program: "src/app.TS", request: "launch" }).language, "typescript");
  assert.equal(resolver.resolve({ program: "src/app.mjs", request: "launch" }).language, "node");
  // Inference also works for attach when a source path is present.
  assert.equal(resolver.resolve({ file: "src/app.js", request: "attach" }).language, "node");
}

// (13.5) Zero matches → UNSUPPORTED_LANGUAGE including the extension + ids.
{
  const { registry, resolver } = makeResolver();
  try {
    resolver.resolve({ program: "src/app.rb", request: "launch" });
    assert.fail("expected UNSUPPORTED_LANGUAGE");
  } catch (err) {
    assert.ok(err instanceof BreakPilotError);
    assert.equal(err.code, ErrorCodes.UNSUPPORTED_LANGUAGE);
    assert.equal(err.details.extension, ".rb");
    assert.deepEqual(err.details.supported, registry.listIdentifiers());
  }
}

// (13.6) Two-or-more matches → INVALID_ARGUMENT listing the matches.
{
  const registry = new AdapterRegistry();
  // A synthetic adapter that also claims ".py", making it ambiguous.
  registry.register(
    new LanguageAdapter({
      language: "pylike",
      adapterId: "synthetic-pylike",
      envCommandName: "BREAKPILOT_TEST_PYLIKE",
      fileExtensions: [".py"]
    })
  );
  const resolver = new LanguageResolver(registry);
  try {
    resolver.resolve({ program: "src/app.py", request: "launch" });
    assert.fail("expected INVALID_ARGUMENT for ambiguous extension");
  } catch (err) {
    assert.ok(err instanceof BreakPilotError);
    assert.equal(err.code, ErrorCodes.INVALID_ARGUMENT);
    assert.deepEqual(new Set(err.details.matches), new Set(["python", "pylike"]));
  }
}

// (13.4) No explicit language and no source path (launch) → INVALID_ARGUMENT.
{
  const { resolver } = makeResolver();
  try {
    resolver.resolve({ request: "launch" });
    assert.fail("expected INVALID_ARGUMENT");
  } catch (err) {
    assert.ok(err instanceof BreakPilotError);
    assert.equal(err.code, ErrorCodes.INVALID_ARGUMENT);
  }
}

// (13.8) Attach without explicit language and without a source → INVALID_ARGUMENT.
{
  const { resolver } = makeResolver();
  try {
    resolver.resolve({ request: "attach" });
    assert.fail("expected INVALID_ARGUMENT for attach without source");
  } catch (err) {
    assert.ok(err instanceof BreakPilotError);
    assert.equal(err.code, ErrorCodes.INVALID_ARGUMENT);
    assert.match(err.message, /attach/i);
  }
}

// (13.7) Empty-string lang is treated as "no explicit language", never a default.
{
  const { resolver } = makeResolver();
  try {
    resolver.resolve({ lang: "   ", request: "launch" });
    assert.fail("expected INVALID_ARGUMENT, not a python default");
  } catch (err) {
    assert.ok(err instanceof BreakPilotError);
    assert.equal(err.code, ErrorCodes.INVALID_ARGUMENT);
  }
}

// FileExtensionMap normalization is case-insensitive and dot-tolerant.
{
  assert.equal(FileExtensionMap.normalizeExtension("PY"), ".py");
  assert.equal(FileExtensionMap.normalizeExtension(".Py"), ".py");
  assert.equal(FileExtensionMap.normalizeExtension(""), "");
  assert.equal(FileExtensionMap.normalizeExtension("."), "");

  const map = FileExtensionMap.fromRegistry(new AdapterRegistry());
  assert.deepEqual(map.match(".py"), ["python"]);
  assert.deepEqual(map.match(".TS"), ["typescript"]);
  assert.deepEqual(map.match(".rb"), []);
}

// Resolver accepts a function provider returning the registry.
{
  const registry = new AdapterRegistry();
  const resolver = new LanguageResolver(() => registry);
  assert.equal(resolver.resolve({ program: "main.py", request: "launch" }).language, "python");
}

console.log("language resolver unit tests ok");
