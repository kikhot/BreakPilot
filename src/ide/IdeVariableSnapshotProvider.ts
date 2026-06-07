import type { AnyRecord, BridgeMessage, RuntimeSnapshot } from "../types.ts";
import { DebugMcpError, ErrorCodes } from "../utils/errors.ts";
import { createDeferred, type Deferred, withTimeout } from "../utils/timeout.ts";
import { makeId } from "../utils/ids.ts";
import { IdeMessageTypes } from "./IdeProtocol.ts";
import { IdeBridgeServer } from "./IdeBridgeServer.ts";

export class IdeVariableSnapshotProvider {
  bridge?: IdeBridgeServer;
  pending: Map<string, Deferred<RuntimeSnapshot | AnyRecord>>;

  constructor(bridge?: IdeBridgeServer) {
    this.bridge = bridge;
    this.pending = new Map();
    bridge?.on(IdeMessageTypes.IDE_VARIABLES_SNAPSHOT, ({ message }: { message: BridgeMessage }) => {
      if (!message.requestId) return;
      const deferred = this.pending.get(message.requestId);
      if (!deferred) return;
      this.pending.delete(message.requestId);
      deferred.resolve(message.snapshot ?? {});
    });
  }

  async requestSnapshot(sessionId: string, options: AnyRecord = {}): Promise<RuntimeSnapshot | AnyRecord> {
    if (!this.bridge) {
      throw new DebugMcpError(ErrorCodes.IDE_NOT_CONNECTED, "IDE bridge is not available.");
    }
    const requestId = makeId("ide_snapshot");
    const deferred = createDeferred<RuntimeSnapshot | AnyRecord>();
    this.pending.set(requestId, deferred);
    this.bridge.broadcast({
      type: "agent_request_variables",
      requestId,
      sessionId,
      options
    });
    return withTimeout(
      deferred.promise,
      options.timeoutMs ?? 5000,
      () =>
        new DebugMcpError(ErrorCodes.IDE_SESSION_NOT_FOUND, "IDE variable snapshot timed out.", {
          sessionId,
          requestId
        })
    );
  }
}
