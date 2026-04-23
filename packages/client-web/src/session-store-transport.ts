import type { EventBatch } from "@rah/runtime-protocol";
import * as api from "./api";

type SessionStoreTransportCallbacks = {
  getReplayFromSeq: () => number | undefined;
  isInitialLoaded: () => boolean;
  onBatch: (batch: EventBatch) => void;
  onError: (error: Error) => void;
  onOpen: () => void;
  onReplayGap: (batch: EventBatch) => void;
  onStoredSessionsRefresh: () => void;
};

let callbacks: SessionStoreTransportCallbacks | null = null;
let eventsSocket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let storedSessionsRefreshTimer: number | null = null;
let suppressNextSocketCloseReconnect = false;
let reconnectAttempt = 0;

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

function scheduleStoredSessionsRefresh() {
  if (storedSessionsRefreshTimer !== null) {
    return;
  }
  storedSessionsRefreshTimer = window.setTimeout(() => {
    storedSessionsRefreshTimer = null;
    callbacks?.onStoredSessionsRefresh();
  }, 150);
}

export function connectSessionStoreTransport(
  nextCallbacks: SessionStoreTransportCallbacks,
) {
  callbacks = nextCallbacks;
  if (eventsSocket && eventsSocket.readyState < WebSocket.CLOSING) {
    return;
  }
  const replayFromSeq = nextCallbacks.getReplayFromSeq();
  const socket = api.createEventsSocket(
    replayFromSeq === undefined ? {} : { replayFromSeq },
    (batch) => {
      if (eventsSocket !== socket) {
        return;
      }
      if (batch.events?.some((event) => event.type === "session.discovery")) {
        scheduleStoredSessionsRefresh();
      }
      if (batch.replayGap) {
        nextCallbacks.onReplayGap(batch);
        return;
      }
      nextCallbacks.onBatch(batch);
    },
    (error) => {
      if (eventsSocket !== socket) {
        return;
      }
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
      onClose: () => {
        const shouldReconnect = !suppressNextSocketCloseReconnect;
        suppressNextSocketCloseReconnect = false;
        if (eventsSocket === socket) {
          eventsSocket = null;
        }
        clearReconnectTimer();
        if (shouldReconnect && callbacks) {
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
    suppressNextSocketCloseReconnect = true;
    eventsSocket.close();
    eventsSocket = null;
  }
}

export function restartSessionStoreTransport() {
  clearReconnectTimer();
  reconnectAttempt = 0;
  const socket = eventsSocket;
  eventsSocket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) {
    suppressNextSocketCloseReconnect = true;
    socket.close();
  }
  if (callbacks) {
    connectSessionStoreTransport(callbacks);
  }
}
