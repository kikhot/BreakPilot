import path from "node:path";
import { types } from "node:util";

import { BreakpointManager } from "./BreakpointManager.ts";
import type { DapBreakpoint } from "../types/dap.ts";
import type {
  BreakpointPatchRequest,
  BreakpointRecord,
  BreakpointUpdateResult,
  DebugSessionRecord,
  ReconciliationFailureDetails
} from "../types/sessions.ts";
import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";

type SourceState = {
  filePath: string;
  original: BreakpointRecord[];
  desired: BreakpointRecord[];
};

type ProvenRecoveryDetails = {
  outcome: "restored";
  retrySafe: true;
  rollbackApplied: true;
  affectedIds: string[];
  recommendedAction: string;
  causeCode: string;
};

type SourceLockMap = Map<string, Promise<void>>;

const sourceLocksByManager = new WeakMap<BreakpointManager, SourceLockMap>();
const GENERIC_PROVIDER_FAILURE_CODE = "PROVIDER_REPLACEMENT_FAILED";
const RETRY_RECOMMENDATION = "Retry the breakpoint update after confirming the debugger is responsive.";
const INSPECT_RECOMMENDATION = "Inspect the debugger breakpoint state, re-list breakpoints, and reconcile before retrying.";
const PATCH_FIELD_ORDER = ["filePath", "line", "column", "condition", "hitCondition", "logMessage", "enabled"] as const;

/**
 * Applies an existing breakpoint patch as a full-source replacement transaction.
 *
 * This service deliberately has no public-tool concerns (workspace authorization,
 * requireVerified, output formatting, or capability gates). Its responsibility is
 * to preserve complete source lists and only commit local desired state after the
 * provider has acknowledged every affected source replacement.
 */
export class BreakpointReconciler {
  readonly #breakpoints: BreakpointManager;

  constructor(breakpoints: BreakpointManager) {
    this.#breakpoints = breakpoints;
  }

