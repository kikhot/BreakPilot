import net from "node:net";
import path from "node:path";
import { DapServerProcessTransport } from "../../dap/DapTransport.ts";
import type { DapTransport } from "../../types/dap.ts";
import type { AnyRecord } from "../../types/json.ts";
import { BreakPilotError, ErrorCodes } from "../../utils/errors.ts";
import { LanguageAdapter } from "../LanguageAdapter.ts";
import type {
  AdapterContext,
  AttachClassification,
  Dependency,
  ValidationResult
} from "../types.ts";
import { BridgeCompiler } from "./BridgeCompiler.ts";
import {
  BridgeResolver,
  resolveBridgeOutputDir,
  resolveBridgeSource,
  resolveJdk
} from "./BridgeResolver.ts";

/** Highest valid network port (JDWP/DAP). */
const MAX_PORT = 65535;
/** Lowest non-privileged loopback port the launch transport may bind. */
const MIN_LOOPBACK_PORT = 1024;
/** Loopback host the bridge's DAP server listens on. */
const LOOPBACK_HOST = "127.0.0.1";

/**
 * Java language adapter.
 *
 * Java does not ship a stock DAP server. Instead this adapter resolves a local
 * JDK, compiles the vendored `JdiDapServer.java` JDI-to-DAP bridge on demand,
 * and drives it over loopback TCP using BreakPilot's existing
 * {@link DapServerProcessTransport} — the same shape `PythonAdapter` uses to
 * drive `debugpy` in server mode (Requirement 12.3, no new core transport).
 *
 * It extends {@link LanguageAdapter} to reuse the lifecycle state machine,
 * idempotent disposal, `supportsAttach`/`supportsFeature`, and override only the
 * Java-specific behavior: dependency declaration, JDK-based environment
 * validation, bridge compilation during `initialize`, the server-process
 * transport, JDWP attach-target classification, and the Java launch/attach
 * config transforms.
 *
 * Design reference: `.kiro/specs/pluggable-debug-adapters/design.md`,
 * section "Java adapter" → "JavaAdapter".
 */
export class JavaAdapter extends LanguageAdapter {
  /** Absolute path to the resolved `javac` (set during {@link initialize}). */
  #javacExe?: string;
  /** Absolute path to the resolved `java` (set during {@link initialize}). */
  #javaExe?: string;
  /** Directory holding the compiled bridge classes (set during init). */
  #outDir?: string;
  /** Compiler used to compile the vendored bridge source on demand. */
  #compiler = new BridgeCompiler();

  constructor() {
    super({
      language: "java",
      adapterId: "java",
      envCommandName: "BREAKPILOT_JAVA_ADAPTER_COMMAND",
      displayName: "Java",
      fileExtensions: [".java"],
      supportsAttach: true
    });
  }

  // --- Dependencies and environment validation (Requirements 3.1, 3.2) ------

  /** The Java adapter needs a JDK to compile the bridge and a JRE to run it. */
  override getRequiredDependencies(): Dependency[] {
    return [
      { name: "javac (JDK 21+)", description: "Compiles the vendored JDI-to-DAP bridge." },
      { name: "java (JRE)", description: "Runs the compiled JDI-to-DAP bridge." }
    ];
  }

