import fs from "node:fs";
import path from "node:path";
import { DapClient } from "../dap/DapClient.ts";
import {
  DapProcessTransport,
  DapServerProcessTransport,
  DapSocketTransport
} from "../dap/DapTransport.ts";
import type { DapTransport } from "../types/dap.ts";
import type { DebugLanguage } from "../types/debug.ts";
import type { AnyRecord } from "../types/json.ts";
import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";
import type {
  Adapter_Contract,
  AdapterContext,
  AdapterMetadata,
  AdapterState,
  AttachClassification,
  Dependency,
  ValidationResult
} from "./types.ts";

interface LanguageAdapterOptions {
  language: DebugLanguage;
  adapterId: string;
  defaultCommand?: string;
  defaultArgs?: string[];
  envCommandName: string;
  /** Human-readable name; defaults to the language identifier. */
  displayName?: string;
  /** Source file extensions handled by this adapter (e.g. `[".py"]`). */
  fileExtensions?: string[];
  /** Optional toolchain/adapter version string. */
  version?: string;
  /** Whether this language supports attach-mode debugging (default true). */
  supportsAttach?: boolean;
}

/**
 * Default implementation of the {@link Adapter_Contract}. Python, Node, and Java
 * adapters extend this base. It keeps the original command/args/normalize
 * ergonomics while exposing the full pluggable contract: metadata, a lifecycle
 * state machine, idempotent disposal, environment validation, transport
 * selection, attach classification, and capability queries.
 */
export class LanguageAdapter implements Adapter_Contract {
  language: DebugLanguage;
  adapterId: string;
  defaultCommand?: string;
  defaultArgs: string[];
  envCommandName: string;

  readonly metadata: AdapterMetadata;
  #state: AdapterState = "uninitialized";

  constructor({
    language,
    adapterId,
    defaultCommand,
    defaultArgs = [],
    envCommandName,
    displayName,
    fileExtensions = [],
    version,
    supportsAttach = true
  }: LanguageAdapterOptions) {
    this.language = language;
    this.adapterId = adapterId;
    this.defaultCommand = defaultCommand;
    this.defaultArgs = defaultArgs;
    this.envCommandName = envCommandName;
    this.metadata = {
      language,
      displayName: displayName ?? language,
      version,
      fileExtensions,
      supportsAttach
    };
  }

  // --- Lifecycle (Requirement 1.3, 1.2, 1.9) ---------------------------------

  /** Current adapter lifecycle state. */
  get state(): AdapterState {
    return this.#state;
  }

  /**
   * No-op base initialization: Python/Node hold no extra resources, so this
   * simply transitions the adapter to `ready`. Subclasses that acquire
   * resources override this and roll back to `uninitialized` on failure.
   */
  async initialize(_ctx: AdapterContext): Promise<void> {
    if (this.#state === "disposed") {
      throw new BreakPilotError(
        ErrorCodes.ADAPTER_START_FAILED,
        `Cannot initialize a disposed ${this.language} adapter.`,
        { language: this.language }
      );
    }
    this.#state = "initializing";
    this.#state = "ready";
  }

