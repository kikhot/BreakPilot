import path from "node:path";
import { AdapterRegistry } from "../adapters/AdapterRegistry.ts";
import type { LanguageAdapter } from "../adapters/LanguageAdapter.ts";
import { DapSession } from "../dap/DapSession.ts";
import { RuntimeSnapshotBuilder } from "../serializers/SnapshotBuilder.ts";
import { SecurityPolicy } from "../security/SecurityPolicy.ts";
import { AuditLogger } from "../audit/AuditLogger.ts";
import type {
  AnyRecord,
  DebugLanguage,
  DebugMcpPolicy,
  DebugMode,
  DebugSessionRecord,
  EvaluateMode,
  RuntimeSnapshot,
  SessionOwnerValue,
  SessionSummary,
  StoppedEvent,
  ToolResponse
} from "../types.ts";
import { IdeBridgeServer } from "../ide/IdeBridgeServer.ts";
import { DebugMcpError, ErrorCodes, ok } from "../utils/errors.ts";
import { makeSessionId } from "../utils/ids.ts";
import { resolveWorkspacePath } from "../utils/path.ts";
import { BreakpointManager } from "./BreakpointManager.ts";
import { SessionCoordinator } from "./SessionCoordinator.ts";
import { SessionOwner, SessionState } from "./SessionOwner.ts";
import { SessionStore } from "./SessionStore.ts";

type DebugToolArgs = AnyRecord & {
  sessionId?: string;
  lang?: DebugLanguage;
  language?: DebugLanguage;
  workspace?: string;
  program?: string;
  mode?: DebugMode | EvaluateMode;
  owner?: SessionOwnerValue;
  host?: string;
  port?: number | string;
  file?: string;
  line?: number;
  breakpointId?: string;
  requireVerified?: boolean;
  expression?: string;
  frameId?: number;
  threadId?: number;
  timeoutMs?: number;
  terminateDebuggee?: boolean;
  restart?: boolean;
  env?: NodeJS.ProcessEnv | AnyRecord;
  maxDepth?: number;
  maxItems?: number;
  maxStringLength?: number;
  redactPatterns?: string[];
};

interface CreateSessionInput {
  language: DebugLanguage;
  adapter: LanguageAdapter;
  workspaceRoot: string;
  mode: DebugMode;
  owner: SessionOwnerValue;
  adapterArgs?: AnyRecord;
}

export class DebugSessionManager {
  policy: DebugMcpPolicy;
  security: SecurityPolicy;
  audit: AuditLogger;
  adapters: AdapterRegistry;
  sessions: SessionStore;
  breakpoints: BreakpointManager;
  coordinator: SessionCoordinator;
  ideBridge?: IdeBridgeServer | null;

  constructor({ policy, ideBridge }: { policy: DebugMcpPolicy; ideBridge?: IdeBridgeServer | null }) {
    this.policy = policy;
    this.security = new SecurityPolicy(policy);
    this.audit = new AuditLogger(policy);
    this.adapters = new AdapterRegistry();
    this.sessions = new SessionStore();
    this.breakpoints = new BreakpointManager();
    this.coordinator = new SessionCoordinator();
    this.ideBridge = ideBridge;
  }

