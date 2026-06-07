import fs from "node:fs";
import path from "node:path";
import type { AnyRecord, DebugMcpPolicy, JsonValue } from "../types.ts";
import { normalizeWorkspaceRoot } from "../utils/path.ts";

const DEFAULT_POLICY: DebugMcpPolicy = {
  workspace: {
    root: ".",
    allowOutsideWorkspace: false
  },
  network: {
    allowedHosts: ["127.0.0.1", "localhost"],
    allowedPorts: [5678, 9229, 5005]
  },
  ide: {
    enabled: true,
    preferredMode: "hybrid",
    bridge: {
      host: "127.0.0.1",
      port: 27891
    },
    requireUserConfirmation: {
      continueAfterBreakpoint: true,
      unsafeEvaluate: true,
      attachRemote: true
    },
    confirmationTimeoutMs: 30000,
    defaultOnTimeout: "continue"
  },
  evaluate: {
    defaultMode: "readonly",
    allowFunctionCalls: false,
    requireConfirmationForUnsafe: true,
    timeoutMs: 1000
  },
  variables: {
    maxDepth: 3,
    maxItems: 50,
    maxStringLength: 2000,
    redactPatterns: [
      "password",
      "token",
      "secret",
      "key",
      "authorization",
      "cookie",
      "credential"
    ]
  },
  runtime: {
    maxPauseMs: 30000,
    autoContinue: true,
    forbidProduction: true
  },
  audit: {
    enabled: true,
    file: ".debug-mcp/audit.log"
  }
};

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return (override === undefined ? base : override) as T;
  }
  const merged: AnyRecord = { ...(base as AnyRecord) };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = deepMerge((base as AnyRecord)?.[key], value);
  }
  return merged as T;
}

function scalar(value: string): JsonValue {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if ((char === '"' || char === "'") && line[i - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (char === "#" && !quote) return line.slice(0, i);
  }
  return line;
}

interface YamlRow {
  indent: number;
  text: string;
}

function parseYamlSubset(text: string): JsonValue {
  const rows = text
    .split(/\r?\n/)
    .map((raw) => stripComment(raw).replace(/\s+$/, ""))
    .filter((raw) => raw.trim().length > 0)
    .map((raw) => ({
      indent: raw.match(/^ */)?.[0].length ?? 0,
      text: raw.trim()
    })) satisfies YamlRow[];

  let index = 0;

  function parseBlock(indent: number): JsonValue {
    if (index >= rows.length) return {};
    const current = rows[index];
    if (!current) return {};
    const isList = current.indent === indent && current.text.startsWith("- ");
    if (isList) {
      const list: JsonValue[] = [];
      while (index < rows.length && rows[index]?.indent === indent && rows[index]?.text.startsWith("- ")) {
        const item = rows[index]?.text.slice(2).trim() ?? "";
        index += 1;
        if (!item) {
          list.push(parseBlock(indent + 2));
        } else if (item.includes(":")) {
          const [key, ...rest] = item.split(":");
          const value = rest.join(":").trim();
          const obj: AnyRecord = { [(key ?? "").trim()]: value ? scalar(value) : parseBlock(indent + 2) };
          while (index < rows.length && (rows[index]?.indent ?? 0) > indent) {
            Object.assign(obj, parseBlock(rows[index]?.indent ?? indent + 2));
          }
          list.push(obj as JsonValue);
        } else {
          list.push(scalar(item));
        }
      }
      return list;
    }

    const obj: AnyRecord = {};
    while (index < rows.length && rows[index]?.indent === indent && !rows[index]?.text.startsWith("- ")) {
      const line = rows[index]?.text ?? "";
      const colon = line.indexOf(":");
      if (colon === -1) {
        index += 1;
        continue;
      }
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      index += 1;
      obj[key] = value ? scalar(value) : parseBlock(indent + 2);
    }
    return obj as JsonValue;
  }

  return parseBlock(rows[0]?.indent ?? 0);
}

export function loadPolicy(
  policyPath = "debug-mcp.yaml",
  env: NodeJS.ProcessEnv = process.env
): DebugMcpPolicy {
  const configuredPath = env.DEBUG_MCP_POLICY || policyPath;
  let loaded: unknown = {};
  const absolute = path.resolve(configuredPath);
  if (fs.existsSync(absolute)) {
    const text = fs.readFileSync(absolute, "utf8");
    loaded = absolute.endsWith(".json") ? JSON.parse(text) : parseYamlSubset(text);
  }
  const policy = deepMerge(DEFAULT_POLICY, loaded);
  const envWorkspace = env.DEBUG_MCP_WORKSPACE;
  const root = normalizeWorkspaceRoot(envWorkspace || policy.workspace.root || ".");
  policy.workspace.root = root;
  if (policy.audit?.file) {
    policy.audit.file = path.resolve(root, policy.audit.file);
  }
  return policy;
}

export { DEFAULT_POLICY, parseYamlSubset };
