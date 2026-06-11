import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";
import type { DebugLanguage } from "../types/debug.ts";
import { NodeAdapter, PythonAdapter } from "./LanguageAdapter.ts";
import type { LanguageAdapter } from "./LanguageAdapter.ts";
import { JavaAdapter } from "./java/JavaAdapter.ts";
import type { Adapter_Contract, AdapterFactory } from "./types.ts";

/** Maximum allowed length for a language identifier (Requirement 2.2). */
const MAX_IDENTIFIER_LENGTH = 64;

/**
 * Case-insensitive store of language adapters (Requirement 2).
 *
 * Identifiers are normalized with `toLowerCase()` for keying and comparison,
 * while the original-cased identifier is preserved inside each adapter's (or
 * factory's) metadata for display and listing. The registry accepts either an
 * eagerly-constructed {@link Adapter_Contract} via {@link register} or a lazy
 * {@link AdapterFactory} via {@link registerFactory}; a factory's adapter is
 * constructed on first {@link get}.
 */
export class AdapterRegistry {
  /** Eagerly-registered adapters, keyed by lowercased identifier. */
  adapters: Map<string, Adapter_Contract>;
  /** Lazy factories, keyed by lowercased identifier, resolved on first `get`. */
  #factories: Map<string, AdapterFactory>;

  constructor() {
    this.adapters = new Map();
    this.#factories = new Map();
    // Default set: exactly Python, Node, TypeScript, and Java (Requirement 10.5).
    this.register(new PythonAdapter());
    this.register(new NodeAdapter("node"));
    this.register(new NodeAdapter("typescript"));
    this.register(new JavaAdapter());
  }

  /**
   * Register an eagerly-constructed adapter under its `metadata.language`
   * identifier (Requirement 2.1). Validates the identifier and rejects
   * case-insensitive collisions, leaving the registry unchanged on failure
   * (Requirements 2.2, 2.3, 12.5).
   */
  register(adapter: LanguageAdapter | Adapter_Contract): void {
    const identifier = adapter.metadata.language;
    const key = this.#validateIdentifier(identifier);
    this.#assertNoCollision(key, identifier);
    this.adapters.set(key, adapter);
  }

  /**
   * Register a lazy {@link AdapterFactory} (Requirement 2.7). The factory's
   * `metadata.language` is validated and checked for collisions immediately,
   * but the adapter instance is constructed only on first {@link get}.
   */
  registerFactory(factory: AdapterFactory): void {
    const identifier = factory.metadata.language;
    const key = this.#validateIdentifier(identifier);
    this.#assertNoCollision(key, identifier);
    this.#factories.set(key, factory);
  }

  /**
   * Resolve an adapter by language identifier, compared case-insensitively
   * (Requirement 2.4). A factory-backed identifier is constructed lazily on the
   * first call and cached. On a miss, throws `UNSUPPORTED_LANGUAGE` with the
   * requested identifier and the full list of registered identifiers
   * (Requirement 2.5).
   */
  get(language: DebugLanguage): Adapter_Contract {
    const key = String(language ?? "").toLowerCase();

    const existing = this.adapters.get(key);
    if (existing) return existing;

    const factory = this.#factories.get(key);
    if (factory) {
      const adapter = factory.create();
      this.adapters.set(key, adapter);
      this.#factories.delete(key);
      return adapter;
    }

    throw new BreakPilotError(
      ErrorCodes.UNSUPPORTED_LANGUAGE,
      `Unsupported language: ${language}`,
      { language, supported: this.listIdentifiers() }
    );
  }

  /**
   * Case-insensitive membership check across both eagerly-registered adapters
   * and pending factories.
   */
  has(language: DebugLanguage): boolean {
    const key = String(language ?? "").toLowerCase();
    return this.adapters.has(key) || this.#factories.has(key);
  }

  /**
   * Every registered language identifier in its original case, `[]` when empty
   * (Requirement 2.6). Includes identifiers backed by not-yet-resolved
   * factories.
   */
  listIdentifiers(): string[] {
    const identifiers: string[] = [];
    for (const adapter of this.adapters.values()) {
      identifiers.push(adapter.metadata.language);
    }
    for (const factory of this.#factories.values()) {
      identifiers.push(factory.metadata.language);
    }
    return identifiers;
  }

  /** Alias of {@link listIdentifiers} retained for existing call sites. */
  list(): string[] {
    return this.listIdentifiers();
  }

  /**
   * Validate a language identifier (Requirement 2.2) and return its normalized
   * (lowercased) key. Throws `INVALID_LANGUAGE_IDENTIFIER` with the rejected
   * identifier for empty, whitespace-only, or over-length identifiers, without
   * mutating the registry.
   */
  #validateIdentifier(identifier: unknown): string {
    const value = typeof identifier === "string" ? identifier : "";
    if (value.trim().length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
      throw new BreakPilotError(
        ErrorCodes.INVALID_LANGUAGE_IDENTIFIER,
        `Invalid language identifier: ${JSON.stringify(identifier)}`,
        { identifier }
      );
    }
    return value.toLowerCase();
  }

  /**
   * Reject a case-insensitive collision with an already-registered adapter or
   * factory (Requirements 2.3, 12.5), retaining the previously registered entry
   * unchanged.
   */
  #assertNoCollision(key: string, identifier: string): void {
    if (this.adapters.has(key) || this.#factories.has(key)) {
      throw new BreakPilotError(
        ErrorCodes.DUPLICATE_LANGUAGE,
        `A language adapter is already registered for "${identifier}".`,
        { identifier }
      );
    }
  }
}