  async debugLaunch(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const auditId = this.audit.record("debug_launch_requested", { args: this.#safeArgs(args) });
    this.security.assertNotProduction(args);
    const language = String(args.lang || args.language || "python").toLowerCase();
    const adapter = this.adapters.get(language);
    const workspaceRoot = args.workspace
      ? resolveWorkspacePath(this.security.workspaceRoot(), args.workspace)
      : this.security.workspaceRoot();
    if (args.program) this.security.assertWorkspacePath(args.program);

    const session = await this.#createSession({
      language,
      adapter,
      workspaceRoot,
      mode: args.mode ?? "headless",
      owner: args.owner ?? SessionOwner.MCP,
      adapterArgs: args
    });

    try {
      await session.dap.initialize(adapter.adapterId);
      await session.dap.launch(
        adapter.normalizeLaunchArgs({
          ...args,
          workspaceRoot
        })
      );
      session.state = SessionState.RUNNING;
      this.audit.record("debug_launch_succeeded", { sessionId: session.sessionId, language });
      return ok(session.sessionId, this.#sessionSummary(session), auditId);
    } catch (error) {
      const typedError = error as Error & { details?: AnyRecord };
      session.state = SessionState.FAILED;
      throw new DebugMcpError(ErrorCodes.LAUNCH_FAILED, typedError.message, {
        sessionId: session.sessionId,
        cause: typedError.details ?? {}
      });
    }
  }

  async debugAttach(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const auditId = this.audit.record("debug_attach_requested", { args: this.#safeArgs(args) });
    const host = args.host ?? "127.0.0.1";
    const port = Number(args.port ?? (args.lang === "node" ? 9229 : 5678));
    this.security.assertHostPort(host, port, "attach");
    this.security.assertNotProduction(args);
    const language = String(args.lang || args.language || "python").toLowerCase();
    const adapter = this.adapters.get(language);
    const workspaceRoot = args.workspace
      ? resolveWorkspacePath(this.security.workspaceRoot(), args.workspace)
      : this.security.workspaceRoot();

    const session = await this.#createSession({
      language,
      adapter,
      workspaceRoot,
      mode: args.mode ?? "headless",
      owner: args.owner ?? SessionOwner.MCP,
      adapterArgs: { ...args, attachMode: true, host, port }
    });

    try {
      await session.dap.initialize(adapter.adapterId);
      await session.dap.attach(
        adapter.normalizeAttachArgs({
          ...args,
          host,
          port,
          workspaceRoot
        })
      );
      session.state = SessionState.RUNNING;
      this.audit.record("debug_attach_succeeded", { sessionId: session.sessionId, language, host, port });
      return ok(session.sessionId, this.#sessionSummary(session), auditId);
    } catch (error) {
      const typedError = error as Error & { details?: AnyRecord };
      session.state = SessionState.FAILED;
      throw new DebugMcpError(ErrorCodes.ATTACH_FAILED, typedError.message, {
        sessionId: session.sessionId,
        cause: typedError.details ?? {}
      });
    }
  }

  async setBreakpoint(args: DebugToolArgs = {}): Promise<ToolResponse> {
    if (!args.sessionId || !args.file || !args.line) {
      throw new DebugMcpError(ErrorCodes.INVALID_ARGUMENT, "sessionId, file, and line are required.");
    }
    const session = this.sessions.get(args.sessionId);
    this.coordinator.assertCanControl(session, SessionOwner.MCP, "set breakpoint");
    const file = this.security.assertWorkspacePath(args.file);
    const auditId = this.audit.record("set_breakpoint_requested", {
      sessionId: session.sessionId,
      file,
      line: args.line
    });
    const breakpoint = this.breakpoints.add(session.sessionId, {
      file,
      line: args.line,
      column: args.column,
      condition: args.condition,
      hitCondition: args.hitCondition,
      logMessage: args.logMessage,
      owner: args.owner ?? "agent"
    });
    const sourceBreakpoints = this.breakpoints.listForSource(session.sessionId, file);
    const dapBreakpoints = await session.dap.setBreakpoints(file, sourceBreakpoints);
    this.breakpoints.updateVerification(session.sessionId, file, dapBreakpoints);
    const updated = this.breakpoints.listForSource(session.sessionId, file);
    const selected = updated.find((bp) => bp.id === breakpoint.id) ?? breakpoint;

    this.ideBridge?.broadcast({
      type: "agent_set_breakpoint",
      sessionId: session.sessionId,
      workspaceRoot: session.workspaceRoot,
      breakpoint: selected
    });

    if (!selected.verified && args.requireVerified) {
      throw new DebugMcpError(
        ErrorCodes.BREAKPOINT_NOT_VERIFIED,
        "Breakpoint was not verified by debug adapter.",
        { breakpoint: selected }
      );
    }

    this.audit.record("set_breakpoint_finished", {
      sessionId: session.sessionId,
      breakpoint: selected
    });
    return ok(session.sessionId, { breakpoint: selected, breakpoints: updated }, auditId);
  }

  async removeBreakpoint(args: DebugToolArgs = {}): Promise<ToolResponse> {
    if (!args.sessionId || !args.breakpointId) {
      throw new DebugMcpError(ErrorCodes.INVALID_ARGUMENT, "sessionId and breakpointId are required.");
    }
    const session = this.sessions.get(args.sessionId);
    const auditId = this.audit.record("remove_breakpoint_requested", args);
    const breakpoint = this.breakpoints.list(session.sessionId).find((bp) => bp.id === args.breakpointId);
    const removed = this.breakpoints.remove(session.sessionId, args.breakpointId);
    if (breakpoint) {
      const remaining = this.breakpoints.listForSource(session.sessionId, breakpoint.file);
      await session.dap.setBreakpoints(breakpoint.file, remaining);
      this.ideBridge?.broadcast({
        type: "agent_remove_breakpoint",
        sessionId: session.sessionId,
        breakpointId: args.breakpointId,
        file: breakpoint.file,
        line: breakpoint.line
      });
    }
    return ok(session.sessionId, { removed }, auditId);
  }

  async waitForBreakpoint(args: DebugToolArgs = {}): Promise<ToolResponse> {
    if (!args.sessionId) {
      throw new DebugMcpError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
    }
    const session = this.sessions.get(args.sessionId);
    const auditId = this.audit.record("wait_for_breakpoint_requested", {
      sessionId: session.sessionId,
      timeoutMs: args.timeoutMs
    });
    const stopped = await session.dap.waitForBreakpoint(args.timeoutMs ?? 30000).catch(async (error) => {
      if (error instanceof DebugMcpError && error.code === ErrorCodes.BREAKPOINT_TIMEOUT) {
        const recovered = await this.#recoverBreakpointHit(session);
        if (recovered) return recovered;
      }
      throw error;
    });
    session.state = SessionState.PAUSED;
    this.ideBridge?.broadcast({
      type: "ide_breakpoint_hit",
      sessionId: session.sessionId,
      stopped
    });
    return ok(session.sessionId, { stopped }, auditId);
  }

  async getRuntimeSnapshot(args: DebugToolArgs = {}): Promise<ToolResponse<RuntimeSnapshot>> {
    if (!args.sessionId) {
      throw new DebugMcpError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
    }
    const session = this.sessions.get(args.sessionId);
    const auditId = this.audit.record("get_runtime_snapshot_requested", {
      sessionId: session.sessionId,
      limits: args.limits
    });
    const limits = this.security.variableLimits(args);
    const snapshot = await new RuntimeSnapshotBuilder(session.dap, limits).build(args);
    this.audit.record("get_runtime_snapshot_finished", {
      sessionId: session.sessionId,
      frameId: snapshot.frameId
    });
    return ok(session.sessionId, snapshot, auditId);
  }

  async evaluate(args: DebugToolArgs = {}): Promise<ToolResponse> {
    if (!args.sessionId || !args.expression) {
      throw new DebugMcpError(ErrorCodes.INVALID_ARGUMENT, "sessionId and expression are required.");
    }
    const session = this.sessions.get(args.sessionId);
    const mode = args.mode ?? this.policy.evaluate.defaultMode ?? "readonly";
    const auditId = this.audit.record("evaluate_requested", {
      sessionId: session.sessionId,
      expression: args.expression,
      mode
    });
    this.security.assertEvaluate(args.expression, mode);
    let frameId = args.frameId;
    if (!frameId) {
      const stack = await session.dap.stackTrace(args.threadId ?? session.dap.threadId, 1);
      frameId = stack.stackFrames[0]?.id;
    }
    const result = await session.dap.evaluate(args.expression, {
      frameId,
      context: args.context ?? "watch",
      timeoutMs: args.timeoutMs ?? this.policy.evaluate.timeoutMs
    });
    return ok(session.sessionId, { result, mode, frameId }, auditId);
  }

  async continueExecution(args: DebugToolArgs = {}): Promise<ToolResponse> {
    if (!args.sessionId) {
      throw new DebugMcpError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
    }
    const session = this.sessions.get(args.sessionId);
    const auditId = this.audit.record("continue_requested", { sessionId: session.sessionId });
    this.coordinator.assertCanControl(session, SessionOwner.MCP, "continue");
    this.coordinator.beginExecution(session, "continue");
    try {
      const result = await session.dap.continue(args.threadId ?? session.dap.threadId);
      session.state = SessionState.RUNNING;
      return ok(session.sessionId, { result }, auditId);
    } finally {
      this.coordinator.endExecution(session);
    }
  }

  async step(args: DebugToolArgs = {}, kind: "over" | "into" | "out" = "over"): Promise<ToolResponse> {
    if (!args.sessionId) {
      throw new DebugMcpError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
    }
    const session = this.sessions.get(args.sessionId);
    const auditId = this.audit.record(`step_${kind}_requested`, { sessionId: session.sessionId });
    this.coordinator.assertCanControl(session, SessionOwner.MCP, `step ${kind}`);
    this.coordinator.beginExecution(session, `step:${kind}`);
    try {
      const threadId = args.threadId ?? session.dap.threadId;
      const result =
        kind === "into"
          ? await session.dap.stepInto(threadId)
          : kind === "out"
            ? await session.dap.stepOut(threadId)
            : await session.dap.stepOver(threadId);
      session.state = SessionState.RUNNING;
      return ok(session.sessionId, { result }, auditId);
    } finally {
      this.coordinator.endExecution(session);
    }
  }

  async disconnect(args: DebugToolArgs = {}): Promise<ToolResponse> {
    if (!args.sessionId) {
      throw new DebugMcpError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
    }
    const session = this.sessions.get(args.sessionId);
    const auditId = this.audit.record("disconnect_requested", { sessionId: session.sessionId });
    const result = await session.dap.disconnect({
      terminateDebuggee: Boolean(args.terminateDebuggee),
      restart: Boolean(args.restart)
    });
    session.state = SessionState.TERMINATED;
    this.breakpoints.clear(session.sessionId);
    this.sessions.remove(session.sessionId);
    const warnings = result.acknowledged === false ? [result.message ?? "Debug adapter did not acknowledge disconnect."] : [];
    return ok(session.sessionId, { disconnected: true, result }, auditId, warnings);
  }

  listSessions(): ToolResponse {
    const auditId = this.audit.record("list_sessions_requested");
    return ok(null, { sessions: this.sessions.list() }, auditId);
  }

  listBreakpoints(args: DebugToolArgs = {}): ToolResponse {
    if (!args.sessionId) {
      throw new DebugMcpError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
    }
    const auditId = this.audit.record("list_breakpoints_requested", args);
    return ok(args.sessionId, { breakpoints: this.breakpoints.list(args.sessionId) }, auditId);
  }

  ideStatus(): ToolResponse {
    const auditId = this.audit.record("ide_status_requested");
    return ok(null, this.ideBridge?.status() ?? { enabled: false, clients: [] }, auditId);
  }

  async #createSession({
    language,
    adapter,
    workspaceRoot,
    mode,
    owner,
    adapterArgs = {}
  }: CreateSessionInput): Promise<DebugSessionRecord> {
    const sessionId = makeSessionId();
    const client = adapter.createClient({ ...adapterArgs, workspaceRoot });
    const dap = new DapSession({ sessionId, language, client, workspaceRoot });
    const record: DebugSessionRecord = {
      sessionId,
      language,
      workspaceRoot,
      mode,
      owner,
      state: SessionState.INITIALIZING,
      createdAt: new Date().toISOString(),
      dap
    };
    dap.on("stopped", () => {
      record.state = SessionState.PAUSED;
    });
    dap.on("terminated", () => {
      record.state = SessionState.TERMINATED;
    });
    this.sessions.add(record);
    dap.startClient();
    return record;
  }

