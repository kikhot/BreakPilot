import fs from "node:fs";
import path from "node:path";
import { AdapterRegistry } from "../debug-adapters/AdapterRegistry.ts";
import type { LanguageAdapter } from "../debug-adapters/LanguageAdapter.ts";
import type { AdapterContext } from "../debug-adapters/types.ts";
import { DapClient } from "../dap/DapClient.ts";
import { DapSession } from "../dap/DapSession.ts";
import { SecurityPolicy } from "../security/SecurityPolicy.ts";
import { AuditLogger } from "../audit/AuditLogger.ts";
import type { ToolResponse } from "../types/control.ts";
import type { DebugLanguage, DebugMode, SessionOwnerValue } from "../types/debug.ts";
import type { DapStackFrame, StoppedEvent } from "../types/dap.ts";
import type { BridgeMessage, IdeClientInfo, IdeDebugSessionInfo } from "../types/ide.ts";
import type { VariableNode, VariableScopeView } from "../types/inspection.ts";
import type { AnyRecord } from "../types/json.ts";
import type { BreakPilotPolicy, EvaluateMode } from "../types/policy.ts";
import type {
  BreakpointRecord,
  DebugSessionRecord,
  DetailLevel,
  DrainEventsArgs,
  ProjectBreakpointRecord,
  RuntimeEvent,
  RuntimeEventPage,
  SessionSummary,
  ThreadId
} from "../types/sessions.ts";
import { IdeBridgeServer } from "../ide/IdeBridgeServer.ts";
import { IdeMessageTypes } from "../ide/IdeProtocol.ts";
import { BreakPilotError, ErrorCodes, ok } from "../utils/errors.ts";
import { makeId, makeSessionId } from "../utils/ids.ts";
import { resolveWorkspacePath } from "../utils/path.ts";
import { BreakpointManager } from "./BreakpointManager.ts";
import { LanguageResolver } from "./LanguageResolver.ts";
import { DapRuntimeProvider } from "../runtime/providers/DapRuntimeProvider.ts";
import { IdeRuntimeProvider } from "../runtime/providers/IdeRuntimeProvider.ts";
import { VariableSerializer } from "../inspection/VariableSerializer.ts";
import { SessionCoordinator } from "./SessionCoordinator.ts";
import { SessionOwner, SessionState } from "./SessionOwner.ts";
import { SessionStore } from "./SessionStore.ts";
import { ideProviderCapabilities, mergeIdeCapabilityRecords } from "../runtime/ProviderCapabilities.ts";
import type { RuntimeProviderCapabilities } from "../types/capabilities.ts";
import { RuntimeEventBuffer } from "../runtime/RuntimeEventBuffer.ts";

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
  threadId?: ThreadId;
  timeoutMs?: number;
  timeout?: number;
  terminateDebuggee?: boolean;
  restart?: boolean;
  includeFrame?: boolean;
  offset?: number;
  detail?: DetailLevel;
  enabled?: boolean;
  temporary?: boolean;
  suspendPolicy?: "ALL" | "THREAD" | "NONE";
  isLogMessage?: boolean;
  isLogStack?: boolean;
  includeDisabled?: boolean;
  clientId?: string;
  ide?: string;
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

type ProjectIdeTarget = {
  workspaceRoot: string;
  client: IdeClientInfo;
  session?: IdeDebugSessionInfo;
};

type ArchivedRuntimeEvents = {
  events: RuntimeEventBuffer;
};