  /** Idempotent disposal: a second call is a no-op (Requirement 1.2). */
  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
  }

  // --- Environment validation and dependencies (Requirement 3.1, 3.2) -------

  /**
   * Best-effort environment validation. The base check resolves the effective
   * adapter command and confirms it exists on `PATH` or as an absolute/relative
   * file. A missing or unresolved command is reported as unavailable, but as a
   * warning rather than a hard error, preserving today's lazy-at-spawn behavior.
   */
  async validateEnvironment(): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const { command, warnings: overrideWarnings } = this.resolveAdapterCommand();
    warnings.push(...overrideWarnings);

    if (!command) {
      warnings.push(
        `No debug adapter command configured for ${this.language}; it will be validated when a session starts.`
      );
      return { available: false, errors, warnings };
    }

    const resolved = this.#findExecutable(command);
    if (!resolved) {
      warnings.push(
        `Debug adapter command "${command}" for ${this.language} could not be resolved on PATH; it will be validated when a session starts.`
      );
      return { available: false, errors, warnings };
    }

    return { available: true, errors, warnings };
  }

  /** Declared external dependencies for this adapter (Requirement 3.2). */
  getRequiredDependencies(): Dependency[] {
    if (this.defaultCommand) {
      return [{ name: this.defaultCommand }];
    }
    return [];
  }

  /**
   * Resolve the adapter executable to an absolute path. Throws
   * `ADAPTER_START_FAILED` rather than returning an empty/unresolved path
   * (Requirement 1.8).
   */
  async resolveExecutablePath(ctx: AdapterContext): Promise<string> {
    const args = this.#contextArgs(ctx);
    const { command } = this.resolveAdapterCommand(args);
    if (!command) {
      throw new BreakPilotError(
        ErrorCodes.ADAPTER_START_FAILED,
        `No debug adapter command configured for ${this.language}.`,
        { language: this.language, envCommandName: this.envCommandName }
      );
    }
    const resolved = this.#findExecutable(command, args.workspaceRoot as string | undefined);
    if (!resolved) {
      throw new BreakPilotError(
        ErrorCodes.ADAPTER_START_FAILED,
        `Could not resolve the ${this.language} debug adapter executable "${command}".`,
        { language: this.language, command }
      );
    }
    return resolved;
  }

  // --- Transport selection (Requirement 1.6, 4.1) ---------------------------

  /**
   * Build a DAP client for the session. Retained as a synchronous, behavior
   * preserving entry point: it wraps the transport produced by
   * {@link buildTransport} in a {@link DapClient}.
   */
  createClient(args: AnyRecord = {}): DapClient {
    return new DapClient(this.buildTransport(args));
  }

  /**
   * Contract transport factory (async). Transport selection lives here; the
   * core never chooses the transport. Defers to the synchronous
   * {@link buildTransport} helper so `createClient` stays behavior-preserving.
   */
  async createTransport(ctx: AdapterContext): Promise<DapTransport> {
    return this.buildTransport(this.#contextArgs(ctx));
  }

  /**
   * Synchronous transport-selection helper shared by `createClient` and
   * `createTransport`: a direct DAP socket when `dapHost`/`dapPort` are present,
   * otherwise a stdio `DapProcessTransport`.
   */
  protected buildTransport(args: AnyRecord = {}): DapTransport {
    if (args.dapHost && args.dapPort) {
      return new DapSocketTransport(String(args.dapHost), Number(args.dapPort));
    }
    const { command, warnings } = this.resolveAdapterCommand(args);
    for (const warning of warnings) console.warn(warning);
    const adapterArgs =
      Array.isArray(args.adapterArgs) && args.adapterArgs.length > 0
        ? args.adapterArgs
        : this.defaultArgs;
    if (!command) {
      throw new BreakPilotError(
        ErrorCodes.ADAPTER_START_FAILED,
        `No debug adapter command configured for ${this.language}.`,
        { language: this.language, envCommandName: this.envCommandName }
      );
    }
    return new DapProcessTransport(command, adapterArgs, {
      cwd: args.workspaceRoot,
      env: args.env
    });
  }

  // --- Attach classification and capabilities (Requirement 1.4, 1.5, 4.x) ---

  /**
   * Default attach classification: connect directly to the supplied host/port
   * as a DAP socket. Adapters whose attach target is not a DAP endpoint (e.g.
   * Java's JDWP endpoint) override this.
   */
  classifyAttachTarget(_host: string | undefined, _port: number): AttachClassification {
    return { kind: "dap-socket" };
  }

  /** Whether this language supports attach mode (Requirement 1.4). */
  supportsAttach(): boolean {
    return this.metadata.supportsAttach;
  }

  /**
   * Total feature query: returns true for a recognized, supported feature and
   * false for an unsupported or unrecognized name (Requirement 1.5).
   */
  supportsFeature(name: string): boolean {
    return this.supportedFeatures().has(name);
  }

  /** The set of feature names this adapter supports. */
  protected supportedFeatures(): Set<string> {
    const features = new Set<string>([
      "launch",
      "breakpoints",
      "conditionalBreakpoints",
      "evaluate",
      "stepping",
      "stackTrace",
      "scopes",
      "variables",
      "disconnect"
    ]);
    if (this.supportsAttach()) features.add("attach");
    return features;
  }

  // --- Config transforms ----------------------------------------------------

  normalizeLaunchArgs(args: AnyRecord = {}): AnyRecord {
    return args.dap || args;
  }

  normalizeAttachArgs(args: AnyRecord = {}): AnyRecord {
    return args.dap || args;
  }

  // --- Internal helpers -----------------------------------------------------

  /**
   * Centralized env-override resolution (Requirement 10.3, 10.4). Precedence:
   * explicit `args.adapterCommand` → non-empty `process.env[envCommandName]`
   * override → `defaultCommand`. An empty/whitespace-only override is ignored
   * and produces a warning.
   */
  protected resolveAdapterCommand(args: AnyRecord = {}): {
    command?: string;
    warnings: string[];
  } {
    const warnings: string[] = [];
    if (args.adapterCommand) {
      return { command: String(args.adapterCommand), warnings };
    }
    const override = process.env[this.envCommandName];
    if (override !== undefined) {
      if (override.trim().length > 0) {
        return { command: override, warnings };
      }
      warnings.push(
        `Ignoring empty ${this.envCommandName} override for ${this.language}; falling back to the default command.`
      );
    }
    return { command: this.defaultCommand, warnings };
  }

  /** Merge an {@link AdapterContext} into the flat args shape used internally. */
  #contextArgs(ctx: AdapterContext): AnyRecord {
    const baseArgs = (ctx.args ?? {}) as AnyRecord;
    return {
      ...baseArgs,
      workspaceRoot: baseArgs.workspaceRoot ?? ctx.workspaceRoot,
      env: baseArgs.env ?? ctx.env
    };
  }

  /**
   * Resolve a command to an absolute executable path: returns the path when the
   * command is an absolute/relative file that exists, or when it is found on
   * `PATH`; otherwise returns undefined.
   */
  #findExecutable(command: string, cwd?: string): string | undefined {
    if (command.includes(path.sep) || command.includes("/")) {
      const candidate = path.isAbsolute(command)
        ? command
        : path.resolve(cwd ?? process.cwd(), command);
      return this.#isFile(candidate) ? candidate : undefined;
    }
    const pathEnv = process.env.PATH ?? "";
    for (const dir of pathEnv.split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, command);
      if (this.#isFile(candidate)) return candidate;
    }
    return undefined;
  }

  #isFile(candidate: string): boolean {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }
}

