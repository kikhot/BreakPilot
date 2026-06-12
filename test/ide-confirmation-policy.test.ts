import assert from "node:assert/strict";
import {
  debugControlConfirmationRequest,
  evaluateConfirmationRequest,
  expressionLooksCallable,
  variableInspectionConfirmationRequest
} from "../src/ide/ConfirmationPolicy.ts";

assert.equal(expressionLooksCallable("user.name"), false);
assert.equal(expressionLooksCallable("service.fetchUser()"), true);

const readonlyEval = evaluateConfirmationRequest("order[\"discount\"]", "readonly");
assert.equal(readonlyEval.actionKind, "safe_inspection");
assert.equal(readonlyEval.riskLevel, "safe");
assert.deepEqual(readonlyEval.rememberScopes, ["once", "project"]);
assert.equal(readonlyEval.action, "readonly_evaluate");

const unsafeEval = evaluateConfirmationRequest("service.deleteAll()", "unsafe");
assert.equal(unsafeEval.actionKind, "high_risk");
assert.equal(unsafeEval.riskLevel, "high");
assert.deepEqual(unsafeEval.rememberScopes, ["once"]);
assert.equal(unsafeEval.action, "unsafe_evaluate");

const guardedCall = evaluateConfirmationRequest("service.fetchUser()", "guarded");
assert.equal(guardedCall.actionKind, "high_risk");
assert.equal(guardedCall.riskLevel, "high");

const snapshot = variableInspectionConfirmationRequest({ profile: "focused" });
assert.equal(snapshot.actionKind, "safe_inspection");
assert.equal(snapshot.riskLevel, "safe");
assert.deepEqual(snapshot.rememberScopes, ["once", "project"]);

for (const action of ["continue", "step_over", "step_into", "step_out", "stop_debug"]) {
  const request = debugControlConfirmationRequest(action);
  assert.equal(request.actionKind, "debug_control");
  assert.equal(request.riskLevel, "control");
  assert.deepEqual(request.rememberScopes, ["once", "session"]);
}

console.log("ide confirmation policy tests ok");
