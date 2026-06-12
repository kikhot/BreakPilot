import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadPolicy } from "../security/PolicyLoader.ts";
import type { BreakPilotPolicy } from "../types/policy.ts";
import type { AnyRecord } from "../types/json.ts";
import { stableJson, safeJsonParse } from "../utils/json.ts";

export interface HubContext {
  policy: BreakPilotPolicy;
  workspaceRoot: string;
  policyPath: string;
  policyHash: string;
}

export interface HubManifest {
  instanceId: string;
  pid: number;
  version: string;
  workspaceRoot: string;
  policyPath: string;
  policyHash: string;
  controlUrl: string;
  bridgeUrl?: string;
  controlToken: string;
  startedAt: string;
  updatedAt: string;
}

export interface HubStatus extends AnyRecord {
  ok?: boolean;
  server?: string;
  instanceId?: string;
  workspaceRoot?: string;
  policyHash?: string;
  controlUrl?: string;
  bridgeUrl?: string;
}

export interface EnsureDaemonOptions {
  policyPath?: string;
  controlUrl?: string;
  ensure?: boolean;
  timeoutMs?: number;
}

const HUB_DIR = ".breakpilot";
const HUB_FILE = "hub.json";
const HUB_LOCK = "hub.lock";
const DEFAULT_VERSION = "0.1.0";
const DEFAULT_CONTROL_URL = "http://127.0.0.1:27890";

export function hubContext(policyPath = "breakpilot.yaml"): HubContext {
  const policy = loadPolicy(policyPath);
  const configuredPath = process.env.BREAKPILOT_POLICY || policyPath;
  const resolvedPolicyPath = path.resolve(configuredPath);
  return {
    policy,
    workspaceRoot: policy.workspace.root,
    policyPath: resolvedPolicyPath,
    policyHash: hashPolicy(policy, resolvedPolicyPath)
  };
}

export function hubDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, HUB_DIR);
}

export function hubManifestPath(workspaceRoot: string): string {
  return path.join(hubDir(workspaceRoot), HUB_FILE);
}

export function hubLockPath(workspaceRoot: string): string {
  return path.join(hubDir(workspaceRoot), HUB_LOCK);
}

