import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRouter } from "../src/control/ToolRouter.ts";
import { validateToolInput, validateToolOutput } from "../src/control/ToolInputValidator.ts";
import { loadPolicy } from "../src/security/PolicyLoader.ts";
import { DebugSessionManager } from "../src/sessions/DebugSessionManager.ts";
import type { JsonSchema, ToolResponse } from "../src/types/control.ts";
import type { AnyRecord } from "../src/types/json.ts";
import { BreakPilotError } from "../src/utils/errors.ts";

type FinalizedToolName =
  | "bp_debug_status"
  | "bp_debug_control"
  | "bp_debug_set_value"
  | "bp_debug_eval";

function createRouterWithHandler(
  name: FinalizedToolName,
  handler: (args?: AnyRecord) => Promise<ToolResponse>
): { manager: DebugSessionManager; router: ToolRouter } {
  const manager = new DebugSessionManager({ policy: loadPolicy("breakpilot.yaml") });
  if (name === "bp_debug_status") manager.bpDebugStatus = handler;
  if (name === "bp_debug_control") manager.bpDebugControl = handler;
  if (name === "bp_debug_set_value") manager.bpDebugSetValue = handler;
  if (name === "bp_debug_eval") manager.bpDebugEval = handler;
  return { manager, router: new ToolRouter(manager) };
}

const schema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { required: { type: "string" }, optional: { type: "string", default: "added" } },
  required: ["required"]
};
const candidate = { required: "present" };
assert.deepEqual(validateToolInput(schema, candidate).value, { required: "present", optional: "added" });
const output = validateToolOutput(schema, candidate);
assert.equal(output.value, candidate, "output validation returns the original object");
assert.deepEqual(candidate, { required: "present" }, "output validation never applies defaults");
assert.deepEqual(output.errors, []);
assert.equal(validateToolOutput(schema, {}).errors[0]?.path, "$.required");
assert.equal(validateToolOutput(schema, { required: "ok", extra: true }).errors[0]?.keyword, "additionalProperties");

const jsonCompatibleObjectIssue = {
  path: "$",
  keyword: "type",
  message: "must be a JSON-compatible object"
};
const permissiveSchema: JsonSchema = { type: "object", additionalProperties: true };
let accessorReads = 0;
const accessorOutput = {};
Object.defineProperty(accessorOutput, "unsafe", {
  get() {
    accessorReads += 1;
    return "accessed";
  },
  enumerable: true,
  configurable: true
});
const cyclicOutput: { self?: unknown } = {};
cyclicOutput.self = cyclicOutput;
const nonJsonOutputs = [
  { value: { undefined: undefined } },
  { value: { bigint: 1n } },
  { value: { function() {} } },
  { value: { symbol: Symbol("output") } },
  { value: { nonFinite: Number.NaN } },
  { value: accessorOutput },
  { value: cyclicOutput },
  { value: new Map() },
  { value: new Set() },
  { value: new Date(0) }
];
assert.deepEqual(
  nonJsonOutputs.map(({ value }) => validateToolOutput(permissiveSchema, value).errors),
  nonJsonOutputs.map(() => [jsonCompatibleObjectIssue])
);
assert.equal(accessorReads, 0, "output validation must not invoke accessors");

let proxyAccessorReads = 0;
const proxyAccessorTarget = {};
Object.defineProperty(proxyAccessorTarget, "unsafe", {
  get() {
    proxyAccessorReads += 1;
    return "accessed";
  },
  enumerable: true,
  configurable: true
});
const accessorConcealingProxy = new Proxy(proxyAccessorTarget, {
  getOwnPropertyDescriptor(target, property) {
    if (property === "unsafe") {
      return { value: "safe", writable: true, enumerable: true, configurable: true };
    }
    return Reflect.getOwnPropertyDescriptor(target, property);
  }
});
assert.deepEqual(
  validateToolOutput({ type: "object", enum: [{ unsafe: "accessed" }] }, accessorConcealingProxy).errors,
  [jsonCompatibleObjectIssue]
);
assert.equal(proxyAccessorReads, 0, "output validation must reject proxies before property reads");

