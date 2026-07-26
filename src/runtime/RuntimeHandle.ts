import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";

export interface RuntimeReferenceHandle {
  handle: string;
  sessionId: string;
  ideSessionId: string;
  pauseEpoch: number;
}

export function assertHandleEpoch(handle: RuntimeReferenceHandle, currentEpoch: number): void {
  if (handle.pauseEpoch === currentEpoch) return;
  throw new BreakPilotError(
    ErrorCodes.STALE_RUNTIME_HANDLE,
    "Runtime reference belongs to an earlier paused state.",
    {
      handle: handle.handle,
      currentEpoch,
      retrySafe: true,
      recommendedAction: "Request fresh context and use a newly returned reference."
    }
  );
}
