import path from "node:path";
import { AdapterRegistry } from "../adapters/AdapterRegistry.ts";
import type { LanguageAdapter } from "../adapters/LanguageAdapter.ts";
import { DapSession } from "../dap/DapSession.ts";
import { SecurityPolicy } from "../security/SecurityPolicy.ts";
import { AuditLogger } from "../audit/AuditLogger.ts";
import type {
  AnyRecord,
  DebugLanguage,
  DebugMcpPolicy,
  DebugMode,
  DebugSessionRecord,
  EvaluateMode,
  IdeDebugSessionInfo,
  RuntimeSnapshot,
  SessionOwnerValue,
  SessionSummary,
  StoppedEvent,
  ToolResponse
} from "../types.ts";
import { IdeBridgeServer } from "../ide/IdeBridgeServer.ts";
import { IdeMessageTypes } from "../ide/IdeProtocol.ts";
import { DebugMcpError, ErrorCodes, ok } from "../utils/errors.ts";
import { makeSessionId } from "../utils/ids.ts";
import { resolveWorkspacePath } from "../utils/path.ts";
import { BreakpointManager } from "./BreakpointManager.ts";
import { DapRuntimeProvider } from "./DapRuntimeProvider.ts";
import { IdeRuntimeProvider } from "./IdeRuntimeProvider.ts";
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
  clientId?: string;
  ideSessionId?: string;
  env?: NodeJS.ProcessEnv | AnyRecord;
  maxDepth?: number;
  maxItems?: number;
  maxStringLength?: number;
  variablesReference?: number;
  start?: number;
  count?: number;
  objectFields?: string;
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
    this.#wireIdeBridge();
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
      const dap = session.dap;
      if (!dap) throw new DebugMcpError(ErrorCodes.TOOL_FAILED, "DAP session was not initialized.");
      await dap.initialize(adapter.adapterId);
      await dap.launch(
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
      const dap = session.dap;
      if (!dap) throw new DebugMcpError(ErrorCodes.TOOL_FAILED, "DAP session was not initialized.");
      await dap.initialize(adapter.adapterId);
      await dap.attach(
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
    if (session.providerKind !== "ide") {
      this.coordinator.assertCanControl(session, SessionOwner.MCP, "set breakpoint");
    }
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
    const dapBreakpoints = await session.provider.setBreakpoints(file, sourceBreakpoints);
    this.breakpoints.updateVerification(session.sessionId, file, dapBreakpoints);
    const updated = this.breakpoints.listForSource(session.sessionId, file);
    const selected = updated.find((bp) => bp.id === breakpoint.id) ?? breakpoint;

    if (session.providerKind === "dap") {
      this.ideBridge?.broadcast({
        type: "agent_set_breakpoint",
        sessionId: session.sessionId,
        workspaceRoot: session.workspaceRoot,
        breakpoint: selected
      });
    }

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
      if (session.provider.removeBreakpoint) {
        await session.provider.removeBreakpoint(breakpoint);
      } else {
        await session.provider.setBreakpoints(breakpoint.file, remaining);
      }
      if (session.providerKind === "dap") {
        this.ideBridge?.broadcast({
          type: "agent_remove_breakpoint",
          sessionId: session.sessionId,
          breakpointId: args.breakpointId,
          file: breakpoint.file,
          line: breakpoint.line
        });
      }
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
    const stopped = await session.provider.waitForBreakpoint(args.timeoutMs ?? 30000).catch(async (error) => {
      if (error instanceof DebugMcpError && error.code === ErrorCodes.BREAKPOINT_TIMEOUT) {
        const recovered = await this.#recoverBreakpointHit(session);
        if (recovered) return recovered;
      }
      throw error;
    });
    session.state = SessionState.PAUSED;
    if (session.providerKind === "dap") {
      this.ideBridge?.broadcast({
        type: "ide_breakpoint_hit",
        sessionId: session.sessionId,
        stopped
      });
    }
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
    const snapshot = await session.provider.getRuntimeSnapshot(args, limits);
    this.audit.record("get_runtime_snapshot_finished", {
      sessionId: session.sessionId,
      frameId: snapshot.frameId
    });
    return ok(session.sessionId, snapshot, auditId);
  }

  async inspectVariable(args: DebugToolArgs = {}): Promise<ToolResponse> {
    if (!args.sessionId || !args.variablesReference) {
      throw new DebugMcpError(ErrorCodes.INVALID_ARGUMENT, "sessionId and variablesReference are required.");
    }
    const session = this.sessions.get(args.sessionId);
    const auditId = this.audit.record("inspect_variable_requested", {
      sessionId: session.sessionId,
      variablesReference: args.variablesReference,
      start: args.start,
      count: args.count
    });
    const limits = this.security.variableLimits({
      ...args,
      maxItems: args.count ?? args.maxItems
    });
    if (!session.provider.inspectVariable) {
      throw new DebugMcpError(ErrorCodes.TOOL_FAILED, "Runtime provider does not support variable inspection.", {
        sessionId: session.sessionId,
        providerKind: session.providerKind
      });
    }
    const result = await session.provider.inspectVariable(args, limits);
    return ok(session.sessionId, result, auditId);
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
    const result = await session.provider.evaluate(args.expression, {
      frameId: args.frameId,
      threadId: args.threadId,
      context: args.context ?? "watch",
      timeoutMs: args.timeoutMs ?? this.policy.evaluate.timeoutMs
    });
    return ok(session.sessionId, { result, mode }, auditId);
  }

  async continueExecution(args: DebugToolArgs = {}): Promise<ToolResponse> {
    if (!args.sessionId) {
      throw new DebugMcpError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
    }
    const session = this.sessions.get(args.sessionId);
    const auditId = this.audit.record("continue_requested", { sessionId: session.sessionId });
    if (session.providerKind !== "ide") {
      this.coordinator.assertCanControl(session, SessionOwner.MCP, "continue");
    }
    this.coordinator.beginExecution(session, "continue");
    try {
      const result = await session.provider.continue(args.threadId ?? session.provider.threadId);
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
    if (session.providerKind !== "ide") {
      this.coordinator.assertCanControl(session, SessionOwner.MCP, `step ${kind}`);
    }
    this.coordinator.beginExecution(session, `step:${kind}`);
    try {
      const threadId = args.threadId ?? session.provider.threadId;
      const result = await session.provider.step(kind, threadId);
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
    const result = await session.provider.disconnect({
      terminateDebuggee: Boolean(args.terminateDebuggee),
      restart: Boolean(args.restart)
    });
    session.state = SessionState.TERMINATED;
    this.breakpoints.clear(session.sessionId);
    this.sessions.remove(session.sessionId);
    const warnings = result.acknowledged === false ? [result.message ?? "Debug adapter did not acknowledge disconnect."] : [];
    return ok(session.sessionId, { disconnected: true, result }, auditId, warnings);
  }

  listIdeSessions(args: DebugToolArgs = {}): ToolResponse {
    const auditId = this.audit.record("list_ide_sessions_requested", {
      workspaceRoot: args.workspace
    });
    const workspaceRoot = args.workspace
      ? resolveWorkspacePath(this.security.workspaceRoot(), args.workspace)
      : undefined;
    const sessions = this.ideBridge?.registry.listSessions({
      clientId: args.clientId,
      workspaceRoot
    }) ?? [];
    return ok(null, { sessions }, auditId);
  }

  async adoptIdeSession(args: DebugToolArgs = {}): Promise<ToolResponse> {
    if (!this.ideBridge) {
      throw new DebugMcpError(ErrorCodes.IDE_NOT_CONNECTED, "IDE bridge is not available.");
    }
    const auditId = this.audit.record("adopt_ide_session_requested", {
      clientId: args.clientId,
      ideSessionId: args.ideSessionId
    });
    const ideSession = this.#selectIdeSession(args);
    if (!ideSession) {
      throw new DebugMcpError(ErrorCodes.IDE_SESSION_NOT_FOUND, "IDE debug session was not found.", {
        clientId: args.clientId,
        ideSessionId: args.ideSessionId
      });
    }
    const workspaceRoot = ideSession.workspaceRoot ?? this.security.workspaceRoot();
    if (!this.policy.workspace.allowOutsideWorkspace) {
      this.security.assertWorkspacePath(path.relative(this.security.workspaceRoot(), workspaceRoot) || ".");
    }
    const existing = [...this.sessions.sessions.values()].find(
      (session) => session.ideSessionId === ideSession.ideSessionId && session.ideClientId === ideSession.clientId
    );
    if (existing) {
      return ok(existing.sessionId, this.#sessionSummary(existing), auditId, ["IDE session was already adopted."]);
    }

    const sessionId = makeSessionId();
    const provider = new IdeRuntimeProvider({
      sessionId,
      bridge: this.ideBridge,
      ideSession,
      workspaceRoot,
      language: args.lang ?? args.language ?? ideSession.language ?? "idea",
      confirmationTimeoutMs: this.policy.ide.confirmationTimeoutMs
    });
    const record: DebugSessionRecord = {
      sessionId,
      language: provider.language,
      workspaceRoot,
      mode: args.mode ?? "ide",
      owner: args.owner ?? SessionOwner.HYBRID,
      state: ideSession.state,
      createdAt: new Date().toISOString(),
      providerKind: provider.kind,
      provider,
      ideClientId: ideSession.clientId,
      ideSessionId: ideSession.ideSessionId
    };
    this.sessions.add(record);
    this.audit.record("adopt_ide_session_succeeded", {
      sessionId,
      clientId: ideSession.clientId,
      ideSessionId: ideSession.ideSessionId
    });
    return ok(sessionId, this.#sessionSummary(record), auditId);
  }

  async getActiveBreakpointContext(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const adopted = args.sessionId ? this.sessions.get(args.sessionId) : await this.#adoptActiveIdeSession(args);
    const auditId = this.audit.record("get_active_breakpoint_context_requested", {
      sessionId: adopted.sessionId,
      ideSessionId: adopted.ideSessionId
    });
    const stopped = await adopted.provider.waitForBreakpoint(args.timeoutMs ?? 1000).catch(() => null);
    const limits = this.security.variableLimits({
      ...args,
      maxDepth: args.maxDepth ?? 1,
      maxItems: args.maxItems ?? 10
    });
    const snapshot = await adopted.provider.getRuntimeSnapshot(
      {
        ...args,
        sessionId: adopted.sessionId,
        profile: args.profile ?? "focused",
        objectFields: args.objectFields ?? "preview"
      },
      limits
    );
    const topFrame = snapshot.stackFrames[args.frameIndex ?? 0] ?? snapshot.stackFrames[0] ?? null;
    return ok(
      adopted.sessionId,
      {
        stopped,
        topFrame,
        snapshot,
        ideSessionId: adopted.ideSessionId,
        providerKind: adopted.providerKind
      },
      auditId
    );
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
    const provider = new DapRuntimeProvider(dap);
    const record: DebugSessionRecord = {
      sessionId,
      language,
      workspaceRoot,
      mode,
      owner,
      state: SessionState.INITIALIZING,
      createdAt: new Date().toISOString(),
      providerKind: provider.kind,
      provider,
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
      providerKind: session.providerKind,
      ideClientId: session.ideClientId,
      ideSessionId: session.ideSessionId,
      capabilities: session.provider.capabilities
    };
  }

  async #recoverBreakpointHit(session: DebugSessionRecord): Promise<StoppedEvent | null> {
    if (!session.dap) return null;
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

  #wireIdeBridge(): void {
    if (!this.ideBridge) return;
    this.ideBridge.on(IdeMessageTypes.IDE_SESSION_PAUSED, ({ message }: { message: AnyRecord }) => {
      this.#updateAdoptedIdeSession(message.ideSessionId, message.clientId, SessionState.PAUSED);
    });
    this.ideBridge.on(IdeMessageTypes.IDE_BREAKPOINT_HIT, ({ message }: { message: AnyRecord }) => {
      this.#updateAdoptedIdeSession(message.ideSessionId, message.clientId, SessionState.PAUSED);
    });
    this.ideBridge.on(IdeMessageTypes.IDE_SESSION_STOPPED, ({ message }: { message: AnyRecord }) => {
      this.#updateAdoptedIdeSession(message.ideSessionId, message.clientId, SessionState.PAUSED);
    });
    this.ideBridge.on(IdeMessageTypes.IDE_SESSION_RESUMED, ({ message }: { message: AnyRecord }) => {
      this.#updateAdoptedIdeSession(message.ideSessionId, message.clientId, SessionState.RUNNING);
    });
    this.ideBridge.on(IdeMessageTypes.IDE_SESSION_TERMINATED, ({ message }: { message: AnyRecord }) => {
      this.#updateAdoptedIdeSession(message.ideSessionId, message.clientId, SessionState.TERMINATED);
    });
  }

  #updateAdoptedIdeSession(
    ideSessionId: string | undefined,
    clientId: string | undefined,
    state: string
  ): void {
    if (!ideSessionId) return;
    for (const session of this.sessions.sessions.values()) {
      if (session.ideSessionId !== ideSessionId) continue;
      if (clientId && session.ideClientId && session.ideClientId !== clientId) continue;
      session.state = state;
    }
  }

  #selectIdeSession(args: DebugToolArgs): IdeDebugSessionInfo | undefined {
    if (!this.ideBridge) return undefined;
    if (args.ideSessionId) return this.ideBridge.registry.findSession(args.ideSessionId, args.clientId);
    const workspaceRoot = args.workspace
      ? resolveWorkspacePath(this.security.workspaceRoot(), args.workspace)
      : this.security.workspaceRoot();
    const sessions = this.ideBridge.registry.listSessions({
      clientId: args.clientId,
      workspaceRoot
    });
    return (
      sessions.find((session) => session.active && session.state === SessionState.PAUSED) ??
      sessions.find((session) => session.state === SessionState.PAUSED) ??
      sessions.find((session) => session.active) ??
      sessions[0]
    );
  }

  async #adoptActiveIdeSession(args: DebugToolArgs): Promise<DebugSessionRecord> {
    const ideSession = this.#selectIdeSession(args);
    if (!ideSession) {
      throw new DebugMcpError(ErrorCodes.IDE_SESSION_NOT_FOUND, "No active IDE debug session is available.", {
        clientId: args.clientId,
        ideSessionId: args.ideSessionId
      });
    }
    const existing = [...this.sessions.sessions.values()].find(
      (session) => session.ideSessionId === ideSession.ideSessionId && session.ideClientId === ideSession.clientId
    );
    if (existing) return existing;
    const response = await this.adoptIdeSession({
      ...args,
      clientId: ideSession.clientId,
      ideSessionId: ideSession.ideSessionId
    });
    if (!response.sessionId) {
      throw new DebugMcpError(ErrorCodes.TOOL_FAILED, "Failed to adopt IDE session.", { response });
    }
    return this.sessions.get(response.sessionId);
  }

  #safeArgs(args: DebugToolArgs): AnyRecord {
    const clone: AnyRecord = { ...args };
    if (clone.env) clone.env = "[redacted env]";
    return clone;
  }
}
