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

  get capabilities(): AnyRecord {
    return this.dap.capabilities;
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
