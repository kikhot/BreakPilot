import path from "node:path";
import type { AdapterRegistry } from "../debug-adapters/AdapterRegistry.ts";
import type { Adapter_Contract } from "../debug-adapters/types.ts";
import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";

/**
 * The kind of request being resolved. Used to enforce the attach-specific rule
 * that an attach request lacking an inferable source requires an explicit
 * language (Requirement 13.8).
 */
export type ResolveRequestKind = "launch" | "attach";

/**
 * Raw, untransformed inputs relevant to Language_Resolution, taken directly
 * from the `bp_debug_start` tool arguments. `lang` and `language` are the two
 * spellings the Debug_Session_Manager reads today;
 * `program` and `file` are the two source-path spellings from which a language
 * may be inferred. `request` distinguishes launch from attach so the
 * attach-without-source rule can be enforced.
 */
export interface LanguageResolveInput {
  /** Explicit language identifier (preferred spelling). */
  lang?: unknown;
  /** Explicit language identifier (alternate spelling). */
  language?: unknown;
  /** Source program path (launch). */
  program?: unknown;
  /** Source file path (used by some tools / inference). */
  file?: unknown;
  /** Whether this is a launch or an attach request. */
  request: ResolveRequestKind;
}

/**
 * Result of a successful resolution: the canonical (original-case) language
 * identifier and the resolved adapter instance.
 */
export interface LanguageResolveResult {
  language: string;
  adapter: Adapter_Contract;
}

/** A registry instance or a zero-arg function that returns one. */
export type RegistryProvider = AdapterRegistry | (() => AdapterRegistry);

/**
 * Maps a source file extension (lowercased, including the leading dot) to the
 * set of registered language identifiers that declare it.
 *
 * The map is derived entirely from the registered adapters' declared
 * `metadata.fileExtensions`, so a newly registered adapter contributes its
 * extensions automatically with no change here (design: File_Extension_Map,
 * Requirement 13.2). Because two adapters may legitimately declare the same
 * extension, each extension maps to a LIST of matching identifiers, which is
 * what makes the 0 / 1 / 2+ match distinction (Requirements 13.3, 13.5, 13.6)
 * expressible.
 */
export class FileExtensionMap {
  /** extension (".py") → matching language identifiers (original case). */
  readonly #byExtension: Map<string, string[]>;

  private constructor(byExtension: Map<string, string[]>) {
    this.#byExtension = byExtension;
  }

  /**
   * Build the map from a registry by reading every registered identifier and
   * its adapter's declared file extensions. Each extension is normalized to
   * lowercase with a guaranteed leading dot so lookups are case- and
   * format-insensitive.
   */
  static fromRegistry(registry: AdapterRegistry): FileExtensionMap {
    const byExtension = new Map<string, string[]>();
    for (const identifier of registry.listIdentifiers()) {
      const adapter = registry.get(identifier);
      for (const rawExt of adapter.metadata.fileExtensions ?? []) {
        const ext = FileExtensionMap.normalizeExtension(rawExt);
        if (!ext) continue;
        const matches = byExtension.get(ext);
        if (matches) {
          // Avoid listing the same identifier twice if an adapter declares a
          // duplicate extension.
          if (!matches.includes(adapter.metadata.language)) {
            matches.push(adapter.metadata.language);
          }
        } else {
          byExtension.set(ext, [adapter.metadata.language]);
        }
      }
    }
    return new FileExtensionMap(byExtension);
  }

