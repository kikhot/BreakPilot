import type { VariableLimits } from "./inspection.ts";

export type EvaluateMode = "readonly" | "guarded" | "unsafe" | string;

export interface BreakPilotPolicy {
  workspace: {
    root: string;
    allowOutsideWorkspace: boolean;
  };
  network: {
    allowedHosts: string[];
    allowedPorts: number[];
  };
  ide: {
    enabled: boolean;
    preferredMode: string;
    bridge: {
      host: string;
      port: number;
    };
    requireUserConfirmation: {
      continueAfterBreakpoint: boolean;
      unsafeEvaluate: boolean;
      attachRemote: boolean;
    };
    confirmationTimeoutMs: number;
    defaultOnTimeout: "continue" | "stop" | string;
  };
  evaluate: {
    defaultMode: EvaluateMode;
    allowFunctionCalls: boolean;
    requireConfirmationForUnsafe: boolean;
    timeoutMs: number;
  };
  variables: VariableLimits & {
    redactPatterns: string[];
  };
  runtime: {
    maxPauseMs: number;
    maxEventBuffer: number;
    autoContinue: boolean;
    forbidProduction: boolean;
  };
  audit: {
    enabled: boolean;
    file: string;
  };
}
