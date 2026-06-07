import assert from "node:assert/strict";
import { loadPolicy, parseYamlSubset } from "../src/security/PolicyLoader.ts";
import { createRuntime } from "../src/server.ts";
import { toolDefinitions } from "../src/mcp/schemas.ts";
import type { AnyRecord } from "../src/types.ts";

const parsed = parseYamlSubset(`
workspace:
  root: .
network:
  allowedHosts:
    - 127.0.0.1
  allowedPorts:
    - 5678
evaluate:
  defaultMode: readonly
`) as AnyRecord;

assert.equal(parsed.workspace.root, ".");
assert.equal(parsed.network.allowedHosts[0], "127.0.0.1");
assert.equal(parsed.network.allowedPorts[0], 5678);

const policy = loadPolicy("debug-mcp.yaml");
assert.ok(policy.workspace.root.endsWith("BreakPilot"));
assert.equal(policy.evaluate.defaultMode, "readonly");

const runtime = createRuntime({ policyPath: "debug-mcp.yaml", enableIdeBridge: false });
assert.ok(toolDefinitions.some((tool) => tool.name === "debug_launch"));
assert.ok(runtime.router.listTools().some((tool) => tool.name === "get_runtime_snapshot"));

const sessions = await runtime.router.callTool("list_sessions", {});
assert.equal(sessions.ok, true);
assert.deepEqual((sessions.data as AnyRecord).sessions, []);

const badEval = await runtime.router.callTool("evaluate", {
  sessionId: "missing",
  expression: "doSomething()",
  mode: "readonly"
});
assert.equal(badEval.ok, false);

const blockedAttach = await runtime.router.callTool("debug_attach", {
  lang: "python",
  host: "example.com",
  port: 5678
});
assert.equal(blockedAttach.ok, false);
assert.equal(blockedAttach.error?.code, "DEBUG_PORT_NOT_ALLOWED");

console.log("smoke ok");