const malformedSetValue = {
  path: ["x"],
  oldValue: "0",
  newValue: "1",
  applied: "yes",
  verified: false,
  mutationMode: "native"
};
const { manager: mutationManager, router: mutationRouter } = createRouterWithHandler(
  "bp_debug_set_value",
  async () => malformedSetValue
);
const auditRecords: Array<{ type: string; payload: AnyRecord }> = [];
mutationManager.audit.record = (type: string, payload: AnyRecord = {}) => {
  auditRecords.push({ type, payload });
  return "audit_contract_violation";
};
const mutationResponse = await mutationRouter.callTool("bp_debug_set_value", {
  path: ["x"],
  newValue: "1",
  detail: "diagnostic"
});
assert.equal(mutationResponse.error?.code, "OUTPUT_CONTRACT_VIOLATION");
assert.equal(mutationResponse.error?.retrySafe, false);
assert.equal(mutationResponse.error?.actionMayHaveApplied, false);
assert.equal(mutationResponse.error?.diagnostics?.outcome, "indeterminate");
assert.equal(mutationResponse.error?.diagnostics?.retrySafe, false);
assert.equal("details" in (mutationResponse.error ?? {}), false);
assert.equal(auditRecords.length, 1);
assert.equal(auditRecords[0]?.type, "tool_output_contract_violation");
assert.equal(auditRecords[0]?.payload.tool, "bp_debug_set_value");
assert.ok(Number(auditRecords[0]?.payload.issueCount) > 0);
assert.equal(JSON.stringify(auditRecords).includes("yes"), false);

for (const testCase of [
  {
    name: "bp_debug_status" as const,
    args: {},
    candidate: {
      activeSessionId: null,
      sessions: "invalid",
      ideConnected: false,
      ideSessions: []
    },
    outcome: "failed",
    retrySafe: true
  },
  {
    name: "bp_debug_control" as const,
    args: { action: "wait" },
    candidate: { status: 42 },
    outcome: "indeterminate",
    retrySafe: false
  },
  {
    name: "bp_debug_eval" as const,
    args: { expression: "x" },
    candidate: { expression: 42 },
    outcome: "indeterminate",
    retrySafe: false
  }
]) {
  const { router } = createRouterWithHandler(testCase.name, async () => testCase.candidate);
  const finalized = await router.callTool(testCase.name, { ...testCase.args, detail: "diagnostic" });
  assert.equal(finalized.error?.code, "OUTPUT_CONTRACT_VIOLATION", testCase.name);
  assert.equal(finalized.error?.diagnostics?.outcome, testCase.outcome, testCase.name);
  assert.equal(finalized.error?.retrySafe, testCase.retrySafe, testCase.name);
  assert.equal(finalized.error?.actionMayHaveApplied, false, testCase.name);
}

const { router: caughtErrorRouter } = createRouterWithHandler(
  "bp_debug_status",
  async () => {
    throw new BreakPilotError("EXPECTED_FAILURE", "Expected failure.", { absent: undefined });
  }
);
const caughtErrorResponse = await caughtErrorRouter.callTool("bp_debug_status", {});
assert.deepEqual(caughtErrorResponse, {
  error: {
    code: "EXPECTED_FAILURE",
    message: "Expected failure.",
    retrySafe: false,
    actionMayHaveApplied: false
  }
});

const { manager: nullRejectionManager, router: nullRejectionRouter } = createRouterWithHandler(
  "bp_debug_status",
  async () => {
    throw null;
  }
);
const nullRejectionAuditRecords: Array<{ type: string; payload: AnyRecord }> = [];
nullRejectionManager.audit.record = (type: string, payload: AnyRecord = {}) => {
  nullRejectionAuditRecords.push({ type, payload });
  return "audit_null_rejection";
};
let nullRejectionResponse: ToolResponse | undefined;
await assert.doesNotReject(async () => {
  nullRejectionResponse = await nullRejectionRouter.callTool("bp_debug_status", {});
}, "known tools must normalize non-Error rejections before audit extraction");
assert.deepEqual(nullRejectionResponse, {
  error: {
    code: "TOOL_FAILED",
    message: "null",
    retrySafe: false,
    actionMayHaveApplied: false
  }
});
assert.deepEqual(nullRejectionAuditRecords, [{
  type: "tool_failed",
  payload: {
    name: "bp_debug_status",
    message: "null",
    code: "TOOL_FAILED"
  }
}]);

