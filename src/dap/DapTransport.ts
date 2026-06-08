import { EventEmitter } from "node:events";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import type { DapTransport } from "../types.ts";
import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";

interface ProcessTransportOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

interface ServerProcessTransportOptions extends ProcessTransportOptions {
  host: string;
  port: number;
  connectTimeoutMs?: number;
}

export class DapProcessTransport extends EventEmitter implements DapTransport {
  command: string;
  args: string[];
  options: ProcessTransportOptions;
  process: ChildProcessWithoutNullStreams | null;

  constructor(command: string, args: string[] = [], options: ProcessTransportOptions = {}) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.process = null;
  }

  start(): void {
    const child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process = child;
    child.stdout.on("data", (chunk: Buffer) => this.emit("data", chunk));
    child.stderr.on("data", (chunk) => this.emit("stderr", chunk.toString("utf8")));
    child.on("error", (error) => this.emit("error", error));
    child.on("exit", (code, signal) => this.emit("exit", { code, signal }));
  }

  write(buffer: Buffer): void {
    if (!this.process?.stdin?.writable) {
      throw new BreakPilotError(
        ErrorCodes.ADAPTER_START_FAILED,
        "Debug adapter process stdin is not writable."
      );
    }
    this.process.stdin.write(buffer);
  }

  close(): void {
    this.process?.kill();
  }
}

export class DapSocketTransport extends EventEmitter implements DapTransport {
  host: string;
  port: number;
  socket: net.Socket | null;

  constructor(host: string, port: number) {
    super();
    this.host = host;
    this.port = port;
    this.socket = null;
  }

  start(): void {
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.on("connect", () => this.emit("connect"));
    this.socket.on("data", (chunk) => this.emit("data", chunk));
    this.socket.on("error", (error) => this.emit("error", error));
    this.socket.on("close", () => this.emit("exit", { code: 0, signal: null }));
  }

  write(buffer: Buffer): void {
    if (!this.socket?.writable) {
      throw new BreakPilotError(ErrorCodes.ATTACH_FAILED, "DAP socket is not writable.");
    }
    this.socket.write(buffer);
  }

  close(): void {
    this.socket?.end();
  }
}

export class DapServerProcessTransport extends EventEmitter implements DapTransport {
  command: string;
  args: string[];
  options: ServerProcessTransportOptions;
  process: ChildProcess | null;
  socket: net.Socket | null;
  pendingWrites: Buffer[];
  connected: boolean;
  closed: boolean;

  constructor(command: string, args: string[] = [], options: ServerProcessTransportOptions) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.process = null;
    this.socket = null;
    this.pendingWrites = [];
    this.connected = false;
    this.closed = false;
  }

  start(): void {
    const child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.process = child;
    child.stdout?.on("data", (chunk: Buffer) => this.emit("stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => this.emit("stderr", chunk.toString("utf8")));
    child.on("error", (error) => this.emit("error", error));
    child.on("exit", (code, signal) => {
      if (!this.closed) this.emit("exit", { code, signal });
    });
    this.#connectWithRetry(Date.now());
  }

  write(buffer: Buffer): void {
    if (this.socket?.writable && this.connected) {
      this.socket.write(buffer);
      return;
    }
    this.pendingWrites.push(buffer);
  }

  close(): void {
    this.closed = true;
    this.socket?.end();
    this.process?.kill();
  }

  #connectWithRetry(startedAt: number): void {
    if (this.closed) return;
    const socket = net.createConnection({ host: this.options.host, port: this.options.port });
    let didConnect = false;

    socket.once("connect", () => {
      didConnect = true;
      this.connected = true;
      this.socket = socket;
      socket.on("data", (chunk: Buffer) => this.emit("data", chunk));
      socket.on("error", (error) => this.emit("error", error));
      socket.on("close", () => {
        this.connected = false;
        if (!this.closed) this.emit("exit", { code: 0, signal: null });
      });
      for (const pending of this.pendingWrites.splice(0)) socket.write(pending);
      this.emit("connect");
    });

    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      const elapsed = Date.now() - startedAt;
      const timeoutMs = this.options.connectTimeoutMs ?? 5000;
      if (!didConnect && error.code === "ECONNREFUSED" && elapsed < timeoutMs) {
        setTimeout(() => this.#connectWithRetry(startedAt), 100);
        return;
      }
      this.emit("error", error);
    });
  }
}
