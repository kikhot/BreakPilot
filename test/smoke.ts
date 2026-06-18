import assert from "node:assert/strict";
import { loadPolicy, parseYamlSubset } from "../src/security/PolicyLoader.ts";
import { toolDefinitions } from "../src/control/toolDefinitions.ts";
import { RuntimeSnapshotBuilder } from "../src/inspection/SnapshotBuilder.ts";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { IdeClientRegistry } from "../src/ide/IdeClientRegistry.ts";
import type { DapSession } from "../src/dap/DapSession.ts";
import type { AnyRecord } from "../src/types/json.ts";
import type { Socket } from "node:net";

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

const policy = loadPolicy("breakpilot.yaml");
assert.ok(policy.workspace.root.endsWith("BreakPilot"));
assert.equal(policy.evaluate.defaultMode, "readonly");

const runtime = createRuntime({ policyPath: "breakpilot.yaml", enableIdeBridge: false });
assert.ok(toolDefinitions.some((tool) => tool.name === "bp_debug_start"));
assert.ok(runtime.router.listTools().some((tool) => tool.name === "bp_debug_frame"));
assert.ok(runtime.router.listTools().some((tool) => tool.name === "bp_debug_value"));
assert.ok(runtime.router.listTools().some((tool) => tool.name === "bp_debug_threads"));
assert.ok(runtime.router.listTools().some((tool) => tool.name === "bp_debug_call_stack"));
assert.ok(runtime.router.listTools().some((tool) => tool.name === "bp_debug_context"));
assert.equal(runtime.router.listTools().some((tool) => tool.name === "debug_launch"), false);

const frameTool = toolDefinitions.find((tool) => tool.name === "bp_debug_frame");
assert.equal(frameTool?.inputSchema.properties.expand.default, "preview");
assert.ok(frameTool?.inputSchema.properties.depth);
assert.ok(frameTool?.inputSchema.properties.limit);
assert.ok(frameTool?.outputSchema);
assert.ok(toolDefinitions.find((tool) => tool.name === "bp_debug_status")?.outputSchema);
assert.equal(toolDefinitions.some((tool) => tool.name === "bp_debug_diagnostics"), false);
const statusTool = toolDefinitions.find((tool) => tool.name === "bp_debug_status");
assert.equal("verbose" in statusTool!.inputSchema.properties, false);
assert.equal("includeHub" in statusTool!.inputSchema.properties, false);
assert.equal("includeLanguages" in statusTool!.inputSchema.properties, false);
assert.equal("includeTerminated" in statusTool!.inputSchema.properties, false);

const sessions = await runtime.router.callTool("bp_debug_status", {});
assert.equal(sessions.ok, true);
assert.deepEqual((sessions.data as AnyRecord).sessions, []);
assert.equal("languages" in (sessions.data as AnyRecord), false);
assert.equal("hub" in (sessions.data as AnyRecord), false);

const registry = new IdeClientRegistry();
registry.add({} as Socket, {
  clientId: "ide_test",
  ide: "idea",
  workspaceRoot: policy.workspace.root,
  capabilities: { variableSnapshot: true }
});
registry.upsertSession(
  "ide_test",
  {
    type: "ide_session_paused",
    ideSessionId: "idea_test",
    workspaceRoot: policy.workspace.root,
    topFrame: { name: "frame" }
  },
  "paused"
);
assert.equal(registry.listSessions()[0]?.ideSessionId, "idea_test");
assert.equal(registry.findSession("idea_test")?.state, "paused");

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

const fakeSession = {
  sessionId: "sess_test",
  language: "python",
  threadId: 1,
  async stackTrace() {
    return {
      threadId: 1,
      stackFrames: [{ id: 10, name: "calculate_total", line: 12 }]
    };
  },
  async scopes() {
    return [
      { name: "Locals", variablesReference: 1, expensive: false },
      { name: "Globals", variablesReference: 2, expensive: false }
    ];
  },
  async variables(variablesReference: number) {
    if (variablesReference === 1) {
      return [
        { name: "amount", value: "100", type: "int", variablesReference: 0 },
        { name: "order", value: "{'amount': 100}", type: "dict", variablesReference: 3 }
      ];
    }
    if (variablesReference === 2) {
      return [
        { name: "__builtins__", value: "{...}", type: "dict", variablesReference: 4 },
        { name: "app", value: "<Flask 'app'>", type: "Flask", variablesReference: 0 }
      ];
    }
    return [{ name: "'amount'", value: "100", type: "int", variablesReference: 0 }];
  }
} as unknown as DapSession;

const snapshotLimits = {
  maxDepth: 3,
  maxItems: 10,
  maxStringLength: 2000,
  redactPatterns: []
};
const focusedSnapshot = await new RuntimeSnapshotBuilder(fakeSession, snapshotLimits).build({});
assert.equal(focusedSnapshot.profile, "focused");
assert.ok(focusedSnapshot.variables.locals);
assert.equal(focusedSnapshot.variables.globals, undefined);
assert.ok(focusedSnapshot.omittedCategories?.includes("globals"));
const orderVariable = focusedSnapshot.variables.locals.variables.order as AnyRecord;
assert.equal(orderVariable.variablesReference, 3);
assert.equal(orderVariable.value, undefined);

const fullSnapshot = await new RuntimeSnapshotBuilder(fakeSession, snapshotLimits).build({ profile: "full" });
assert.ok(fullSnapshot.variables.globals);

console.log("smoke ok");
