import fs from "node:fs";
import path from "node:path";
import { AdapterRegistry } from "../debug-adapters/AdapterRegistry.ts";
import { CapabilityReporter } from "../control/CapabilityReporter.ts";
import type { LanguageAdapter } from "../debug-adapters/LanguageAdapter.ts";
import type { AdapterContext } from "../debug-adapters/types.ts";
import { DapClient } from "../dap/DapClient.ts";
import { DapSession } from "../dap/DapSession.ts";
import { SecurityPolicy } from "../security/SecurityPolicy.ts";
import { AuditLogger } from "../audit/AuditLogger.ts";
import type { ToolResponse } from "../types/control.ts";
import type { DebugLanguage, DebugMode, SessionOwnerValue } from "../types/debug.ts";
import type { DapStackFrame, StoppedEvent } from "../types/dap.ts";
import type { IdeClientInfo, IdeDebugSessionInfo } from "../types/ide.ts";
import type { RuntimeSnapshot, VariableNode, VariableScopeView } from "../types/inspection.ts";
import type { AnyRecord } from "../types/json.ts";
import type { BreakPilotPolicy, EvaluateMode } from "../types/policy.ts";
import type {
  DebugSessionRecord,
  SessionSummary
} from "../types/sessions.ts";
import { IdeBridgeServer } from "../ide/IdeBridgeServer.ts";
import { IdeMessageTypes } from "../ide/IdeProtocol.ts";
import { BreakPilotError, ErrorCodes, ok } from "../utils/errors.ts";
import { makeSessionId } from "../utils/ids.ts";
import { resolveWorkspacePath } from "../utils/path.ts";
import { BreakpointManager } from "./BreakpointManager.ts";
import { LanguageResolver } from "./LanguageResolver.ts";
import { DapRuntimeProvider } from "../runtime/providers/DapRuntimeProvider.ts";
import { IdeRuntimeProvider } from "../runtime/providers/IdeRuntimeProvider.ts";
import { VariableSerializer } from "../inspection/VariableSerializer.ts";
import { SessionCoordinator } from "./SessionCoordinator.ts";
import { SessionOwner, SessionState } from "./SessionOwner.ts";
import { SessionStore } from "./SessionStore.ts";

