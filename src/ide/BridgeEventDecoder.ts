import type { AnyRecord } from "../types/json.ts";

export type SafeBridgeSnapshot = null | undefined | string | number | boolean | SafeBridgeSnapshot[] | { [key: string]: SafeBridgeSnapshot };

type SnapshotBudget = { remainingKeys: number; remainingItems: number };
type SnapshotLimits = {
  maxDepth: number;
  maxRecordKeys: number;
  maxArrayItems: number;
  maxTotalKeys: number;
  maxTotalItems: number;
};

const MALFORMED = Symbol("malformed bridge snapshot");
const LIMIT = Symbol("bridge snapshot limit exceeded");
const MISSING = Symbol("missing bridge field");
type SnapshotFailure = typeof MALFORMED | typeof LIMIT;
type BridgeCorrelation = {
  type?: string;
  requestId?: string;
  sessionId?: string;
  ideSessionId?: string;
  originRequestId?: string;
  pauseEpoch?: number;
};
export type BridgeDecodeResult =
  | { kind: "accepted"; clientId?: string; message: AnyRecord }
  | {
      kind: "rejected";
      code: "BRIDGE_PAYLOAD_LIMIT";
      clientId?: string;
      correlation: BridgeCorrelation;
    }
  | { kind: "malformed" };
const STRICT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxDepth: 8,
  maxRecordKeys: 128,
  maxArrayItems: 128,
  maxTotalKeys: 128,
  maxTotalItems: 128
};
const BRIDGE_MESSAGE_LIMITS: SnapshotLimits = {
  maxDepth: 16,
  maxRecordKeys: 128,
  maxArrayItems: 1_000,
  maxTotalKeys: 65_536,
  maxTotalItems: 8_192
};

export function safeBridgeDataRecord(value: unknown): AnyRecord | null {
  return snapshotDataRecord(value, STRICT_SNAPSHOT_LIMITS);
}

function snapshotDataRecord(value: unknown, limits: SnapshotLimits): AnyRecord | null {
  const result = snapshotDataRecordDetailed(value, limits);
  return result.kind === "accepted" ? result.value : null;
}

function snapshotDataRecordDetailed(
  value: unknown,
  limits: SnapshotLimits
): { kind: "accepted"; value: AnyRecord } | { kind: "rejected"; failure: SnapshotFailure } {
  try {
    const snapshot = snapshotBridgeValue(
      value,
      new WeakSet<object>(),
      { remainingKeys: limits.maxTotalKeys, remainingItems: limits.maxTotalItems },
      limits,
      0
    );
    if (snapshot === MALFORMED || snapshot === LIMIT) return { kind: "rejected", failure: snapshot };
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return { kind: "rejected", failure: MALFORMED };
    }
    return { kind: "accepted", value: snapshot as AnyRecord };
  } catch {
    return { kind: "rejected", failure: MALFORMED };
  }
}

export function decodeBridgeEvent(event: unknown): { clientId?: string; message: AnyRecord } | null {
  const decoded = decodeBridgeEventDetailed(event);
  return decoded.kind === "accepted"
    ? { clientId: decoded.clientId, message: decoded.message }
    : null;
}

export function decodeBridgeEventDetailed(event: unknown): BridgeDecodeResult {
  try {
    const envelope = bridgeEnvelope(event);
    if (!envelope) return { kind: "malformed" };
    const clientId = opaqueBridgeId(envelope.clientId);
    const correlation = bridgeCorrelation(envelope.message);
    const decoded = snapshotDataRecordDetailed(envelope.message, BRIDGE_MESSAGE_LIMITS);
    if (decoded.kind === "accepted") {
      return { kind: "accepted", clientId, message: decoded.value };
    }
    if (decoded.failure === LIMIT) {
      return { kind: "rejected", code: "BRIDGE_PAYLOAD_LIMIT", clientId, correlation };
    }
    return { kind: "malformed" };
  } catch {
    return { kind: "malformed" };
  }
}

