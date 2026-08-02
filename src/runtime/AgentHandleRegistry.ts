import type { RuntimeMutationMode, RuntimeReference } from "../types/inspection.ts";
import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";

export interface AgentHandleTarget {
  providerRef?: RuntimeReference;
  parentRef?: RuntimeReference;
  name: string;
  path?: string[];
  modifiable?: boolean;
  mutationMode?: RuntimeMutationMode;
}

interface SessionHandles {
  pauseId?: number;
  nextId: number;
  active: Map<string, AgentHandleTarget>;
  byTarget: Map<string, string>;
  issuedAt: Map<string, number>;
}

function targetKey(target: AgentHandleTarget): string {
  return JSON.stringify([
    target.providerRef ?? null,
    target.parentRef ?? null,
    target.name,
    target.path ?? []
  ]);
}

export class AgentHandleRegistry {
  readonly #sessions = new Map<string, SessionHandles>();

  beginPause(sessionId: string, pauseId: number): void {
    const state = this.#state(sessionId);
    if (state.pauseId === pauseId) return;
    state.pauseId = pauseId;
    state.active.clear();
    state.byTarget.clear();
  }

  invalidate(sessionId: string): void {
    const state = this.#sessions.get(sessionId);
    if (!state) return;
    state.pauseId = undefined;
    state.active.clear();
    state.byTarget.clear();
  }

  clear(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  register(sessionId: string, pauseId: number, target: AgentHandleTarget): string {
    const state = this.#state(sessionId);
    this.#assertCurrentPause(sessionId, state, pauseId);
    const key = targetKey(target);
    const existing = state.byTarget.get(key);
    if (existing) return existing;
    const handle = `v${state.nextId++}`;
    const snapshot = structuredClone(target);
    state.active.set(handle, snapshot);
    state.byTarget.set(key, handle);
    state.issuedAt.set(handle, pauseId);
    return handle;
  }

  resolve(sessionId: string, pauseId: number, handle: string): AgentHandleTarget {
    const state = this.#sessions.get(sessionId);
    const issuedAt = state?.issuedAt.get(handle);
    if (issuedAt !== undefined && issuedAt !== pauseId) {
      throw this.#stale(sessionId, handle, issuedAt, pauseId);
    }
    if (!state || state.pauseId !== pauseId) {
      throw this.#stale(sessionId, handle, issuedAt, pauseId);
    }
    const target = state.active.get(handle);
    if (!target) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "Unknown runtime value handle.", {
        sessionId,
        handle,
        pauseId,
        retrySafe: true,
        recommendedAction: "Request fresh context and use a returned handle."
      });
    }
    return structuredClone(target);
  }

  #state(sessionId: string): SessionHandles {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = {
        nextId: 1,
        active: new Map(),
        byTarget: new Map(),
        issuedAt: new Map()
      };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }

  #assertCurrentPause(sessionId: string, state: SessionHandles, pauseId: number): void {
    if (state.pauseId === pauseId) return;
    throw this.#stale(sessionId, "", state.pauseId, pauseId);
  }

  #stale(
    sessionId: string,
    handle: string,
    handlePauseId: number | undefined,
    currentPauseId: number
  ): BreakPilotError {
    return new BreakPilotError(
      ErrorCodes.STALE_RUNTIME_HANDLE,
      "Runtime value handle belongs to an earlier paused state.",
      {
        sessionId,
        ...(handle ? { handle } : {}),
        ...(handlePauseId === undefined ? {} : { handlePauseId }),
        currentPauseId,
        retrySafe: true,
        recommendedAction: "Request fresh context and use a newly returned handle."
      }
    );
  }
}
