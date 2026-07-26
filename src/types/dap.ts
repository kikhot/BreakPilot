import type { AnyRecord } from "./json.ts";

export interface DapTransport {
  on(event: string, listener: (...args: any[]) => void): this;
  start(): void;
  write(buffer: Buffer): void;
  close(): void;
}

export interface DapRequestMessage {
  seq: number;
  type: "request";
  command: string;
  arguments?: AnyRecord;
}

export interface DapResponseMessage {
  seq: number;
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: AnyRecord;
}

export interface DapEventMessage {
  seq: number;
  type: "event";
  event: string;
  body?: AnyRecord;
}

export type DapMessage = DapRequestMessage | DapResponseMessage | DapEventMessage | AnyRecord;

export interface DapVariable {
  name: string;
  value?: string;
  type?: string;
  variablesReference?: number;
  indexedVariables?: number;
  namedVariables?: number;
  memoryReference?: string;
  [key: string]: any;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
  [key: string]: any;
}

export interface DapStackFrame {
  id: number;
  name?: string;
  line?: number;
  column?: number;
  source?: AnyRecord;
  [key: string]: any;
}

export interface DapBreakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  line?: number;
  column?: number;
  [key: string]: any;
}

export interface DapGotoTarget {
  id: number;
  label: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  [key: string]: any;
}

export interface DapGotoTargetsResponse {
  targets?: DapGotoTarget[];
  [key: string]: any;
}

export interface StoppedEvent {
  sessionId?: string;
  reason?: string;
  threadId?: number;
  description?: string;
  allThreadsStopped?: boolean;
  [key: string]: any;
}

/** A causal snapshot used to wait only for a stop/terminal event observed later. */
export interface FreshStopBoundary {
  stopSequence: number;
  terminalSequence: number;
}

export type FreshStopResult = StoppedEvent | { terminated: true };
