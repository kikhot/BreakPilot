/**
 * Regression tests for DapSession start (#start) error surfacing.
 *
 * Runner: node --experimental-strip-types test/dap-session-start.test.ts
 *
 * Reproduces the masked-launch-failure bug: an adapter that emits the
 * `initialized` event (resolving the start race) but then rejects the
 * `launch`/`attach` request used to report a healthy session. Before the fix,
 * `#start` resolved via the `initialized` branch and swallowed the rejection,
 * so a doomed session was reported RUNNING and only failed much later with an
 * opaque "No active debug session" / breakpoint-never-binds symptom.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { DapClient } from "../src/dap/DapClient.ts";
import { DapSession } from "../src/dap/DapSession.ts";
import { BreakPilotError, ErrorCodes } from "../src/utils/errors.ts";
import type { DapTransport } from "../src/types/dap.ts";

interface FakeBehavior {
  /** Whether to emit an `initialized` event in response to `initialize`. */
  emitInitialized?: boolean;
  /** Commands that should be answered with an error response. */
  failCommands?: Record<string, string>;
  /** Delay (ms) before sending the response for a given command. */
  responseDelayMs?: Record<string, number>;
}

/**
 * Minimal in-memory DAP transport that frames responses/events exactly like a
 * real adapter so DapClient can parse them.
 */
class FakeTransport extends EventEmitter implements DapTransport {
  #behavior: FakeBehavior;
  #buffer = Buffer.alloc(0);
  closeCount = 0;

  constructor(behavior: FakeBehavior) {
    super();
    this.#behavior = behavior;
  }

  start(): void {
    /* nothing to spawn */
  }

  close(): void {
    this.closeCount += 1;
  }

  write(buffer: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, buffer]);
    // Parse one framed message at a time.
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.#buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.#buffer = this.#buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      const end = start + length;
      if (this.#buffer.length < end) return;
      const payload = this.#buffer.slice(start, end).toString("utf8");
      this.#buffer = this.#buffer.slice(end);
      this.#handleRequest(JSON.parse(payload));
    }
  }

  #handleRequest(message: { seq: number; command: string }): void {
    const { command, seq } = message;
    const send = () => {
      const failMessage = this.#behavior.failCommands?.[command];
      if (failMessage) {
        this.#send({
          type: "response",
          request_seq: seq,
          success: false,
          command,
          message: failMessage
        });
        return;
      }
      this.#send({ type: "response", request_seq: seq, success: true, command, body: {} });
      if (command === "initialize" && this.#behavior.emitInitialized) {
        this.#send({ type: "event", event: "initialized", body: {} });
      }
    };
    const delay = this.#behavior.responseDelayMs?.[command];
    if (delay && delay > 0) setTimeout(send, delay);
    else queueMicrotask(send);
  }

  #send(message: Record<string, unknown>): void {
    const json = JSON.stringify({ seq: 0, ...message });
    const length = Buffer.byteLength(json, "utf8");
    this.emit("data", Buffer.from(`Content-Length: ${length}\r\n\r\n${json}`, "utf8"));
  }
}

function makeSession(behavior: FakeBehavior): DapSession {
  const transport = new FakeTransport(behavior);
  const client = new DapClient(transport);
  const session = new DapSession({
    sessionId: "sess_test",
    language: "java",
    client,
    workspaceRoot: "/tmp"
  });
  session.startClient();
  return session;
}

test("launch rejects when the adapter errors the launch request after initialized", async () => {
  const session = makeSession({
    emitInitialized: true,
    failCommands: { launch: "mainClass is required" }
  });
  await session.initialize("java");
  await assert.rejects(
    () => session.launch({ startGraceMs: 1000 }),
    (error: unknown) => {
      assert.ok(error instanceof BreakPilotError);
      assert.equal((error as BreakPilotError).message, "mainClass is required");
      return true;
    }
  );
});

test("waitForBreakpoint fails fast with the start error instead of timing out", async () => {
  const session = makeSession({
    emitInitialized: true,
    failCommands: { launch: "mainClass is required" }
  });
  await session.initialize("java");
  await session.launch({ startGraceMs: 1000 }).catch(() => {});
  const begin = Date.now();
  await assert.rejects(
    () => session.waitForBreakpoint(5000),
    (error: unknown) => {
      assert.ok(error instanceof BreakPilotError);
      assert.equal((error as BreakPilotError).message, "mainClass is required");
      return true;
    }
  );
  assert.ok(Date.now() - begin < 4000, "should not block for the full waitForBreakpoint timeout");
});

test("launch still succeeds via the initialized race when the adapter delays its response", async () => {
  const session = makeSession({
    emitInitialized: true,
    responseDelayMs: { launch: 5000 }
  });
  await session.initialize("java");
  const result = await session.launch({ startGraceMs: 200 });
  assert.deepEqual(result, { initialized: true });
});

test("disposing a DAP session twice settles pending initialized and stopped waits once", async () => {
  const session = makeSession({ responseDelayMs: { launch: 100 } });
  const transport = session.client.transport as FakeTransport;
  const launch = session.launch({
    timeoutMs: 100,
    initializedTimeoutMs: 100,
    startGraceMs: 10
  }).then(
    () => ({ outcome: "resolved" as const }),
    (error: unknown) => ({ outcome: "rejected" as const, error })
  );
  const stopped = session.waitForBreakpoint(100).then(
    () => ({ outcome: "resolved" as const }),
    (error: unknown) => ({ outcome: "rejected" as const, error })
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(session.initializedWaiters.length, 1);
  assert.equal(session.stoppedWaiters.length, 1);
  assert.equal(session.client.pending.size, 1);

  session.disposeClient();
  session.disposeClient();
  const settled = await Promise.race([
    Promise.all([launch, stopped]),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 25))
  ]);

  assert.ok(settled, "disposing should settle waits without waiting for their timeouts");
  for (const result of settled) {
    assert.equal(result.outcome, "rejected");
    assert.ok(result.error instanceof BreakPilotError);
    assert.equal(result.error.code, ErrorCodes.TARGET_PROCESS_EXITED);
  }
  assert.deepEqual(session.initializedWaiters, []);
  assert.deepEqual(session.stoppedWaiters, []);
  assert.equal(session.client.pending.size, 0);
  assert.equal(transport.closeCount, 1);
});
