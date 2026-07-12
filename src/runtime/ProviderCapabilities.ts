import type { RuntimeProviderCapabilities } from "../types/capabilities.ts";
import type { AnyRecord } from "../types/json.ts";

function enabled(raw: AnyRecord, ...keys: string[]): boolean {
  return keys.some((key) => raw[key] === true);
}

export function dapProviderCapabilities(raw: AnyRecord = {}): RuntimeProviderCapabilities {
  return {
    pause: "native",
    stepping: "native",
    runToLine: "unsupported",
    variableReferences: "native",
    setValue: enabled(raw, "supportsSetVariable") ? "native" : "unsupported",
    breakpointUpdate: "unsupported",
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
  return {
    pause: enabled(raw, "debugCommands") ? "native" : "unsupported",
    stepping: enabled(raw, "debugCommands") ? "native" : "unsupported",
    runToLine: enabled(raw, "runToLine", "supportsRunToLine") ? "native" : "unsupported",
    variableReferences: enabled(raw, "variableSnapshot") ? "snapshot" : "unsupported",
    setValue: !setVariable
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
