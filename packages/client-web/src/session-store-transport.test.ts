import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectSessionStoreTransport,
  restartSessionStoreTransport,
  sessionStoreSocketCloseDecision,
} from "./session-store-transport";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback =
      typeof listener === "function"
        ? (event: unknown) => listener(event as Event)
        : (event: unknown) => listener.handleEvent(event as Event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  send() {
    // Subscription payloads are irrelevant to this transport lifecycle test.
  }

  close(code = 1000) {
    if (this.readyState >= FakeWebSocket.CLOSING) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  message(value: unknown) {
    this.emit("message", { data: JSON.stringify(value) });
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

test("stale socket close events cannot alter the active transport", () => {
  assert.equal(sessionStoreSocketCloseDecision(false, 1006), "ignore");
  assert.equal(sessionStoreSocketCloseDecision(false, 4001), "ignore");
});

test("only the active socket decides whether to reconnect", () => {
  assert.equal(sessionStoreSocketCloseDecision(true, 1006), "reconnect");
  assert.equal(sessionStoreSocketCloseDecision(true, 4001), "stop");
});

test("transport recovery waits for the restarted socket initial replay boundary", async () => {
  const originalWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });

  try {
    connectSessionStoreTransport({
      getReplayFromSeq: () => 42,
      isInitialLoaded: () => true,
      onBatch: () => undefined,
      onError: () => undefined,
      onOpen: () => undefined,
      onReplayGap: () => undefined,
      onStoredSessionsRefresh: () => undefined,
    });
    assert.equal(FakeWebSocket.instances.length, 1);

    let recovered = false;
    const recovery = restartSessionStoreTransport().then(() => {
      recovered = true;
    });
    assert.equal(FakeWebSocket.instances.length, 2);
    const restarted = FakeWebSocket.instances[1]!;

    restarted.open();
    await Promise.resolve();
    assert.equal(recovered, false);

    restarted.message({ events: [] });
    await Promise.resolve();
    assert.equal(recovered, false);

    restarted.message({ events: [], initial: true });
    await recovery;
    assert.equal(recovered, true);

    restarted.close(4001);
  } finally {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  }
});

test("transport recovery fails when the socket closes before initial replay", async () => {
  const originalWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });

  try {
    connectSessionStoreTransport({
      getReplayFromSeq: () => 42,
      isInitialLoaded: () => true,
      onBatch: () => undefined,
      onError: () => undefined,
      onOpen: () => undefined,
      onReplayGap: () => undefined,
      onStoredSessionsRefresh: () => undefined,
    });

    const recovery = restartSessionStoreTransport();
    const restarted = FakeWebSocket.instances[1]!;
    restarted.open();
    restarted.close(4001);

    await assert.rejects(recovery, /closed before initial replay/i);
  } finally {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  }
});

test("transport recovery observes cancellation while waiting for initial replay", async () => {
  const originalWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });

  try {
    connectSessionStoreTransport({
      getReplayFromSeq: () => 42,
      isInitialLoaded: () => true,
      onBatch: () => undefined,
      onError: () => undefined,
      onOpen: () => undefined,
      onReplayGap: () => undefined,
      onStoredSessionsRefresh: () => undefined,
    });

    const controller = new AbortController();
    const recovery = restartSessionStoreTransport({ signal: controller.signal });
    const restarted = FakeWebSocket.instances[1]!;
    restarted.open();
    controller.abort();

    await assert.rejects(recovery, /aborted/i);
    restarted.close(4001);
  } finally {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  }
});