  /**
   * Return the language identifiers (original case) declaring `extension`.
   * `extension` is normalized before lookup. Returns `[]` for an unmatched or
   * empty extension.
   */
  match(extension: string): string[] {
    const ext = FileExtensionMap.normalizeExtension(extension);
    if (!ext) return [];
    return [...(this.#byExtension.get(ext) ?? [])];
  }

  /**
   * Normalize a file extension to lowercase with a single leading dot. Returns
   * `""` for an empty / dot-only value so callers can treat "no usable
   * extension" uniformly.
   */
  static normalizeExtension(extension: string): string {
    const trimmed = String(extension ?? "").trim().toLowerCase();
    if (trimmed === "" || trimmed === ".") return "";
    return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  }
}

/**
 * Resolves the target {@link Adapter_Contract} for a `bp_debug_start` launch
 * or attach request using the Requirement 13 strategy ("option B"):
 *
 * 1. An explicit `lang`/`language` resolves case-insensitively via the
 *    {@link AdapterRegistry} (Requirement 13.1); an unknown identifier surfaces
 *    the registry's `UNSUPPORTED_LANGUAGE` error.
 * 2. With no explicit language but a source `program`/`file`, the language is
 *    inferred from the file extension via a {@link FileExtensionMap} built from
 *    the registry (Requirement 13.2): exactly one match resolves that adapter
 *    (13.3); zero matches → `UNSUPPORTED_LANGUAGE` with the unmatched extension
 *    and the registered identifiers (13.5); two-or-more → `INVALID_ARGUMENT`
 *    listing the matches (13.6).
 * 3. With no explicit language AND no source path → `INVALID_ARGUMENT`
 *    (13.4); for an attach request specifically the message states that an
 *    explicit language is required when there is no inferable source (13.8).
 *
 * A default language is NEVER applied when resolution does not produce a single
 * language (Requirement 13.7) — the silent `"python"` default is removed.
 */
export class LanguageResolver {
  readonly #registryProvider: RegistryProvider;

  constructor(registry: RegistryProvider) {
    this.#registryProvider = registry;
  }

  /** Resolve the current {@link AdapterRegistry} from the provider. */
  #registry(): AdapterRegistry {
    return typeof this.#registryProvider === "function"
      ? this.#registryProvider()
      : this.#registryProvider;
  }

  /**
   * Resolve the language identifier and adapter for a request. See the class
   * doc for the full strategy. Throws a {@link BreakPilotError} and resolves no
   * adapter whenever a single language cannot be determined.
   */
  resolve(input: LanguageResolveInput): LanguageResolveResult {
    const registry = this.#registry();

    // (1) Explicit language wins, resolved case-insensitively by the registry.
    const explicit = LanguageResolver.#firstNonEmptyString(input.lang, input.language);
    if (explicit !== undefined) {
      const adapter = registry.get(explicit);
      return { language: adapter.metadata.language, adapter };
    }

    // (2)/(3) No explicit language: try to infer from a source path.
    const sourcePath = LanguageResolver.#firstNonEmptyString(input.program, input.file);
    if (sourcePath === undefined) {
      if (input.request === "attach") {
        // (13.8) attach without an inferable source requires explicit lang.
        throw new BreakPilotError(
          ErrorCodes.INVALID_ARGUMENT,
          "An explicit language is required for attach requests that lack an inferable source program or file.",
          { request: input.request, supported: registry.listIdentifiers() }
        );
      }
      // (13.4) no explicit language and no source path at all.
      throw new BreakPilotError(
        ErrorCodes.INVALID_ARGUMENT,
        "The target language could not be resolved: provide an explicit language or a source program/file.",
        { request: input.request, supported: registry.listIdentifiers() }
      );
    }

    const extension = path.extname(sourcePath).toLowerCase();
    const map = FileExtensionMap.fromRegistry(registry);
    const matches = map.match(extension);

    const [matched] = matches;
    if (matches.length === 1 && matched !== undefined) {
      // (13.3) exactly one match.
      const adapter = registry.get(matched);
      return { language: adapter.metadata.language, adapter };
    }

    if (matches.length === 0) {
      // (13.5) zero matches: include the extension and registered identifiers.
      throw new BreakPilotError(
        ErrorCodes.UNSUPPORTED_LANGUAGE,
        `No registered language adapter handles the file extension "${extension}".`,
        { extension, supported: registry.listIdentifiers() }
      );
    }

    // (13.6) two-or-more matches: ambiguous, list the matching identifiers.
    throw new BreakPilotError(
      ErrorCodes.INVALID_ARGUMENT,
      `The target language could not be resolved unambiguously for extension "${extension}": it matches multiple registered adapters.`,
      { extension, matches }
    );
  }

  /**
   * Return the first argument that is a string with non-whitespace content
   * (trimmed-empty strings are treated as absent), or `undefined`. This makes
   * `lang: ""` behave like "no explicit language" rather than a bad identifier.
   */
  static #firstNonEmptyString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
    return undefined;
  }
}
