export type CapabilityLevel = "native" | "fallback" | "unsupported";

export interface RuntimeProviderCapabilities {
  pause: CapabilityLevel;
  stepping: CapabilityLevel;
  runToLine: CapabilityLevel;
  variableReferences: "native" | "snapshot" | "unsupported";
  setValue: "native" | "evaluateAssignment" | "unsupported";
  breakpointUpdate: CapabilityLevel;
  conditionalBreakpoints: CapabilityLevel;
  hitConditionalBreakpoints: CapabilityLevel;
  tracepoints: CapabilityLevel;
  eventDrain: CapabilityLevel;
}
