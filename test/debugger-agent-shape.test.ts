import assert from "node:assert/strict";

import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import { ToolRouter } from "../src/control/ToolRouter.ts";
import { SessionOwner, SessionState } from "../src/sessions/SessionOwner.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import type { RuntimeDebugProvider, DebugSessionRecord } from "../src/types/sessions.ts";
import type { AnyRecord } from "../src/types/json.ts";

const policy = loadPolicy();
const manager = new DebugSessionManager({ policy });
const router = new ToolRouter(manager);

const snapshot = {
  sessionId: "sess_shape",
  source: "ide" as const,
  language: "idea" as const,
  profile: "focused",
  threadId: 1,
  frameId: 10,
  threads: [{ id: 1, name: "main", state: "paused", isCurrent: true, frameCount: 2 }],
  partial: false,
  stackFrames: [
    { id: 10, name: "hello", line: 21, column: 1, source: { path: `${policy.workspace.root}/src/Hello.java` } },
    { id: 11, name: "caller", line: 12, column: 1, source: { path: `${policy.workspace.root}/src/Caller.java` } }
  ],
  variables: {
    locals: {
      name: "locals",
      category: "locals",
      rawScopes: ["IDEA Frame"],
      expensive: false,
      variables: {
        analysis: {
          name: "analysis",
          kind: "object",
          valuePreview: "Analysis(score=42)",
          variablesReference: 0,
          truncated: false,
          value: {
            score: {
              name: "score",
              kind: "primitive",
              valuePreview: "42",
              variablesReference: 0,
              truncated: false,
              value: "42"
            }
          }
        }
      }
    }
  },
  availableCategories: ["locals"],
  availableScopes: ["IDEA Frame"],
  limits: { maxDepth: 2, maxItems: 10, maxStringLength: 2000 }
};

const provider: RuntimeDebugProvider = {
  kind: "ide",
  sessionId: "sess_shape",
  language: "idea",
  workspaceRoot: policy.workspace.root,
  capabilities: { stackTrace: true, threads: true },
  threadId: 1,
  async setBreakpoints() {
    return [];
  },
  async waitForBreakpoint() {
    return {
      sessionId: "sess_shape",
      reason: "breakpoint",
      threadId: 1,
      allThreadsStopped: true,
      topFrame: snapshot.stackFrames[0]
    };
  },
  async listThreads() {
    return snapshot.threads;
  },
  async getCallStack() {
    return { threadId: 1, stackFrames: snapshot.stackFrames, totalFrames: 2, partial: false };
  },
  async getRuntimeSnapshot() {
    return snapshot as any;
  },
  async evaluate(expression: string) {
    return { value: { name: "result", kind: "primitive", valuePreview: expression.endsWith("score()") ? "42" : "ok" } };
  },
  async continue() {
    return { ok: true };
  },
  async step() {
    return { ok: true };
  },
  async disconnect() {
    return { detached: true };
  }
};

const record: DebugSessionRecord = {
  sessionId: "sess_shape",
  language: "idea",
  workspaceRoot: policy.workspace.root,
  mode: "ide",
  owner: SessionOwner.HYBRID,
  state: SessionState.PAUSED,
  createdAt: new Date().toISOString(),
  providerKind: "ide",
  provider
};
manager.sessions.add(record);
manager.sessions.add({
  ...record,
  sessionId: "sess_terminated",
  state: SessionState.TERMINATED,
  provider: { ...provider, sessionId: "sess_terminated" }
});

const status = await manager.bpDebugStatus({});
assert.equal(status.ok, true);
const statusData = status.data as AnyRecord;
assert.equal("hub" in statusData, false);
assert.equal("languages" in statusData, false);
assert.ok(statusData.capabilities);
assert.deepEqual((statusData.sessions as AnyRecord[]).map((session) => session.sessionId), ["sess_shape"]);

const wait = await manager.bpDebugControl({ sessionId: "sess_shape", action: "wait" });
assert.equal(wait.ok, true);
assert.equal(((wait.data as AnyRecord).frame), null);
assert.deepEqual((wait.data as AnyRecord).position, {
  filePath: `${policy.workspace.root}/src/Hello.java`,
  line: 21,
  frameIndex: 0
});

const waitWithFrame = await manager.bpDebugControl({ sessionId: "sess_shape", action: "wait", includeFrame: true });
assert.equal(waitWithFrame.ok, true);
assert.ok((waitWithFrame.data as AnyRecord).frame);

const score = await manager.bpDebugValue({ sessionId: "sess_shape", path: ["analysis", "score"], depth: 0 });
assert.equal(score.ok, true);
const scoreNode = ((score.data as AnyRecord).value as AnyRecord);
assert.equal(scoreNode.summary, "42");
assert.equal(scoreNode.raw, "42");
assert.deepEqual(scoreNode.path, ["analysis", "score"]);

const analysis = await manager.bpDebugValue({ sessionId: "sess_shape", path: ["analysis"] });
const analysisNode = ((analysis.data as AnyRecord).value as AnyRecord);
assert.equal("raw" in analysisNode, false);
assert.equal("value" in analysisNode, false);
assert.equal("debugRaw" in analysisNode, false);
assert.ok(Array.isArray(analysisNode.children));

const evalAccessor = await router.callTool("bp_debug_eval", { sessionId: "sess_shape", expression: "analysis.score()", mode: "readonly" });
assert.equal(evalAccessor.ok, true);

const evalBlocked = await router.callTool("bp_debug_eval", { sessionId: "sess_shape", expression: "analysis.delete()", mode: "readonly" });
assert.equal(evalBlocked.ok, false);
assert.equal(evalBlocked.error?.code, "EVALUATE_BLOCKED_BY_POLICY");
assert.equal(evalBlocked.error?.details.suggestedExpression, "analysis.delete");

const missingDisconnect = await manager.bpDebugControl({ sessionId: "missing", action: "disconnect" });
assert.equal(missingDisconnect.ok, true);
assert.equal((missingDisconnect.data as AnyRecord).status, "stopped");

console.log("debugger agent shape tests ok");
