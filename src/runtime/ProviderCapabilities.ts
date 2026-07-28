import type { RuntimeProviderCapabilities } from "../types/capabilities.ts";
import type { AnyRecord } from "../types/json.ts";

const hasOwn = (value: AnyRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const ideCapabilityKeys = [
  ["runToLine", "supportsRunToLine"],
  ["setVariable", "supportsSetVariable"],
  ["setVariableMode", "setValueMode"],
  ["conditionalBreakpoints", "supportsConditionalBreakpoints"],
  ["hitConditionalBreakpoints", "supportsHitConditionalBreakpoints"],
  ["tracepoints", "logPoints", "supportsLogPoints"]
] as const;

function enabled(raw: AnyRecord, canonical: string, ...aliases: string[]): boolean {
  for (const key of [canonical, ...aliases]) {
    if (hasOwn(raw, key)) return raw[key] === true;
  }
  return false;
}

export function mergeIdeCapabilityRecords(...layers: AnyRecord[]): AnyRecord {
  const merged: AnyRecord = {};
  for (const layer of layers) {
    Object.assign(merged, layer);
    for (const keys of ideCapabilityKeys) {
      const selected = keys.find((key) => hasOwn(layer, key));
      if (!selected) continue;
      for (const key of keys) delete merged[key];
      merged[keys[0]] = layer[selected];
    }
  }
  return merged;
}

export interface DapProviderCapabilityOptions {
  /**
   * The live provider has both the adapter capability and the causal DAP
   * primitives needed to implement goto safely.
   */
  nativeRunToLineAvailable?: boolean;
  /** A manager-wired Reconciler can safely provide the temporary-breakpoint path. */
  fallbackRunToLineAvailable?: boolean;
}

export function dapProviderCapabilities(
  raw: AnyRecord = {},
  options: DapProviderCapabilityOptions = {}
): RuntimeProviderCapabilities {
  // The raw DAP flag alone is not enough: it only says the adapter recognizes
  // goto requests.  The live provider must also prove it owns the Task-4
  // causal boundary/wait primitives, and supplies that fact explicitly.
  const nativeRunToLine = options.nativeRunToLineAvailable === true && enabled(raw, "supportsGotoTargetsRequest");
  const fallbackRunToLine = options.fallbackRunToLineAvailable === true;
  return {
    pause: "native",
    stepping: "native",
    runToLine: nativeRunToLine ? "native" : fallbackRunToLine ? "fallback" : "unsupported",
    variableReferences: "native",
    setValue: enabled(raw, "supportsSetVariable") ? "native" : "unsupported",
    breakpointUpdate: "fallback",
    conditionalBreakpoints: enabled(raw, "supportsConditionalBreakpoints")
      ? "native"
      : "unsupported",
    hitConditionalBreakpoints: enabled(raw, "supportsHitConditionalBreakpoints")
      ? "native"
      : "unsupported",
    tracepoints: enabled(raw, "supportsLogPoints") ? "native" : "unsupported",
    eventDrain: "unsupported"
  };
}

export function ideProviderCapabilities(raw: AnyRecord = {}): RuntimeProviderCapabilities {
  const setVariable = enabled(raw, "setVariable", "supportsSetVariable");
  const setVariableMode = raw.setVariableMode ?? raw.setValueMode;
  const variableHandles = raw.variableHandles === true;
  const nativeSetVariable = raw.nativeSetVariable === true;
  return {
    pause: enabled(raw, "debugCommands") ? "native" : "unsupported",
    stepping: enabled(raw, "debugCommands") ? "native" : "unsupported",
    runToLine: enabled(raw, "runToLine", "supportsRunToLine") ? "native" : "unsupported",
    variableReferences: variableHandles
      ? "native"
      : enabled(raw, "variableSnapshot")
        ? "snapshot"
        : "unsupported",
    setValue: nativeSetVariable
      ? "native"
      : !setVariable
        ? "unsupported"
        : setVariableMode === "evaluateAssignment"
          ? "evaluateAssignment"
          : "native",
    breakpointUpdate: "unsupported",
    conditionalBreakpoints: enabled(raw, "conditionalBreakpoints", "supportsConditionalBreakpoints")
      ? "native"
      : "unsupported",
    hitConditionalBreakpoints: enabled(raw, "hitConditionalBreakpoints", "supportsHitConditionalBreakpoints")
      ? "native"
      : "unsupported",
    tracepoints: enabled(raw, "tracepoints", "logPoints", "supportsLogPoints")
      ? "native"
      : "unsupported",
    eventDrain: "unsupported"
  };
}
