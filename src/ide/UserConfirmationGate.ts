import type { BridgeMessage } from "../types/ide.ts";
import type { AnyRecord } from "../types/json.ts";
import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";
import { createDeferred, type Deferred, withTimeout } from "../utils/timeout.ts";
import { makeId } from "../utils/ids.ts";
import { IdeMessageTypes } from "./IdeProtocol.ts";
import { IdeBridgeServer } from "./IdeBridgeServer.ts";

export interface ConfirmationResult {
  confirmed: boolean;
  action: string;
}

export class UserConfirmationGate {
  bridge?: IdeBridgeServer;
  timeoutMs: number;
  pending: Map<string, Deferred<ConfirmationResult>>;

  constructor({ bridge, timeoutMs = 30000 }: { bridge?: IdeBridgeServer; timeoutMs?: number } = {}) {
    this.bridge = bridge;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    bridge?.on(IdeMessageTypes.USER_CONFIRM_CONTINUE, ({ message }: { message: BridgeMessage }) => {
      this.#resolve(message.confirmationId, { confirmed: true, action: message.action ?? "continue" });
    });
    bridge?.on(IdeMessageTypes.USER_REJECT_CONTINUE, ({ message }: { message: BridgeMessage }) => {
      this.#resolve(message.confirmationId, { confirmed: false, action: "reject" });
    });
  }

  async request(payload: BridgeMessage, timeoutMs = this.timeoutMs): Promise<ConfirmationResult> {
    if (!this.bridge) {
      throw new BreakPilotError(ErrorCodes.IDE_NOT_CONNECTED, "IDE bridge is not available.");
    }
    const confirmationId = makeId("confirm");
    const deferred = createDeferred<ConfirmationResult>();
    this.pending.set(confirmationId, deferred);
    this.bridge.broadcast({
      ...payload,
      type: "agent_request_confirmation",
      confirmationId
    });
    return withTimeout(
      deferred.promise,
      timeoutMs,
      () =>
        new BreakPilotError(
          ErrorCodes.IDE_CONFIRMATION_TIMEOUT,
          "Timed out waiting for user confirmation.",
          { confirmationId, timeoutMs }
        )
    );
  }

  #resolve(confirmationId: string | undefined, value: ConfirmationResult): void {
    if (!confirmationId) return;
    const deferred = this.pending.get(confirmationId);
    if (!deferred) return;
    this.pending.delete(confirmationId);
    deferred.resolve(value);
  }
}
