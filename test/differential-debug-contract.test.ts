import assert from "node:assert/strict";
import test from "node:test";

import { verifyEvidenceBundle } from "../src/evidence/DifferentialEvidenceReplay.ts";

test("IDEA and BreakPilot retain the checked semantic debugger baseline through verified lineage", async () => {
  const artifact = await verifyEvidenceBundle("test/fixtures/evidence/differential-v1");
  assert.equal(artifact.source.line, 24);
  assert.deepEqual(artifact.values.normalizedName, { idea: "Ada Lovelace", breakpilot: "Ada Lovelace" });
  assert.deepEqual(artifact.values["analysis.score"], { idea: 28, breakpilot: 28 });
});