type DebugToolArgs = AnyRecord & {
  sessionId?: string;
  lang?: DebugLanguage;
  language?: DebugLanguage;
  workspace?: string;
  projectPath?: string;
  program?: string;
  runConfigName?: string;
  mode?: DebugMode | EvaluateMode;
  owner?: SessionOwnerValue;
  host?: string;
  port?: number | string;
  file?: string;
  filePath?: string;
  line?: number;
  breakpointId?: string;
  requireVerified?: boolean;
  expression?: string;
  frameId?: number;
  threadId?: number;
  timeoutMs?: number;
  timeout?: number;
  terminateDebuggee?: boolean;
  restart?: boolean;
  includeFrame?: boolean;
  clientId?: string;
  ideSessionId?: string;
  env?: NodeJS.ProcessEnv | AnyRecord;
  maxDepth?: number;
  maxItems?: number;
  maxStringLength?: number;
  depth?: number;
  limit?: number;
  maxString?: number;
  variablesReference?: number;
  ref?: number;
  path?: string[];
  start?: number;
  count?: number;
  objectFields?: string;
  expand?: string;
  action?: string;
  newValue?: string;
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
  policy: BreakPilotPolicy;
  security: SecurityPolicy;
  audit: AuditLogger;
  adapters: AdapterRegistry;
  languageResolver: LanguageResolver;
  sessions: SessionStore;
  breakpoints: BreakpointManager;
  coordinator: SessionCoordinator;
  ideBridge?: IdeBridgeServer | null;
  cleaningSessions: Set<string>;

  constructor({ policy, ideBridge }: { policy: BreakPilotPolicy; ideBridge?: IdeBridgeServer | null }) {
    this.policy = policy;
    this.security = new SecurityPolicy(policy);
    this.audit = new AuditLogger(policy);
    this.adapters = new AdapterRegistry();
    this.languageResolver = new LanguageResolver(this.adapters);
    this.sessions = new SessionStore();
    this.breakpoints = new BreakpointManager();
    this.coordinator = new SessionCoordinator();
    this.ideBridge = ideBridge;
    this.cleaningSessions = new Set();
    this.#wireIdeBridge();
  }

  async bpDebugStart(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const auditId = this.audit.record("bp_debug_start_requested", { args: this.#safeArgs(normalized) });

    if (normalized.runConfigName || (normalized.filePath && normalized.line && normalized.mode !== "launch" && normalized.mode !== "attach")) {
      return this.#startIdeDebug(normalized, auditId);
    }

    if (normalized.mode === "ide" || normalized.ideSessionId) {
      const response = await this.adoptIdeSession(normalized);
      return ok(response.sessionId, { session: response.data, startMode: "ide" }, auditId, response.warnings);
    }

    const mode = normalized.mode === "attach" || normalized.host || normalized.port ? "attach" : "launch";
    const response = mode === "attach"
      ? await this.debugAttach({ ...normalized, mode: "headless" })
      : await this.debugLaunch({
          ...normalized,
          mode: "headless",
          program: normalized.program ?? normalized.filePath
        });
    return ok(response.sessionId, { session: response.data, startMode: mode }, auditId, response.warnings);
  }

  async #startIdeDebug(args: DebugToolArgs, auditId: string): Promise<ToolResponse> {
    if (!this.ideBridge) {
      throw new BreakPilotError(ErrorCodes.IDE_NOT_CONNECTED, "IDE bridge is not available.");
    }
    const workspaceRoot = args.projectPath || args.workspace
      ? resolveWorkspacePath(this.security.workspaceRoot(), String(args.projectPath ?? args.workspace))
      : this.security.workspaceRoot();
    const client = this.#selectIdeClient(args, workspaceRoot);
    if (!client) {
      throw new BreakPilotError(ErrorCodes.IDE_NOT_CONNECTED, "No IDE client is registered for this project.", {
        projectPath: workspaceRoot,
        clientId: args.clientId
      });
    }
    const requestId = `start_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = args.timeout ?? 30000;
    const started = this.#waitForIdeDebugStart({
      requestId,
      clientId: client.clientId,
      workspaceRoot,
      timeoutMs
    });
    const sent = this.ideBridge.sendToClient(client.clientId, {
      type: IdeMessageTypes.AGENT_START_DEBUG,
      requestId,
      workspaceRoot,
      runConfigName: args.runConfigName,
      filePath: args.filePath,
      line: args.line,
      sessionId: args.sessionId
    });
    if (!sent) {
      throw new BreakPilotError(ErrorCodes.IDE_BRIDGE_DISCONNECTED, "IDE client disconnected before debug launch.", {
        clientId: client.clientId,
        projectPath: workspaceRoot
      });
    }
    const ideSession = await started;
    const response = await this.adoptIdeSession({
      ...args,
      clientId: ideSession.clientId,
      ideSessionId: ideSession.ideSessionId,
      projectPath: workspaceRoot,
      mode: "ide"
    });
    return ok(response.sessionId, { session: response.data, startMode: "ide", ideLaunch: ideSession }, auditId, response.warnings);
  }

  async bpDebugStatus(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const auditId = this.audit.record("bp_debug_status_requested", { projectPath: args.projectPath });
    const sessions = this.#sessionStatusList(args);
    const active = this.#selectSessionCandidate();
    const ide = this.#ideStatusView(args);
    const data: AnyRecord = {
      activeSessionId: active && sessions.some((session) => session.sessionId === active.sessionId) ? active.sessionId : null,
      sessions,
      ide,
      capabilities: {
        ideBridge: Boolean(ide.enabled),
        ideConnected: Boolean(ide.connected),
        threads: Boolean((ide.capabilities as AnyRecord | undefined)?.threads),
        stackTrace: Boolean((ide.capabilities as AnyRecord | undefined)?.stackTrace)
      }
    };
    return ok(null, data, auditId);
  }

  async bpDebugControl(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const action = normalized.action;
    const auditId = this.audit.record("bp_debug_control_requested", { sessionId: normalized.sessionId, action });
    let session: DebugSessionRecord;
    try {
      session = this.#resolveSession(normalized);
    } catch (error) {
      const payload = error instanceof BreakPilotError ? error : null;
      if (
        (action === "disconnect" || action === "stop") &&
        payload?.code === ErrorCodes.SESSION_NOT_FOUND
      ) {
        return ok(normalized.sessionId, {
          status: "stopped",
          sessionId: normalized.sessionId ?? null,
          alreadyStopped: true,
          events: this.#emptyEvents()
        }, auditId, ["Debug session was already absent."]);
      }
      throw error;
    }

    if (action === "pause") {
      if (!session.provider.pause) {
        throw new BreakPilotError(ErrorCodes.TOOL_FAILED, "Runtime provider does not support pause.", {
          sessionId: session.sessionId,
          providerKind: session.providerKind
        });
      }
      await session.provider.pause(normalized.threadId ?? session.provider.threadId);
      const stopped = await session.provider.waitForBreakpoint(normalized.timeout ?? 5000).catch(() => null);
      session.state = SessionState.PAUSED;
      return ok(session.sessionId, await this.#controlView(session, "paused", stopped, normalized), auditId);
    }

    if (action === "wait") {
      const stopped = await session.provider.waitForBreakpoint(normalized.timeout ?? 30000).catch(async (error) => {
        if (error instanceof BreakPilotError && error.code === ErrorCodes.BREAKPOINT_TIMEOUT) {
          const recovered = await this.#recoverBreakpointHit(session);
          if (recovered) return recovered;
        }
        throw error;
      });
      session.state = SessionState.PAUSED;
      return ok(session.sessionId, await this.#controlView(session, "paused", stopped, normalized), auditId);
    }

    if (action === "resume") {
      if (session.providerKind !== "ide") this.coordinator.assertCanControl(session, SessionOwner.MCP, "resume");
      const result = await session.provider.continue(normalized.threadId ?? session.provider.threadId);
      session.state = SessionState.RUNNING;
      return ok(session.sessionId, { status: "running", sessionId: session.sessionId, result, events: this.#emptyEvents() }, auditId);
    }

    if (action === "stepOver" || action === "stepInto" || action === "stepOut") {
      if (session.providerKind !== "ide") this.coordinator.assertCanControl(session, SessionOwner.MCP, action);
      const kind = action === "stepInto" ? "into" : action === "stepOut" ? "out" : "over";
      await session.provider.step(kind, normalized.threadId ?? session.provider.threadId);
      const stopped = await session.provider.waitForBreakpoint(normalized.timeout ?? 10000).catch(() => null);
      session.state = SessionState.PAUSED;
      return ok(session.sessionId, await this.#controlView(session, "paused", stopped, normalized), auditId);
    }

    if (action === "disconnect" || action === "stop") {
      const result = await this.#cleanupSession(session, {
        reason: action,
        terminateDebuggee: action === "stop" || Boolean(normalized.terminateDebuggee)
      });
      return ok(session.sessionId, { status: "stopped", sessionId: session.sessionId, result, events: this.#emptyEvents() }, auditId);
    }

    if (action === "drainEvents") {
      return ok(session.sessionId, { status: session.state, sessionId: session.sessionId, events: this.#emptyEvents() }, auditId);
    }

    throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, `Unsupported debug control action: ${String(action)}`, { action });
  }

  async bpDebugThreads(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const session = this.#resolveSession(args);
    const auditId = this.audit.record("bp_debug_threads_requested", { sessionId: session.sessionId });
    if (!session.provider.listThreads) {
      throw new BreakPilotError(ErrorCodes.TOOL_FAILED, "Runtime provider does not support thread listing.", {
        sessionId: session.sessionId,
        providerKind: session.providerKind
      });
    }
    const threads = await session.provider.listThreads();
    const limited = threads.slice(0, args.limit ?? 50);
    return ok(session.sessionId, { sessionId: session.sessionId, threads: limited, totalCount: threads.length }, auditId);
  }

  async bpDebugCallStack(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const session = this.#resolveSession(args);
    const auditId = this.audit.record("bp_debug_call_stack_requested", { sessionId: session.sessionId });
    const stack = await this.#callStack(session, args.threadId, args.limit ?? 20);
    return ok(session.sessionId, stack, auditId);
  }

  async bpDebugFrame(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const session = this.#resolveSession(normalized);
    const auditId = this.audit.record("bp_debug_frame_requested", { sessionId: session.sessionId });
    const frame = await this.#frameView(session, normalized);
    return ok(session.sessionId, frame, auditId);
  }

  async bpDebugValue(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const session = this.#resolveSession(normalized);
    const auditId = this.audit.record("bp_debug_value_requested", { sessionId: session.sessionId, ref: normalized.ref, path: normalized.path });

    if (normalized.ref !== undefined) {
      const limits = this.#variableLimits(normalized);
      if (session.dap) {
        const variables = await session.dap.variables(Number(normalized.ref), {
          start: normalized.start ?? 0,
          count: normalized.count ?? limits.maxItems
        });
        const serializer = new VariableSerializer(session.dap, limits, { objectFields: normalized.expand ?? "deep" });
        const items = await serializer.serializeVariableNodes(variables);
        return ok(session.sessionId, {
          sessionId: session.sessionId,
          ref: normalized.ref,
          items,
          presentation: this.#presentNodes(items)
        }, auditId);
      }
      const result = await session.provider.inspectVariable?.({ variablesReference: normalized.ref, ...normalized }, limits);
      return ok(session.sessionId, { sessionId: session.sessionId, ref: normalized.ref, result }, auditId);
    }

    if (!normalized.path || normalized.path.length === 0) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "bp_debug_value requires either ref or path.", {});
    }

    const found = await this.#resolveNodeByPath(session, {
      ...normalized,
      expand: "deep",
      maxDepth: Math.max(
        Number(normalized.maxDepth ?? normalized.depth ?? 0),
        normalized.path.length
      )
    }, normalized.path);
    if (!found) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "Variable path was not found in the selected frame.", {
        path: normalized.path
      });
    }
    return ok(session.sessionId, { sessionId: session.sessionId, path: normalized.path, value: found, presentation: found.label }, auditId);
  }

  async bpDebugSetValue(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const session = this.#resolveSession(normalized);
    const auditId = this.audit.record("bp_debug_set_value_requested", { sessionId: session.sessionId, path: normalized.path, ref: normalized.ref });
    if (!normalized.path || normalized.path.length === 0) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "bp_debug_set_value requires path + newValue.", {});
    }
    if (normalized.ref !== undefined) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "bp_debug_set_value does not accept ref; use path + newValue.", {});
    }
    if (!session.provider.setVariable) {
      throw new BreakPilotError(ErrorCodes.TOOL_FAILED, "Runtime provider does not support variable mutation.", {
        sessionId: session.sessionId,
        providerKind: session.providerKind
      });
    }
    const node = await this.#resolveNodeByPath(session, normalized, normalized.path);
    if (!node) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "Variable path was not found in the selected frame.", {
        path: normalized.path
      });
    }
    if (!node.parentRef) {
      throw new BreakPilotError(ErrorCodes.TOOL_FAILED, "Runtime provider cannot mutate this variable because parentRef is unavailable.", {
        path: normalized.path,
        providerKind: session.providerKind
      });
    }
    const result = await session.provider.setVariable({
      ...normalized,
      parentRef: node.parentRef,
      name: node.name
    });
    return ok(session.sessionId, { sessionId: session.sessionId, path: normalized.path, oldValue: node.raw ?? node.summary, result }, auditId);
  }

  async bpDebugEval(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const session = this.#resolveSession(normalized);
    const mode = normalized.mode ?? this.policy.evaluate.defaultMode ?? "readonly";
    const auditId = this.audit.record("bp_debug_eval_requested", { sessionId: session.sessionId, expression: normalized.expression, mode });
    if (!normalized.expression) throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "Expression is required.");
    this.security.assertEvaluate(normalized.expression, mode, { ideConfirmationAvailable: session.providerKind === "ide" });
    let frameId = normalized.frameId;
    if (!frameId && normalized.frameIndex !== undefined && session.dap) {
      const stack = await session.dap.stackTrace(normalized.threadId ?? session.dap.threadId, (normalized.frameIndex ?? 0) + 1);
      frameId = stack.stackFrames[normalized.frameIndex ?? 0]?.id;
    }
    const result = await session.provider.evaluate(normalized.expression, {
      mode,
      frameId,
      threadId: normalized.threadId,
      context: normalized.context ?? "watch",
      timeoutMs: normalized.timeout ?? this.policy.evaluate.timeoutMs
    });
    return ok(session.sessionId, { sessionId: session.sessionId, expression: normalized.expression, mode, result }, auditId);
  }

  async bpDebugContext(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    let session: DebugSessionRecord;
    try {
      session = this.#resolveSession(normalized);
    } catch {
      session = await this.#adoptActiveIdeSession(normalized);
    }
    const auditId = this.audit.record("bp_debug_context_requested", { sessionId: session.sessionId });
    const stopped = await session.provider.waitForBreakpoint(normalized.timeout ?? 1000).catch(() => null);
    const stack = await this.#callStack(session, normalized.threadId, normalized.limit ?? 20).catch(() => null);
    const frame = await this.#frameView(session, normalized).catch(() => null);
    return ok(session.sessionId, {
      sessionId: session.sessionId,
      status: session.state,
      stopped,
      position: frame?.frame ? this.#positionFromFrame(frame.frame) : null,
      stack,
      frame
    }, auditId);
  }

  async bpDebugSetBreakpoint(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const session = this.#resolveSession(normalized);
    const response = await this.setBreakpoint({ ...normalized, sessionId: session.sessionId, file: normalized.filePath });
    const breakpoint = (response.data as AnyRecord)?.breakpoint as AnyRecord | undefined;
    const lineText = breakpoint?.file && breakpoint?.line ? this.#readLine(String(breakpoint.file), Number(breakpoint.line)) : undefined;
    return ok(session.sessionId, { ...(response.data as AnyRecord), lineText }, response.auditId, response.warnings);
  }

  async bpDebugListBreakpoints(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const session = this.#resolveSession(normalized);
    const auditId = this.audit.record("bp_debug_list_breakpoints_requested", { sessionId: session.sessionId });
    let breakpoints = this.breakpoints.list(session.sessionId);
    if (normalized.filePath) {
      const file = this.security.assertWorkspacePath(normalized.filePath);
      breakpoints = breakpoints.filter((bp) => path.resolve(bp.file) === path.resolve(file));
    }
    return ok(session.sessionId, { sessionId: session.sessionId, breakpoints, totalCount: breakpoints.length }, auditId);
  }

  async bpDebugRemoveBreakpoint(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const session = this.#resolveSession(normalized);
    const auditId = this.audit.record("bp_debug_remove_breakpoint_requested", { sessionId: session.sessionId });
    let breakpointId = normalized.breakpointId;
    if (!breakpointId && normalized.filePath && normalized.line) {
      const file = this.security.assertWorkspacePath(normalized.filePath);
      breakpointId = this.breakpoints
        .list(session.sessionId)
        .find((bp) => path.resolve(bp.file) === path.resolve(file) && bp.line === normalized.line)?.id;
    }
    if (!breakpointId) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "Pass breakpointId or filePath + line to remove a breakpoint.", {});
    }
    const response = await this.removeBreakpoint({ sessionId: session.sessionId, breakpointId });
    return ok(session.sessionId, { ...(response.data as AnyRecord), breakpointId }, auditId, response.warnings);
  }

  async debugLaunch(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const auditId = this.audit.record("debug_launch_requested", { args: this.#safeArgs(args) });
    this.security.assertNotProduction(args);
    const { language, adapter } = this.languageResolver.resolve({
      lang: args.lang,
      language: args.language,
      program: args.program,
      file: args.file,
      request: "launch"
    });
    const adapterImpl = adapter as LanguageAdapter;
    const workspaceRoot = args.workspace
      ? resolveWorkspacePath(this.security.workspaceRoot(), args.workspace)
      : this.security.workspaceRoot();
    if (args.program) this.security.assertWorkspacePath(args.program);

    const session = await this.#createSession({
      language,
      adapter: adapterImpl,
      workspaceRoot,
      mode: args.mode ?? "headless",
      owner: args.owner ?? SessionOwner.MCP,
      adapterArgs: args
    });

    try {
      const dap = session.dap;
      if (!dap) throw new BreakPilotError(ErrorCodes.TOOL_FAILED, "DAP session was not initialized.");
      await dap.initialize(adapterImpl.adapterId);
      await dap.launch(
        adapterImpl.normalizeLaunchArgs({
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
      throw new BreakPilotError(ErrorCodes.LAUNCH_FAILED, typedError.message, {
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
    const { language, adapter } = this.languageResolver.resolve({
      lang: args.lang,
      language: args.language,
      program: args.program,
      file: args.file,
      request: "attach"
    });
    const adapterImpl = adapter as LanguageAdapter;
    const workspaceRoot = args.workspace
      ? resolveWorkspacePath(this.security.workspaceRoot(), args.workspace)
      : this.security.workspaceRoot();

    // Delegate attach-target classification to the resolved adapter rather than
    // interpreting host/port in core session logic (Requirement 4.3). This runs
    // BEFORE #createSession and OUTSIDE the ATTACH_FAILED try/catch below, so:
    //   - a `classifyAttachTarget` validation throw (e.g. Java's INVALID_ARGUMENT
    //     for a missing host or out-of-range port) propagates as-is with no
    //     session created and no connection opened, and
    //   - an `unknown` classification rejects the attach before any transport is
    //     built (Requirement 4.8).
    const classification = adapterImpl.classifyAttachTarget(host, port);
    if (classification.kind === "unknown") {
      throw new BreakPilotError(
        ErrorCodes.INVALID_ARGUMENT,
        `Could not determine the attach-target endpoint type for ${language} at ${host}:${port}.`,
        { language, host, port }
      );
    }

    // Always feed host/port into normalizeAttachArgs via the adapter args. For a
    // `delegated` target the host/port is NOT a DAP endpoint (e.g. a Java JDWP
    // endpoint): the adapter spawns its own server (e.g. the JDI bridge) and the
    // core must never dial it directly, so we strip any dapHost/dapPort that
    // would otherwise select a direct DAP socket (Requirements 4.2, 4.4).
    const adapterArgs: AnyRecord = { ...args, attachMode: true, host, port };
    if (classification.kind === "delegated") {
      delete adapterArgs.dapHost;
      delete adapterArgs.dapPort;
    }

    const session = await this.#createSession({
      language,
      adapter: adapterImpl,
      workspaceRoot,
      mode: args.mode ?? "headless",
      owner: args.owner ?? SessionOwner.MCP,
      adapterArgs
    });

    try {
      const dap = session.dap;
      if (!dap) throw new BreakPilotError(ErrorCodes.TOOL_FAILED, "DAP session was not initialized.");
      await dap.initialize(adapterImpl.adapterId);
      await dap.attach(
        adapterImpl.normalizeAttachArgs({
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
      throw new BreakPilotError(ErrorCodes.ATTACH_FAILED, typedError.message, {
        sessionId: session.sessionId,
        cause: typedError.details ?? {}
      });
    }
  }

  async setBreakpoint(args: DebugToolArgs = {}): Promise<ToolResponse> {
    if (!args.sessionId || !args.file || !args.line) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "sessionId, file, and line are required.");
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
      this.#broadcastToWorkspace(session.workspaceRoot, {
        type: "agent_set_breakpoint",
        sessionId: session.sessionId,
        workspaceRoot: session.workspaceRoot,
        breakpoint: selected
      });
    }

    if (!selected.verified && args.requireVerified) {
      throw new BreakPilotError(
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
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "sessionId and breakpointId are required.");
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
        this.#broadcastToWorkspace(session.workspaceRoot, {
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
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
    }
    const session = this.sessions.get(args.sessionId);
    const auditId = this.audit.record("wait_for_breakpoint_requested", {
      sessionId: session.sessionId,
      timeoutMs: args.timeoutMs
    });
    const stopped = await session.provider.waitForBreakpoint(args.timeoutMs ?? 30000).catch(async (error) => {
      if (error instanceof BreakPilotError && error.code === ErrorCodes.BREAKPOINT_TIMEOUT) {
        const recovered = await this.#recoverBreakpointHit(session);
        if (recovered) return recovered;
      }
      throw error;
    });
    session.state = SessionState.PAUSED;
    if (session.providerKind === "dap") {
      this.#broadcastToWorkspace(session.workspaceRoot, {
        type: "ide_breakpoint_hit",
        sessionId: session.sessionId,
        stopped
      });
    }
    return ok(session.sessionId, { stopped }, auditId);
  }

  async getRuntimeSnapshot(args: DebugToolArgs = {}): Promise<ToolResponse<RuntimeSnapshot>> {
    if (!args.sessionId) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
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
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "sessionId and variablesReference are required.");
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
      throw new BreakPilotError(ErrorCodes.TOOL_FAILED, "Runtime provider does not support variable inspection.", {
        sessionId: session.sessionId,
        providerKind: session.providerKind
      });
    }
    const result = await session.provider.inspectVariable(args, limits);
    return ok(session.sessionId, result, auditId);
  }

  async evaluate(args: DebugToolArgs = {}): Promise<ToolResponse> {
    if (!args.sessionId || !args.expression) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "sessionId and expression are required.");
    }
    const session = this.sessions.get(args.sessionId);
    const mode = args.mode ?? this.policy.evaluate.defaultMode ?? "readonly";
    const auditId = this.audit.record("evaluate_requested", {
      sessionId: session.sessionId,
      expression: args.expression,
      mode
    });
    this.security.assertEvaluate(args.expression, mode, {
      ideConfirmationAvailable: session.providerKind === "ide"
    });
    const result = await session.provider.evaluate(args.expression, {
      mode,
      frameId: args.frameId,
      threadId: args.threadId,
      context: args.context ?? "watch",
      timeoutMs: args.timeoutMs ?? this.policy.evaluate.timeoutMs
    });
    return ok(session.sessionId, { result, mode }, auditId);
  }

  async continueExecution(args: DebugToolArgs = {}): Promise<ToolResponse> {
    if (!args.sessionId) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
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
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
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
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
    }
    const session = this.sessions.get(args.sessionId);
    const auditId = this.audit.record("disconnect_requested", { sessionId: session.sessionId });
    const result = await this.#cleanupSession(session, {
      reason: "disconnect",
      terminateDebuggee: Boolean(args.terminateDebuggee),
      restart: Boolean(args.restart)
    });
    const warnings = result.acknowledged === false ? [result.message ?? "Debug adapter did not acknowledge disconnect."] : [];
    return ok(session.sessionId, { disconnected: true, result }, auditId, warnings);
  }

  async cleanupAll(reason = "shutdown"): Promise<void> {
    const sessions = [...this.sessions.sessions.values()];
    await Promise.allSettled(sessions.map((session) => this.#cleanupSession(session, { reason })));
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
      throw new BreakPilotError(ErrorCodes.IDE_NOT_CONNECTED, "IDE bridge is not available.");
    }
    const auditId = this.audit.record("adopt_ide_session_requested", {
      clientId: args.clientId,
      ideSessionId: args.ideSessionId
    });
    const ideSession = this.#selectIdeSession(args);
    if (!ideSession) {
      throw new BreakPilotError(ErrorCodes.IDE_SESSION_NOT_FOUND, "IDE debug session was not found.", {
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

  async listSupportedLanguages(): Promise<ToolResponse> {
    const auditId = this.audit.record("list_supported_languages_requested");
    const reporter = new CapabilityReporter(this.adapters, this.audit);
    const languages = await reporter.report();
    return ok(null, { languages }, auditId);
  }

  listBreakpoints(args: DebugToolArgs = {}): ToolResponse {
    if (!args.sessionId) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "sessionId is required.");
    }
    const auditId = this.audit.record("list_breakpoints_requested", args);
    return ok(args.sessionId, { breakpoints: this.breakpoints.list(args.sessionId) }, auditId);
  }

  ideStatus(): ToolResponse {
    const auditId = this.audit.record("ide_status_requested");
    return ok(null, this.ideBridge?.status() ?? { enabled: false, clients: [] }, auditId);
  }

  #normalizeBpArgs(args: DebugToolArgs = {}): DebugToolArgs {
    return {
      ...args,
      lang: args.lang ?? args.language,
      workspace: args.workspace ?? args.projectPath,
      file: args.file ?? args.filePath,
      filePath: args.filePath ?? args.file,
      timeoutMs: args.timeoutMs ?? args.timeout,
      variablesReference: args.variablesReference ?? args.ref,
      ref: args.ref ?? args.variablesReference,
      maxDepth: args.maxDepth ?? args.depth,
      maxItems: args.maxItems ?? args.limit,
      maxStringLength: args.maxStringLength ?? args.maxString,
      objectFields: args.objectFields ?? args.expand,
      expand: args.expand ?? args.objectFields
    };
  }

  #variableLimits(args: DebugToolArgs): Required<import("../types/inspection.ts").VariableLimits> {
    return this.security.variableLimits({
      maxDepth: args.maxDepth ?? args.depth,
      maxItems: args.maxItems ?? args.limit ?? args.count,
      maxStringLength: args.maxStringLength ?? args.maxString,
      redactPatterns: args.redactPatterns
    });
  }

  #resolveSession(args: DebugToolArgs = {}): DebugSessionRecord {
    if (args.sessionId) return this.sessions.get(args.sessionId);
    const workspaceRoot = args.projectPath || args.workspace
      ? resolveWorkspacePath(this.security.workspaceRoot(), String(args.projectPath ?? args.workspace))
      : undefined;
    const candidates = [...this.sessions.sessions.values()].filter((session) => {
      if (session.state === SessionState.TERMINATED || session.state === SessionState.FAILED) return false;
      if (workspaceRoot && path.resolve(session.workspaceRoot) !== path.resolve(workspaceRoot)) return false;
      return true;
    });
    if (candidates.length === 0) {
      throw new BreakPilotError(ErrorCodes.SESSION_NOT_FOUND, "No active debug session is available.", {
        projectPath: args.projectPath ?? args.workspace
      });
    }
    const selected = this.#selectSessionCandidate(candidates);
    if (selected) return selected;
    throw new BreakPilotError(
      ErrorCodes.SESSION_AMBIGUOUS,
      "Multiple debug sessions are active. Pass sessionId to choose one.",
      { sessions: candidates.map((session) => this.#sessionSummary(session)) }
    );
  }

  #selectSessionCandidate(candidates = [...this.sessions.sessions.values()]): DebugSessionRecord | null {
    const live = candidates.filter((session) => session.state !== SessionState.TERMINATED && session.state !== SessionState.FAILED);
    if (live.length === 0) return null;
    const paused = live.filter((session) => session.state === SessionState.PAUSED);
    if (paused.length === 1) return paused[0]!;
    if (live.length === 1) return live[0]!;
    return null;
  }

  #statusWorkspaceRoot(args: DebugToolArgs = {}): string {
    return args.projectPath || args.workspace
      ? resolveWorkspacePath(this.security.workspaceRoot(), String(args.projectPath ?? args.workspace))
      : this.security.workspaceRoot();
  }

  #sessionStatusList(args: DebugToolArgs = {}): SessionSummary[] {
    const workspaceRoot = this.#statusWorkspaceRoot(args);
    return this.sessions.list().filter((session) => {
      if (path.resolve(session.workspaceRoot) !== path.resolve(workspaceRoot)) return false;
      if (session.state === SessionState.TERMINATED || session.state === SessionState.FAILED) {
        return false;
      }
      return true;
    });
  }

  #ideStatusView(args: DebugToolArgs = {}): AnyRecord {
    if (!this.ideBridge) return { enabled: false, connected: false, clients: 0, sessions: [] };
    const workspaceRoot = this.#statusWorkspaceRoot(args);
    const clients = this.ideBridge.registry.list().filter((client) => {
      if (client.workspaceRoot && path.resolve(client.workspaceRoot) !== path.resolve(workspaceRoot)) return false;
      return true;
    });
    const sessions = this.ideBridge.registry.listSessions({ workspaceRoot }).filter((session) => {
      return session.state !== SessionState.TERMINATED && session.state !== SessionState.FAILED;
    });
    const capabilities = clients.reduce<AnyRecord>((merged, client) => {
      for (const [key, value] of Object.entries(client.capabilities ?? {})) {
        if (value === true || merged[key] === undefined) merged[key] = value;
      }
      return merged;
    }, {});
    return {
      enabled: true,
      connected: clients.length > 0,
      clients: clients.length,
      sessions: sessions.map((session) => ({
        ideSessionId: session.ideSessionId,
        clientId: session.clientId,
        name: session.name,
        state: session.state,
        active: Boolean(session.active),
        threadId: session.threadId ?? null,
        topFrame: session.topFrame,
        capabilities: session.capabilities
      })),
      capabilities
    };
  }

  async #callStack(session: DebugSessionRecord, threadId?: number, limit = 20): Promise<AnyRecord> {
    if (!session.provider.getCallStack) {
      throw new BreakPilotError(ErrorCodes.TOOL_FAILED, "Runtime provider does not support call stack inspection.", {
        sessionId: session.sessionId,
        providerKind: session.providerKind
      });
    }
    const stack = await session.provider.getCallStack(threadId ?? session.provider.threadId, limit);
    const frames = (stack.stackFrames ?? []).map((frame: DapStackFrame, index: number) => this.#frameSummary(frame, index));
    return {
      sessionId: session.sessionId,
      threadId: stack.threadId ?? threadId ?? session.provider.threadId,
      frames,
      totalFrames: stack.totalFrames ?? frames.length,
      partial: Boolean(stack.partial),
      capabilities: stack.capabilities
    };
  }

  async #frameView(session: DebugSessionRecord, args: DebugToolArgs): Promise<{
    sessionId: string;
    threadId: number | null;
    frame: AnyRecord | null;
    variables: VariableScopeView[];
    presentation: string;
  }> {
    const limits = this.#variableLimits(args);
    const expand = args.expand ?? args.objectFields ?? "preview";

    if (session.dap) {
      const stack = await session.dap.stackTrace(args.threadId ?? session.dap.threadId, (args.frameIndex ?? 0) + 1);
      const frame = args.frameId
        ? stack.stackFrames.find((candidate) => candidate.id === args.frameId) ?? { id: args.frameId }
        : stack.stackFrames[args.frameIndex ?? 0];
      const scopes = frame?.id ? await session.dap.scopes(frame.id) : [];
      const serializer = new VariableSerializer(session.dap, limits, { objectFields: expand });
      const variables: VariableScopeView[] = [];
      for (const scope of scopes) {
        const dapVariables = await session.dap.variables(scope.variablesReference, {
          start: 0,
          count: limits.maxItems
        });
        variables.push({
          scope: scope.name,
          expensive: Boolean(scope.expensive),
          items: await serializer.serializeVariableNodes(dapVariables, 0, new Set<number>(), scope.variablesReference)
        });
      }
      const presentation = variables.map((scope) => `${scope.scope}\n${this.#presentNodes(scope.items)}`).join("\n");
      return {
        sessionId: session.sessionId,
        threadId: stack.threadId,
        frame: frame ? this.#frameSummary(frame, args.frameIndex ?? 0) : null,
        variables,
        presentation
      };
    }

    const snapshot = await session.provider.getRuntimeSnapshot({
      ...args,
      profile: "focused",
      objectFields: expand,
      maxDepth: limits.maxDepth,
      maxItems: limits.maxItems,
      maxStringLength: limits.maxStringLength
    }, limits);
    const frameIndex = args.frameIndex ?? 0;
    const frame = snapshot.stackFrames[frameIndex] ?? snapshot.stackFrames[0] ?? null;
    const variables = Object.values(snapshot.variables ?? {}).map((scope) => ({
      scope: scope.name,
      category: scope.category,
      rawScopes: scope.rawScopes,
      expensive: scope.expensive,
      items: this.#nodesFromSerializedMap(scope.variables)
    }));
    return {
      sessionId: session.sessionId,
      threadId: snapshot.threadId,
      frame: frame ? this.#frameSummary(frame, frameIndex) : null,
      variables,
      presentation: variables.map((scope) => `${scope.scope}\n${this.#presentNodes(scope.items)}`).join("\n")
    };
  }

  #frameSummary(frame: DapStackFrame, index: number): AnyRecord {
    const source = frame.source as AnyRecord | undefined;
    const filePath = source?.path ?? source?.sourceReference ?? null;
    const fn = frame.name ?? "";
    return {
      index,
      id: frame.id,
      filePath,
      line: frame.line ?? null,
      column: frame.column ?? null,
      function: fn,
      presentation: `${fn}${frame.line ? `:${frame.line}` : ""}`
    };
  }

  #positionFromFrame(frame: AnyRecord): AnyRecord {
    return {
      filePath: frame.filePath ?? null,
      line: frame.line ?? null,
      frameIndex: frame.index ?? 0
    };
  }

  async #controlView(
    session: DebugSessionRecord,
    status: string,
    stopped: AnyRecord | null,
    args: DebugToolArgs = {}
  ): Promise<AnyRecord> {
    const frame = args.includeFrame
      ? await this.#frameView(session, {
          ...args,
          threadId: this.#numberOrUndefined(stopped?.threadId ?? session.provider.threadId ?? args.threadId),
          expand: args.expand ?? "preview",
          depth: args.depth ?? 1,
          limit: args.limit ?? 10
        }).catch(() => null)
      : null;
    return {
      status,
      sessionId: session.sessionId,
      stopped,
      position: frame?.frame ? this.#positionFromFrame(frame.frame) : this.#positionFromStopped(stopped),
      frame: frame
        ? {
            summary: frame.frame?.presentation ?? null,
            variables: frame.variables
          }
        : null,
      events: this.#emptyEvents()
    };
  }

  #positionFromStopped(stopped: AnyRecord | null): AnyRecord | null {
    const topFrame = (stopped?.topFrame ?? stopped?.stopped?.topFrame) as AnyRecord | undefined;
    if (!topFrame || Object.keys(topFrame).length === 0) return null;
    const source = topFrame.source as AnyRecord | undefined;
    return {
      filePath: source?.path ?? topFrame.filePath ?? null,
      line: topFrame.line ?? null,
      frameIndex: 0
    };
  }

  #emptyEvents(): AnyRecord {
    return { breakpointErrors: [], tracepoints: [] };
  }

  #numberOrUndefined(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  #nodesFromSerializedMap(map: AnyRecord, parentPath: string[] = []): VariableNode[] {
    return Object.entries(map ?? {}).map(([name, value]) => {
      const variable = value as AnyRecord;
      if (variable.kind === "metadata") {
        const summary = String(variable.value ?? "");
        return {
          name,
          label: String(variable.value ?? name),
          kind: "metadata",
          summary,
          path: [...parentPath, name],
          expandable: false,
          truncated: Boolean(variable.truncated)
        } as VariableNode;
      }
      const ref = Number(variable.variablesReference ?? 0) > 0 ? Number(variable.variablesReference) : undefined;
      const nodeName = String(variable.name ?? name);
      const children = variable.value && typeof variable.value === "object" && !Array.isArray(variable.value)
        ? this.#nodesFromSerializedMap(variable.value as AnyRecord, [...parentPath, nodeName])
        : undefined;
      const summary = String(variable.valuePreview ?? variable.value ?? "");
      const raw = ref || children ? undefined : variable.value;
      const node: VariableNode = {
        name: nodeName,
        label: `${nodeName} = ${summary}`,
        type: String(variable.type ?? ""),
        kind: String(variable.kind ?? "primitive") as VariableNode["kind"],
        summary,
        ref,
        path: [...parentPath, nodeName],
        expandable: Boolean(ref),
        truncated: Boolean(variable.truncated),
        redacted: Boolean(variable.redacted),
        cycle: Boolean(variable.cycle),
        children
      };
      if (raw !== undefined) node.raw = raw;
      return node;
    });
  }

  #presentNodes(nodes: VariableNode[], indent = ""): string {
    return nodes
      .map((node) => {
        const marker = node.expandable ? "+ " : "";
        const line = `${indent}${marker}${node.label}`;
        const children = node.children?.length ? `\n${this.#presentNodes(node.children, `${indent}  `)}` : "";
        return `${line}${children}`;
      })
      .join("\n");
  }

  #findNodeByPath(nodes: VariableNode[], pathTokens: string[]): VariableNode | null {
    let current: VariableNode | undefined;
    let level = nodes;
    for (const token of pathTokens) {
      current = level.find((node) => node.name === token);
      if (!current) return null;
      level = current.children ?? [];
    }
    return current ?? null;
  }

  async #resolveNodeByPath(
    session: DebugSessionRecord,
    args: DebugToolArgs,
    pathTokens: string[]
  ): Promise<VariableNode | null> {
    const frame = await this.#frameView(session, { ...args, expand: args.expand ?? "preview" });
    let level = frame.variables.flatMap((scope) => scope.items);
    let current: VariableNode | undefined;
    for (let index = 0; index < pathTokens.length; index += 1) {
      const token = pathTokens[index];
      current = level.find((node) => node.name === token);
      if (!current) return null;
      if (index === pathTokens.length - 1) return current;
      if ((!current.children || current.children.length === 0) && current.ref && session.dap) {
        const limits = this.#variableLimits(args);
        const variables = await session.dap.variables(current.ref, {
          start: 0,
          count: limits.maxItems
        });
        const serializer = new VariableSerializer(session.dap, limits, { objectFields: "preview" });
        current.children = await serializer.serializeVariableNodes(variables, 0, new Set<number>(), current.ref);
      }
      level = current.children ?? [];
    }
    return current ?? null;
  }

  #readLine(filePath: string, line: number): string | undefined {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      return text.split(/\r?\n/)[line - 1]?.trim();
    } catch {
      return undefined;
    }
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
    // Build the adapter context from the create-session input. The core never
    // selects a transport itself — it drives the adapter contract lifecycle
    // and lets the adapter own transport selection (Requirements 1.6, 4.1).
    const ctx: AdapterContext = {
      workspaceRoot,
      env: adapterArgs.env as Record<string, string | undefined> | undefined,
      args: { ...adapterArgs, workspaceRoot }
    };
    // Initialize the adapter FIRST, before any session record is created or
    // added to the store. On validation/initialization failure this throws and
    // no partial session state is left behind (Requirements 1.7, 1.9). The
    // security gates (assertNotProduction / assertWorkspacePath / assertHostPort)
    // have already run in debugLaunch/debugAttach before #createSession.
    await adapter.initialize(ctx);
    const transport = await adapter.createTransport(ctx);
    const client = new DapClient(transport);
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
      void this.#cleanupSession(record, { reason: "dap_terminated", disconnectProvider: false });
    });
    dap.on("exited", () => {
      record.state = SessionState.TERMINATED;
      void this.#cleanupSession(record, { reason: "dap_exited", disconnectProvider: false });
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

  async #cleanupSession(
    session: DebugSessionRecord,
    {
      reason,
      terminateDebuggee = false,
      restart = false,
      disconnectProvider = true
    }: {
      reason: string;
      terminateDebuggee?: boolean;
      restart?: boolean;
      disconnectProvider?: boolean;
    }
  ): Promise<AnyRecord> {
    if (this.cleaningSessions.has(session.sessionId)) {
      return { acknowledged: true, alreadyCleaning: true, reason };
    }
    this.cleaningSessions.add(session.sessionId);
    try {
      this.#broadcastToWorkspace(session.workspaceRoot, {
        type: IdeMessageTypes.AGENT_CLEAR_BREAKPOINTS,
        sessionId: session.sessionId,
        workspaceRoot: session.workspaceRoot,
        reason
      });
      let result: AnyRecord = { acknowledged: true, reason };
      if (disconnectProvider) {
        try {
          result = await session.provider.disconnect({ terminateDebuggee, restart });
        } catch (error) {
          const typedError = error as Error;
          result = { acknowledged: false, message: typedError.message, reason };
        }
      }
      session.state = SessionState.TERMINATED;
      this.breakpoints.clear(session.sessionId);
      this.sessions.remove(session.sessionId);
      return result;
    } finally {
      this.cleaningSessions.delete(session.sessionId);
    }
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
      void this.#cleanupAdoptedIdeSession(message.ideSessionId, message.clientId, "ide_session_terminated");
    });
  }

  async #cleanupAdoptedIdeSession(
    ideSessionId: string | undefined,
    clientId: string | undefined,
    reason: string
  ): Promise<void> {
    if (!ideSessionId) return;
    const sessions = [...this.sessions.sessions.values()].filter((session) => {
      if (session.ideSessionId !== ideSessionId) return false;
      if (clientId && session.ideClientId && session.ideClientId !== clientId) return false;
      return true;
    });
    await Promise.allSettled(sessions.map((session) => this.#cleanupSession(session, { reason, disconnectProvider: false })));
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
    const workspaceRoot = args.projectPath || args.workspace
      ? resolveWorkspacePath(this.security.workspaceRoot(), String(args.projectPath ?? args.workspace))
      : this.security.workspaceRoot();
    const sessions = this.ideBridge.registry.listSessions({
      clientId: args.clientId,
      workspaceRoot
    });
    if (!args.ideSessionId && sessions.length > 1) {
      throw new BreakPilotError(
        ErrorCodes.IDE_SESSION_AMBIGUOUS,
        "Multiple IDE debug sessions match. Pass clientId and ideSessionId to choose one.",
        { sessions }
      );
    }
    return (
      sessions.find((session) => session.active && session.state === SessionState.PAUSED) ??
      sessions.find((session) => session.state === SessionState.PAUSED) ??
      sessions.find((session) => session.active) ??
      sessions[0]
    );
  }

  #selectIdeClient(args: DebugToolArgs, workspaceRoot: string): IdeClientInfo | undefined {
    if (!this.ideBridge) return undefined;
    const clients = this.ideBridge.registry.list().filter((client) => {
      if (args.clientId && client.clientId !== args.clientId) return false;
      if (workspaceRoot && client.workspaceRoot && path.resolve(client.workspaceRoot) !== path.resolve(workspaceRoot)) return false;
      return true;
    });
    if (clients.length > 1 && !args.clientId) {
      throw new BreakPilotError(ErrorCodes.PROJECT_AMBIGUOUS, "Multiple IDE clients match. Pass projectPath or clientId.", {
        clients: clients.map((client) => ({ clientId: client.clientId, workspaceRoot: client.workspaceRoot }))
      });
    }
    return clients[0];
  }

  #waitForIdeDebugStart({
    requestId,
    clientId,
    workspaceRoot,
    timeoutMs
  }: {
    requestId: string;
    clientId: string;
    workspaceRoot: string;
    timeoutMs: number;
  }): Promise<IdeDebugSessionInfo> {
    if (!this.ideBridge) {
      return Promise.reject(new BreakPilotError(ErrorCodes.IDE_NOT_CONNECTED, "IDE bridge is not available."));
    }
    const bridge = this.ideBridge;
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const cleanup = (): void => {
        clearTimeout(timer);
        bridge.off(IdeMessageTypes.IDE_COMMAND_RESULT, commandListener);
        bridge.off(IdeMessageTypes.IDE_SESSION_STARTED, sessionListener);
        bridge.off(IdeMessageTypes.IDE_SESSION_PAUSED, sessionListener);
      };
      const resolveSession = (message: AnyRecord): boolean => {
        if (message.clientId !== clientId) return false;
        const session = bridge.registry.findSession(message.ideSessionId, clientId);
        if (!session) return false;
        if (session.workspaceRoot && path.resolve(session.workspaceRoot) !== path.resolve(workspaceRoot)) return false;
        cleanup();
        resolve(session);
        return true;
      };
      const commandListener = ({ message }: { message: AnyRecord }): void => {
        if (message.requestId !== requestId) return;
        if (message.error && Object.keys(message.error).length > 0) {
          cleanup();
          reject(new BreakPilotError(
            String(message.error.code ?? ErrorCodes.TOOL_FAILED),
            String(message.error.message ?? "IDE debug launch failed."),
            { error: message.error, requestId }
          ));
          return;
        }
        if (message.ideSessionId && resolveSession(message)) return;
        const existing = bridge.registry
          .listSessions({ clientId, workspaceRoot })
          .find((session) => Date.parse(session.startedAt) >= startedAt - 1000);
        if (existing) {
          cleanup();
          resolve(existing);
        }
      };
      const sessionListener = ({ message }: { message: AnyRecord }): void => {
        if (message.requestId && message.requestId !== requestId) return;
        resolveSession(message);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new BreakPilotError(ErrorCodes.BREAKPOINT_TIMEOUT, "Timed out waiting for IDE debug session to start.", {
          requestId,
          clientId,
          workspaceRoot,
          timeoutMs
        }));
      }, timeoutMs);
      bridge.on(IdeMessageTypes.IDE_COMMAND_RESULT, commandListener);
      bridge.on(IdeMessageTypes.IDE_SESSION_STARTED, sessionListener);
      bridge.on(IdeMessageTypes.IDE_SESSION_PAUSED, sessionListener);
    });
  }

  #broadcastToWorkspace(workspaceRoot: string, message: AnyRecord): void {
    if (!this.ideBridge) return;
    const clients = this.ideBridge.registry.list().filter((client) => client.workspaceRoot === workspaceRoot);
    for (const client of clients) {
      this.ideBridge.sendToClient(client.clientId, {
        ...message,
        workspaceRoot
      });
    }
  }

  async #adoptActiveIdeSession(args: DebugToolArgs): Promise<DebugSessionRecord> {
    const ideSession = this.#selectIdeSession(args);
    if (!ideSession) {
      throw new BreakPilotError(ErrorCodes.IDE_SESSION_NOT_FOUND, "No active IDE debug session is available.", {
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
      throw new BreakPilotError(ErrorCodes.TOOL_FAILED, "Failed to adopt IDE session.", { response });
    }
    return this.sessions.get(response.sessionId);
  }

  #safeArgs(args: DebugToolArgs): AnyRecord {
    const clone: AnyRecord = { ...args };
    if (clone.env) clone.env = "[redacted env]";
    return clone;
  }
}