let nextPythonAdapterPort = 27892;

export class PythonAdapter extends LanguageAdapter {
  constructor() {
    super({
      language: "python",
      adapterId: "python",
      defaultCommand: fs.existsSync(".venv/bin/python") ? ".venv/bin/python" : "python3",
      defaultArgs: ["-m", "debugpy.adapter"],
      envCommandName: "BREAKPILOT_PYTHON_ADAPTER",
      displayName: "Python",
      fileExtensions: [".py"]
    });
  }

  /**
   * Python transport selection (moved verbatim out of the former `createClient`
   * override). The inherited `createClient` and `createTransport` both delegate
   * here, so all three entry points stay behavior-identical to the pre-feature
   * baseline (Requirement 10.1):
   *
   * 1. `dapHost`/`dapPort` present → connect to an already-running DAP socket.
   * 2. The attach short-circuit (attach mode + host + port and no command/port/
   *    args/env override) → connect directly to the `debugpy` socket.
   * 3. Otherwise → spawn `debugpy.adapter` in server mode via
   *    `DapServerProcessTransport`, allocating a loopback port when none was
   *    supplied (`nextPythonAdapterPort`).
   */
  protected override buildTransport(args: AnyRecord = {}): DapTransport {
    if (args.dapHost && args.dapPort) {
      return new DapSocketTransport(args.dapHost, Number(args.dapPort));
    }
    if (
      args.attachMode &&
      args.host &&
      args.port &&
      !args.adapterCommand &&
      !args.adapterPort &&
      !args.adapterArgs &&
      !process.env[this.envCommandName]
    ) {
      return new DapSocketTransport(String(args.host), Number(args.port));
    }
    const command =
      args.adapterCommand ||
      process.env[this.envCommandName] ||
      this.defaultCommand;
    if (!command) {
      throw new BreakPilotError(
        ErrorCodes.ADAPTER_START_FAILED,
        "No Python debug adapter command configured.",
        { envCommandName: this.envCommandName }
      );
    }
    const host = String(args.adapterHost ?? "127.0.0.1");
    const port = Number(args.adapterPort ?? nextPythonAdapterPort++);
    const baseAdapterArgs =
      Array.isArray(args.adapterArgs) && args.adapterArgs.length > 0
        ? args.adapterArgs
        : this.defaultArgs;
    const adapterArgs = [
      ...baseAdapterArgs,
      "--host",
      host,
      "--port",
      String(port)
    ];
    return new DapServerProcessTransport(command, adapterArgs, {
      host,
      port,
      cwd: args.workspaceRoot,
      env: args.env
    });
  }

