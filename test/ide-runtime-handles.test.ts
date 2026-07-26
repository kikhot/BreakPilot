import assert from "node:assert/strict";
import test from "node:test";

import { assertHandleEpoch } from "../src/runtime/RuntimeHandle.ts";

test("runtime handles reject a pause epoch mismatch with retry guidance", () => {
  const handle = {
    handle: "bpref_opaque",
    sessionId: "debug-1",
    ideSessionId: "ide-1",
    pauseEpoch: 3
  };

  assert.doesNotThrow(() => assertHandleEpoch(handle, 3));
  assert.throws(
    () => assertHandleEpoch(handle, 4),
    (error: Error & { code?: string; details?: Record<string, unknown> }) => {
      assert.equal(error.code, "STALE_RUNTIME_HANDLE");
      assert.deepEqual(error.details, {
        handle: "bpref_opaque",
        currentEpoch: 4,
        retrySafe: true,
        recommendedAction: "Request fresh context and use a newly returned reference."
      });
      return true;
    }
  );
});