export function opaqueBridgeId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function publicBridgeSnapshot(value: SafeBridgeSnapshot): SafeBridgeSnapshot {
  if (Array.isArray(value)) return value.map((item) => publicBridgeSnapshot(item));
  if (!value || typeof value !== "object") return value;
  const copy: { [key: string]: SafeBridgeSnapshot } = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) continue;
    Object.defineProperty(copy, key, {
      value: publicBridgeSnapshot(descriptor.value as SafeBridgeSnapshot),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return copy;
}

function bridgeEnvelope(value: unknown): { clientId?: unknown; message: unknown } | null {
  if (!value || typeof value !== "object") return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length > STRICT_SNAPSHOT_LIMITS.maxRecordKeys) return null;
  let clientId: unknown;
  let message: unknown | typeof MISSING = MISSING;
  for (const key of keys) {
    if (typeof key !== "string" || (key !== "clientId" && key !== "message")) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    if (key === "clientId") clientId = descriptor.value;
    if (key === "message") message = descriptor.value;
  }
  return message === MISSING ? null : { clientId, message };
}

function bridgeCorrelation(value: unknown): BridgeCorrelation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return {};
  const correlation: BridgeCorrelation = {};
  for (const key of ["type", "requestId", "sessionId", "ideSessionId", "originRequestId", "pauseEpoch"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
    if (key === "pauseEpoch") {
      if (typeof descriptor.value === "number" && Number.isSafeInteger(descriptor.value)) {
        correlation.pauseEpoch = descriptor.value;
      }
    } else if (typeof descriptor.value === "string") {
      correlation[key] = descriptor.value;
    }
  }
  return correlation;
}

function snapshotBridgeValue(
  value: unknown,
  seen: WeakSet<object>,
  budget: SnapshotBudget,
  limits: SnapshotLimits,
  depth: number
): SafeBridgeSnapshot | SnapshotFailure {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : MALFORMED;
  if (depth > limits.maxDepth) return LIMIT;
  if (typeof value !== "object" || seen.has(value)) return MALFORMED;
  seen.add(value);
  let snapshot: SafeBridgeSnapshot | SnapshotFailure;
  if (Array.isArray(value)) {
    snapshot = Object.getPrototypeOf(value) === Array.prototype
      ? snapshotArray(value, seen, budget, limits, depth)
      : MALFORMED;
  } else {
    const prototype = Object.getPrototypeOf(value);
    snapshot = prototype === Object.prototype || prototype === null
      ? snapshotRecord(value, seen, budget, limits, depth)
      : MALFORMED;
  }
  seen.delete(value);
  return snapshot;
}

function snapshotRecord(
  value: object,
  seen: WeakSet<object>,
  budget: SnapshotBudget,
  limits: SnapshotLimits,
  depth: number
): SafeBridgeSnapshot | SnapshotFailure {
  const keys = Reflect.ownKeys(value);
  if (keys.length > limits.maxRecordKeys || keys.length > budget.remainingKeys) return LIMIT;
  budget.remainingKeys -= keys.length;
  const copy = Object.create(null) as { [key: string]: SafeBridgeSnapshot };
  for (const key of keys) {
    if (typeof key !== "string") return MALFORMED;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return MALFORMED;
    const child = snapshotBridgeValue(descriptor.value, seen, budget, limits, depth + 1);
    if (child === MALFORMED || child === LIMIT) return child;
    Object.defineProperty(copy, key, { value: child, enumerable: true, configurable: true, writable: true });
  }
  return copy;
}

function snapshotArray(
  value: object,
  seen: WeakSet<object>,
  budget: SnapshotBudget,
  limits: SnapshotLimits,
  depth: number
): SafeBridgeSnapshot | SnapshotFailure {
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0) return MALFORMED;
  if (keys.length - 1 > budget.remainingItems) return LIMIT;
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > limits.maxArrayItems ||
    length > budget.remainingItems
  ) return LIMIT;
  if (keys.length !== length + 1) return MALFORMED;
  budget.remainingItems -= length;
  const copy: SafeBridgeSnapshot[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return MALFORMED;
    const child = snapshotBridgeValue(descriptor.value, seen, budget, limits, depth + 1);
    if (child === MALFORMED || child === LIMIT) return child;
    Object.defineProperty(copy, index, { value: child, enumerable: true, configurable: true, writable: true });
  }
  return copy;
}