const hostileRejection = Object.assign(Object.create(null), {
  secret: "must-not-reach-audit"
});
const { manager: hostileManager, router: hostileRouter } = createRouterWithHandler(
  "bp_debug_status",
  async () => {
    throw hostileRejection;
  }
);
const hostileAuditRecords: Array<{ type: string; payload: AnyRecord }> = [];
hostileManager.audit.record = (type: string, payload: AnyRecord = {}) => {
  hostileAuditRecords.push({ type, payload });
  return "audit_hostile_rejection";
};
let hostileResponse: ToolResponse | undefined;
await assert.doesNotReject(async () => {
  hostileResponse = await hostileRouter.callTool("bp_debug_status", {});
}, "known tools must contain failures from hostile display conversion");
assert.deepEqual(hostileResponse, {
  error: {
    code: "TOOL_FAILED",
    message: "Unknown tool failure.",
    retrySafe: false,
    actionMayHaveApplied: false
  }
});
assert.deepEqual(hostileAuditRecords, [{
  type: "tool_failed",
  payload: {
    name: "bp_debug_status",
    message: "Unknown tool failure.",
    code: "TOOL_FAILED"
  }
}]);
assert.equal(JSON.stringify(hostileAuditRecords).includes("must-not-reach-audit"), false);

const malformedBreakPilotAuditDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "breakpilot-malformed-error-")
);
try {
  const auditFile = path.join(malformedBreakPilotAuditDirectory, "audit.jsonl");
  const policy = loadPolicy("breakpilot.yaml");
  policy.audit = { enabled: true, file: auditFile };
  const manager = new DebugSessionManager({ policy });
  const router = new ToolRouter(manager);
  const malformedMessage = new BreakPilotError(
    "PRIVATE_MESSAGE_CODE",
    "must-not-reach-audit-message"
  );
  malformedMessage.message = 1n as unknown as string;
  const malformedDetails = new BreakPilotError(
    "PRIVATE_DETAILS_CODE",
    "must-not-reach-audit-details",
    {
      secret: "must-not-reach-audit-secret",
      nested: { value: 1n }
    }
  );

  for (const malformedError of [malformedMessage, malformedDetails]) {
    manager.bpDebugStatus = async () => {
      throw malformedError;
    };
    let response: ToolResponse | undefined;
    await assert.doesNotReject(async () => {
      response = await router.callTool("bp_debug_status", {});
    }, "malformed BreakPilotError fields must not escape the router boundary");
    assert.deepEqual(response, {
      error: {
        code: "TOOL_FAILED",
        message: "Unknown tool failure.",
        retrySafe: false,
        actionMayHaveApplied: false
      }
    });
  }

  const auditText = fs.readFileSync(auditFile, "utf8");
  const auditEntries = auditText.trim().split("\n").map((line) => JSON.parse(line) as AnyRecord);
  assert.deepEqual(auditEntries.map(({ type, name, message, code }) => ({
    type,
    name,
    message,
    code
  })), [
    {
      type: "tool_failed",
      name: "bp_debug_status",
      message: "Unknown tool failure.",
      code: "TOOL_FAILED"
    },
    {
      type: "tool_failed",
      name: "bp_debug_status",
      message: "Unknown tool failure.",
      code: "TOOL_FAILED"
    }
  ]);
  assert.equal(auditText.includes("must-not-reach-audit"), false);
  assert.equal(auditText.includes("PRIVATE_"), false);
} finally {
  fs.rmSync(malformedBreakPilotAuditDirectory, { recursive: true, force: true });
}
console.log("tool output validation tests ok");
