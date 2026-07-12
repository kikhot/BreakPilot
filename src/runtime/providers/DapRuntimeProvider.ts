import type {
  DapBreakpoint,
  StoppedEvent
} from "../../types/dap.ts";
import type { DebugLanguage, RuntimeStepKind } from "../../types/debug.ts";
import type { InspectVariableResult, RuntimeSnapshot, VariableLimits } from "../../types/inspection.ts";
import type { AnyRecord } from "../../types/json.ts";
import type { BreakpointRecord, RuntimeDebugProvider } from "../../types/sessions.ts";
import { DapSession } from "../../dap/DapSession.ts";
import { RuntimeSnapshotBuilder } from "../../inspection/SnapshotBuilder.ts";
import { VariableSerializer } from "../../inspection/VariableSerializer.ts";
import type { RuntimeProviderCapabilities } from "../../types/capabilities.ts";
import { dapProviderCapabilities } from "../ProviderCapabilities.ts";

export class DapRuntimeProvider implements RuntimeDebugProvider {
  kind = "dap";
  dap: DapSession;

  constructor(dap: DapSession) {
    this.dap = dap;
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
    return dapProviderCapabilities(this.dap.capabilities);
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
    return this.dap.disconnect(options);
  }
}