  async update(session: DebugSessionRecord, patch: BreakpointPatchRequest): Promise<BreakpointUpdateResult> {
    const request: BreakpointPatchRequest = { ...patch };

    // A target can be moved while this call is waiting for a source lock. Retry
    // with the current source set rather than snapshotting stale source lists.
    while (true) {
      const targetBeforeLock = this.#breakpoints.get(session.sessionId, request.breakpointId);
      if (!targetBeforeLock) this.#throwMissingBreakpoint(session.sessionId, request.breakpointId);

      const lockedSources = this.#affectedSources(targetBeforeLock, request);
      const release = await this.#acquireLocks(lockedSources);
      try {
        const target = this.#breakpoints.get(session.sessionId, request.breakpointId);
        if (!target) this.#throwMissingBreakpoint(session.sessionId, request.breakpointId);

        const currentSources = this.#affectedSources(target, request);
        if (!this.#sameSources(lockedSources, currentSources)) continue;

        this.#assertOwnerAllowed(target, request.owner);
        return await this.#updateLocked(session, target, request, currentSources);
      } finally {
        release();
      }
    }
  }

  async #updateLocked(
    session: DebugSessionRecord,
    target: BreakpointRecord,
    patch: BreakpointPatchRequest,
    sourcePaths: string[]
  ): Promise<BreakpointUpdateResult> {
    const previous = this.#clone(target);
    const { current: requested, changedFields: requestedChangedFields } = this.#applyPatch(target, patch);
    if (requestedChangedFields.length === 0) {
      return {
        operation: "updated",
        breakpointId: target.id,
        previous,
        current: this.#clone(target),
        changedFields: requestedChangedFields,
        verified: target.verified
      };
    }
    const sourceStates = this.#sourceStates(session.sessionId, previous, requested, sourcePaths);
    const affectedIds = this.#affectedIds(sourceStates);

    try {
      const appliedBySource = new Map<string, BreakpointRecord[]>();
      for (const source of sourceStates) {
        // Providers receive their own deep clone. A provider must never be able to
        // mutate our desired snapshot while returning adapter evidence.
        const providerInput = source.desired.map((breakpoint) => this.#clone(breakpoint));
        const responses = await session.provider.setBreakpoints(source.filePath, providerInput);
        const evidence = this.#normalizeAdapterEvidence(source.desired, responses);
        appliedBySource.set(source.filePath, this.#projectAdapterEvidence(source.desired, evidence));
      }

      // No local source list changes before every provider call has fulfilled and
      // supplied complete adapter evidence. The manager preflights every clone
      // and installs every affected source in one map replacement.
      this.#breakpoints.replaceSources(session.sessionId, sourceStates.map((source) => {
        const applied = appliedBySource.get(source.filePath);
        if (!applied) throw new Error("Missing applied breakpoint source state.");
        return { filePath: source.filePath, records: applied };
      }));

      const current = this.#breakpoints.get(session.sessionId, target.id);
      if (!current) throw new Error("Breakpoint was missing after a successful replacement.");
      const changedFields = this.#changedFields(previous, current);
      const relocated = changedFields.some((field) => field === "filePath" || field === "line" || field === "column");
      return {
        operation: relocated ? "relocated" : "updated",
        breakpointId: target.id,
        previous,
        current,
        changedFields,
        verified: current.verified
      };
    } catch (error) {
      const rollbackApplied = await this.#restoreOriginalSources(session, sourceStates);
      if (!rollbackApplied) {
        const details: ReconciliationFailureDetails = {
          outcome: "indeterminate",
          retrySafe: false,
          rollbackApplied: false,
          affectedIds,
          recommendedAction: INSPECT_RECOMMENDATION
        };
        throw new BreakPilotError(
          "BREAKPOINT_ROLLBACK_FAILED",
          "BreakPilot could not restore the previous breakpoint state.",
          details
        );
      }

      const details: ProvenRecoveryDetails = {
        outcome: "restored",
        retrySafe: true,
        rollbackApplied: true,
        affectedIds,
        recommendedAction: RETRY_RECOMMENDATION,
        causeCode: this.#safeCauseCode(error)
      };
      throw new BreakPilotError(
        "BREAKPOINT_UPDATE_FAILED",
        "BreakPilot could not apply the breakpoint update; the previous state was restored.",
        details
      );
    }
  }

  #sourceStates(
    sessionId: string,
    previous: BreakpointRecord,
    requested: BreakpointRecord,
    sourcePaths: string[]
  ): SourceState[] {
    const states = sourcePaths.map((filePath) => {
      const original = this.#breakpoints.listSource(sessionId, filePath).map((breakpoint) => this.#clone(breakpoint));
      return {
        filePath,
        original,
        desired: original.map((breakpoint) => this.#clone(breakpoint))
      };
    });
    const oldSource = this.#normalizeSource(previous.file);
    const newSource = this.#normalizeSource(requested.file);
    const oldState = states.find((state) => state.filePath === oldSource);
    const newState = states.find((state) => state.filePath === newSource);
    if (!oldState || !newState) throw new Error("Affected breakpoint source state was not initialized.");

    if (oldSource === newSource) {
      oldState.desired = oldState.original.map((breakpoint) =>
        breakpoint.id === previous.id ? this.#clone(requested) : this.#clone(breakpoint)
      );
      return states;
    }

    oldState.desired = oldState.original
      .filter((breakpoint) => breakpoint.id !== previous.id)
      .map((breakpoint) => this.#clone(breakpoint));
    newState.desired = [
      ...newState.original
        .filter((breakpoint) => breakpoint.id !== previous.id)
        .map((breakpoint) => this.#clone(breakpoint)),
      this.#clone(requested)
    ];
    return states;
  }

  #applyPatch(target: BreakpointRecord, patch: BreakpointPatchRequest): {
    current: BreakpointRecord;
    changedFields: string[];
  } {
    const current = this.#clone(target);
    const changed = new Set<string>();

    if (patch.filePath !== undefined) {
      const filePath = this.#normalizeSource(patch.filePath);
      if (filePath !== current.file) {
        current.file = filePath;
        changed.add("filePath");
      }
    }
    if (patch.line !== undefined && patch.line !== current.line) {
      current.line = patch.line;
      changed.add("line");
    }
    if (patch.column !== undefined) {
      const column = patch.column === null ? undefined : patch.column;
      if (column !== current.column) {
        if (column === undefined) delete current.column;
        else current.column = column;
        changed.add("column");
      }
    }
    if (patch.condition !== undefined) {
      const condition = patch.condition === null ? undefined : patch.condition;
      if (condition !== current.condition) {
        if (condition === undefined) delete current.condition;
        else current.condition = condition;
        changed.add("condition");
      }
    }
    if (patch.hitCondition !== undefined) {
      const hitCondition = patch.hitCondition === null ? undefined : patch.hitCondition;
      if (hitCondition !== current.hitCondition) {
        if (hitCondition === undefined) delete current.hitCondition;
        else current.hitCondition = hitCondition;
        changed.add("hitCondition");
      }
    }
    if (patch.logMessage !== undefined) {
      const logMessage = patch.logMessage === null ? undefined : patch.logMessage;
      if (logMessage !== current.logMessage) {
        if (logMessage === undefined) delete current.logMessage;
        else current.logMessage = logMessage;
        changed.add("logMessage");
      }
    }
    if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
      current.enabled = patch.enabled;
      changed.add("enabled");
    }

    return {
      current,
      changedFields: PATCH_FIELD_ORDER.filter((field) => changed.has(field))
    };
  }

  #changedFields(previous: BreakpointRecord, current: BreakpointRecord): string[] {
    const changed = new Set<string>();
    if (previous.file !== current.file) changed.add("filePath");
    if (previous.line !== current.line) changed.add("line");
    if (previous.column !== current.column) changed.add("column");
    if (previous.condition !== current.condition) changed.add("condition");
    if (previous.hitCondition !== current.hitCondition) changed.add("hitCondition");
    if (previous.logMessage !== current.logMessage) changed.add("logMessage");
    if (previous.enabled !== current.enabled) changed.add("enabled");
    return PATCH_FIELD_ORDER.filter((field) => changed.has(field));
  }

  #projectAdapterEvidence(desired: BreakpointRecord[], responses: DapBreakpoint[]): BreakpointRecord[] {
    return desired.map((breakpoint, index) => {
      const response = responses[index];
      const projected = this.#clone(breakpoint);
      if (!response) return projected;

      projected.verified = response.verified;
      if (response.message !== undefined) projected.message = response.message;
      if (response.id !== undefined) projected.adapterBreakpointId = response.id;
      if (response.line !== undefined) projected.line = response.line;
      if (response.column !== undefined) projected.column = response.column;
      return projected;
    });
  }

  async #restoreOriginalSources(session: DebugSessionRecord, sourceStates: SourceState[]): Promise<boolean> {
    let restored = true;
    for (const source of sourceStates) {
      try {
        const responses = await session.provider.setBreakpoints(
          source.filePath,
          source.original.map((breakpoint) => this.#clone(breakpoint))
        );
        this.#normalizeAdapterEvidence(source.original, responses);
      } catch {
        restored = false;
      }
    }
    return restored;
  }

  #normalizeAdapterEvidence(desired: BreakpointRecord[], responses: unknown): DapBreakpoint[] {
    try {
      if (!Array.isArray(responses) || types.isProxy(responses) || responses.length !== desired.length) {
        throw new Error("Provider did not return complete breakpoint evidence.");
      }
      const normalized: DapBreakpoint[] = [];
      for (let index = 0; index < responses.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(responses, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("Provider returned an unsafe breakpoint evidence entry.");
        }
        normalized.push(this.#normalizeAdapterEvidenceEntry(descriptor.value));
      }
      return normalized;
    } catch {
      throw new Error("Provider returned malformed breakpoint evidence.");
    }
  }

  #normalizeAdapterEvidenceEntry(response: unknown): DapBreakpoint {
    if (typeof response !== "object" || response === null || Array.isArray(response) || types.isProxy(response)) {
      throw new Error("Breakpoint evidence entry is not a plain object.");
    }
    const prototype = Object.getPrototypeOf(response);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Breakpoint evidence entry is not a plain object.");
    }

    for (const key of Reflect.ownKeys(response)) {
      if (typeof key !== "string") throw new Error("Breakpoint evidence entry contains an unsupported key.");
      const descriptor = Object.getOwnPropertyDescriptor(response, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("Breakpoint evidence entry contains an unsafe property.");
      }
    }

    const verified = this.#requiredEvidenceValue(response, "verified");
    if (typeof verified !== "boolean") throw new Error("Breakpoint evidence verified must be boolean.");

    const normalized: DapBreakpoint = { verified };
    const id = this.#optionalEvidenceValue(response, "id");
    if (id !== undefined) {
      if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error("Breakpoint evidence id must be a safe integer.");
      normalized.id = id;
    }
    const message = this.#optionalEvidenceValue(response, "message");
    if (message !== undefined) {
      if (typeof message !== "string") throw new Error("Breakpoint evidence message must be a string.");
      normalized.message = message;
    }
    const line = this.#optionalEvidenceValue(response, "line");
    if (line !== undefined) {
      if (typeof line !== "number" || !Number.isSafeInteger(line)) throw new Error("Breakpoint evidence line must be a safe integer.");
      normalized.line = line;
    }
    const column = this.#optionalEvidenceValue(response, "column");
    if (column !== undefined) {
      if (typeof column !== "number" || !Number.isSafeInteger(column)) throw new Error("Breakpoint evidence column must be a safe integer.");
      normalized.column = column;
    }
    return normalized;
  }

  #requiredEvidenceValue(response: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(response, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`Breakpoint evidence ${key} is missing or unsafe.`);
    }
    return descriptor.value;
  }

  #optionalEvidenceValue(response: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(response, key);
    if (!descriptor) return undefined;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`Breakpoint evidence ${key} is unsafe.`);
    }
    return descriptor.value;
  }

  #affectedSources(target: BreakpointRecord, patch: BreakpointPatchRequest): string[] {
    const oldSource = this.#normalizeSource(target.file);
    const newSource = patch.filePath === undefined ? oldSource : this.#normalizeSource(patch.filePath);
    return [...new Set([oldSource, newSource])].sort((left, right) => this.#compareSourceKeys(left, right));
  }

  #affectedIds(sourceStates: SourceState[]): string[] {
    return [...new Set(sourceStates.flatMap((source) => source.original.map((breakpoint) => breakpoint.id)))]
      .sort((left, right) => this.#compareSourceKeys(left, right));
  }

  #assertOwnerAllowed(target: BreakpointRecord, requestedOwner: BreakpointPatchRequest["owner"]): void {
    const owner = requestedOwner ?? "agent";
    if (owner === "all" || target.owner === owner) return;
    throw new BreakPilotError(
      ErrorCodes.POLICY_VIOLATION,
      "The requested breakpoint is not owned by the selected breakpoint owner.",
      { breakpointId: target.id, owner: target.owner, requestedOwner: owner }
    );
  }

  #throwMissingBreakpoint(sessionId: string, breakpointId: string): never {
    throw new BreakPilotError(
      ErrorCodes.INVALID_ARGUMENT,
      "Breakpoint was not found in the selected debug session.",
      { sessionId, breakpointId }
    );
  }

  async #acquireLocks(sourcePaths: string[]): Promise<() => void> {
    let locks = sourceLocksByManager.get(this.#breakpoints);
    if (!locks) {
      locks = new Map();
      sourceLocksByManager.set(this.#breakpoints, locks);
    }

    const releases: Array<() => void> = [];
    try {
      for (const sourcePath of sourcePaths) {
        const previous = locks.get(sourcePath) ?? Promise.resolve();
        let releaseCurrent!: () => void;
        const current = new Promise<void>((resolve) => {
          releaseCurrent = resolve;
        });
        const queued = previous.then(() => current);
        locks.set(sourcePath, queued);
        await previous;
        releases.push(() => {
          releaseCurrent();
          if (locks?.get(sourcePath) === queued) locks.delete(sourcePath);
        });
      }
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }

    return () => {
      for (const release of releases.reverse()) release();
    };
  }

  #safeCauseCode(error: unknown): string {
    try {
      if (typeof error !== "object" || error === null) return GENERIC_PROVIDER_FAILURE_CODE;
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
        return GENERIC_PROVIDER_FAILURE_CODE;
      }
      const code = descriptor.value;
      return /^[A-Z][A-Z0-9_:-]{0,127}$/.test(code) ? code : GENERIC_PROVIDER_FAILURE_CODE;
    } catch {
      return GENERIC_PROVIDER_FAILURE_CODE;
    }
  }

  #normalizeSource(filePath: string): string {
    return path.resolve(filePath);
  }

  #sameSources(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((source, index) => source === right[index]);
  }

  #compareSourceKeys(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  #clone<T extends BreakpointRecord>(breakpoint: T): T {
    return structuredClone(breakpoint);
  }
}
