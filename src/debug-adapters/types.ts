/**
 * Adapter_Contract type definitions for BreakPilot's pluggable language-adapter
 * architecture.
 *
 * This module is the single source of truth for the contract every language
 * adapter implements. It is intentionally self-contained and exhaustively
 * documented so that a maintainer can implement a brand-new {@link Adapter_Contract}
 * using only this file, without reading the BreakPilot core source
 * (Requirement 12.4).
 *
 * Design references: see `.kiro/specs/pluggable-debug-adapters/design.md`,
 * sections "Adapter_Contract" and "Data Models".
 *
 * Conventions used throughout:
 * - "throws" means the operation rejects (for async) or throws synchronously
 *   with a `BreakPilotError` carrying one of the codes in `src/utils/errors.ts`.
 * - "returns" describes the resolved value of the Promise for async operations.
 * - All host/port values follow DAP/JDWP conventions: ports are integers and a
 *   valid network port is in the range 1–65535.
 */

import type { DapTransport } from "../types/dap.ts";
import type { AnyRecord } from "../types/json.ts";

/**
 * Lifecycle state of a {@link Adapter_Contract} instance (Requirement 1.3).
 *
 * State transitions:
 * - `uninitialized` → `initializing` → `ready` via {@link Adapter_Contract.initialize}.
 * - any state → `disposed` via {@link Adapter_Contract.dispose}.
 * - If {@link Adapter_Contract.initialize} fails, the adapter MUST roll back to
 *   `uninitialized` after releasing any acquired resources (Requirement 1.9).
 */
export type AdapterState = "uninitialized" | "initializing" | "ready" | "disposed";

/**
 * Static, declarative description of a language adapter.
 *
 * Pure data — reading these fields never performs I/O and never throws.
 */
export interface AdapterMetadata {
  /**
   * Canonical language identifier in its original case (e.g. `"java"`,
   * `"python"`). The {@link Adapter_Contract} registry compares identifiers
   * case-insensitively but preserves this original casing for display and
   * round-tripping.
   */
  language: string;
  /** Human-readable name shown to the Agent, e.g. `"Java"`. */
  displayName: string;
  /** Optional adapter/toolchain version string, when known. */
  version?: string;
  /**
   * Source file extensions this adapter handles, each including the leading dot
   * (e.g. `[".java"]`, `[".py"]`, `[".ts"]`). Used to build the
   * File_Extension_Map for language inference.
   */
  fileExtensions: string[];
  /** Whether this language supports attach-mode debugging (Requirement 1.4). */
  supportsAttach: boolean;
}

/**
 * A single external dependency the adapter requires to debug a target
 * (Requirement 3.2). Returned by {@link Adapter_Contract.getRequiredDependencies}.
 */
export interface Dependency {
  /** Dependency identifier, e.g. `"javac (JDK 21+)"` or `"java (JRE)"`. */
  name: string;
  /** Optional human-readable description of why the dependency is needed. */
  description?: string;
}

/**
 * Result of {@link Adapter_Contract.validateEnvironment} (Requirement 3.1).
 *
 * - `available` is `true` only when EVERY required dependency resolved.
 * - On a validation timeout (>10s) the adapter returns `available: false` with
 *   a timeout error in `errors` (Requirement 3.6).
 */
export interface ValidationResult {
  /** True only if every required dependency resolved successfully. */
  available: boolean;
  /** Zero or more errors describing missing/invalid toolchain or a timeout. */
  errors: string[];
  /** Zero or more non-fatal warnings (e.g. an ignored env override). */
  warnings: string[];
}

/**
 * Classification of an attach target, returned by
 * {@link Adapter_Contract.classifyAttachTarget} (Requirements 4.2, 4.4, 4.8).
 *
 * The Debug_Session_Manager uses this to decide how (or whether) to connect:
 * - `dap-socket`: the core opens a direct DAP socket to the supplied host/port.
 * - `delegated`:  the adapter routes the host/port into its own transport
 *                 (e.g. a JDWP endpoint passed to the JDI bridge); the core MUST
 *                 NOT dial the host/port directly.
 * - `unknown`:    the endpoint type could not be determined; the attach is
 *                 rejected without opening any connection.
 */
export type AttachClassification =
  | { kind: "dap-socket" }
  | { kind: "delegated" }
  | { kind: "unknown" };

/**
 * Inputs passed to lifecycle and transport operations on the contract.
 *
 * `args` carries the raw, untransformed tool arguments (e.g. `program`, `host`,
 * `port`, `adapterCommand`, ...) so the adapter can derive its own configuration.
 */
export interface AdapterContext {
  /** Absolute path to the configured workspace root. */
  workspaceRoot: string;
  /** Optional environment to use for spawned processes / resolution. */
  env?: Record<string, string | undefined>;
  /** Raw tool arguments for the request being served. */
  args: AnyRecord;
}

