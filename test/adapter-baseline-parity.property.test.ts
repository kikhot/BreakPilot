// Feature: pluggable-debug-adapters, Property 15: Migrated adapters preserve baseline configuration (model-based)
/**
 * Model-based property test for migrated-adapter baseline parity (Task 2.7).
 *
 * Runner: node --experimental-strip-types test/adapter-baseline-parity.property.test.ts
 *
 * Property 15: Migrated adapters preserve baseline configuration (model-based).
 * For any launch or attach argument set, the migrated PythonAdapter and
 * NodeAdapter normalizeLaunchArgs/normalizeAttachArgs produce output equal to
 * the captured pre-feature baseline for those identical inputs.
 *
 * Part A (fixtures as oracle): the Task 1.2 baseline fixtures
 * (test/fixtures/adapter-baselines/{python,node,typescript}.json) are replayed
 * against the CURRENT adapters; each recorded `output` must equal the live
 * output under JSON round-trip equality (mirroring how the fixtures were
 * captured, where `undefined` fields drop under JSON.stringify).
 *
 * Part B (randomized model-based): arbitrary launch/attach arg objects are
 * generated with fast-check and the live adapter output is checked against an
 * independent reference model of the documented transform, plus determinism.
 *
 * Validates: Requirements 10.1, 10.2
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fc from "fast-check";
import {
  NodeAdapter,
  PythonAdapter
} from "../src/debug-adapters/LanguageAdapter.ts";
import type { AnyRecord } from "../src/types/json.ts";

const RUNS = 200;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures", "adapter-baselines");

/**
 * JSON round-trip equality. The baselines were captured via JSON.stringify, so
 * keys whose value is `undefined` are absent. Comparing the round-tripped forms
 * mirrors that capture exactly.
 */
function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.parse(JSON.stringify(actual));
  const e = JSON.parse(JSON.stringify(expected));
  assert.deepEqual(a, e, message);
}

// ---------------------------------------------------------------------------
// Adapter instances under test.
// ---------------------------------------------------------------------------

const pythonAdapter = new PythonAdapter();
const nodeAdapter = new NodeAdapter("node");
const typescriptAdapter = new NodeAdapter("typescript");

interface BaselineCase {
  name: string;
  input: AnyRecord;
  output: AnyRecord;
}

interface BaselineFixture {
  language: string;
  adapter: string;
  cases: {
    normalizeLaunchArgs: BaselineCase[];
    normalizeAttachArgs: BaselineCase[];
  };
}

function loadFixture(file: string): BaselineFixture {
  const raw = readFileSync(path.join(FIXTURE_DIR, file), "utf8");
  return JSON.parse(raw) as BaselineFixture;
}

// ---------------------------------------------------------------------------
// Part A: replay the captured baselines against the current adapters.
// ---------------------------------------------------------------------------

const fixtureTargets: Array<{
  file: string;
  adapter: PythonAdapter | NodeAdapter;
}> = [
  { file: "python.json", adapter: pythonAdapter },
  { file: "node.json", adapter: nodeAdapter },
  { file: "typescript.json", adapter: typescriptAdapter }
];

for (const { file, adapter } of fixtureTargets) {
  const fixture = loadFixture(file);

  for (const c of fixture.cases.normalizeLaunchArgs) {
    const actual = adapter.normalizeLaunchArgs({ ...c.input });
    assertJsonEqual(
      actual,
      c.output,
      `${file} normalizeLaunchArgs case "${c.name}" diverged from baseline`
    );
  }

  for (const c of fixture.cases.normalizeAttachArgs) {
    const actual = adapter.normalizeAttachArgs({ ...c.input });
    assertJsonEqual(
      actual,
      c.output,
      `${file} normalizeAttachArgs case "${c.name}" diverged from baseline`
    );
  }
}

console.log("Part A: baseline fixtures replayed against current adapters ok");

// ---------------------------------------------------------------------------
// Part B: independent reference model of the documented pre-feature transform.
// These re-implement the documented behavior independently of production code;
// the migrated adapters MUST stay equal to them for any generated input.
// ---------------------------------------------------------------------------

function modelPythonLaunch(args: AnyRecord): AnyRecord {
  if (args.dap) return args.dap as AnyRecord;
  return {
    program: args.program,
    module: args.module,
    args: args.args ?? [],
    cwd: args.cwd ?? args.workspaceRoot,
    env: args.env,
    justMyCode: args.justMyCode ?? true,
    stopOnEntry: args.stopOnEntry ?? false
  };
}

function modelPythonAttach(args: AnyRecord): AnyRecord {
  if (args.dap) return args.dap as AnyRecord;
  return {
    connect: {
      host: args.host ?? "127.0.0.1",
      port: Number(args.port ?? 5678)
    },
    justMyCode: args.justMyCode ?? true
  };
}

