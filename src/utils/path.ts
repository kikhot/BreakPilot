import path from "node:path";
import { pathToFileURL } from "node:url";
import { DebugMcpError, ErrorCodes } from "./errors.ts";

export interface DapSource {
  name: string;
  path: string;
  sourceReference: number;
}

export function normalizeWorkspaceRoot(root?: string): string {
  return path.resolve(root || ".");
}

export function resolveWorkspacePath(workspaceRoot: string, candidate?: string): string {
  if (!candidate) return workspaceRoot;
  return path.resolve(workspaceRoot, candidate);
}

export function assertInsideWorkspace(
  workspaceRoot: string,
  candidate: string,
  allowOutsideWorkspace = false
): string {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const resolved = path.resolve(candidate);
  if (allowOutsideWorkspace) return resolved;
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new DebugMcpError(
      ErrorCodes.WORKSPACE_VIOLATION,
      `Path is outside the allowed workspace: ${resolved}`,
      { workspaceRoot: root, path: resolved }
    );
  }
  return resolved;
}

export function toDapSource(filePath: string): DapSource {
  const absolute = path.resolve(filePath);
  return {
    name: path.basename(absolute),
    path: absolute,
    sourceReference: 0
  };
}

export function fileUrl(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}
