import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadPolicy } from "../security/PolicyLoader.ts";
import type { BreakPilotPolicy } from "../types/policy.ts";
import { safeJsonParse, stableJson } from "../utils/json.ts";

export interface BridgeContext {
  policy: BreakPilotPolicy;
  workspaceRoot: string;
  policyPath: string;
  policyHash: string;
}

export type BridgeManifestOwner = "mcp" | "daemon";
export type BridgeManifestLifecycle = "stdio" | "persistent";

export interface BridgeManifest {
  schemaVersion: 1;
  owner: BridgeManifestOwner;
  instanceId: string;
  pid: number;
  lifecycle: BridgeManifestLifecycle;
  workspaceRoot: string;
  policyPath: string;
  policyHash: string;
  bridgeUrl?: string;
  controlUrl?: string;
  controlToken?: string;
  startedAt: string;
  updatedAt: string;
}

const BRIDGE_DIR = ".breakpilot";
const BRIDGE_FILE = "bridge.json";

export function bridgeContext(policyPath = "breakpilot.yaml"): BridgeContext {
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

export function bridgeDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, BRIDGE_DIR);
}

export function bridgeManifestPath(workspaceRoot: string): string {
  return path.join(bridgeDir(workspaceRoot), BRIDGE_FILE);
}

export function makeInstanceId(prefix = "bridge"): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function makeControlToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function hashPolicy(policy: BreakPilotPolicy, policyPath: string): string {
  return crypto
    .createHash("sha256")
    .update(stableJson({ policy, policyPath }, false))
    .digest("hex");
}

export function readBridgeManifest(workspaceRoot: string): BridgeManifest | null {
  const file = bridgeManifestPath(workspaceRoot);
  if (!fs.existsSync(file)) return null;
  const parsed = safeJsonParse<BridgeManifest>(fs.readFileSync(file, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.instanceId !== "string") return null;
  return parsed;
}

export function writeBridgeManifest(manifest: BridgeManifest): void {
  fs.mkdirSync(bridgeDir(manifest.workspaceRoot), { recursive: true });
  const target = bridgeManifestPath(manifest.workspaceRoot);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${stableJson(manifest, true)}\n`);
  fs.renameSync(tmp, target);
}

export function removeBridgeManifestForInstance(workspaceRoot: string, instanceId: string): void {
  try {
    const current = readBridgeManifest(workspaceRoot);
    if (current?.instanceId !== instanceId) return;
    fs.unlinkSync(bridgeManifestPath(workspaceRoot));
  } catch {
    // Best effort cleanup only.
  }
}

export function manifestForControlUrl(controlUrl: string, policyPath?: string): BridgeManifest | null {
  const context = bridgeContext(policyPath);
  const manifest = readBridgeManifest(context.workspaceRoot);
  if (manifest?.owner === "daemon" && manifest.controlUrl === controlUrl) return manifest;
  return null;
}
