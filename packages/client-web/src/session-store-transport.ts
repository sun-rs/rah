import type { EventBatch, RahEvent } from "@rah/runtime-protocol";
import * as api from "./api";

type SessionStoreTransportCallbacks = {
  getReplayFromSeq: () => number | undefined;
  isInitialLoaded: () => boolean;
  onBatch: (batch: EventBatch) => void | boolean;
  onError: (error: Error) => void;
  onOpen: () => void;
  onReplayGap: (batch: EventBatch) => void;
  onStoredSessionsRefresh: (events: RahEvent[]) => void;
};

type RestartSessionStoreTransportOptions = {
  signal?: AbortSignal;
};

type InitialReplayWaiter = {
  socket: WebSocket;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  detachAbort: () => void;
};

let callbacks: SessionStoreTransportCallbacks | null = null;
let eventsSocket: WebSocket | null = null;
let initialReplayReadySocket: WebSocket | null = null;
let initialReplayWaiter: InitialReplayWaiter | null = null;
let reconnectTimer: number | null = null;
let storedSessionsRefreshTimer: number | null = null;
let pendingStoredSessionEvents: RahEvent[] = [];
const MAX_PENDING_STORED_SESSION_EVENTS = 512;
let reconnectAttempt = 0;

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function settleInitialReplayWaiter(socket: WebSocket, error?: Error) {
  const waiter = initialReplayWaiter;
  if (!waiter || waiter.socket !== socket) {
    return;
  }
  initialReplayWaiter = null;
  waiter.detachAbort();
  if (error) {
    waiter.reject(error);
  } else {
    waiter.resolve();
  }
}

function rejectCurrentInitialReplayWaiter(error: Error) {
  const waiter = initialReplayWaiter;
  if (!waiter) {
    return;
  }
  settleInitialReplayWaiter(waiter.socket, error);
}

function waitForInitialReplay(
  socket: WebSocket,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (initialReplayReadySocket === socket) {
    return Promise.resolve();
  }
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (initialReplayWaiter?.socket === socket) {
    return initialReplayWaiter.promise;
  }
  rejectCurrentInitialReplayWaiter(createAbortError());

  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const handleAbort = () => settleInitialReplayWaiter(socket, createAbortError());
  signal?.addEventListener("abort", handleAbort, { once: true });
  initialReplayWaiter = {
    socket,
    promise,
    resolve,
    reject,
    detachAbort: () => signal?.removeEventListener("abort", handleAbort),
  };
  return promise;
}

export function sessionStoreSocketCloseDecision(
  isCurrentSocket: boolean,
  closeCode: number,
): "ignore" | "stop" | "reconnect" {
  if (!isCurrentSocket) {
    return "ignore";
  }
  return closeCode === 4001 ? "stop" : "reconnect";
}

export function sessionStoreTransportIsHealthy(): boolean {
  return (
    eventsSocket !== null &&
    eventsSocket.readyState === WebSocket.OPEN &&
    initialReplayReadySocket === eventsSocket
  );
}

/**
 * Establish the causal boundary required before a command can create new
 * Session events. Waiting on the current socket is important: restarting a
 * CONNECTING socket here would create another blind window and could discard
 * the very replay that closes it.
 */
export function ensureSessionStoreTransportReady(
  options: RestartSessionStoreTransportOptions = {},
): Promise<void> {
  // Store commands are also exercised in non-browser adapters and unit tests,
  // where there is no event transport and therefore no replay boundary to
  // await. In an actual browser, an uninitialized transport remains a hard
  // error so activation can never silently bypass the causal barrier.
  if (typeof window === "undefined" && callbacks === null) {
    return Promise.resolve();
  }
  const socket = eventsSocket;
  if (socket && socket.readyState < WebSocket.CLOSING) {
    return waitForInitialReplay(socket, options.signal);
  }
  return restartSessionStoreTransport(options);
}

