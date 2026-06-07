import type { AnyRecord, RuntimeSnapshot, VariableLimits } from "../types.ts";
import { DapSession } from "../dap/DapSession.ts";
import { VariableSerializer } from "./VariableSerializer.ts";

export class RuntimeSnapshotBuilder {
  session: DapSession;
  limits: Required<VariableLimits>;

  constructor(session: DapSession, limits: Required<VariableLimits>) {
    this.session = session;
    this.limits = limits;
  }

  async build(options: AnyRecord = {}): Promise<RuntimeSnapshot> {
    const threadId = options.threadId ?? this.session.threadId;
    const stack = await this.session.stackTrace(threadId, options.levels ?? 20);
    const frame = options.frameId
      ? { id: options.frameId }
      : stack.stackFrames[options.frameIndex ?? 0];
    const serializer = new VariableSerializer(this.session, this.limits);
    const scopes = frame?.id ? await this.session.scopes(frame.id) : [];
    const variables: RuntimeSnapshot["variables"] = {};
    for (const scope of scopes) {
      const scopeVariables = await this.session.variables(scope.variablesReference, {
        start: 0,
        count: this.limits.maxItems
      });
      variables[scope.name] = {
        name: scope.name,
        expensive: Boolean(scope.expensive),
        variables: await serializer.serializeVariables(scopeVariables)
      };
    }
    return {
      sessionId: this.session.sessionId,
      source: "headless",
      language: this.session.language,
      threadId: stack.threadId,
      frameId: frame?.id ?? null,
      stackFrames: stack.stackFrames,
      variables,
      limits: {
        maxDepth: this.limits.maxDepth,
        maxItems: this.limits.maxItems,
        maxStringLength: this.limits.maxStringLength
      }
    };
  }
}
