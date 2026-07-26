import type { AnyRecord } from "../types/json.ts";

export type SafeBridgeSnapshot = null | undefined | string | number | boolean | SafeBridgeSnapshot[] | { [key: string]: SafeBridgeSnapshot };

type SnapshotBudget = { remainingKeys: number; remainingItems: number };

const INVALID = Symbol("invalid bridge snapshot");
const MAX_DEPTH = 8;
const MAX_KEYS = 128;
const MAX_ITEMS = 128;

export function safeBridgeDataRecord(value: unknown): AnyRecord | null {
  try {
    const snapshot = snapshotBridgeValue(value, new WeakSet<object>(), { remainingKeys: MAX_KEYS, remainingItems: MAX_ITEMS }, 0);
    if (snapshot === INVALID || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
    return snapshot as AnyRecord;
  } catch {
    return null;
  }
}

export function decodeBridgeEvent(event: unknown): { clientId?: string; message: AnyRecord } | null {
  const envelope = safeBridgeDataRecord(event);
  if (!envelope) return null;
  const message = safeBridgeDataRecord(envelope.message);
  if (!message) return null;
  return { clientId: opaqueBridgeId(envelope.clientId), message };
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

function snapshotBridgeValue(value: unknown, seen: WeakSet<object>, budget: SnapshotBudget, depth: number): SafeBridgeSnapshot | typeof INVALID {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID;
  if (typeof value !== "object" || depth > MAX_DEPTH || seen.has(value)) return INVALID;
  seen.add(value);
  let snapshot: SafeBridgeSnapshot | typeof INVALID;
  if (Array.isArray(value)) {
    snapshot = Object.getPrototypeOf(value) === Array.prototype ? snapshotArray(value, seen, budget, depth) : INVALID;
  } else {
    const prototype = Object.getPrototypeOf(value);
    snapshot = prototype === Object.prototype || prototype === null ? snapshotRecord(value, seen, budget, depth) : INVALID;
  }
  seen.delete(value);
  return snapshot;
}

function snapshotRecord(value: object, seen: WeakSet<object>, budget: SnapshotBudget, depth: number): SafeBridgeSnapshot | typeof INVALID {
  const keys = Reflect.ownKeys(value);
  if (keys.length > budget.remainingKeys) return INVALID;
  budget.remainingKeys -= keys.length;
  const copy = Object.create(null) as { [key: string]: SafeBridgeSnapshot };
  for (const key of keys) {
    if (typeof key !== "string") return INVALID;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return INVALID;
    const child = snapshotBridgeValue(descriptor.value, seen, budget, depth + 1);
    if (child === INVALID) return INVALID;
    Object.defineProperty(copy, key, { value: child, enumerable: true, configurable: true, writable: true });
  }
  return copy;
}

function snapshotArray(value: object, seen: WeakSet<object>, budget: SnapshotBudget, depth: number): SafeBridgeSnapshot | typeof INVALID {
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0 || keys.length - 1 > budget.remainingItems) return INVALID;
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > budget.remainingItems || keys.length !== length + 1) return INVALID;
  budget.remainingItems -= length;
  const copy: SafeBridgeSnapshot[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return INVALID;
    const child = snapshotBridgeValue(descriptor.value, seen, budget, depth + 1);
    if (child === INVALID) return INVALID;
    Object.defineProperty(copy, index, { value: child, enumerable: true, configurable: true, writable: true });
  }
  return copy;
}