export function makeInstanceId(): string {
  return `hub_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function makeControlToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function defaultControlUrl(): string {
  return DEFAULT_CONTROL_URL;
}

export function readHubManifest(workspaceRoot: string): HubManifest | null {
  const file = hubManifestPath(workspaceRoot);
  if (!fs.existsSync(file)) return null;
  const parsed = safeJsonParse<HubManifest>(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed.controlUrl !== "string") return null;
  return parsed;
}

export function writeHubManifest(manifest: HubManifest): void {
  fs.mkdirSync(hubDir(manifest.workspaceRoot), { recursive: true });
  fs.writeFileSync(hubManifestPath(manifest.workspaceRoot), `${stableJson(manifest, true)}\n`);
}

export function removeHubManifest(workspaceRoot: string): void {
  try {
    fs.unlinkSync(hubManifestPath(workspaceRoot));
  } catch {
    // Best effort cleanup only.
  }
}

export async function probeHub(controlUrl: string, token?: string, timeoutMs = 1000): Promise<HubStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${controlUrl}/status`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: controller.signal
    });
    if (!response.ok) return null;
    return (await response.json()) as HubStatus;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function findHealthyHub(context: HubContext, controlUrl?: string): Promise<HubManifest | null> {
  const manifest = readHubManifest(context.workspaceRoot);
  const candidates = [
    manifest,
    controlUrl
      ? ({
          controlUrl,
          controlToken: manifest?.controlUrl === controlUrl ? manifest.controlToken : ""
        } as HubManifest)
      : null
  ].filter(Boolean) as HubManifest[];

  for (const candidate of candidates) {
    const status = await probeHub(candidate.controlUrl, candidate.controlToken);
    if (!status || status.server !== "breakpilot") continue;
    if (status.workspaceRoot !== context.workspaceRoot) continue;
    if (status.policyHash !== context.policyHash) continue;
    if (manifest && candidate.controlUrl === manifest.controlUrl) return manifest;
    return {
      ...candidate,
      instanceId: String(status.instanceId ?? ""),
      pid: Number(status.pid ?? 0),
      version: String(status.version ?? DEFAULT_VERSION),
      workspaceRoot: context.workspaceRoot,
      policyPath: context.policyPath,
      policyHash: context.policyHash,
      controlUrl: String(status.controlUrl ?? candidate.controlUrl),
      bridgeUrl: status.bridgeUrl ? String(status.bridgeUrl) : undefined,
      startedAt: String(status.startedAt ?? new Date().toISOString()),
      updatedAt: new Date().toISOString()
    };
  }

  if (manifest) removeHubManifest(context.workspaceRoot);
  return null;
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<HubManifest> {
  const context = hubContext(options.policyPath);
  const existing = await findHealthyHub(context, options.controlUrl);
  if (existing) return existing;
  if (options.ensure === false) {
    throw new Error(
      `Cannot reach BreakPilot daemon for ${context.workspaceRoot}. Start it with: breakpilot serve --auto-port`
    );
  }

  fs.mkdirSync(hubDir(context.workspaceRoot), { recursive: true });
  const lockFile = hubLockPath(context.workspaceRoot);
  let lockFd: number | null = null;
  try {
    lockFd = acquireLock(lockFile);
  } catch {
    const waited = await waitForHealthyHub(context, options.timeoutMs ?? 10000);
    if (waited) return waited;
    cleanupStaleLock(lockFile);
    lockFd = acquireLock(lockFile);
  }

  try {
    const afterLock = await findHealthyHub(context, options.controlUrl);
    if (afterLock) return afterLock;
    spawnDaemon(context, options);
    const started = await waitForHealthyHub(context, options.timeoutMs ?? 10000);
    if (!started) {
      throw new Error("Timed out waiting for BreakPilot daemon to become ready.");
    }
    return started;
  } finally {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {
        // Best effort cleanup only.
      }
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // Best effort cleanup only.
      }
    }
  }
}

export function manifestForControlUrl(controlUrl: string, policyPath?: string): HubManifest | null {
  const context = hubContext(policyPath);
  const manifest = readHubManifest(context.workspaceRoot);
  if (manifest?.controlUrl === controlUrl) return manifest;
  return null;
}

export function hashPolicy(policy: BreakPilotPolicy, policyPath: string): string {
  return crypto
    .createHash("sha256")
    .update(stableJson({ policy, policyPath }, false))
    .digest("hex");
}

async function waitForHealthyHub(context: HubContext, timeoutMs: number): Promise<HubManifest | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const manifest = await findHealthyHub(context);
    if (manifest) return manifest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function spawnDaemon(context: HubContext, options: EnsureDaemonOptions): void {
  const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
  const logFile = path.join(hubDir(context.workspaceRoot), "daemon.log");
  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");
  const args = [
    "--experimental-strip-types",
    cliEntry,
    "serve",
    "--auto-port",
    "--policy",
    context.policyPath
  ];
  if (options.controlUrl) {
    const url = new URL(options.controlUrl);
    if (url.hostname) args.push("--host", url.hostname);
    if (url.port) args.push("--http-port", url.port);
  }
  const child = spawn(process.execPath, args, {
    cwd: context.workspaceRoot,
    detached: true,
    stdio: ["ignore", out, err],
    env: {
      ...process.env,
      BREAKPILOT_WORKSPACE: context.workspaceRoot
    }
  });
  child.unref();
}

function acquireLock(lockFile: string): number {
  return fs.openSync(lockFile, "wx");
}

function cleanupStaleLock(lockFile: string): void {
  try {
    const stat = fs.statSync(lockFile);
    if (Date.now() - stat.mtimeMs > 10000) fs.unlinkSync(lockFile);
  } catch {
    // Best effort cleanup only.
  }
}
