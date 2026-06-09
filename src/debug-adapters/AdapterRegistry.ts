import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";
import type { DebugLanguage } from "../types/debug.ts";
import { JavaAdapter, NodeAdapter, PythonAdapter } from "./LanguageAdapter.ts";
import type { LanguageAdapter } from "./LanguageAdapter.ts";

export class AdapterRegistry {
  adapters: Map<DebugLanguage, LanguageAdapter>;

  constructor() {
    this.adapters = new Map();
    this.register(new PythonAdapter());
    this.register(new NodeAdapter("node"));
    this.register(new NodeAdapter("typescript"));
    this.register(new JavaAdapter());
  }

  register(adapter: LanguageAdapter): void {
    this.adapters.set(adapter.language, adapter);
  }

  get(language: DebugLanguage): LanguageAdapter {
    const normalized = String(language || "").toLowerCase();
    const adapter = this.adapters.get(normalized);
    if (!adapter) {
      throw new BreakPilotError(
        ErrorCodes.UNSUPPORTED_LANGUAGE,
        `Unsupported language: ${language}`,
        { language, supported: [...this.adapters.keys()] }
      );
    }
    return adapter;
  }

  list(): DebugLanguage[] {
    return [...this.adapters.keys()];
  }
}