function modelNodeLaunch(args: AnyRecord): AnyRecord {
  if (args.dap) return args.dap as AnyRecord;
  return {
    type: "pwa-node",
    request: "launch",
    name: args.name ?? "BreakPilot Node Launch",
    program: args.program,
    args: args.args ?? [],
    cwd: args.cwd ?? args.workspaceRoot,
    env: args.env,
    stopOnEntry: args.stopOnEntry ?? false,
    sourceMaps: args.sourceMaps ?? true
  };
}

function modelNodeAttach(args: AnyRecord): AnyRecord {
  if (args.dap) return args.dap as AnyRecord;
  return {
    type: "pwa-node",
    request: "attach",
    name: args.name ?? "BreakPilot Node Attach",
    address: args.host ?? "127.0.0.1",
    port: Number(args.port ?? 9229),
    cwd: args.cwd ?? args.workspaceRoot,
    sourceMaps: args.sourceMaps ?? true
  };
}

// ---------------------------------------------------------------------------
// Generators: intelligently constrain to the documented input space (the keys
// the transforms actually read), with optional `dap` passthrough.
// ---------------------------------------------------------------------------

const smallString = fc.string({ maxLength: 16 });
const stringArray = fc.array(smallString, { maxLength: 4 });
const envObj = fc.dictionary(smallString, smallString, { maxKeys: 3 });
const portArb = fc.oneof(
  fc.integer({ min: 1, max: 65535 }),
  fc.integer({ min: 1, max: 65535 }).map((n) => String(n))
);
const dapArb = fc.record(
  {
    type: smallString,
    request: fc.constantFrom("launch", "attach"),
    program: smallString,
    address: smallString,
    custom: fc.integer()
  },
  { requiredKeys: [] }
);

const launchArgsArb: fc.Arbitrary<AnyRecord> = fc.record(
  {
    dap: dapArb,
    program: smallString,
    module: smallString,
    args: stringArray,
    cwd: smallString,
    workspaceRoot: smallString,
    env: envObj,
    name: smallString,
    justMyCode: fc.boolean(),
    stopOnEntry: fc.boolean(),
    sourceMaps: fc.boolean()
  },
  { requiredKeys: [] }
) as fc.Arbitrary<AnyRecord>;

const attachArgsArb: fc.Arbitrary<AnyRecord> = fc.record(
  {
    dap: dapArb,
    host: smallString,
    port: portArb,
    cwd: smallString,
    workspaceRoot: smallString,
    name: smallString,
    justMyCode: fc.boolean(),
    sourceMaps: fc.boolean()
  },
  { requiredKeys: [] }
) as fc.Arbitrary<AnyRecord>;

interface TransformTarget {
  label: string;
  fn: (args: AnyRecord) => AnyRecord;
  model: (args: AnyRecord) => AnyRecord;
  arb: fc.Arbitrary<AnyRecord>;
}

const transforms: TransformTarget[] = [
  {
    label: "PythonAdapter.normalizeLaunchArgs",
    fn: (a) => pythonAdapter.normalizeLaunchArgs(a),
    model: modelPythonLaunch,
    arb: launchArgsArb
  },
  {
    label: "PythonAdapter.normalizeAttachArgs",
    fn: (a) => pythonAdapter.normalizeAttachArgs(a),
    model: modelPythonAttach,
    arb: attachArgsArb
  },
  {
    label: "NodeAdapter(node).normalizeLaunchArgs",
    fn: (a) => nodeAdapter.normalizeLaunchArgs(a),
    model: modelNodeLaunch,
    arb: launchArgsArb
  },
  {
    label: "NodeAdapter(node).normalizeAttachArgs",
    fn: (a) => nodeAdapter.normalizeAttachArgs(a),
    model: modelNodeAttach,
    arb: attachArgsArb
  },
  {
    label: "NodeAdapter(typescript).normalizeLaunchArgs",
    fn: (a) => typescriptAdapter.normalizeLaunchArgs(a),
    model: modelNodeLaunch,
    arb: launchArgsArb
  },
  {
    label: "NodeAdapter(typescript).normalizeAttachArgs",
    fn: (a) => typescriptAdapter.normalizeAttachArgs(a),
    model: modelNodeAttach,
    arb: attachArgsArb
  }
];

for (const t of transforms) {
  fc.assert(
    fc.property(t.arb, (args) => {
      // Equality with the independent reference model (baseline transform).
      const actual = t.fn({ ...args });
      const expected = t.model({ ...args });
      assertJsonEqual(actual, expected, `${t.label} diverged from reference model`);

      // Determinism / stability: identical inputs yield identical output.
      const again = t.fn({ ...args });
      assertJsonEqual(actual, again, `${t.label} was not deterministic`);
    }),
    { numRuns: RUNS }
  );
}

console.log("Part B: model-based parity across adapters ok");
console.log("adapter baseline parity property tests ok");
