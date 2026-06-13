import assert from "node:assert/strict";

import { ClientLeaseManager } from "../src/http/ClientLeaseManager.ts";

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let managedInactive = 0;
const managed = new ClientLeaseManager({
  lifecycle: "managed",
  ttlMs: 50,
  shutdownGraceMs: 20,
  onInactive: () => {
    managedInactive += 1;
  }
});

managed.acquire({ clientId: "mcp_1", kind: "mcp" });
assert.equal(managed.activeCount(), 1);
managed.heartbeat({ clientId: "mcp_1" });
managed.release({ clientId: "mcp_1" });
await delay(40);
assert.equal(managedInactive, 1);
managed.stop();

let persistentInactive = 0;
const persistent = new ClientLeaseManager({
  lifecycle: "persistent",
  ttlMs: 50,
  shutdownGraceMs: 20,
  onInactive: () => {
    persistentInactive += 1;
  }
});
persistent.acquire({ clientId: "mcp_2", kind: "mcp" });
persistent.release({ clientId: "mcp_2" });
await delay(40);
assert.equal(persistentInactive, 0);
persistent.stop();

console.log("client lease manager tests ok");