  /**
   * Validate that a JDK toolchain is locatable. Resolution is synchronous and
   * fast (filesystem existence checks only), so it always completes well within
   * the 10s budget (Requirement 3.6). A missing JDK is reported as unavailable
   * with the resolver's message — it never rejects for an ordinary
   * "dependency missing" outcome.
   */
  override async validateEnvironment(): Promise<ValidationResult> {
    try {
      BridgeResolver.resolveJdk();
      return { available: true, errors: [], warnings: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { available: false, errors: [message], warnings: [] };
    }
  }

  // --- Lifecycle (Requirements 1.3, 1.9) ------------------------------------

  /**
   * Resolve the JDK and ensure the vendored bridge is compiled, caching the
   * resolved `javac`/`java` and output directory for {@link createTransport}.
   *
   * On any failure the partially-acquired state is cleared and the error is
   * rethrown, leaving the adapter `uninitialized` (Requirement 1.9). On success
   * the base state machine transitions the adapter to `ready`.
   */
  override async initialize(ctx: AdapterContext): Promise<void> {
    if (this.state === "disposed") {
      throw new BreakPilotError(
        ErrorCodes.ADAPTER_START_FAILED,
        "Cannot initialize a disposed java adapter.",
        { language: "java" }
      );
    }
    try {
      this.#prepareBridge(ctx);
      // Only mark ready once the bridge is compiled and paths are cached.
      await super.initialize(ctx);
    } catch (error) {
      // Release any partially-acquired state and stay uninitialized.
      this.#javacExe = undefined;
      this.#javaExe = undefined;
      this.#outDir = undefined;
      throw error;
    }
  }

  /**
   * Resolve the JDK and compile the bridge if stale, caching the resolved
   * executables and output directory. Synchronous; throws `ADAPTER_START_FAILED`
   * (via the resolver/compiler) on failure.
   */
  #prepareBridge(ctx?: AdapterContext): void {
    const { javac, java } = resolveJdk(ctx?.env);
    const outDir = this.#compiler.ensureCompiled({
      javac,
      sourceFile: resolveBridgeSource(ctx?.env),
      outDir: resolveBridgeOutputDir(ctx?.env)
    });
    this.#javacExe = javac;
    this.#javaExe = java;
    this.#outDir = outDir;
  }

  // --- Transport selection (Requirements 6.1, 7.1, 12.3) --------------------

  /**
   * Build the bridge transport: a {@link DapServerProcessTransport} that runs
   * `java -cp <outDir> JdiDapServer --port <tcpPort>` and speaks DAP over a
   * free loopback TCP port in the 1024–65535 range.
   *
   * If {@link initialize} has not run (or its cached state was released) the JDK
   * and bridge are resolved lazily here as a defensive fallback — normally
   * `#createSession` calls `initialize` first.
   */
  override async createTransport(ctx: AdapterContext): Promise<DapTransport> {
    if (!this.#outDir || !this.#javaExe) {
      this.#prepareBridge(ctx);
    }
    const outDir = this.#outDir as string;
    const javaExe = this.#javaExe ?? "java";
    const tcpPort = await this.#pickFreeLoopbackPort();
    return new DapServerProcessTransport(
      javaExe,
      ["-cp", outDir, "JdiDapServer", "--port", String(tcpPort)],
      {
        host: LOOPBACK_HOST,
        port: tcpPort,
        cwd: ctx.workspaceRoot,
        env: ctx.env
      }
    );
  }

  /**
   * Pick a free loopback TCP port in the 1024–65535 range by binding a server
   * to port 0 (OS-assigned), capturing the port, and closing the server. The
   * OS-assigned ephemeral range is always within bounds; the explicit guard
   * documents and enforces the contract.
   */
  #pickFreeLoopbackPort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, LOOPBACK_HOST, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close((closeErr) => {
          if (closeErr) {
            reject(closeErr);
            return;
          }
          if (port >= MIN_LOOPBACK_PORT && port <= MAX_PORT) {
            resolve(port);
          } else {
            reject(
              new BreakPilotError(
                ErrorCodes.ADAPTER_START_FAILED,
                `Could not allocate a loopback port in range ${MIN_LOOPBACK_PORT}-${MAX_PORT} (got ${port}).`,
                { language: "java", port }
              )
            );
          }
        });
      });
    });
  }

  // --- Attach classification (Requirements 4.2, 4.8, 7.2) -------------------

  /**
   * Classify a Java attach target. For Java the `host:port` is a JDWP
   * server-mode endpoint, not a DAP socket, so a valid target is always
   * `delegated`: the core feeds it into the bridge's DAP `attach` request and
   * never dials it directly (Requirement 4.2). Invalid parameters throw an
   * `INVALID_ARGUMENT` error identifying the offending parameter (Requirement
   * 7.2). `{ kind: "unknown" }` is reachable only if the endpoint type cannot be
   * determined, which for Java never happens once host/port validate
   * (Requirement 4.8).
   */
  override classifyAttachTarget(
    host: string | undefined,
    port: number
  ): AttachClassification {
    if (host === undefined || host.trim().length === 0) {
      throw new BreakPilotError(
        ErrorCodes.INVALID_ARGUMENT,
        "A non-empty host is required to attach to a Java JDWP endpoint.",
        { language: "java", parameter: "host", host }
      );
    }
    if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
      throw new BreakPilotError(
        ErrorCodes.INVALID_ARGUMENT,
        `Invalid port for Java attach: expected an integer in 1-${MAX_PORT}, got ${port}.`,
        { language: "java", parameter: "port", port }
      );
    }
    // A valid Java attach target is a JDWP endpoint: always delegated.
    return { kind: "delegated" };
  }

  // --- Config transforms (Requirements 6.x, 7.x) ----------------------------

  /**
   * Transform raw launch args into the bridge's DAP launch config. `mainClass`
   * is taken explicitly, else derived from `program` (a `.java` path → its base
   * name without extension; otherwise the value is treated as a fully-qualified
   * class name). A `dap` passthrough short-circuits, consistent with the other
   * adapters.
   */
  override normalizeLaunchArgs(args: AnyRecord = {}): AnyRecord {
    if (args.dap) return args.dap as AnyRecord;
    const config: AnyRecord = {
      request: "launch",
      mainClass: this.#deriveMainClass(args),
      classpath: args.classpath ?? ".",
      cwd: args.cwd ?? args.workspaceRoot,
      args: args.args ?? [],
      stopOnEntry: args.stopOnEntry ?? true
    };
    if (args.vmArgs) config.vmArgs = args.vmArgs;
    if (args.javaPath) config.javaPath = args.javaPath;
    return config;
  }

  /**
   * Transform raw attach args into the bridge's DAP attach config. `host:port`
   * is the JDWP server-mode endpoint passed straight into the bridge's attach
   * request. A `dap` passthrough short-circuits.
   */
  override normalizeAttachArgs(args: AnyRecord = {}): AnyRecord {
    if (args.dap) return args.dap as AnyRecord;
    const config: AnyRecord = {
      request: "attach",
      host: args.host ?? "localhost",
      port: Number(args.port)
    };
    if (args.sourcePaths) config.sourcePaths = args.sourcePaths;
    return config;
  }

  /** Derive the main class from explicit `mainClass` or a `program` value. */
  #deriveMainClass(args: AnyRecord): string {
    if (args.mainClass) return String(args.mainClass);
    const program = args.program ? String(args.program) : "";
    if (!program) return "";
    if (program.endsWith(".java")) {
      return path.basename(program, ".java");
    }
    // No `.java` extension: treat the value as a fully-qualified class name.
    return program;
  }
}