function nextReconnectDelayMs(): number {
  const delay = Math.min(30_000, 750 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  return delay;
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleStoredSessionsRefresh(events: RahEvent[]) {
  pendingStoredSessionEvents = [
    ...pendingStoredSessionEvents,
    ...events,
  ].slice(-MAX_PENDING_STORED_SESSION_EVENTS);
  if (storedSessionsRefreshTimer !== null) {
    return;
  }
  storedSessionsRefreshTimer = window.setTimeout(() => {
    storedSessionsRefreshTimer = null;
    const eventsToFlush = pendingStoredSessionEvents;
    pendingStoredSessionEvents = [];
    callbacks?.onStoredSessionsRefresh(eventsToFlush);
  }, 150);
}

export function connectSessionStoreTransport(
  nextCallbacks: SessionStoreTransportCallbacks,
): WebSocket | null {
  callbacks = nextCallbacks;
  if (eventsSocket && eventsSocket.readyState < WebSocket.CLOSING) {
    return eventsSocket;
  }
  const replayFromSeq = nextCallbacks.getReplayFromSeq();
  const socket = api.createEventsSocket(
    replayFromSeq === undefined ? {} : { replayFromSeq },
    (batch) => {
      if (eventsSocket !== socket) {
        return;
      }
      const storedSessionEvents = batch.events?.filter((event) => event.type === "session.discovery") ?? [];
      if (storedSessionEvents.length > 0) {
        scheduleStoredSessionsRefresh(storedSessionEvents);
      }
      if (batch.replayGap) {
        nextCallbacks.onReplayGap(batch);
      } else {
        const accepted = nextCallbacks.onBatch(batch);
        if (accepted === false && socket.readyState < WebSocket.CLOSING) {
          socket.close(1013, "Client event backlog exceeded render budget");
        }
      }
      if (batch.initial && batch.replayComplete !== false) {
        initialReplayReadySocket = socket;
        settleInitialReplayWaiter(socket);
      }
    },
    (error) => {
      if (eventsSocket !== socket) {
        return;
      }
      settleInitialReplayWaiter(socket, error);
      nextCallbacks.onError(error);
      if (socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
    },
    {
      onOpen: () => {
        if (eventsSocket !== socket) {
          return;
        }
        reconnectAttempt = 0;
        nextCallbacks.onOpen();
      },
      onClose: (event) => {
        const decision = sessionStoreSocketCloseDecision(eventsSocket === socket, event.code);
        if (decision === "ignore") {
          return;
        }
        if (initialReplayReadySocket === socket) {
          initialReplayReadySocket = null;
        }
        settleInitialReplayWaiter(
          socket,
          new Error("Events socket closed before initial replay completed."),
        );
        eventsSocket = null;
        clearReconnectTimer();
        if (decision === "reconnect" && callbacks) {
          const delayMs = nextReconnectDelayMs();
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            if (callbacks) {
              connectSessionStoreTransport(callbacks);
            }
          }, delayMs);
        }
      },
    },
  );
  eventsSocket = socket;

  if (!nextCallbacks.isInitialLoaded()) {
    eventsSocket = null;
    socket.close();
    return null;
  }
  return socket;
}

export function restartSessionStoreTransport(
  options: RestartSessionStoreTransportOptions = {},
): Promise<void> {
  clearReconnectTimer();
  reconnectAttempt = 0;
  rejectCurrentInitialReplayWaiter(createAbortError());
  const socket = eventsSocket;
  eventsSocket = null;
  if (initialReplayReadySocket === socket) {
    initialReplayReadySocket = null;
  }
  if (socket && socket.readyState < WebSocket.CLOSING) {
    socket.close();
  }
  if (!callbacks) {
    return Promise.reject(new Error("Events transport is not initialized."));
  }
  const restartedSocket = connectSessionStoreTransport(callbacks);
  if (!restartedSocket) {
    return Promise.reject(new Error("Events transport is not ready to connect."));
  }
  return waitForInitialReplay(restartedSocket, options.signal);
}
