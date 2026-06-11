import type { AdapterRegistry } from "../debug-adapters/AdapterRegistry.ts";
import type { LanguageCapability } from "../debug-adapters/types.ts";
import type { AuditLogger } from "../audit/AuditLogger.ts";

/**
 * Answers "which languages are supported and available right now, and if not,
 * why" for the Agent, backing the `list_supported_languages` control tool
 * (Requirement 3.3, 3.4, 3.5, 12.2).
 *
 * Given the {@link AdapterRegistry}, {@link report} produces one
 * {@link LanguageCapability} per registered language by invoking each adapter's
 * `validateEnvironment()` (each already bounded to 10s) in parallel. Unavailable
 * languages carry the validation errors describing the missing toolchain
 * (Requirement 3.4). Every query records a `capability_query` audit entry
 * listing each queried identifier and its availability (Requirement 3.5).
 */
export class CapabilityReporter {
  #registry: AdapterRegistry;
  #audit: AuditLogger;

  constructor(registry: AdapterRegistry, audit: AuditLogger) {
    this.#registry = registry;
    this.#audit = audit;
  }

  /**
   * Build the supported-languages report. Returns exactly one entry per
   * registered language identifier, each populated with `language`,
   * `displayName`, `supportsAttach`, and a live `availability` result from the
   * adapter's environment validation. Records a `capability_query` audit entry.
   */
  async report(): Promise<LanguageCapability[]> {
    const identifiers = this.#registry.listIdentifiers();
    const capabilities = await Promise.all(
      identifiers.map(async (identifier): Promise<LanguageCapability> => {
        const adapter = this.#registry.get(identifier);
        const availability = await adapter.validateEnvironment();
        return {
          language: adapter.metadata.language,
          displayName: adapter.metadata.displayName,
          supportsAttach: adapter.metadata.supportsAttach,
          availability
        };
      })
    );

    this.#audit.record("capability_query", {
      languages: capabilities.map((capability) => ({
        language: capability.language,
        available: capability.availability.available
      }))
    });

    return capabilities;
  }
}
