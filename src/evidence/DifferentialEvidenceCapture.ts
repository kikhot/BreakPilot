import { spawn, execFile as execFileCallback, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { sha256File, sha256Text } from "./DifferentialEvidenceHash.ts";
import { extractSemanticArtifact, verifyEvidenceBundle } from "./DifferentialEvidenceReplay.ts";
import { SANITIZER_ID, SANITIZER_VERSION, sanitizeTranscript } from "./DifferentialEvidenceSanitizer.ts";
import {
  EvidenceVerificationError,
  type CaptureConfig,
  type CaptureResult,
  type CapturedMcpCommand,
  type EvidenceManifestV1,
  type LineageFileV1,
  type TranscriptEntry,
  type TranscriptProvider
} from "./DifferentialEvidenceTypes.ts";

const execFile = promisify(execFileCallback);
const INFRASTRUCTURE_CODE = "EVIDENCE_INFRASTRUCTURE_UNAVAILABLE";

class StdioMcpClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #buffer = "";
  #nextId = 1;

  constructor(command: CapturedMcpCommand) {
    this.#child = spawn(command.command, command.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(command.env ?? {}) }
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#read(chunk));
    this.#child.on("error", (error) => this.#rejectAll(error));
    this.#child.on("exit", (code) => this.#rejectAll(new Error(`MCP process exited with code ${String(code)}.`)));
  }

  async initialize(): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "breakpilot-evidence", version: "1" }
    });
  }

  request(method: string, params: unknown, timeoutMs = 10000): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("MCP request timed out."));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
      try {
        this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timeout);
        reject(error as Error);
      }
    });
  }

  close(): void {
    this.#child.stdin.end();
    this.#child.kill();
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    while (this.#buffer.includes("\n")) {
      const index = this.#buffer.indexOf("\n");
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      const pending = this.#pending.get(Number(message.id));
      if (!pending) continue;
      this.#pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(String(message.error.message ?? "MCP request failed.")));
      else pending.resolve(message.result);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current = value;
  for (const part of pointer.replace(/^\//, "").split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || !(key in current)) throw new Error("Template pointer does not resolve.");
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function resolveTemplates(value: unknown, provider: TranscriptProvider, entries: TranscriptEntry[]): unknown {
  if (typeof value === "string") {
    const match = /^\$\{(idea|breakpilot)\.([^:]+):(\/.*|)\}$/.exec(value);
    if (!match) return value;
    if (match[1] !== provider) throw new EvidenceVerificationError("capture", "template", "Cross-provider identity interpolation is forbidden.");
    const prior = [...entries].reverse().find((entry) => entry.stepId === match[2] && entry.direction === "response");
    if (!prior) throw new Error("Template source response does not exist.");
    return jsonPointer(prior.payload, match[3] ?? "");
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, provider, entries));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveTemplates(child, provider, entries)]));
  }
  return value;
}

function findIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["ideSessionId", "sessionId"]) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findIdentity(child);
    if (found) return found;
  }
  return undefined;
}

async function gitRevision(root: string): Promise<{ revision: string | null; revisionReason?: string }> {
  try {
    const { stdout } = await execFile("git", ["-C", root, "rev-parse", "HEAD"]);
    return { revision: stdout.trim() };
  } catch {
    return { revision: null, revisionReason: "not a git repository" };
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, filePath);
}

function unavailableManifest(config: CaptureConfig, runId: string, marker: EvidenceManifestV1["application"]["sourceMarker"]): EvidenceManifestV1 {
  const empty = { transcript: "", sha256: "", bytes: 0 };
  return {
    schemaVersion: 1,
    runId,
    harness: { revision: null, node: process.version, platform: `${process.platform}-${process.arch}` },
    breakpilot: { revision: null, hubUrl: config.hubUrl, bridgeUrl: config.bridgeUrl },
    application: { root: config.sampleRoot, revision: null, revisionReason: "capture did not start", sourceMarker: marker },
    providers: { idea: { ...empty }, breakpilot: { ...empty } },
    sanitizer: { id: SANITIZER_ID, version: SANITIZER_VERSION },
    rawRetention: "unavailable",
    outcome: "infrastructure_unavailable"
  };
}

