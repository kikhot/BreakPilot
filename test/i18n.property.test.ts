/**
 * Property-based tests for the i18n pure functions (Task 1.3).
 *
 * Runner: node --experimental-strip-types test/i18n.property.test.ts
 *
 * Covers the design's Correctness Properties:
 * - Property 1 (locale resolution is a total function)
 * - Property 6 (translator fallback never yields blank or the raw key)
 */

import assert from "node:assert/strict";
import fc from "fast-check";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  createTranslator,
  resolveLocale,
  type Locale
} from "../src/cli/i18n.ts";

const RUNS = 1000;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A token that can never be parsed as a `--locale` flag (noise). */
const noiseToken = fc
  .string()
  .filter((token) => token !== "--locale" && !token.startsWith("--locale="));

/** A string that is NOT a supported locale value. */
const unsupportedValue = fc
  .string()
  .filter((value) => !(SUPPORTED_LOCALES as string[]).includes(value));

/** Build a `--locale` argument pair/equals form for a given value. */
const localeArgFor = (value: string) =>
  fc.oneof(
    fc.constant<string[]>(["--locale", value]),
    fc.constant<string[]>([`--locale=${value}`])
  );

const validLocaleArg = fc
  .constantFrom<Locale>(...SUPPORTED_LOCALES)
  .chain((loc) => localeArgFor(loc).map((arg) => ({ loc, arg })));

const invalidLocaleArg = unsupportedValue.chain((value) => localeArgFor(value));

// ---------------------------------------------------------------------------
// Property 1: locale resolution is a total function
// Validates: Requirements 13.1, 13.3, 13.4
// ---------------------------------------------------------------------------

// 1a. For ANY argv array, resolveLocale never throws and always returns a
//     supported locale.
fc.assert(
  fc.property(fc.array(fc.string()), (argv) => {
    const result = resolveLocale(argv);
    assert.ok(
      (SUPPORTED_LOCALES as string[]).includes(result),
      `resolveLocale returned unsupported locale: ${String(result)}`
    );
  }),
  { numRuns: RUNS }
);

// 1b. When there is no `--locale` token at all, the default locale is returned.
fc.assert(
  fc.property(fc.array(noiseToken), (argv) => {
    assert.equal(resolveLocale(argv), DEFAULT_LOCALE);
  }),
  { numRuns: RUNS }
);

// 1c. When `--locale` only ever carries unsupported values, fall back to default.
fc.assert(
  fc.property(
    fc.array(noiseToken),
    invalidLocaleArg,
    fc.array(noiseToken),
    (before, badArg, after) => {
      const argv = [...before, ...badArg, ...after];
      assert.equal(resolveLocale(argv), DEFAULT_LOCALE);
    }
  ),
  { numRuns: RUNS }
);

// 1d. A supported `--locale` value (surrounded by noise that contains no
//     locale flag) resolves to that locale.
fc.assert(
  fc.property(
    fc.array(noiseToken),
    validLocaleArg,
    fc.array(noiseToken),
    (before, { loc, arg }, after) => {
      const argv = [...before, ...arg, ...after];
      assert.equal(resolveLocale(argv), loc);
    }
  ),
  { numRuns: RUNS }
);

// ---------------------------------------------------------------------------
// Property 6: translator fallback
// Validates: Requirements 13.8
// ---------------------------------------------------------------------------

// Representative set of real catalog keys plus structurally-valid keys.
const knownCmdNames = [
  "serve",
  "daemon status",
  "mcp serve",
  "tools",
  "policy print",
  "call",
  "launch",
  "attach",
  "eval",
  "breakpoint set",
  "ide context"
];
const knownOptNames = [
  "control-url",
  "pretty",
  "policy",
  "locale",
  "session",
  "file",
  "line",
  "args",
  "category",
  "scope"
];

const keyArb = fc.oneof(
  fc.constantFrom("usage", "epilog"),
  fc.constantFrom(...knownCmdNames).map((name) => `cmd.${name}`),
  fc.constantFrom(...knownOptNames).map((name) => `opt.${name}`),
  // Unknown / arbitrary keys to exercise the placeholder fallback path.
  fc.string(),
  fc.string().map((s) => `cmd.${s}`),
  fc.string().map((s) => `opt.${s}`)
);

const localeArb = fc.constantFrom<Locale>(...SUPPORTED_LOCALES);

// 6a. For any locale and any key, the translation is a non-empty string that
//     is never equal to the raw key name.
fc.assert(
  fc.property(localeArb, keyArb, (locale, key) => {
    const value = createTranslator(locale)(key);
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0, `empty translation for key "${key}" (${locale})`);
    assert.notEqual(value, key, `translation equals raw key "${key}" (${locale})`);
  }),
  { numRuns: RUNS }
);

// 6b. Fallback to English: for any KNOWN key, a non-default locale yields either
//     its own localized copy or the English copy, and the English translator
//     yields the same non-empty copy for that key (i.e. fallback never blanks).
fc.assert(
  fc.property(
    localeArb,
    fc.oneof(
      fc.constantFrom("usage", "epilog"),
      fc.constantFrom(...knownCmdNames).map((name) => `cmd.${name}`),
      fc.constantFrom(...knownOptNames).map((name) => `opt.${name}`)
    ),
    (locale, key) => {
      const english = createTranslator(DEFAULT_LOCALE)(key);
      const localized = createTranslator(locale)(key);
      assert.ok(english.length > 0);
      assert.ok(localized.length > 0);
      assert.notEqual(localized, key);
    }
  ),
  { numRuns: RUNS }
);

console.log("i18n property tests ok");
