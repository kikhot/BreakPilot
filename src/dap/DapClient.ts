import { EventEmitter } from "node:events";
import type { DapMessage, DapResponseMessage, DapTransport } from "../types/dap.ts";
import type { AnyRecord } from "../types/json.ts";
import { BreakPilotError, ErrorCodes } from "../utils/errors.ts";
import { withTimeout } from "../utils/timeout.ts";

interface PendingRequest {
  resolve: (value: AnyRecord) => void;
  reject: (reason?: unknown) => void;
  command: string;
}

export class DapClient extends EventEmitter {
  transport: DapTransport;
  seq: number;
  pending: Map<number, PendingRequest>;
  buffer: Buffer;
  defaultTimeoutMs: number;
  stderr: string[];

  constructor(transport: DapTransport, options: { defaultTimeoutMs?: number } = {}) {
    super();
    this.transport = transport;
    this.seq = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10000;
    this.stderr = [];
  }

  start(): void {
    this.transport.on("data", (chunk: Buffer) => this.#onData(chunk));
    this.transport.on("stderr", (text: string) => {
      this.stderr.push(text);
      this.emit("stderr", text);
    });
    this.transport.on("error", (error: Error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (this.listenerCount("error") > 0) this.emit("error", error);
      this.emit("adapterError", error);
    });
    this.transport.on("exit", (info: AnyRecord) => {
      const error = new BreakPilotError(
        ErrorCodes.TARGET_PROCESS_EXITED,
        "Debug adapter exited.",
        { ...info, stderr: this.stderr.slice(-10).join("") }
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.emit("exit", info);
    });
    this.transport.start();
  }

  async request(command: string, args: AnyRecord = {}, timeoutMs = this.defaultTimeoutMs): Promise<AnyRecord> {
    const seq = this.seq;
    this.seq += 1;
    const message = {
      seq,
      type: "request",
      command,
      arguments: args
    };
    const responsePromise = new Promise<AnyRecord>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject, command });
    });
    this.#send(message);
    try {
      return await withTimeout(
        responsePromise,
        timeoutMs,
        () =>
          new BreakPilotError(ErrorCodes.TOOL_FAILED, `DAP request timed out: ${command}`, {
            command,
            timeoutMs
          })
      );
    } catch (error) {
      this.pending.delete(seq);
      throw error;
    }
  }

  sendEvent(event: string, body: AnyRecord = {}): void {
    this.#send({
      seq: this.seq++,
      type: "event",
      event,
      body
    });
  }

  close(): void {
    this.transport.close();
  }

  #send(message: DapMessage): void {
    const json = JSON.stringify(message);
    const length = Buffer.byteLength(json, "utf8");
    this.transport.write(Buffer.from(`Content-Length: ${length}\r\n\r\n${json}`, "utf8"));
  }

  #onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.emit("protocolError", { header });
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = Number(lengthMatch[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) return;
      const payload = this.buffer.slice(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);
      this.#handleMessage(JSON.parse(payload));
    }
  }

  #handleMessage(message: DapMessage): void {
    if (message.type === "response") {
      const response = message as DapResponseMessage;
      const pending = this.pending.get(response.request_seq);
      if (!pending) {
        this.emit("orphanResponse", message);
        return;
      }
      this.pending.delete(response.request_seq);
      if (response.success) {
        pending.resolve(response.body ?? {});
      } else {
        pending.reject(
          new BreakPilotError(
            ErrorCodes.TOOL_FAILED,
            response.message || `DAP request failed: ${pending.command}`,
            {
              command: pending.command,
              response
            }
          )
        );
      }
      return;
    }
    if (message.type === "event") {
      const event = message as { event: string; body?: AnyRecord };
      this.emit("event", message);
      this.emit(String(event.event), event.body ?? {});
      return;
    }
    this.emit("message", message);
  }
}