const MAX_ARCHIVED_RUNTIME_SESSIONS = 32;
const DAP_TERMINATION_GRACE_MS = 100;

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
  readonly #archivedRuntimeEvents: Map<string, ArchivedRuntimeEvents>;
  readonly #dapTerminationTimers: Map<string, ReturnType<typeof setTimeout>>;

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
    this.#archivedRuntimeEvents = new Map();
    this.#dapTerminationTimers = new Map();
    this.#wireIdeBridge();
  }

  async bpDebugStart(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const auditId = this.audit.record("bp_debug_start_requested", { args: this.#safeArgs(normalized) });

    if (
      (normalized.mode === undefined || normalized.mode === "ide") &&
      (normalized.runConfigName || (normalized.filePath && normalized.line))
    ) {
      return this.#startIdeDebug(normalized, auditId);
    }

    if (normalized.mode === "ide" || (normalized.mode === undefined && normalized.ideSessionId)) {
      const adopted = await this.#adoptIdeSession(normalized);
      return ok(adopted.session.sessionId, {
        ...this.#sessionSummary(adopted.session, true),
        startMode: "ide"
      }, auditId, adopted.warnings);
    }

    const mode = normalized.mode === "attach"
      ? "attach"
      : normalized.mode === "launch"
        ? "launch"
        : normalized.host || normalized.port
          ? "attach"
          : "launch";
    const session = mode === "attach"
      ? await this.#attachDapSession({ ...normalized, mode: "headless" })
      : await this.#launchDapSession({
          ...normalized,
          mode: "headless",
          program: normalized.program ?? normalized.filePath
        });
    return ok(session.sessionId, { ...this.#sessionSummary(session, true), startMode: mode }, auditId);
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
    const adopted = await this.#adoptIdeSession({
      ...args,
      clientId: ideSession.clientId,
      ideSessionId: ideSession.ideSessionId,
      projectPath: workspaceRoot,
      mode: "ide"
    });
    return ok(adopted.session.sessionId, {
      ...this.#sessionSummary(adopted.session, true),
      startMode: "ide"
    }, auditId, adopted.warnings);
  }

  async bpDebugStatus(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const auditId = this.audit.record("bp_debug_status_requested", { projectPath: args.projectPath });
    const sessions = this.#sessionStatusList(args);
    const active = this.#selectSessionCandidate();
    const ide = this.#ideStatusView(args);
    const data: AnyRecord = {
      activeSessionId: active && sessions.some((session) => session.sessionId === active.sessionId) ? active.sessionId : null,
      sessions,
      ideConnected: Boolean(ide.connected),
      ideSessions: ide.sessions ?? []
    };
    return ok(null, data, auditId);
  }

  async bpDebugRunConfigurations(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const workspaceRoot = this.#statusWorkspaceRoot(normalized);
    const target = this.#selectProjectIdeTarget(normalized, workspaceRoot);
    const auditId = this.audit.record("bp_debug_run_configurations_requested", {
      workspaceRoot,
      clientId: target.client.clientId,
      ide: target.client.ide,
      filePath: normalized.filePath
    });
    const requestId = makeId("ide_req");
    const response = await this.#sendIdeClientRequest(
      target.client.clientId,
      {
        type: IdeMessageTypes.AGENT_LIST_RUN_CONFIGURATIONS,
        requestId,
        workspaceRoot,
        filePath: normalized.filePath
      },
      [IdeMessageTypes.IDE_RUN_CONFIGURATIONS_SNAPSHOT],
      (message) => message.requestId === requestId
    );
    if (this.#bridgeMessageError(response)) {
      throw new BreakPilotError(
        String(response.error?.code ?? ErrorCodes.TOOL_FAILED),
        String(response.error?.message ?? "IDE failed to list run configurations."),
        { error: response.error }
      );
    }
    const configurations = Array.isArray(response.result?.configurations)
      ? response.result.configurations.map((configuration: unknown) => ({
        ...(configuration && typeof configuration === "object" ? configuration as AnyRecord : {}),
        ide: target.client.ide,
        projectPath: workspaceRoot
      }))
      : undefined;
    return ok(null, {
      ...(normalized.filePath ? { filePath: normalized.filePath } : {}),
      configurations,
      runPoints: Array.isArray(response.result?.runPoints) ? response.result.runPoints : undefined
    }, auditId);
  }

  async bpDebugControl(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const action = normalized.action;
    const auditId = this.audit.record("bp_debug_control_requested", { sessionId: normalized.sessionId, action });
    if (action === "drainEvents" && normalized.sessionId) {
      const archived = this.#archivedRuntimeEvents.get(normalized.sessionId);
      if (archived) {
        return ok(normalized.sessionId, {
          status: SessionState.TERMINATED,
          events: archived.events.read()
        }, auditId);
      }
    }
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
          alreadyStopped: true
        }, auditId, ["Debug session was already absent."]);
      }
      throw error;
    }

    if (action === "pause") {
      if (session.provider.capabilities.pause === "unsupported" || !session.provider.pause) {
        throw new BreakPilotError(ErrorCodes.UNSUPPORTED_CAPABILITY, "Runtime provider does not support pause.", {
          sessionId: session.sessionId,
          providerKind: session.providerKind,
          capability: "pause"
        });
      }
      await session.provider.pause(normalized.threadId ?? session.provider.threadId);
      const stopped = this.#validatedStopEvidence(
        session,
        await session.provider.waitForBreakpoint(normalized.timeout ?? 5000),
        "pause"
      );
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
      await session.provider.continue(normalized.threadId ?? session.provider.threadId);
      session.state = SessionState.RUNNING;
      return ok(session.sessionId, { status: "running" }, auditId);
    }

    if (action === "stepOver" || action === "stepInto" || action === "stepOut") {
      if (session.provider.capabilities.stepping === "unsupported") {
        throw new BreakPilotError(ErrorCodes.UNSUPPORTED_CAPABILITY, "Runtime provider does not support stepping.", {
          sessionId: session.sessionId,
          providerKind: session.providerKind,
          capability: "stepping"
        });
      }
      if (session.providerKind !== "ide") this.coordinator.assertCanControl(session, SessionOwner.MCP, action);
      const kind = action === "stepInto" ? "into" : action === "stepOut" ? "out" : "over";
      await session.provider.step(kind, normalized.threadId ?? session.provider.threadId);
      session.state = SessionState.RUNNING;
      const stopped = this.#validatedStopEvidence(
        session,
        await session.provider.waitForBreakpoint(normalized.timeout ?? 10000),
        action
      );
      session.state = SessionState.PAUSED;
      return ok(session.sessionId, await this.#controlView(session, "paused", stopped, normalized), auditId);
    }

    if (action === "disconnect" || action === "stop") {
      await this.#cleanupSession(session, {
        reason: action,
        terminateDebuggee: action === "stop" || Boolean(normalized.terminateDebuggee)
      });
      return ok(session.sessionId, { status: "stopped" }, auditId);
    }

    if (action === "drainEvents") {
      if (session.provider.capabilities.eventDrain === "unsupported" || !session.provider.drainEvents) {
        throw new BreakPilotError(ErrorCodes.UNSUPPORTED_CAPABILITY, "Runtime provider does not support event drain.", {
          sessionId: session.sessionId,
          providerKind: session.providerKind,
          capability: "eventDrain"
        });
      }
      const events = await session.provider.drainEvents();
      return ok(session.sessionId, { status: session.state, events }, auditId);
    }

    throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, `Unsupported debug control action: ${String(action)}`, { action });
  }

  async bpDebugRunToLine(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const auditId = this.audit.record("bp_debug_run_to_line_requested", {
      sessionId: normalized.sessionId,
      filePath: normalized.filePath,
      line: normalized.line
    });
    const line = normalized.line;
    if (!normalized.filePath || !Number.isInteger(line) || line === undefined || line < 1) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "bp_debug_run_to_line requires filePath and line.", {});
    }
    const session = this.#resolveSession(normalized);
    if (session.provider.capabilities.runToLine === "unsupported" || !session.provider.runToLine) {
      throw new BreakPilotError(ErrorCodes.UNSUPPORTED_CAPABILITY, "Runtime provider does not support run-to-line.", {
        sessionId: session.sessionId,
        providerKind: session.providerKind
      });
    }
    const result = await session.provider.runToLine({
      filePath: normalized.filePath,
      line,
      threadId: normalized.threadId,
      timeoutMs: normalized.timeout
    });
    session.state = result.status === "paused" ? SessionState.PAUSED : result.status === "stopped" ? SessionState.TERMINATED : session.state;
    return ok(session.sessionId, result as AnyRecord, auditId);
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
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 50;
    const threads = await session.provider.listThreads();
    const limited = threads.slice(offset, offset + limit).map((thread) => this.#threadView(thread, session));
    return ok(session.sessionId, { threads: limited, offset, totalCount: threads.length }, auditId);
  }

  async bpDebugCallStack(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const session = this.#resolveSession(args);
    const auditId = this.audit.record("bp_debug_call_stack_requested", { sessionId: session.sessionId });
    const stack = await this.#callStack(session, args.threadId, args.limit ?? 20, args.offset ?? 0);
    return ok(session.sessionId, stack, auditId);
  }

  async bpDebugFrame(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const session = this.#resolveSession(normalized);
    this.#assertVariableReferences(session, "frame inspection");
    const auditId = this.audit.record("bp_debug_frame_requested", { sessionId: session.sessionId });
    const frame = await this.#frameView(session, normalized);
    return ok(session.sessionId, frame, auditId);
  }

  async bpDebugValue(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const session = this.#resolveSession(normalized);
    this.#assertVariableReferences(session, "value inspection");
    const auditId = this.audit.record("bp_debug_value_requested", { sessionId: session.sessionId, ref: normalized.ref, path: normalized.path });

    if (normalized.ref !== undefined) {
      const limits = this.#variableLimits(normalized);
      const requestedCount = Number(normalized.count ?? limits.maxItems);
      const count = Number.isFinite(requestedCount)
        ? Math.min(limits.maxItems, Math.max(1, Math.floor(requestedCount)))
        : limits.maxItems;
      if (session.dap) {
        const variables = await session.dap.variables(Number(normalized.ref), {
          start: normalized.start ?? 0,
          count
        });
        const serializer = new VariableSerializer(session.dap, limits, { objectFields: normalized.expand ?? "deep" });
        const items = await serializer.serializeVariableNodes(variables);
        return ok(session.sessionId, {
          ref: normalized.ref,
          items: items.map((item) => this.#compactNode(item))
        }, auditId);
      }
      const result = await session.provider.inspectVariable?.({
        ...normalized,
        variablesReference: normalized.ref,
        count
      }, limits);
      return ok(session.sessionId, { ref: normalized.ref, result }, auditId);
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
    return ok(session.sessionId, this.#compactNode(found), auditId);
  }

  async bpDebugSetValue(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const session = this.#resolveSession(normalized);
    this.#assertVariableReferences(session, "set-value path resolution");
    const auditId = this.audit.record("bp_debug_set_value_requested", { sessionId: session.sessionId, path: normalized.path, ref: normalized.ref });
    if (!normalized.path || normalized.path.length === 0) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "bp_debug_set_value requires path + newValue.", {});
    }
    if (normalized.ref !== undefined) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "bp_debug_set_value does not accept ref; use path + newValue.", {});
    }
    if (session.provider.capabilities.setValue === "unsupported" || !session.provider.setVariable) {
      throw new BreakPilotError(ErrorCodes.UNSUPPORTED_CAPABILITY, "Runtime provider does not support variable mutation.", {
        sessionId: session.sessionId,
        providerKind: session.providerKind,
        capability: "setValue"
      });
    }
    const node = await this.#resolveNodeByPath(session, normalized, normalized.path);
    if (!node) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "Variable path was not found in the selected frame.", {
        path: normalized.path
      });
    }
    if (!node.parentRef && session.providerKind !== "ide") {
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
    return ok(session.sessionId, { path: normalized.path, oldValue: node.raw ?? node.summary, result }, auditId);
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
      const stack = await session.dap.stackTrace(this.#dapThreadId(normalized.threadId, session.dap.threadId), (normalized.frameIndex ?? 0) + 1);
      frameId = stack.stackFrames[normalized.frameIndex ?? 0]?.id;
    }
    const result = await session.provider.evaluate(normalized.expression, {
      mode,
      frameId,
      threadId: normalized.threadId,
      context: normalized.context ?? "watch",
      timeoutMs: normalized.timeout ?? this.policy.evaluate.timeoutMs
    });
    return ok(session.sessionId, this.#evalView(normalized.expression, result), auditId);
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
    this.#assertVariableReferences(session, "context inspection");
    const stopped = await session.provider.waitForBreakpoint(normalized.timeout ?? 1000).catch(() => null);
    const stack = await this.#callStack(session, normalized.threadId, normalized.limit ?? 20).catch(() => null);
    const frame = await this.#frameView(session, normalized).catch(() => null);
    return ok(session.sessionId, {
      status: session.state,
      position: frame?.frame ? this.#positionFromFrame(frame.frame) : null,
      frames: stack?.frames ?? [],
      variables: frame?.variables ?? []
    }, auditId);
  }

  async bpDebugSetBreakpoint(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    if (normalized.breakpointId) {
      this.audit.record("bp_debug_set_breakpoint_update_requested", {
        sessionId: normalized.sessionId,
        breakpointId: normalized.breakpointId,
        filePath: normalized.filePath,
        line: normalized.line
      });
      return {
        error: {
          code: ErrorCodes.UNSUPPORTED_CAPABILITY,
          message: "bp_debug_set_breakpoint update/relocate is registered, but not implemented in Phase 1.",
          details: {
            phase: "contract",
            breakpointId: normalized.breakpointId
          }
        }
      };
    }
    const session = this.#resolveBreakpointSession(normalized);
    if (!session) return this.#setProjectBreakpoint(normalized);
    const auditId = this.audit.record("bp_debug_set_breakpoint_requested", { sessionId: session.sessionId });
    const response = await this.#setSessionBreakpoint(session, { ...normalized, file: normalized.filePath });
    const lineText = response.filePath && response.line ? this.#readLine(String(response.filePath), Number(response.line)) : undefined;
    return ok(session.sessionId, {
      ...response,
      ...(lineText !== undefined ? { lineText } : {})
    }, auditId);
  }

  async bpDebugListBreakpoints(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const session = this.#resolveBreakpointSession(normalized);
    if (!session) return this.#listProjectBreakpoints(normalized);
    const auditId = this.audit.record("bp_debug_list_breakpoints_requested", { sessionId: session.sessionId });
    let breakpoints = session.provider.listBreakpoints
      ? await session.provider.listBreakpoints({
          filePath: normalized.filePath,
          owner: this.#breakpointOwnerFilter(normalized.owner),
          includeDisabled: normalized.includeDisabled
        })
      : this.breakpoints.list(session.sessionId);
    if (normalized.filePath) {
      const file = this.security.assertWorkspacePath(normalized.filePath);
      breakpoints = breakpoints.filter((bp) => path.resolve(bp.file) === path.resolve(file));
    }
    breakpoints = this.#filterBreakpointRecords(breakpoints, normalized);
    return ok(session.sessionId, { breakpoints: breakpoints.map((breakpoint) => this.#breakpointView(breakpoint)), totalCount: breakpoints.length }, auditId);
  }

  async bpDebugRemoveBreakpoint(args: DebugToolArgs = {}): Promise<ToolResponse> {
    const normalized = this.#normalizeBpArgs(args);
    const session = this.#resolveBreakpointSession(normalized);
    if (!session) return this.#removeProjectBreakpoint(normalized);
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
    const breakpoint = this.breakpoints.list(session.sessionId).find((bp) => bp.id === breakpointId);
    if (breakpoint && !this.#canRemoveBreakpointOwner(breakpoint, normalized.owner)) {
      return ok(session.sessionId, this.#protectedBreakpointRemoveView(breakpoint), auditId);
    }
    const response = await this.#removeSessionBreakpoint(session, breakpointId);
    return ok(session.sessionId, { ...response, breakpointId }, auditId);
  }

  async #launchDapSession(args: DebugToolArgs = {}): Promise<DebugSessionRecord> {
    this.audit.record("bp_debug_launch_session_requested", { args: this.#safeArgs(args) });
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
      if (this.#markDapSessionRunning(session)) {
        this.audit.record("bp_debug_launch_session_succeeded", { sessionId: session.sessionId, language });
      }
      return session;
    } catch (error) {
      const typedError = error as Error & { details?: AnyRecord };
      this.#discardFailedSession(session);
      throw new BreakPilotError(ErrorCodes.LAUNCH_FAILED, typedError.message, {
        sessionId: session.sessionId,
        cause: typedError.details ?? {}
      });
    }
  }

  async #attachDapSession(args: DebugToolArgs = {}): Promise<DebugSessionRecord> {
    this.audit.record("bp_debug_attach_session_requested", { args: this.#safeArgs(args) });
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
      if (this.#markDapSessionRunning(session)) {
        this.audit.record("bp_debug_attach_session_succeeded", { sessionId: session.sessionId, language, host, port });
      }
      return session;
    } catch (error) {
      const typedError = error as Error & { details?: AnyRecord };
      this.#discardFailedSession(session);
      throw new BreakPilotError(ErrorCodes.ATTACH_FAILED, typedError.message, {
        sessionId: session.sessionId,
        cause: typedError.details ?? {}
      });
    }
  }

  async #setSessionBreakpoint(session: DebugSessionRecord, args: DebugToolArgs = {}): Promise<AnyRecord> {
    if (!args.file || !args.line) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "filePath and line are required.");
    }
    if (session.providerKind !== "ide") {
      this.coordinator.assertCanControl(session, SessionOwner.MCP, "set breakpoint");
    }
    this.#assertBreakpointCapabilities(session.provider.capabilities, args, session.providerKind);
    const file = this.security.assertWorkspacePath(args.file);
    this.audit.record("bp_debug_session_set_breakpoint_requested", {
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
      enabled: args.enabled ?? true,
      temporary: args.temporary ?? false,
      suspendPolicy: args.suspendPolicy,
      isLogMessage: args.isLogMessage,
      isLogStack: args.isLogStack,
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

    this.audit.record("bp_debug_session_set_breakpoint_finished", {
      sessionId: session.sessionId,
      breakpoint: selected
    });
    return this.#breakpointView(selected);
  }

  async #removeSessionBreakpoint(session: DebugSessionRecord, breakpointId: string): Promise<AnyRecord> {
    if (!breakpointId) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "breakpointId is required.");
    }
    this.audit.record("bp_debug_session_remove_breakpoint_requested", {
      sessionId: session.sessionId,
      breakpointId
    });
    const breakpoint = this.breakpoints.list(session.sessionId).find((bp) => bp.id === breakpointId);
    if (!breakpoint) return { removed: false };
    const remaining = this.breakpoints
      .listForSource(session.sessionId, breakpoint.file)
      .filter((candidate) => candidate.id !== breakpointId);
    const acknowledged = session.provider.removeBreakpoint
      ? this.#breakpointRemovalAcknowledged(await session.provider.removeBreakpoint(breakpoint))
      : await session.provider.setBreakpoints(breakpoint.file, remaining).then(() => true);
    if (!acknowledged) return { removed: false };
    const removed = this.breakpoints.remove(session.sessionId, breakpointId);
    if (removed && session.providerKind === "dap") {
      this.#broadcastToWorkspace(session.workspaceRoot, {
        type: "agent_remove_breakpoint",
        sessionId: session.sessionId,
        breakpointId,
        file: breakpoint.file,
        line: breakpoint.line
      });
    }
    return { removed };
  }

  async cleanupAll(reason = "shutdown"): Promise<void> {
    const sessions = [...this.sessions.sessions.values()];
    await Promise.allSettled(sessions.map((session) => this.#cleanupSession(session, { reason })));
  }

  appendRuntimeEvent(
    sessionId: string,
    event: Omit<RuntimeEvent, "sequence" | "timestamp" | "sessionId">
  ): RuntimeEvent {
    return this.#runtimeEventsFor(sessionId).append(event);
  }

  readRuntimeEvents(sessionId: string, args?: DrainEventsArgs): RuntimeEventPage {
    const active = this.sessions.maybeGet(sessionId);
    if (active) return this.#runtimeEventsFor(sessionId).read(args);
    const archived = this.#archivedRuntimeEvents.get(sessionId);
    if (archived) return archived.events.read(args);
    return this.#runtimeEventsFor(sessionId).read(args);
  }

  async #adoptIdeSession(args: DebugToolArgs = {}): Promise<{ session: DebugSessionRecord; warnings: string[] }> {
    if (!this.ideBridge) {
      throw new BreakPilotError(ErrorCodes.IDE_NOT_CONNECTED, "IDE bridge is not available.");
    }
    this.audit.record("bp_debug_ide_adopt_requested", {
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
      return { session: existing, warnings: ["IDE session was already adopted."] };
    }

    const sessionId = makeSessionId();
    const runtimeEvents = new RuntimeEventBuffer(sessionId, this.policy.runtime.maxEventBuffer);
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
      runtimeEvents,
      ideClientId: ideSession.clientId,
      ideSessionId: ideSession.ideSessionId
    };
    this.sessions.add(record);
    this.audit.record("bp_debug_ide_adopt_succeeded", {
      sessionId,
      clientId: ideSession.clientId,
      ideSessionId: ideSession.ideSessionId
    });
    return { session: record, warnings: [] };
  }

  async #setProjectBreakpoint(args: DebugToolArgs): Promise<ToolResponse> {
    if (!args.filePath || !args.line) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "filePath and line are required.");
    }
    const workspaceRoot = this.#statusWorkspaceRoot(args);
    const file = this.security.assertWorkspacePath(args.filePath);
    const target = this.#selectProjectIdeTarget(args, workspaceRoot);
    this.#assertBreakpointCapabilities(
      ideProviderCapabilities(mergeIdeCapabilityRecords(
        target.client.capabilities ?? {},
        target.session?.capabilities ?? {}
      )),
      args,
      target.client.ide
    );
    const auditId = this.audit.record("bp_debug_project_set_breakpoint_requested", {
      workspaceRoot,
      clientId: target.client.clientId,
      ide: target.client.ide,
      file,
      line: args.line
    });
    const breakpoint = this.breakpoints.addProject({
      workspaceRoot,
      clientId: target.client.clientId,
      ide: target.client.ide,
      ideSessionId: target.session?.ideSessionId,
      file,
      line: args.line,
      column: args.column,
      condition: args.condition,
      hitCondition: args.hitCondition,
      logMessage: args.logMessage,
      enabled: args.enabled ?? true,
      temporary: args.temporary ?? false,
      suspendPolicy: args.suspendPolicy,
      isLogMessage: args.isLogMessage,
      isLogStack: args.isLogStack,
      owner: args.owner ?? "agent"
    });
    const requestId = makeId("ide_req");
    try {
      const response = await this.#sendIdeClientRequest(
        target.client.clientId,
        {
          type: IdeMessageTypes.AGENT_SET_BREAKPOINT,
          requestId,
          workspaceRoot,
          ideSessionId: target.session?.ideSessionId,
          breakpoint
        },
        [IdeMessageTypes.IDE_BREAKPOINT_ADDED],
        (message) => (
          message.requestId === requestId ||
          message.breakpointId === breakpoint.id ||
          message.breakpoint?.id === breakpoint.id
        )
      );
      if (this.#bridgeMessageError(response)) {
        throw new BreakPilotError(
          String(response.error?.code ?? ErrorCodes.BREAKPOINT_NOT_VERIFIED),
          String(response.error?.message ?? "IDE failed to set breakpoint."),
          { error: response.error, breakpoint }
        );
      }
      const responseBreakpoint = response.breakpoint as AnyRecord | undefined;
      const selected = this.breakpoints.updateProject(breakpoint.id, {
        verified: responseBreakpoint?.verified === undefined ? true : Boolean(responseBreakpoint.verified),
        adapterBreakpointId: responseBreakpoint?.adapterBreakpointId as number | string | undefined,
        ideBreakpointId: typeof responseBreakpoint?.ideBreakpointId === "string" ? responseBreakpoint.ideBreakpointId : undefined,
        message: response.error?.message ? String(response.error.message) : undefined,
        line: typeof responseBreakpoint?.line === "number" ? responseBreakpoint.line : breakpoint.line,
        column: typeof responseBreakpoint?.column === "number" ? responseBreakpoint.column : breakpoint.column
      }) ?? breakpoint;
      if (!selected.verified && args.requireVerified) {
        throw new BreakPilotError(
          ErrorCodes.BREAKPOINT_NOT_VERIFIED,
          "Breakpoint was not verified by IDE.",
          { breakpoint: selected }
        );
      }
      const lineText = selected.file && selected.line ? this.#readLine(selected.file, selected.line) : undefined;
      return ok(null, {
        ...this.#projectBreakpointView(selected),
        ...(lineText !== undefined ? { lineText } : {})
      }, auditId);
    } catch (error) {
      this.breakpoints.removeProject(breakpoint.id);
      throw error;
    }
  }

  async #listProjectBreakpoints(args: DebugToolArgs): Promise<ToolResponse> {
    const workspaceRoot = this.#statusWorkspaceRoot(args);
    const ide = this.#normalizedIde(args.ide);
    const file = args.filePath ? this.security.assertWorkspacePath(args.filePath) : undefined;
    const auditId = this.audit.record("bp_debug_project_list_breakpoints_requested", {
      workspaceRoot,
      clientId: args.clientId,
      ide,
      file
    });
    const ideBreakpoints = await this.#listIdeProjectBreakpoints(args, workspaceRoot, ide, file).catch((error) => {
      if (error instanceof BreakPilotError && error.code === ErrorCodes.IDE_NOT_CONNECTED) return null;
      throw error;
    });
    const breakpoints = ideBreakpoints ?? this.breakpoints.listProject({
      workspaceRoot,
      clientId: args.clientId,
      ide,
      file
    });
    const matchingFile = file
      ? breakpoints.filter((breakpoint) => path.resolve(breakpoint.file) === path.resolve(file))
      : breakpoints;
    const filtered = this.#filterBreakpointRecords(matchingFile, args);
    return ok(null, {
      breakpoints: filtered.map((breakpoint) => this.#projectBreakpointView(breakpoint)),
      totalCount: filtered.length
    }, auditId);
  }

  async #removeProjectBreakpoint(args: DebugToolArgs): Promise<ToolResponse> {
    const workspaceRoot = this.#statusWorkspaceRoot(args);
    const ide = this.#normalizedIde(args.ide);
    const file = args.filePath ? this.security.assertWorkspacePath(args.filePath) : undefined;
    const auditId = this.audit.record("bp_debug_project_remove_breakpoint_requested", {
      workspaceRoot,
      clientId: args.clientId,
      ide,
      breakpointId: args.breakpointId,
      file,
      line: args.line
    });
    const breakpoint = this.#findProjectBreakpointToRemove(args, workspaceRoot, ide, file);
    if (!breakpoint) {
      return ok(null, {
        removed: false,
        breakpointId: args.breakpointId
      }, auditId);
    }
    if (!this.#canRemoveBreakpointOwner(breakpoint, args.owner)) {
      return ok(null, this.#protectedBreakpointRemoveView(breakpoint), auditId);
    }
    const requestId = makeId("ide_req");
    const response = await this.#sendIdeClientRequest(
      breakpoint.clientId,
      {
        type: IdeMessageTypes.AGENT_REMOVE_BREAKPOINT,
        requestId,
        workspaceRoot: breakpoint.workspaceRoot,
        ideSessionId: breakpoint.ideSessionId,
        breakpointId: breakpoint.id,
        breakpoint
      },
      [IdeMessageTypes.IDE_BREAKPOINT_REMOVED],
      (message) => (
        message.requestId === requestId ||
        message.breakpointId === breakpoint.id ||
        message.breakpoint?.id === breakpoint.id
      )
    );
    const removed = this.#breakpointRemovalAcknowledged(response);
    if (removed) this.breakpoints.removeProject(breakpoint.id);
    return ok(null, {
      removed,
      breakpointId: breakpoint.id
    }, auditId);
  }

  async #listIdeProjectBreakpoints(
    args: DebugToolArgs,
    workspaceRoot: string,
    ide: string | undefined,
    file: string | undefined
  ): Promise<ProjectBreakpointRecord[] | null> {
    if (!this.ideBridge) return null;
    const target = this.#selectProjectIdeTarget(args, workspaceRoot);
    const requestId = makeId("ide_req");
    const response = await this.#sendIdeClientRequest(
      target.client.clientId,
      {
        type: IdeMessageTypes.AGENT_LIST_BREAKPOINTS,
        requestId,
        workspaceRoot,
        ideSessionId: target.session?.ideSessionId,
        options: {
          filePath: file,
          owner: args.owner,
          includeDisabled: args.includeDisabled
        }
      },
      [IdeMessageTypes.IDE_BREAKPOINTS_SNAPSHOT],
      (message) => message.requestId === requestId
    );
    const rawBreakpoints: unknown[] = Array.isArray(response.result?.breakpoints)
      ? response.result.breakpoints
      : Array.isArray(response.breakpoints)
        ? response.breakpoints
        : [];
    return rawBreakpoints
      .map((breakpoint, index) => this.#projectBreakpointFromIde(
        breakpoint as AnyRecord,
        index,
        workspaceRoot,
        target.client,
        target.session?.ideSessionId
      ))
      .filter((breakpoint): breakpoint is ProjectBreakpointRecord => Boolean(breakpoint));
  }

  #normalizeBpArgs(args: DebugToolArgs = {}): DebugToolArgs {
    return {
      ...args,
      lang: args.lang ?? args.language,
      workspace: args.workspace ?? args.projectPath,
      file: args.file ?? args.filePath,
      filePath: args.filePath ?? args.file,
      timeout: args.timeout ?? args.timeoutMs,
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

  #assertVariableReferences(session: DebugSessionRecord, operation: string): void {
    if (session.provider.capabilities.variableReferences !== "unsupported") return;
    throw new BreakPilotError(
      ErrorCodes.UNSUPPORTED_CAPABILITY,
      `Runtime provider does not support ${operation}.`,
      {
        sessionId: session.sessionId,
        providerKind: session.providerKind,
        capability: "variableReferences",
        operation
      }
    );
  }

  #assertBreakpointCapabilities(
    capabilities: RuntimeProviderCapabilities,
    args: DebugToolArgs,
    providerKind: string
  ): void {
    const advancedOptions: Array<{
      requested: boolean;
      capability: keyof Pick<
        RuntimeProviderCapabilities,
        "conditionalBreakpoints" | "hitConditionalBreakpoints" | "tracepoints"
      >;
      option: string;
    }> = [
      {
        requested: args.condition !== undefined && args.condition !== null,
        capability: "conditionalBreakpoints",
        option: "condition"
      },
      {
        requested: args.hitCondition !== undefined && args.hitCondition !== null,
        capability: "hitConditionalBreakpoints",
        option: "hitCondition"
      },
      {
        requested: args.logMessage !== undefined && args.logMessage !== null,
        capability: "tracepoints",
        option: "logMessage"
      }
    ];
    const unsupportedAdvanced = advancedOptions.find(
      ({ requested, capability }) => requested && capabilities[capability] === "unsupported"
    );
    if (unsupportedAdvanced) {
      throw new BreakPilotError(
        ErrorCodes.UNSUPPORTED_CAPABILITY,
        `Runtime provider does not support breakpoint option ${unsupportedAdvanced.option}.`,
        {
          providerKind,
          capability: unsupportedAdvanced.capability,
          option: unsupportedAdvanced.option
        }
      );
    }

    const unsupportedSemantic = [
      { requested: args.enabled === false, option: "enabled:false" },
      { requested: args.temporary === true, option: "temporary:true" },
      { requested: args.suspendPolicy !== undefined, option: "suspendPolicy" },
      { requested: args.isLogMessage === true, option: "isLogMessage:true" },
      { requested: args.isLogStack === true, option: "isLogStack:true" }
    ].find(({ requested }) => requested);
    if (unsupportedSemantic) {
      throw new BreakPilotError(
        ErrorCodes.UNSUPPORTED_CAPABILITY,
        `Runtime provider does not implement breakpoint semantic ${unsupportedSemantic.option}.`,
        {
          providerKind,
          option: unsupportedSemantic.option
        }
      );
    }
  }

  #resolveSession(args: DebugToolArgs = {}): DebugSessionRecord {
    if (args.sessionId) {
      const session = this.sessions.get(args.sessionId);
      if (session.state === SessionState.TERMINATED || session.state === SessionState.FAILED) {
        throw new BreakPilotError(ErrorCodes.SESSION_NOT_FOUND, `Session not found: ${args.sessionId}`, {
          sessionId: args.sessionId
        });
      }
      return session;
    }
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
        ...(args.projectPath ?? args.workspace
          ? { projectPath: args.projectPath ?? args.workspace }
          : {})
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

  #validatedStopEvidence(
    session: DebugSessionRecord,
    stopped: unknown,
    operation: string
  ): AnyRecord {
    const evidence = stopped && typeof stopped === "object" && !Array.isArray(stopped)
      ? stopped as AnyRecord
      : null;
    const mismatchedSession = Boolean(
      evidence?.sessionId && evidence.sessionId !== session.sessionId
    );
    const mismatchedIdeSession = Boolean(
      evidence?.ideSessionId &&
      session.ideSessionId &&
      evidence.ideSessionId !== session.ideSessionId
    );
    const nested = evidence?.stopped && typeof evidence.stopped === "object" && !Array.isArray(evidence.stopped)
      ? evidence.stopped as AnyRecord
      : null;
    const hasStopDetail = this.#hasStopDetail(evidence) || this.#hasStopDetail(nested);
    if (!evidence || mismatchedSession || mismatchedIdeSession || !hasStopDetail) {
      throw new BreakPilotError(
        ErrorCodes.TOOL_FAILED,
        `Runtime provider did not report correlated stop evidence after ${operation}.`,
        {
          sessionId: session.sessionId,
          providerKind: session.providerKind,
          ...(session.ideSessionId !== undefined ? { ideSessionId: session.ideSessionId } : {}),
          ...(evidence?.sessionId !== undefined ? { reportedSessionId: evidence.sessionId } : {}),
          ...(evidence?.ideSessionId !== undefined ? { reportedIdeSessionId: evidence.ideSessionId } : {})
        }
      );
    }
    return evidence;
  }

  #hasStopDetail(value: AnyRecord | null): boolean {
    if (!value) return false;
    const threadId = value.threadId;
    const hasThread =
      (typeof threadId === "number" && Number.isFinite(threadId)) ||
      (typeof threadId === "string" && threadId.trim().length > 0);
    const topFrame = value.topFrame;
    const hasFrame = Boolean(
      topFrame &&
      typeof topFrame === "object" &&
      !Array.isArray(topFrame) &&
      Object.keys(topFrame).length > 0
    );
    return Boolean(
      (typeof value.reason === "string" && value.reason.trim().length > 0) ||
      (typeof value.description === "string" && value.description.trim().length > 0) ||
      hasThread ||
      hasFrame ||
      typeof value.allThreadsStopped === "boolean"
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

  #resolveBreakpointSession(args: DebugToolArgs): DebugSessionRecord | null {
    if (args.sessionId) return this.#resolveSession(args);
    if (args.clientId || args.ide) return null;
    try {
      return this.#resolveSession(args);
    } catch (error) {
      if (
        error instanceof BreakPilotError &&
        (error.code === ErrorCodes.SESSION_NOT_FOUND || error.code === ErrorCodes.SESSION_AMBIGUOUS)
      ) {
        return null;
      }
      throw error;
    }
  }

  #findProjectBreakpointToRemove(
    args: DebugToolArgs,
    workspaceRoot: string,
    ide: string | undefined,
    file: string | undefined
  ): ProjectBreakpointRecord | undefined {
    if (!args.breakpointId && (!file || !args.line)) {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "Pass breakpointId or filePath + line to remove a breakpoint.", {});
    }
    const candidates = this.breakpoints.listProject({
      workspaceRoot,
      clientId: args.clientId,
      ide,
      file
    });
    if (args.breakpointId) {
      return candidates.find((breakpoint) => breakpoint.id === args.breakpointId);
    }
    const matches = candidates.filter((breakpoint) => breakpoint.line === args.line);
    if (matches.length > 1) {
      throw new BreakPilotError(
        ErrorCodes.PROJECT_AMBIGUOUS,
        "Multiple project breakpoints match. Pass breakpointId, ide, or clientId to choose one.",
        {
          breakpoints: matches.map((breakpoint) => ({
            breakpointId: breakpoint.id,
            clientId: breakpoint.clientId,
            ide: breakpoint.ide,
            workspaceRoot: breakpoint.workspaceRoot,
            file: breakpoint.file,
            line: breakpoint.line
          }))
        }
      );
    }
    return matches[0];
  }

  #statusWorkspaceRoot(args: DebugToolArgs = {}): string {
    return args.projectPath || args.workspace
      ? resolveWorkspacePath(this.security.workspaceRoot(), String(args.projectPath ?? args.workspace))
      : this.security.workspaceRoot();
  }

  #sessionStatusList(args: DebugToolArgs = {}): SessionSummary[] {
    const workspaceRoot = this.#statusWorkspaceRoot(args);
    return [...this.sessions.sessions.values()].filter((session) => {
      if (path.resolve(session.workspaceRoot) !== path.resolve(workspaceRoot)) return false;
      if (session.state === SessionState.TERMINATED || session.state === SessionState.FAILED) {
        return false;
      }
      return true;
    }).map((session) => this.#sessionSummary(session, args.detail === "diagnostic"));
  }

  #ideStatusView(args: DebugToolArgs = {}): AnyRecord {
    if (!this.ideBridge) return { enabled: false, connected: false, clients: 0, sessions: [] };
    const workspaceRoot = this.#statusWorkspaceRoot(args);
    const clients = this.ideBridge.registry.list().filter((client) => {
      if (args.clientId && client.clientId !== args.clientId) return false;
      if (client.workspaceRoot && path.resolve(client.workspaceRoot) !== path.resolve(workspaceRoot)) return false;
      return true;
    });
    const sessions = this.ideBridge.registry.listSessions({ clientId: args.clientId, workspaceRoot }).filter((session) => {
      return session.state !== SessionState.TERMINATED && session.state !== SessionState.FAILED;
    });
    return {
      enabled: true,
      connected: clients.length > 0,
      clients: clients.length,
      sessions: sessions.map((session) => ({
        ideSessionId: session.ideSessionId,
        name: session.name,
        state: session.state,
        active: Boolean(session.active),
        position: this.#positionFromTopFrame(session.topFrame),
        ...(args.detail === "diagnostic"
          ? {
              providerKind: "ide",
              capabilities: ideProviderCapabilities(mergeIdeCapabilityRecords(
                this.ideBridge?.registry.get(session.clientId)?.capabilities ?? {},
                session.capabilities ?? {}
              ))
            }
          : {})
      }))
    };
  }

  async #callStack(session: DebugSessionRecord, threadId?: ThreadId, limit = 20, offset = 0): Promise<AnyRecord> {
    if (!session.provider.getCallStack) {
      throw new BreakPilotError(ErrorCodes.TOOL_FAILED, "Runtime provider does not support call stack inspection.", {
        sessionId: session.sessionId,
        providerKind: session.providerKind
      });
    }
    const stack = await session.provider.getCallStack(threadId ?? session.provider.threadId, offset + limit);
    const frames = (stack.stackFrames ?? [])
      .slice(offset, offset + limit)
      .map((frame: DapStackFrame, index: number) => this.#frameSummary(frame, index + offset));
    return {
      threadId: stack.threadId ?? threadId ?? session.provider.threadId,
      frames,
      offset,
      totalFrames: stack.totalFrames ?? frames.length,
      ...(stack.partial ? { partial: true } : {})
    };
  }

  async #frameView(session: DebugSessionRecord, args: DebugToolArgs, compact = true): Promise<AnyRecord> {
    const limits = this.#variableLimits(args);
    const expand = args.expand ?? args.objectFields ?? "preview";

    if (session.dap) {
      const stack = await session.dap.stackTrace(this.#dapThreadId(args.threadId, session.dap.threadId), (args.frameIndex ?? 0) + 1);
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
      const view = {
        threadId: stack.threadId,
        frame: frame ? this.#frameSummary(frame, args.frameIndex ?? 0) : null,
        variables
      };
      return compact ? this.#compactFrameView(view) : view;
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
    const view = {
      threadId: snapshot.threadId,
      frame: frame ? this.#frameSummary(frame, frameIndex) : null,
      variables
    };
    return compact ? this.#compactFrameView(view) : view;
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
      function: fn
    };
  }

  #positionFromFrame(frame: AnyRecord): AnyRecord {
    return {
      filePath: frame.filePath ?? null,
      line: frame.line ?? null
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
          threadId: stopped?.threadId ?? session.provider.threadId ?? args.threadId,
          expand: args.expand ?? "preview",
          depth: args.depth ?? 1,
          limit: args.limit ?? 10
        }).catch(() => null)
      : null;
    const view: AnyRecord = {
      status,
      reason: stopped?.reason ?? null,
      position: frame?.frame ? this.#positionFromFrame(frame.frame) : this.#positionFromStopped(stopped),
    };
    if (frame?.frame) {
      view.frame = frame.frame;
      view.variables = frame.variables;
    }
    return view;
  }

  #positionFromStopped(stopped: AnyRecord | null): AnyRecord | null {
    const topFrame = (stopped?.topFrame ?? stopped?.stopped?.topFrame) as AnyRecord | undefined;
    if (!topFrame || Object.keys(topFrame).length === 0) return null;
    const source = topFrame.source as AnyRecord | undefined;
    return {
      filePath: source?.path ?? topFrame.filePath ?? null,
      line: topFrame.line ?? null
    };
  }

  #filterBreakpointRecords<TBreakpoint extends BreakpointRecord | ProjectBreakpointRecord>(
    breakpoints: TBreakpoint[],
    args: DebugToolArgs
  ): TBreakpoint[] {
    return breakpoints.filter((breakpoint) => {
      if (args.owner && args.owner !== "all" && breakpoint.owner !== args.owner) return false;
      if (args.includeDisabled === false && breakpoint.enabled === false) return false;
      return true;
    });
  }

  #canRemoveBreakpointOwner(
    breakpoint: BreakpointRecord | ProjectBreakpointRecord,
    owner: SessionOwnerValue | "agent" | "user" | "all" | undefined
  ): boolean {
    const requestedOwner = owner ?? "agent";
    if (requestedOwner === "all") return true;
    return breakpoint.owner === requestedOwner;
  }

  #breakpointOwnerFilter(owner: unknown): "agent" | "user" | "all" | undefined {
    return owner === "agent" || owner === "user" || owner === "all" ? owner : undefined;
  }

  #protectedBreakpointRemoveView(breakpoint: BreakpointRecord | ProjectBreakpointRecord): AnyRecord {
    return {
      removed: false,
      protected: true,
      breakpointId: breakpoint.id,
      message: `Breakpoint ${breakpoint.id} is owned by ${breakpoint.owner ?? "agent"} and was not removed. Pass owner:"all" to remove it.`
    };
  }

  #breakpointRemovalAcknowledged(response: AnyRecord): boolean {
    return response.removed === true || (response.result as AnyRecord | undefined)?.removed === true;
  }

  #numberOrUndefined(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  #dapThreadId(threadId: ThreadId | null | undefined, fallback: number | null): number | null {
    if (typeof threadId === "number" && Number.isFinite(threadId)) return threadId;
    if (typeof threadId === "string") {
      const parsed = Number(threadId);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  #threadView(thread: AnyRecord, session: DebugSessionRecord): AnyRecord {
    const providerThreadId = session.provider.threadId;
    return {
      id: thread.id,
      name: String(thread.name ?? thread.id ?? ""),
      state: String(thread.state ?? session.state),
      isCurrent: thread.isCurrent === undefined
        ? providerThreadId !== null && providerThreadId !== undefined && String(thread.id) === String(providerThreadId)
        : Boolean(thread.isCurrent),
      frameCount: thread.frameCount ?? 0,
      ...(thread.partial ? { partial: true } : {})
    };
  }

  #compactFrameView(view: { threadId: ThreadId | null; frame: AnyRecord | null; variables: AnyRecord[] }): AnyRecord {
    return {
      threadId: view.threadId,
      frame: view.frame,
      variables: view.variables.map((scope) => ({
        scope: scope.scope,
        ...(scope.category ? { category: scope.category } : {}),
        items: Array.isArray(scope.items) ? scope.items.map((node: VariableNode) => this.#compactNode(node)) : []
      }))
    };
  }

  #compactNode(node: VariableNode): AnyRecord {
    const compact: AnyRecord = {
      name: node.name,
      value: node.summary,
      path: node.path
    };
    if (node.type) compact.type = node.type;
    if (node.ref !== undefined) compact.ref = node.ref;
    if (node.children?.length) compact.children = node.children.map((child) => this.#compactNode(child));
    return compact;
  }

  #evalView(expression: string | undefined, result: AnyRecord): AnyRecord {
    const value = result.value as AnyRecord | undefined;
    if (!value) return { expression, result };
    return {
      expression,
      value: value.valuePreview ?? value.value ?? result.valuePreview ?? result.value,
      ...(value.type ? { type: value.type } : {})
    };
  }

  #breakpointView(breakpoint: BreakpointRecord): AnyRecord {
    return {
      breakpointId: breakpoint.id,
      filePath: breakpoint.file,
      line: breakpoint.line,
      verified: breakpoint.verified,
      ...(breakpoint.condition !== undefined ? { condition: breakpoint.condition } : {}),
      ...(breakpoint.hitCondition !== undefined ? { hitCondition: breakpoint.hitCondition } : {}),
      ...(breakpoint.logMessage !== undefined ? { logMessage: breakpoint.logMessage } : {}),
      owner: breakpoint.owner,
      enabled: breakpoint.enabled ?? true,
      temporary: breakpoint.temporary ?? false,
      ...(breakpoint.suspendPolicy !== undefined ? { suspendPolicy: breakpoint.suspendPolicy } : {}),
      ...(breakpoint.isLogMessage !== undefined ? { isLogMessage: breakpoint.isLogMessage } : {}),
      ...(breakpoint.isLogStack !== undefined ? { isLogStack: breakpoint.isLogStack } : {}),
      ...(breakpoint.message ? { message: breakpoint.message } : {})
    };
  }

  #projectBreakpointView(breakpoint: ProjectBreakpointRecord): AnyRecord {
    return {
      breakpointId: breakpoint.id,
      filePath: breakpoint.file,
      line: breakpoint.line,
      verified: breakpoint.verified,
      ...(breakpoint.condition !== undefined ? { condition: breakpoint.condition } : {}),
      ...(breakpoint.hitCondition !== undefined ? { hitCondition: breakpoint.hitCondition } : {}),
      ...(breakpoint.logMessage !== undefined ? { logMessage: breakpoint.logMessage } : {}),
      owner: breakpoint.owner,
      enabled: breakpoint.enabled ?? true,
      temporary: breakpoint.temporary ?? false,
      ...(breakpoint.suspendPolicy !== undefined ? { suspendPolicy: breakpoint.suspendPolicy } : {}),
      ...(breakpoint.isLogMessage !== undefined ? { isLogMessage: breakpoint.isLogMessage } : {}),
      ...(breakpoint.isLogStack !== undefined ? { isLogStack: breakpoint.isLogStack } : {}),
      ...(breakpoint.message ? { message: breakpoint.message } : {})
    };
  }

  #projectBreakpointFromIde(
    raw: AnyRecord,
    index: number,
    workspaceRoot: string,
    client: IdeClientInfo,
    ideSessionId?: string
  ): ProjectBreakpointRecord | null {
    const type = typeof raw.type === "string" ? raw.type : "line";
    const file = raw.file ?? raw.filePath;
    const line = raw.line;
    if (type === "line" && (typeof file !== "string" || typeof line !== "number")) return null;
    const id = String(raw.id ?? raw.breakpointId ?? raw.ideBreakpointId ?? `${client.clientId}:ide_bp_${index}`);
    return {
      id,
      workspaceRoot,
      clientId: client.clientId,
      ide: client.ide,
      ideSessionId,
      file: typeof file === "string" ? file : "",
      line: typeof line === "number" ? line : -1,
      column: this.#numberOrUndefined(raw.column),
      condition: typeof raw.condition === "string" ? raw.condition : undefined,
      hitCondition: typeof raw.hitCondition === "string" ? raw.hitCondition : undefined,
      logMessage: typeof raw.logMessage === "string" ? raw.logMessage : undefined,
      enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
      temporary: Boolean(raw.temporary),
      suspendPolicy: raw.suspendPolicy === "ALL" || raw.suspendPolicy === "THREAD" || raw.suspendPolicy === "NONE"
        ? raw.suspendPolicy
        : undefined,
      isLogMessage: Boolean(raw.isLogMessage),
      isLogStack: Boolean(raw.isLogStack),
      owner: typeof raw.owner === "string" ? raw.owner : "user",
      verified: raw.verified === undefined ? true : Boolean(raw.verified),
      adapterBreakpointId: typeof raw.adapterBreakpointId === "number" || typeof raw.adapterBreakpointId === "string"
        ? raw.adapterBreakpointId
        : undefined,
      ideBreakpointId: typeof raw.ideBreakpointId === "string" ? raw.ideBreakpointId : id,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString()
    };
  }

  #positionFromTopFrame(topFrame: unknown): AnyRecord | null {
    if (!topFrame || typeof topFrame !== "object") return null;
    const frame = topFrame as AnyRecord;
    const source = frame.source as AnyRecord | undefined;
    const filePath = source?.path ?? frame.filePath ?? null;
    const line = frame.line ?? null;
    if (!filePath && !line) return null;
    return { filePath, line };
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
    const frame = await this.#frameView(session, { ...args, expand: args.expand ?? "preview" }, false);
    let level = (frame.variables as VariableScopeView[]).flatMap((scope: VariableScopeView) => scope.items);
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
    // have already run in the private launch/attach helpers before #createSession.
    await adapter.initialize(ctx);
    const transport = await adapter.createTransport(ctx);
    const client = new DapClient(transport);
    const dap = new DapSession({ sessionId, language, client, workspaceRoot });
    const runtimeEvents = new RuntimeEventBuffer(sessionId, this.policy.runtime.maxEventBuffer);
    const provider = new DapRuntimeProvider(dap, runtimeEvents);
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
      runtimeEvents,
      dap
    };
    const onStopped = (): void => {
      record.state = SessionState.PAUSED;
    };
    const onTerminated = (): void => {
      record.state = SessionState.TERMINATED;
      void this.#cleanupSession(record, { reason: "dap_terminated", disconnectProvider: false });
    };
    const onExited = (body: AnyRecord): void => {
      record.state = SessionState.TERMINATED;
      runtimeEvents.append({
        kind: "terminated",
        data: this.#dapExitedMetadata(body)
      });
      this.#archiveRuntimeEvents(record);
      this.#scheduleDapTerminationCleanup(record);
    };
    const onAdapterError = (): void => {
      record.state = SessionState.TERMINATED;
      runtimeEvents.append({ kind: "terminated", data: { reason: "adapterError" } });
      void this.#cleanupSession(record, { reason: "dap_adapter_error", disconnectProvider: false });
    };
    const onTransportExit = (): void => {
      record.state = SessionState.TERMINATED;
      runtimeEvents.append({ kind: "terminated", data: { reason: "transportExit" } });
      void this.#cleanupSession(record, { reason: "dap_transport_exit", disconnectProvider: false });
    };
    const onStartFailed = (): void => {
      this.#discardFailedSession(record);
    };
    dap.on("stopped", onStopped);
    dap.on("terminated", onTerminated);
    dap.on("exited", onExited);
    dap.on("adapterError", onAdapterError);
    dap.on("transportExit", onTransportExit);
    dap.on("startFailed", onStartFailed);
    record.disposeLifecycle = () => {
      dap.off("stopped", onStopped);
      dap.off("terminated", onTerminated);
      dap.off("exited", onExited);
      dap.off("adapterError", onAdapterError);
      dap.off("transportExit", onTransportExit);
      dap.off("startFailed", onStartFailed);
    };
    this.sessions.add(record);
    try {
      dap.startClient();
    } catch (error) {
      this.#discardFailedSession(record);
      throw error;
    }
    return record;
  }

  #discardFailedSession(session: DebugSessionRecord): void {
    if (this.sessions.maybeGet(session.sessionId) !== session) return;
    if (session.state === SessionState.TERMINATED) return;
    this.#clearDapTerminationTimer(session.sessionId);
    session.state = SessionState.FAILED;
    session.disposeLifecycle?.();
    session.disposeLifecycle = undefined;
    session.provider.disposeRuntimeEvents?.();
    session.dap?.disposeClient();
    this.breakpoints.clear(session.sessionId);
    this.sessions.remove(session.sessionId);
  }

  #markDapSessionRunning(session: DebugSessionRecord): boolean {
    if (this.sessions.maybeGet(session.sessionId) !== session) return false;
    if (session.state === SessionState.TERMINATED || session.state === SessionState.FAILED) return false;
    session.state = SessionState.RUNNING;
    return true;
  }

  #sessionSummary(session: DebugSessionRecord, diagnostic = false): SessionSummary {
    return {
      sessionId: session.sessionId,
      language: session.language,
      mode: session.mode,
      state: session.state,
      ...(session.ideSessionId ? { ideSessionId: session.ideSessionId } : {}),
      ...(diagnostic
        ? {
            providerKind: session.providerKind,
            capabilities: session.provider.capabilities
          }
        : {})
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
    this.#clearDapTerminationTimer(session.sessionId);
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
      this.#archiveRuntimeEvents(session);
      session.disposeLifecycle?.();
      session.disposeLifecycle = undefined;
      session.provider.disposeRuntimeEvents?.();
      session.dap?.disposeClient();
      this.breakpoints.clear(session.sessionId);
      this.sessions.remove(session.sessionId);
      return result;
    } finally {
      this.cleaningSessions.delete(session.sessionId);
    }
  }

  #runtimeEventsFor(sessionId: string): RuntimeEventBuffer {
    const session = this.sessions.get(sessionId);
    if (!session.runtimeEvents) {
      session.runtimeEvents = new RuntimeEventBuffer(sessionId, this.policy.runtime.maxEventBuffer);
    }
    return session.runtimeEvents;
  }

  #dapExitedMetadata(body: AnyRecord): AnyRecord {
    const metadata: AnyRecord = { reason: "dapExited" };
    const descriptor = Object.getOwnPropertyDescriptor(body, "exitCode");
    if (descriptor && "value" in descriptor && typeof descriptor.value === "number" && Number.isFinite(descriptor.value)) {
      metadata.exitCode = descriptor.value;
    }
    return metadata;
  }

  #scheduleDapTerminationCleanup(session: DebugSessionRecord): void {
    this.#clearDapTerminationTimer(session.sessionId);
    const timer = setTimeout(() => {
      this.#dapTerminationTimers.delete(session.sessionId);
      void this.#cleanupSession(session, { reason: "dap_exited", disconnectProvider: false });
    }, DAP_TERMINATION_GRACE_MS);
    timer.unref?.();
    this.#dapTerminationTimers.set(session.sessionId, timer);
  }

  #clearDapTerminationTimer(sessionId: string): void {
    const timer = this.#dapTerminationTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.#dapTerminationTimers.delete(sessionId);
  }

  #archiveRuntimeEvents(session: DebugSessionRecord): void {
    if (session.providerKind !== "dap") return;
    const events = session.runtimeEvents;
    if (!events || events.read({ cursor: 0, limit: 1 }).items.length === 0) return;
    this.#archivedRuntimeEvents.delete(session.sessionId);
    this.#archivedRuntimeEvents.set(session.sessionId, { events });
    while (this.#archivedRuntimeEvents.size > MAX_ARCHIVED_RUNTIME_SESSIONS) {
      const oldestSessionId = this.#archivedRuntimeEvents.keys().next().value as string | undefined;
      if (!oldestSessionId) break;
      this.#archivedRuntimeEvents.delete(oldestSessionId);
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
    this.ideBridge.on("disconnect", ({ clientId }: { clientId?: string }) => {
      if (clientId) this.breakpoints.clearProjectForClient(clientId);
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

  #selectProjectIdeTarget(args: DebugToolArgs, workspaceRoot: string): ProjectIdeTarget {
    if (!this.ideBridge) {
      throw new BreakPilotError(ErrorCodes.IDE_NOT_CONNECTED, "IDE bridge is not available.");
    }
    const ide = this.#normalizedIde(args.ide);
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    const clients = this.ideBridge.registry.list().filter((client) => {
      if (args.clientId && client.clientId !== args.clientId) return false;
      if (ide && client.ide !== ide) return false;
      if (!client.workspaceRoot) return false;
      if (path.resolve(client.workspaceRoot) !== resolvedWorkspaceRoot) return false;
      return true;
    });
    if (clients.length === 0) {
      throw new BreakPilotError(ErrorCodes.IDE_NOT_CONNECTED, "No matching IDE client is connected for this project.", {
        workspaceRoot: resolvedWorkspaceRoot,
        clientId: args.clientId,
        ide
      });
    }

    const clientIds = new Set(clients.map((client) => client.clientId));
    const liveSessions = this.ideBridge.registry
      .listSessions({ workspaceRoot: resolvedWorkspaceRoot })
      .filter((session) => {
        if (!clientIds.has(session.clientId)) return false;
        if (session.state === SessionState.TERMINATED || session.state === SessionState.FAILED) return false;
        return true;
      });
    const activeSessions = liveSessions.filter((session) => session.active === true);
    if (activeSessions.length === 1) {
      const activeSession = activeSessions[0]!;
      const client = clients.find((candidate) => candidate.clientId === activeSession.clientId);
      if (client) return { workspaceRoot: resolvedWorkspaceRoot, client, session: activeSession };
    }

    if (clients.length === 1) {
      const client = clients[0]!;
      return {
        workspaceRoot: resolvedWorkspaceRoot,
        client,
        session: this.#selectProjectSessionForClient(liveSessions, client.clientId)
      };
    }

    throw new BreakPilotError(
      ErrorCodes.PROJECT_AMBIGUOUS,
      "Multiple IDE clients match. Pass ide or clientId to choose one.",
      {
        workspaceRoot: resolvedWorkspaceRoot,
        clientId: args.clientId,
        ide,
        clients: clients.map((client) => ({
          clientId: client.clientId,
          ide: client.ide,
          workspaceRoot: client.workspaceRoot
        })),
        activeSessions: activeSessions.map((session) => ({
          clientId: session.clientId,
          ideSessionId: session.ideSessionId,
          workspaceRoot: session.workspaceRoot,
          state: session.state,
          active: session.active
        }))
      }
    );
  }

  #selectProjectSessionForClient(
    sessions: IdeDebugSessionInfo[],
    clientId: string
  ): IdeDebugSessionInfo | undefined {
    return (
      sessions.find((session) => session.clientId === clientId && session.active === true) ??
      sessions.find((session) => session.clientId === clientId)
    );
  }

  #normalizedIde(ide: unknown): string | undefined {
    if (ide === undefined || ide === null || ide === "") return undefined;
    const normalized = String(ide).toLowerCase();
    if (normalized !== "vscode" && normalized !== "idea") {
      throw new BreakPilotError(ErrorCodes.INVALID_ARGUMENT, "ide must be either 'vscode' or 'idea'.", { ide });
    }
    return normalized;
  }

  #bridgeMessageError(message: BridgeMessage): boolean {
    return Boolean(message.error && Object.keys(message.error).length > 0);
  }

  #sendIdeClientRequest(
    clientId: string,
    message: Partial<BridgeMessage>,
    responseTypes: string[],
    matches: (message: BridgeMessage) => boolean,
    timeoutMs = 5000
  ): Promise<BridgeMessage> {
    if (!this.ideBridge) {
      return Promise.reject(new BreakPilotError(ErrorCodes.IDE_NOT_CONNECTED, "IDE bridge is not available."));
    }
    const bridge = this.ideBridge;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const listener = ({ clientId: eventClientId, message: response }: { clientId?: string; message: BridgeMessage }): void => {
        const responseClientId = eventClientId ?? response.clientId;
        if (responseClientId !== clientId) return;
        if (!matches(response)) return;
        cleanup();
        resolve(response);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        for (const type of responseTypes) bridge.off(type, listener);
      };
      for (const type of responseTypes) bridge.on(type, listener);
      timer = setTimeout(() => {
        cleanup();
        reject(new BreakPilotError(ErrorCodes.BREAKPOINT_TIMEOUT, "Timed out waiting for IDE breakpoint acknowledgement.", {
          clientId,
          requestId: message.requestId,
          timeoutMs
        }));
      }, timeoutMs);
      const sent = bridge.sendToClient(clientId, message);
      if (!sent) {
        cleanup();
        reject(new BreakPilotError(ErrorCodes.IDE_BRIDGE_DISCONNECTED, "IDE client is not connected.", {
          clientId,
          requestId: message.requestId
        }));
      }
    });
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
    const adopted = await this.#adoptIdeSession({
      ...args,
      clientId: ideSession.clientId,
      ideSessionId: ideSession.ideSessionId
    });
    return adopted.session;
  }

  #safeArgs(args: DebugToolArgs): AnyRecord {
    const clone: AnyRecord = { ...args };
    if (clone.env) clone.env = "[redacted env]";
    return clone;
  }
}
