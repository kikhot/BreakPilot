import { randomUUID } from "node:crypto";

export type HandleDescriptor = {
  sessionId: string;
  pauseEpoch: number;
  dapVariablesReference: number;
  parentVariablesReference?: number;
  name: string;
  evaluateName?: string;
  threadId?: number;
  frameId?: number;
  modifiable?: boolean;
};

export class PauseScopedHandleRegistry {
  private readonly entries = new Map<string, HandleDescriptor>();
  private readonly maxEntries: number;

  constructor(maxEntries = 2048) {
    this.maxEntries = maxEntries;
  }

  register(descriptor: HandleDescriptor): string {
    const handle = `bpref_${randomUUID()}`;
    this.entries.set(handle, { ...descriptor });
    while (this.entries.size > Math.max(1, this.maxEntries)) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    return handle;
  }

  resolve(handle: string, sessionId: string, pauseEpoch: number): HandleDescriptor | undefined {
    const descriptor = this.entries.get(handle);
    if (!descriptor || descriptor.sessionId !== sessionId || descriptor.pauseEpoch !== pauseEpoch) return undefined;
    return { ...descriptor };
  }

  invalidateSession(sessionId: string): void {
    for (const [handle, descriptor] of this.entries) {
      if (descriptor.sessionId === sessionId) this.entries.delete(handle);
    }
  }
}
