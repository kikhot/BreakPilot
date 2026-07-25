import type {
  DapBreakpoint,
  DapEventMessage,
  StoppedEvent
} from "../../types/dap.ts";
import type { DebugLanguage, RuntimeStepKind } from "../../types/debug.ts";
import type { InspectVariableResult, RuntimeSnapshot, VariableLimits } from "../../types/inspection.ts";
import type { AnyRecord } from "../../types/json.ts";
import type {
  BreakpointRecord,
  DrainEventsArgs,
  RuntimeDebugProvider,
  RuntimeEvent,
  RuntimeEventKind,
  RuntimeEventPage,
  ThreadId
} from "../../types/sessions.ts";
import { DapSession } from "../../dap/DapSession.ts";
import { RuntimeSnapshotBuilder } from "../../inspection/SnapshotBuilder.ts";
import { VariableSerializer } from "../../inspection/VariableSerializer.ts";
import type { RuntimeProviderCapabilities } from "../../types/capabilities.ts";
import { dapProviderCapabilities } from "../ProviderCapabilities.ts";
import { RuntimeEventBuffer, normalizeRuntimeEventMetadata } from "../RuntimeEventBuffer.ts";

const dapRuntimeEventKinds = new Set<RuntimeEventKind>([
  "continued",
  "stopped",
  "output",
  "thread",
  "process",
  "terminated"
]);

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function normalizedThreadId(value: unknown): ThreadId | undefined {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedDapMetadata(kind: RuntimeEventKind, body: unknown): AnyRecord | undefined {
  const data = normalizeRuntimeEventMetadata(body) ?? {};
  if (kind === "process" && data.processId === undefined) {
    const systemProcessId = ownValue(body, "systemProcessId");
    const alias = normalizeRuntimeEventMetadata({ processId: systemProcessId });
    if (alias?.processId !== undefined) data.processId = alias.processId;
  }
  return Object.keys(data).length > 0 ? data : undefined;
}

function normalizeDapRuntimeEvent(
  event: DapEventMessage
): Omit<RuntimeEvent, "sequence" | "timestamp" | "sessionId"> | null {
  const eventName = ownValue(event, "event");
  if (typeof eventName !== "string" || !dapRuntimeEventKinds.has(eventName as RuntimeEventKind)) return null;

  const kind = eventName as RuntimeEventKind;
  const body = ownValue(event, "body");
  const normalized: Omit<RuntimeEvent, "sequence" | "timestamp" | "sessionId"> = { kind };
  const threadId = normalizedThreadId(ownValue(body, "threadId"));
  if (threadId !== undefined) normalized.threadId = threadId;
  if (kind === "output") {
    const message = ownValue(body, "output");
    const category = ownValue(body, "category");
    if (typeof message === "string") normalized.message = message;
    if (typeof category === "string") normalized.category = category;
  }
  const data = normalizedDapMetadata(kind, body);
  if (data !== undefined) normalized.data = data;
  return normalized;
}

export class DapRuntimeProvider implements RuntimeDebugProvider {
  kind = "dap";
  dap: DapSession;
  events: RuntimeEventBuffer;
  #unsubscribeRuntimeEvents: (() => void) | null = null;

  constructor(dap: DapSession, events = new RuntimeEventBuffer(dap.sessionId)) {
    this.dap = dap;
    this.events = events;
    if (typeof dap.onRuntimeEvent === "function") {
      this.#unsubscribeRuntimeEvents = dap.onRuntimeEvent((event) => {
        const normalized = normalizeDapRuntimeEvent(event);
        if (normalized) this.events.append(normalized);
      });
    }
  }

  get sessionId(): string {
    return this.dap.sessionId;
  }

  get language(): DebugLanguage {
    return this.dap.language;
  }

  get workspaceRoot(): string {
    return this.dap.workspaceRoot;
  }

  get capabilities(): RuntimeProviderCapabilities {
    const capabilities = dapProviderCapabilities(this.dap.capabilities);
    if (
      this.#unsubscribeRuntimeEvents &&
      typeof this.dap.hasRuntimeEventSource === "function" &&
      this.dap.hasRuntimeEventSource()
    ) {
      capabilities.eventDrain = "native";
    }
    return capabilities;
  }

  get threadId(): number | null {
    return this.dap.threadId;
  }

  async setBreakpoints(filePath: string, breakpoints: BreakpointRecord[]): Promise<DapBreakpoint[]> {
    return this.dap.setBreakpoints(filePath, breakpoints);
  }

  async waitForBreakpoint(timeoutMs = 30000): Promise<StoppedEvent> {
    return this.dap.waitForBreakpoint(timeoutMs);
  }

  async drainEvents(args?: DrainEventsArgs): Promise<RuntimeEventPage> {
    return this.events.read(args);
  }

  disposeRuntimeEvents(): void {
    this.#unsubscribeRuntimeEvents?.();
    this.#unsubscribeRuntimeEvents = null;
  }

  async listThreads(): Promise<AnyRecord[]> {
    return this.dap.threads();
  }

  async getCallStack(threadId: number | null = this.dap.threadId, limit = 20): Promise<AnyRecord> {
    return this.dap.stackTrace(threadId, limit);
  }

  async getRuntimeSnapshot(args: AnyRecord, limits: Required<VariableLimits>): Promise<RuntimeSnapshot> {
    return new RuntimeSnapshotBuilder(this.dap, limits).build(args);
  }

  async inspectVariable(
    args: AnyRecord,
    limits: Required<VariableLimits>
  ): Promise<InspectVariableResult> {
    const variablesReference = Number(args.variablesReference);
    const variables = await this.dap.variables(variablesReference, {
      start: args.start ?? 0,
      count: args.count ?? limits.maxItems
    });
    const serializer = new VariableSerializer(this.dap, limits, {
      objectFields: args.objectFields ?? "deep"
    });
    const serialized = await serializer.serializeVariables(variables);
    return {
      variablesReference,
      start: args.start ?? 0,
      count: args.count ?? limits.maxItems,
      variables: serialized,
      limits: {
        maxDepth: limits.maxDepth,
        maxItems: limits.maxItems,
        maxStringLength: limits.maxStringLength
      }
    };
  }

  async setVariable(args: AnyRecord): Promise<AnyRecord> {
    const parentRef = Number(args.parentRef ?? 0);
    const name = String(args.name ?? "");
    const value = String(args.newValue ?? "");
    if (!parentRef || !name) {
      throw new Error("DAP setVariable requires parentRef and name.");
    }
    return this.dap.setVariable(parentRef, name, value);
  }

  async evaluate(expression: string, options: AnyRecord = {}): Promise<AnyRecord> {
    let frameId = options.frameId;
    if (!frameId) {
      const stack = await this.dap.stackTrace(options.threadId ?? this.dap.threadId, 1);
      frameId = stack.stackFrames[0]?.id;
    }
    return this.dap.evaluate(expression, {
      frameId,
      context: options.context ?? "watch",
      timeoutMs: options.timeoutMs
    });
  }

  async pause(threadId: number | null = this.dap.threadId): Promise<AnyRecord> {
    return this.dap.pause(threadId);
  }

  async continue(threadId: number | null = this.dap.threadId): Promise<AnyRecord> {
    return this.dap.continue(threadId);
  }

  async step(kind: RuntimeStepKind, threadId: number | null = this.dap.threadId): Promise<AnyRecord> {
    if (kind === "into") return this.dap.stepInto(threadId);
    if (kind === "out") return this.dap.stepOut(threadId);
    return this.dap.stepOver(threadId);
  }

  async disconnect(options: { terminateDebuggee?: boolean; restart?: boolean } = {}): Promise<AnyRecord> {
    try {
      return await this.dap.disconnect(options);
    } finally {
      this.disposeRuntimeEvents();
    }
  }
}
