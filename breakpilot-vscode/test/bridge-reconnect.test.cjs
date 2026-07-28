const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

class Disposable {
  constructor(dispose = () => {}) { this.dispose = dispose; }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };
  }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  sent = [];

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
}

const fakeVscode = {
  Disposable,
  EventEmitter,
  workspace: {
    workspaceFolders: undefined,
    onDidChangeWorkspaceFolders: () => new Disposable(),
    getConfiguration: () => ({ inspect: () => undefined })
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "vscode") return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { BridgeClient } = require("../out/bridge/BridgeClient.js");
Module._load = originalLoad;

test("reconnect drops stale queued bridge messages before registration", () => {
  const originalWebSocket = global.WebSocket;
  global.WebSocket = FakeWebSocket;
  const subscriptions = [];
  const bridge = new BridgeClient({ subscriptions });
  try {
    bridge.send({ type: "ide_command_result", requestId: "stale-request" });
    bridge.connect("ws://127.0.0.1:57987/bridge");
    const socket = FakeWebSocket.instances.at(-1);
    socket.open();

    assert.deepEqual(socket.sent.map((message) => message.type), ["ide_register"]);
    assert.equal(socket.sent.some((message) => message.requestId === "stale-request"), false);
  } finally {
    bridge.dispose();
    global.WebSocket = originalWebSocket;
    for (const subscription of subscriptions) subscription.dispose?.();
  }
});

test("late callbacks from an old socket cannot affect its replacement", () => {
  const originalWebSocket = global.WebSocket;
  global.WebSocket = FakeWebSocket;
  const subscriptions = [];
  const bridge = new BridgeClient({ subscriptions });
  const received = [];
  bridge.onMessage((message) => { received.push(message); });
  try {
    bridge.connect("ws://127.0.0.1:57987/one");
    const oldSocket = FakeWebSocket.instances.at(-1);
    bridge.connect("ws://127.0.0.1:57987/two");
    const currentSocket = FakeWebSocket.instances.at(-1);

    oldSocket.open();
    oldSocket.onmessage?.({ data: JSON.stringify({ type: "agent_request_variables", requestId: "old" }) });
    assert.equal(received.some((message) => message.requestId === "old"), false);
    assert.deepEqual(oldSocket.sent, []);

    currentSocket.open();
    oldSocket.onclose?.();
    bridge.send({ type: "ide_heartbeat" });
    assert.deepEqual(currentSocket.sent.map((message) => message.type), ["ide_register", "ide_heartbeat"]);
  } finally {
    bridge.dispose();
    global.WebSocket = originalWebSocket;
    for (const subscription of subscriptions) subscription.dispose?.();
  }
});