/**
 * The stable interface every language adapter implements (Requirement 1.1).
 *
 * Implementations encapsulate ALL language-specific behavior so the BreakPilot
 * core never branches on language. Operation-by-operation contract:
 *
 * - `metadata` / `adapterId` / `state`: pure reads, never throw.
 * - `initialize(ctx)`: acquire resources (e.g. compile a bridge). On failure it
 *   MUST release whatever it acquired, reject with an initialization error, and
 *   leave `state === "uninitialized"` (Requirement 1.9).
 * - `dispose()`: idempotent; releases all held resources; a second call is a
 *   no-op (Requirement 1.2).
 * - `validateEnvironment()`: resolves within 10s to a {@link ValidationResult};
 *   `available` is true only when every dependency resolves; on timeout returns
 *   `available: false` plus a timeout error (Requirements 3.1, 3.6).
 * - `getRequiredDependencies()`: pure read of declared dependencies
 *   (Requirement 3.2).
 * - `resolveExecutablePath(ctx)`: resolves to an ABSOLUTE path; on failure it
 *   throws `ADAPTER_START_FAILED` rather than returning an empty/unresolved path
 *   (Requirement 1.8).
 * - `createTransport(ctx)`: resolves to a {@link DapTransport} ready to
 *   `start()`. Transport choice (direct socket / server-process / stdio) lives
 *   here, never in the core (Requirements 1.6, 4.1).
 * - `classifyAttachTarget(host, port)`: returns an {@link AttachClassification}.
 *   `unknown` causes the attach to be rejected without connecting; invalid
 *   parameters throw an error identifying the bad parameter (Requirements 4.2,
 *   4.4, 4.8).
 * - `supportsAttach()`: boolean attach-mode support (Requirement 1.4).
 * - `supportsFeature(name)`: total function — true when supported, false when
 *   unsupported OR unrecognized (Requirement 1.5).
 * - `normalizeLaunchArgs` / `normalizeAttachArgs`: transform raw tool args into
 *   the adapter-specific DAP configuration object (Requirement 1.1).
 */
export interface Adapter_Contract {
  /** Static metadata describing this adapter. Pure read, never throws. */
  readonly metadata: AdapterMetadata;
  /**
   * Stable adapter implementation identifier (DAP `type`-style id, e.g.
   * `"pwa-node"`). Distinct from `metadata.language`.
   */
  readonly adapterId: string;
  /** Current lifecycle state (Requirement 1.3). Pure read, never throws. */
  readonly state: AdapterState;

  /**
   * Acquire resources needed to debug. On failure: release everything acquired,
   * reject with an initialization error, and remain `uninitialized`
   * (Requirement 1.9).
   */
  initialize(ctx: AdapterContext): Promise<void>;
  /** Idempotent resource release; calling twice is a no-op (Requirement 1.2). */
  dispose(): Promise<void>;

  /**
   * Validate the local environment within 10s (Requirements 3.1, 3.6).
   * Resolves to a {@link ValidationResult}; never rejects for an ordinary
   * "dependency missing" outcome (that is reported via `available`/`errors`).
   */
  validateEnvironment(): Promise<ValidationResult>;
  /** Declared external dependencies, possibly empty (Requirement 3.2). */
  getRequiredDependencies(): Dependency[];
  /**
   * Resolve the adapter executable to an absolute path. Throws
   * `ADAPTER_START_FAILED` on failure rather than returning an empty/unresolved
   * path (Requirement 1.8).
   */
  resolveExecutablePath(ctx: AdapterContext): Promise<string>;

  /**
   * Build a {@link DapTransport} ready to `start()`. All transport selection
   * lives here (Requirements 1.6, 4.1).
   */
  createTransport(ctx: AdapterContext): Promise<DapTransport>;
  /**
   * Classify an attach target (Requirements 4.2, 4.4, 4.8). `host` may be
   * undefined; `port` is the target port. Returns how the core should connect,
   * or throws when a supplied parameter is invalid.
   */
  classifyAttachTarget(host: string | undefined, port: number): AttachClassification;
  /** Whether this language supports attach mode (Requirement 1.4). */
  supportsAttach(): boolean;
  /**
   * Total feature query: true when `name` is supported, false when unsupported
   * or unrecognized (Requirement 1.5). Never throws.
   */
  supportsFeature(name: string): boolean;

  /** Transform raw launch args into the adapter's DAP launch config. */
  normalizeLaunchArgs(args: AnyRecord): AnyRecord;
  /** Transform raw attach args into the adapter's DAP attach config. */
  normalizeAttachArgs(args: AnyRecord): AnyRecord;
}

/**
 * Optional factory enabling lazy adapter construction (Requirement 2.7).
 *
 * The Adapter_Registry can store a factory and obtain the adapter instance plus
 * metadata on first resolution, deferring expensive construction.
 */
export interface AdapterFactory {
  /** Metadata available without constructing the adapter. */
  metadata: AdapterMetadata;
  /** Construct the adapter instance on demand. */
  create(): Adapter_Contract;
}