export async function captureDifferentialEvidence(config: CaptureConfig): Promise<CaptureResult> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const outputRoot = path.resolve(config.outputRoot ?? path.join(config.sampleRoot, ".breakpilot/evidence/differential"));
  const directory = path.join(outputRoot, runId);
  const sourcePath = path.resolve(config.sampleRoot, config.sourceMarker.path);
  if (!sourcePath.startsWith(`${path.resolve(config.sampleRoot)}${path.sep}`)) {
    throw new EvidenceVerificationError("source", "$.sourceMarker.path", "Source marker escapes the sample root.");
  }
  const source = await readFile(sourcePath, "utf8");
  const lineText = source.split(/\r?\n/)[config.sourceMarker.line - 1];
  if (lineText === undefined) throw new EvidenceVerificationError("source", "$.sourceMarker.line", "Source marker line does not exist.");
  const marker = {
    workspaceRelativePath: config.sourceMarker.path,
    line: config.sourceMarker.line,
    lineSha256: sha256Text(lineText),
    lineText
  };
  if (config.sourceMarker.lineTextSha256 && config.sourceMarker.lineTextSha256 !== marker.lineSha256) {
    throw new EvidenceVerificationError("source", "$.sourceMarker.lineTextSha256", "Source marker digest mismatch.");
  }
  await mkdir(directory, { recursive: true });
  if (!config.providers.idea?.command || !config.providers.breakpilot?.command) {
    const manifest = unavailableManifest(config, runId, marker);
    await atomicJson(path.join(directory, "manifest.json"), manifest);
    return { directory, manifest, error: { code: INFRASTRUCTURE_CODE, message: "Both native IDEA and BreakPilot MCP commands are required." } };
  }

  await mkdir(path.join(directory, "raw"), { recursive: true });
  await mkdir(path.join(directory, "sanitized"), { recursive: true });
  const entries: Record<TranscriptProvider, TranscriptEntry[]> = { idea: [], breakpilot: [] };
  const clients = {} as Record<TranscriptProvider, StdioMcpClient>;
  const serverIdentity: Partial<Record<TranscriptProvider, string>> = {};
  const sessionIdentity: Partial<Record<TranscriptProvider, string>> = {};
  const append = async (provider: TranscriptProvider, entry: Omit<TranscriptEntry, "schemaVersion" | "sequence" | "timestamp" | "provider">) => {
    const complete: TranscriptEntry = {
      schemaVersion: 1,
      sequence: entries[provider].length + 1,
      timestamp: new Date().toISOString(),
      provider,
      ...entry
    };
    entries[provider].push(complete);
    await appendFile(path.join(directory, "raw", `${provider}.ndjson`), `${JSON.stringify(complete)}\n`, "utf8");
  };

  try {
    for (const provider of ["idea", "breakpilot"] as const) {
      clients[provider] = new StdioMcpClient(config.providers[provider]!);
      const initialized: any = await clients[provider].initialize();
      serverIdentity[provider] = typeof initialized?.serverInfo?.name === "string" ? initialized.serverInfo.name : undefined;
    }
    for (const step of config.steps) {
      const attempts = Math.max(1, (step.retries ?? 0) + 1);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const params = resolveTemplates(step.params, step.provider, entries[step.provider]);
        await append(step.provider, { direction: "request", stepId: step.id, attempt, payload: { method: step.method, params } });
        try {
          const response = await clients[step.provider].request(step.method, params);
          if (
            response &&
            typeof response === "object" &&
            (response as Record<string, unknown>).isError === true
          ) {
            throw new Error("MCP tool reported an error result.");
          }
          await append(step.provider, { direction: "response", stepId: step.id, attempt, payload: response });
          sessionIdentity[step.provider] ??= findIdentity(response);
          break;
        } catch (error) {
          await append(step.provider, {
            direction: "error",
            stepId: step.id,
            attempt,
            payload: { code: "MCP_REQUEST_FAILED", message: error instanceof Error ? error.message : "MCP request failed." }
          });
          if (attempt === attempts) throw error;
        }
      }
    }
  } catch {
    for (const client of Object.values(clients)) client?.close();
    const manifest = unavailableManifest(config, runId, marker);
    await atomicJson(path.join(directory, "manifest.json"), manifest);
    return { directory, manifest, error: { code: INFRASTRUCTURE_CODE, message: "Debugger MCP infrastructure was unavailable or did not complete the scenario." } };
  } finally {
    for (const client of Object.values(clients)) client?.close();
  }

  const appRevision = await gitRevision(config.sampleRoot);
  const harnessRevision = await gitRevision(path.resolve("."));
  const providers = {} as EvidenceManifestV1["providers"];
  const sanitizedEntries = {} as Record<TranscriptProvider, TranscriptEntry[]>;
  for (const provider of ["idea", "breakpilot"] as const) {
    const rawRelative = `raw/${provider}.ndjson`;
    const sanitizedRelative = `sanitized/${provider}.ndjson`;
    const rawDigest = await sha256File(path.join(directory, rawRelative));
    sanitizedEntries[provider] = sanitizeTranscript(provider, entries[provider]).entries;
    await writeFile(
      path.join(directory, sanitizedRelative),
      sanitizedEntries[provider].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8"
    );
    const digest = await sha256File(path.join(directory, sanitizedRelative));
    providers[provider] = {
      serverIdentity: serverIdentity[provider],
      sessionIdentity: sessionIdentity[provider],
      transcript: sanitizedRelative,
      sha256: digest.sha256,
      bytes: digest.bytes,
      rawTranscript: rawRelative,
      rawSha256: rawDigest.sha256,
      rawBytes: rawDigest.bytes
    };
  }
  const manifest: EvidenceManifestV1 = {
    schemaVersion: 1,
    runId,
    harness: { revision: harnessRevision.revision, node: process.version, platform: `${os.platform()}-${os.arch()}` },
    breakpilot: { revision: harnessRevision.revision, hubUrl: config.hubUrl, bridgeUrl: config.bridgeUrl },
    application: { root: config.sampleRoot, ...appRevision, sourceMarker: marker },
    providers,
    sanitizer: { id: SANITIZER_ID, version: SANITIZER_VERSION },
    rawRetention: "retained",
    outcome: "captured"
  };
  const lineage: LineageFileV1 = {
    schemaVersion: 1,
    assertions: config.lineage.map((assertion) => ({
      ...assertion,
      transcript: providers[assertion.provider].transcript,
      transcriptSha256: providers[assertion.provider].sha256
    }))
  };
  const semantic = extractSemanticArtifact(manifest, sanitizedEntries, lineage);
  await atomicJson(path.join(directory, "manifest.json"), manifest);
  await atomicJson(path.join(directory, "lineage.json"), lineage);
  await atomicJson(path.join(directory, "semantic.json"), semantic);
  await atomicJson(path.join(directory, "sanitized", "SHA256SUMS.json"), {
    idea: { sha256: providers.idea.sha256, bytes: providers.idea.bytes },
    breakpilot: { sha256: providers.breakpilot.sha256, bytes: providers.breakpilot.bytes }
  });
  await verifyEvidenceBundle(directory);
  return { directory, manifest };
}