  #sessionSummary(session: DebugSessionRecord): SessionSummary {
    return {
      sessionId: session.sessionId,
      language: session.language,
      mode: session.mode,
      owner: session.owner,
      state: session.state,
      workspaceRoot: session.workspaceRoot,
      capabilities: session.dap.capabilities
    };
  }

  async #recoverBreakpointHit(session: DebugSessionRecord): Promise<StoppedEvent | null> {
    const breakpoints = this.breakpoints.list(session.sessionId).filter((bp) => bp.verified);
    if (breakpoints.length === 0) return null;

    let threads: AnyRecord[];
    try {
      threads = await session.dap.threads();
    } catch {
      return null;
    }

    for (const thread of threads) {
      const threadId = Number(thread.id);
      if (!Number.isFinite(threadId)) continue;
      try {
        const stack = await session.dap.stackTrace(threadId, 1);
        const topFrame = stack.stackFrames[0];
        const sourcePath = topFrame?.source?.path;
        if (!sourcePath || !topFrame.line) continue;
        const matched = breakpoints.find(
          (bp) => path.resolve(bp.file) === path.resolve(String(sourcePath)) && bp.line === topFrame.line
        );
        if (!matched) continue;
        session.dap.threadId = threadId;
        return {
          sessionId: session.sessionId,
          reason: "breakpoint",
          threadId,
          description: "Recovered breakpoint hit from stackTrace after missing stopped event.",
          allThreadsStopped: true,
          recovered: true,
          breakpointId: matched.id,
          topFrame
        };
      } catch {
        // Running threads can reject stackTrace; only an exact breakpoint match is recoverable.
      }
    }
    return null;
  }

  #safeArgs(args: DebugToolArgs): AnyRecord {
    const clone: AnyRecord = { ...args };
    if (clone.env) clone.env = "[redacted env]";
    return clone;
  }
}