  /**
   * Preserve the direct-`debugpy`-socket attach behavior at the classification
   * level (Requirement 4.2): only when the short-circuit conditions checkable
   * from the attach target hold (host + port present and no env command
   * override) does the core open a direct DAP socket. Otherwise the attach is
   * delegated to the `debugpy.adapter` server transport, which feeds the
   * host/port through `normalizeAttachArgs` exactly as the pre-feature path did.
   */
  override classifyAttachTarget(
    host: string | undefined,
    port: number
  ): AttachClassification {
    if (host && port && !process.env[this.envCommandName]) {
      return { kind: "dap-socket" };
    }
    return { kind: "delegated" };
  }

  override normalizeLaunchArgs(args: AnyRecord = {}): AnyRecord {
    if (args.dap) return args.dap;
    return {
      program: args.program,
      module: args.module,
      args: args.args ?? [],
      cwd: args.cwd ?? args.workspaceRoot,
      env: args.env,
      justMyCode: args.justMyCode ?? true,
      stopOnEntry: args.stopOnEntry ?? false
    };
  }

  override normalizeAttachArgs(args: AnyRecord = {}): AnyRecord {
    if (args.dap) return args.dap;
    return {
      connect: {
        host: args.host ?? "127.0.0.1",
        port: Number(args.port ?? 5678)
      },
      justMyCode: args.justMyCode ?? true
    };
  }
}

export class NodeAdapter extends LanguageAdapter {
  constructor(language: DebugLanguage = "node") {
    const isTypeScript = language === "typescript";
    super({
      language,
      adapterId: "pwa-node",
      defaultCommand: process.env.BREAKPILOT_JS_DEBUG_COMMAND,
      defaultArgs: process.env.BREAKPILOT_JS_DEBUG_ARGS
        ? process.env.BREAKPILOT_JS_DEBUG_ARGS.split(" ")
        : [],
      envCommandName: "BREAKPILOT_JS_DEBUG_COMMAND",
      displayName: isTypeScript ? "TypeScript" : "Node.js",
      // Disjoint extension sets per design: .ts → typescript only,
      // .js/.cjs/.mjs → node only.
      fileExtensions: isTypeScript ? [".ts"] : [".js", ".cjs", ".mjs"]
    });
  }

  override normalizeLaunchArgs(args: AnyRecord = {}): AnyRecord {
    if (args.dap) return args.dap;
    return {
      type: "pwa-node",
      request: "launch",
      name: args.name ?? "BreakPilot Node Launch",
      program: args.program,
      args: args.args ?? [],
      cwd: args.cwd ?? args.workspaceRoot,
      env: args.env,
      stopOnEntry: args.stopOnEntry ?? false,
      sourceMaps: args.sourceMaps ?? true
    };
  }

  override normalizeAttachArgs(args: AnyRecord = {}): AnyRecord {
    if (args.dap) return args.dap;
    return {
      type: "pwa-node",
      request: "attach",
      name: args.name ?? "BreakPilot Node Attach",
      address: args.host ?? "127.0.0.1",
      port: Number(args.port ?? 9229),
      cwd: args.cwd ?? args.workspaceRoot,
      sourceMaps: args.sourceMaps ?? true
    };
  }
}
