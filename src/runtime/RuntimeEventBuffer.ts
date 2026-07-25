import type {
  DrainEventsArgs,
  RuntimeEvent,
  RuntimeEventKind,
  RuntimeEventPage
} from "../types/sessions.ts";
import type { AnyRecord } from "../types/json.ts";

export const runtimeEventKinds = [
  "breakpoint",
  "breakpointError",
  "tracepoint",
  "output",
  "stopped",
  "continued",
  "thread",
  "process",
  "invalidated",
  "terminated"
] as const satisfies readonly RuntimeEventKind[];

const DEFAULT_CAPACITY = 256;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 256;
const runtimeMetadataKeys = [
  "reason",
  "description",
  "exitCode",
  "processId",
  "threadName",
  "moduleName",
  "sourceReference",
  "allThreadsStopped",
  "restart",
  "hitBreakpointIds",
  "areas"
] as const;

type RuntimeMetadataKey = (typeof runtimeMetadataKeys)[number];
type JsonScalar = string | number | boolean | null;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return 1;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function normalizeCapacity(capacity: number): number {
  if (!Number.isFinite(capacity)) return DEFAULT_CAPACITY;
  return Math.min(DEFAULT_CAPACITY, Math.max(1, Math.trunc(capacity)));
}

function normalizeRecord(value: unknown): AnyRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (!encoded) return undefined;
    const decoded: unknown = JSON.parse(encoded);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
    return decoded as AnyRecord;
  } catch {
    return undefined;
  }
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function normalizeMetadataValue(value: unknown): JsonScalar | JsonScalar[] | undefined {
  if (isJsonScalar(value)) return value;
  if (!Array.isArray(value)) return undefined;
  return value.filter(isJsonScalar);
}

export function normalizeRuntimeEventMetadata(value: unknown): AnyRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const normalized: Partial<Record<RuntimeMetadataKey, JsonScalar | JsonScalar[]>> = {};
  for (const key of runtimeMetadataKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
    const normalizedValue = normalizeMetadataValue(descriptor.value);
    if (normalizedValue !== undefined) normalized[key] = normalizedValue;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function copyEvent(event: RuntimeEvent): RuntimeEvent {
  const copy: RuntimeEvent = {
    sequence: event.sequence,
    timestamp: event.timestamp,
    kind: event.kind,
    sessionId: event.sessionId
  };
  if (event.breakpointId !== undefined) copy.breakpointId = event.breakpointId;
  if (event.threadId !== undefined) copy.threadId = event.threadId;
  if (event.message !== undefined) copy.message = event.message;
  if (event.category !== undefined) copy.category = event.category;
  if (event.position !== undefined) copy.position = normalizeRecord(event.position) ?? {};
  if (event.data !== undefined) {
    const data = normalizeRuntimeEventMetadata(event.data);
    if (data !== undefined) copy.data = data;
  }
  return copy;
}

export class RuntimeEventBuffer {
  readonly #sessionId: string;
  readonly #capacity: number;
  #events: RuntimeEvent[] = [];
  #nextSequence = 1;
  #defaultCursor = 0;

  constructor(sessionId: string, capacity = DEFAULT_CAPACITY) {
    this.#sessionId = sessionId;
    this.#capacity = normalizeCapacity(capacity);
  }

  append(event: Omit<RuntimeEvent, "sequence" | "timestamp" | "sessionId">): RuntimeEvent {
    if (!runtimeEventKinds.includes(event.kind as RuntimeEventKind)) {
      throw new TypeError(`Unsupported runtime event kind: ${String(event.kind)}`);
    }

    const normalized: RuntimeEvent = {
      sequence: this.#nextSequence,
      timestamp: new Date().toISOString(),
      kind: event.kind,
      sessionId: this.#sessionId
    };
    this.#nextSequence += 1;

    if (typeof event.breakpointId === "string") normalized.breakpointId = event.breakpointId;
    if (typeof event.threadId === "string" || (typeof event.threadId === "number" && Number.isFinite(event.threadId))) {
      normalized.threadId = event.threadId;
    }
    if (typeof event.message === "string") normalized.message = event.message;
    if (typeof event.category === "string") normalized.category = event.category;
    const position = normalizeRecord(event.position);
    if (position !== undefined) normalized.position = position;
    const data = normalizeRuntimeEventMetadata(event.data);
    if (data !== undefined) normalized.data = data;

    this.#events.push(normalized);
    if (this.#events.length > this.#capacity) this.#events.shift();
    return copyEvent(normalized);
  }

  read(args?: DrainEventsArgs): RuntimeEventPage {
    const requestedCursor = args?.cursor ?? this.#defaultCursor;
    const limit = normalizeLimit(args?.limit);
    const oldestCursor = this.#events[0]?.sequence ?? this.#nextSequence;
    const overflowed = requestedCursor < oldestCursor - 1;
    const effectiveCursor = overflowed ? oldestCursor - 1 : requestedCursor;
    const items = this.#events.filter((event) => event.sequence > effectiveCursor).slice(0, limit).map(copyEvent);
    const nextCursor = items.at(-1)?.sequence ?? effectiveCursor;
    if (args?.cursor === undefined) this.#defaultCursor = nextCursor;

    return {
      items,
      cursor: requestedCursor,
      nextCursor,
      oldestCursor,
      hasMore: this.#events.some((event) => event.sequence > nextCursor),
      overflowed,
      droppedCount: Math.max(0, oldestCursor - 1 - requestedCursor),
      supportedKinds: [...runtimeEventKinds],
      breakpointErrors: items.filter((item) => item.kind === "breakpointError"),
      tracepoints: items.filter((item) => item.kind === "tracepoint")
    };
  }
}
