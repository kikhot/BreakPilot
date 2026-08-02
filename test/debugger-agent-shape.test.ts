import assert from "node:assert/strict";

import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import { ToolRouter } from "../src/control/ToolRouter.ts";
import { SessionOwner, SessionState } from "../src/sessions/SessionOwner.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import type { RuntimeDebugProvider, DebugSessionRecord } from "../src/types/sessions.ts";
import type { AnyRecord } from "../src/types/json.ts";
import { ideProviderCapabilities } from "../src/runtime/ProviderCapabilities.ts";

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
  capabilities: ideProviderCapabilities({ debugCommands: true, variableSnapshot: true }),
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
  async getCallStack(_threadId, request) {
    const stackFrames = snapshot.stackFrames.slice(request.offset, request.offset + request.limit);
    const nextOffset = request.offset + stackFrames.length;
    const partial = nextOffset < 2;
    return {
      threadId: 1,
      stackFrames,
      offset: request.offset,
      totalFrames: 2,
      completeness: partial ? "partial" : "complete",
      partial,
      ...(partial ? { nextOffset, truncationReason: "limit" as const } : {})
    };
  },
  async getRuntimeSnapshot() {
    return snapshot as any;
  },
  async evaluate(expression: string) {
    return { value: { name: "result", kind: "primitive", valuePreview: expression.endsWith("score()") ? "42" : "ok" } };
  },
  async continue() {
    return { continued: true };
  },
  async step() {
    return { stepped: true };
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
assert.equal("ok" in status, false);
assert.equal("data" in status, false);
assert.equal("auditId" in status, false);
assert.equal("hub" in status, false);
assert.equal("languages" in status, false);
assert.equal("capabilities" in status, false);
assert.deepEqual(status, {
  activeSessionId: "sess_shape",
  sessions: [{
    sessionId: "sess_shape",
    state: "paused",
    mode: "ide",
    active: true
  }],
  ideConnected: false
});

const wait = await manager.bpDebugControl({ sessionId: "sess_shape", action: "wait" });
assert.equal("ok" in wait, false);
assert.equal("data" in wait, false);
assert.equal("stopped" in wait, false);
assert.equal("events" in wait, false);
assert.equal("position" in wait, false);
assert.equal("variables" in wait, false);
assert.deepEqual(wait, {
  state: "paused",
  reason: "breakpoint",
  at: {
    filePath: "src/Hello.java",
    line: 21,
    column: 1,
    function: "hello"
  },
  locals: [{
    name: "analysis",
    value: "Analysis(score=42)",
    handle: "v1"
  }],
  pauseId: 1
});

const threads = await manager.bpDebugThreads({ sessionId: "sess_shape", limit: 1 });
assert.deepEqual(threads, {
  threads: [{ id: 1, name: "main", current: true }]
});

const stack = await manager.bpDebugCallStack({ sessionId: "sess_shape", limit: 1 });
assert.deepEqual(stack, {
  threadId: 1,
  frames: [{
    index: 0,
    at: {
      filePath: "src/Hello.java",
      line: 21,
      column: 1,
      function: "hello"
    }
  }],
  pauseId: 1,
  nextOffset: 1
});

const frame = await manager.bpDebugFrame({ sessionId: "sess_shape" });
assert.deepEqual(frame, {
  frame: {
    index: 0,
    at: {
      filePath: "src/Hello.java",
      line: 21,
      column: 1,
      function: "hello"
    }
  },
  locals: [{
    name: "analysis",
    value: "Analysis(score=42)",
    handle: "v1"
  }],
  pauseId: 1
});

const score = await manager.bpDebugValue({ sessionId: "sess_shape", path: ["analysis", "score"], depth: 0 });
assert.deepEqual(score, { value: { name: "score", value: "42" } });
assert.equal("raw" in score, false);
assert.equal("summary" in score, false);
assert.equal("kind" in score, false);

const analysis = await manager.bpDebugValue({ sessionId: "sess_shape", path: ["analysis"] });
assert.equal("raw" in analysis, false);
assert.equal("summary" in analysis, false);
assert.equal("debugRaw" in analysis, false);
assert.deepEqual(analysis, {
  value: {
    name: "analysis",
    value: "Analysis(score=42)",
    handle: "v1",
    children: [{ name: "score", value: "42" }]
  }
});

const expanded = await manager.bpDebugValue({ sessionId: "sess_shape", handle: "v1" });
assert.deepEqual(expanded, analysis);

const context = await manager.bpDebugContext({ sessionId: "sess_shape" });
assert.equal(Buffer.byteLength(JSON.stringify(context), "utf8") < 2_000, true);
assert.deepEqual(context, {
  state: "paused",
  reason: "breakpoint",
  at: {
    filePath: "src/Hello.java",
    line: 21,
    column: 1,
    function: "hello"
  },
  stack: [
    { index: 0, at: { filePath: "src/Hello.java", line: 21, column: 1, function: "hello" } },
    { index: 1, at: { filePath: "src/Caller.java", line: 12, column: 1, function: "caller" } }
  ],
  locals: [{ name: "analysis", value: "Analysis(score=42)", handle: "v1" }],
  pauseId: 1
});

const evalAccessor = await router.callTool("bp_debug_eval", { sessionId: "sess_shape", expression: "analysis.score()", mode: "readonly" });
assert.equal(evalAccessor.value, "42");

const evalBlocked = await router.callTool("bp_debug_eval", { sessionId: "sess_shape", expression: "analysis.delete()", mode: "readonly" });
assert.equal(evalBlocked.error?.code, "EVALUATE_BLOCKED_BY_POLICY");
assert.equal(evalBlocked.error?.retrySafe, true);
assert.equal(evalBlocked.error?.actionMayHaveApplied, false);
assert.equal(evalBlocked.error?.hint, "Try the read-only expression: analysis.delete");
assert.equal("details" in (evalBlocked.error ?? {}), false);

const missingDisconnect = await manager.bpDebugControl({ sessionId: "missing", action: "disconnect" });
assert.equal(missingDisconnect.state, "stopped");
assert.equal(missingDisconnect.alreadyStopped, true);
assert.ok(Array.isArray(missingDisconnect.warnings));

console.log("debugger agent shape tests ok");
