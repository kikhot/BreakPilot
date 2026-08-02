import assert from "node:assert/strict";
import test from "node:test";

import { AgentDebugPresenter } from "../src/control/AgentDebugPresenter.ts";
import { AgentHandleRegistry } from "../src/runtime/AgentHandleRegistry.ts";
import { ErrorCodes } from "../src/utils/errors.ts";

test("pause-scoped provider references become stable short handles", () => {
  const registry = new AgentHandleRegistry();
  registry.beginPause("session-a", 7);

  const first = registry.register("session-a", 7, {
    providerRef: "bpref_uuid-value",
    name: "user",
    path: ["user"],
    modifiable: true
  });
  const repeated = registry.register("session-a", 7, {
    providerRef: "bpref_uuid-value",
    name: "user",
    path: ["user"],
    modifiable: true
  });
  const second = registry.register("session-a", 7, {
    providerRef: 42,
    name: "order",
    path: ["order"]
  });

  assert.equal(first, "v1");
  assert.equal(repeated, "v1");
  assert.equal(second, "v2");
  assert.equal(registry.resolve("session-a", 7, first).providerRef, "bpref_uuid-value");
});
test("a newer pause rejects every handle from the previous pause", () => {
  const registry = new AgentHandleRegistry();
  registry.beginPause("session-a", 7);
  const handle = registry.register("session-a", 7, {
    providerRef: 42,
    name: "order",
    path: ["order"]
  });
  registry.beginPause("session-a", 8);

  assert.throws(
    () => registry.resolve("session-a", 8, handle),
    (error: unknown) => (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === ErrorCodes.STALE_RUNTIME_HANDLE
    )
  );
});

test("semantic presenter emits relative locations and native scalar values", () => {
  const registry = new AgentHandleRegistry();
  registry.beginPause("session-a", 3);
  const presenter = new AgentDebugPresenter({
    workspaceRoot: "/workspace/demo",
    sessionId: "session-a",
    pauseId: 3,
    handles: registry,
    detail: "compact"
  });

  assert.deepEqual(presenter.location({
    name: "hello",
    line: 21,
    column: 4,
    source: { path: "/workspace/demo/src/HelloController.java" }
  }), {
    filePath: "src/HelloController.java",
    line: 21,
    column: 4,
    function: "hello"
  });

  assert.deepEqual(presenter.value({
    name: "count",
    label: "count",
    kind: "number",
    summary: "3",
    raw: "3",
    expandable: false,
    truncated: false
  }), { name: "count", value: 3 });

  assert.deepEqual(presenter.value({
    name: "enabled",
    label: "enabled",
    kind: "boolean",
    summary: "false",
    expandable: false,
    truncated: false
  }), { name: "enabled", value: false });
});

test("semantic presenter removes provider metadata and groups scopes", () => {
  const registry = new AgentHandleRegistry();
  registry.beginPause("session-a", 3);
  const presenter = new AgentDebugPresenter({
    workspaceRoot: "/workspace/demo",
    sessionId: "session-a",
    pauseId: 3,
    handles: registry,
    detail: "compact"
  });
  const node = {
    name: "name",
    label: "name",
    type: "String",
    kind: "primitive" as const,
    summary: "Ada-Lovelace",
    path: ["name"],
    ref: "bpref_long-provider-id",
    pauseEpoch: 3,
    modifiable: true,
    mutationMode: "native" as const,
    expandable: true,
    truncated: false
  };

  assert.deepEqual(presenter.scopes([
    { scope: "Locals", category: "locals", items: [node] },
    { scope: "Registers", category: "runtime", items: [] }
  ]), {
    locals: [{
      name: "name",
      value: "Ada-Lovelace",
      type: "String",
      handle: "v1",
      mutable: true
    }]
  });
});

test("diagnostic projection omits undefined values and applies fixed bounds", () => {
  const presenter = new AgentDebugPresenter({
    workspaceRoot: "/workspace/demo",
    sessionId: "session-a",
    pauseId: 3,
    handles: new AgentHandleRegistry(),
    detail: "diagnostic"
  });

  const projected = presenter.withDiagnostics({ state: "running" }, {
    provider: {
      absent: undefined,
      text: "x".repeat(500),
      items: Array.from({ length: 30 }, (_, index) => index)
    }
  });

  const diagnostics = (projected as typeof projected & { diagnostics: any }).diagnostics;
  assert.equal(JSON.stringify(projected).includes("undefined"), false);
  assert.equal((diagnostics.provider.text as string).length, 200);
  assert.equal((diagnostics.provider.items as unknown[]).length, 20);
  assert.equal("absent" in diagnostics.provider, false);
});
