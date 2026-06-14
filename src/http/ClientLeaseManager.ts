import type { AnyRecord } from "../types/json.ts";

export type DaemonLifecycle = "managed" | "persistent";

export interface ClientLeasePayload {
  clientId?: string;
  kind?: string;
  pid?: number;
}

export interface ClientLeaseManagerOptions {
  lifecycle: DaemonLifecycle;
  ttlMs?: number;
  shutdownGraceMs?: number;
  onInactive?: () => void | Promise<void>;
}

interface ClientLease {
  clientId: string;
  kind: string;
  pid?: number;
  acquiredAt: string;
  lastHeartbeatAt: number;
}

export class ClientLeaseManager {
  readonly lifecycle: DaemonLifecycle;
  readonly ttlMs: number;
  readonly shutdownGraceMs: number;
  readonly onInactive?: () => void | Promise<void>;
  readonly leases = new Map<string, ClientLease>();
  private sweepTimer: NodeJS.Timeout;
  private shutdownTimer: NodeJS.Timeout | null = null;

  constructor({
    lifecycle,
    ttlMs = 15000,
    shutdownGraceMs = 2000,
    onInactive
  }: ClientLeaseManagerOptions) {
    this.lifecycle = lifecycle;
    this.ttlMs = ttlMs;
    this.shutdownGraceMs = shutdownGraceMs;
    this.onInactive = onInactive;
    this.sweepTimer = setInterval(() => this.sweepExpired(), Math.max(1000, Math.floor(ttlMs / 3)));
    this.sweepTimer.unref?.();
  }

  acquire(payload: ClientLeasePayload = {}): AnyRecord {
    const clientId = payload.clientId || `client_${Date.now().toString(36)}`;
    this.cancelInactiveShutdown();
    this.leases.set(clientId, {
      clientId,
      kind: payload.kind ?? "unknown",
      pid: payload.pid,
      acquiredAt: new Date().toISOString(),
      lastHeartbeatAt: Date.now()
    });
    return this.status(clientId);
  }

  heartbeat(payload: ClientLeasePayload = {}): AnyRecord {
    const clientId = payload.clientId;
    if (!clientId || !this.leases.has(clientId)) {
      return { ok: false, error: { message: "Unknown client lease." }, activeClients: this.activeCount() };
    }
    const lease = this.leases.get(clientId);
    if (lease) lease.lastHeartbeatAt = Date.now();
    return this.status(clientId);
  }

  release(payload: ClientLeasePayload = {}): AnyRecord {
    if (payload.clientId) this.leases.delete(payload.clientId);
    this.scheduleInactiveShutdownIfNeeded();
    return this.status(payload.clientId);
  }

  status(clientId?: string): AnyRecord {
    return {
      ok: true,
      clientId,
      lifecycle: this.lifecycle,
      activeClients: this.activeCount(),
      ttlMs: this.ttlMs
    };
  }

  activeCount(): number {
    this.sweepExpired(false);
    return this.leases.size;
  }

  stop(): void {
    clearInterval(this.sweepTimer);
    this.cancelInactiveShutdown();
    this.leases.clear();
  }

  private sweepExpired(schedule = true): void {
    const now = Date.now();
    for (const [clientId, lease] of this.leases.entries()) {
      if (now - lease.lastHeartbeatAt > this.ttlMs) this.leases.delete(clientId);
    }
    if (schedule) this.scheduleInactiveShutdownIfNeeded();
  }

  private scheduleInactiveShutdownIfNeeded(): void {
    if (this.lifecycle !== "managed") return;
    if (this.leases.size > 0 || this.shutdownTimer) return;
    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.leases.size === 0) void Promise.resolve(this.onInactive?.());
    }, this.shutdownGraceMs);
    this.shutdownTimer.unref?.();
  }

  private cancelInactiveShutdown(): void {
    if (!this.shutdownTimer) return;
    clearTimeout(this.shutdownTimer);
    this.shutdownTimer = null;
  }
}
