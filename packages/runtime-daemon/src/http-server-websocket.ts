import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type {
  EventSubscriptionRequest,
  PtyClientMessage,
  ReplayGapNotice,
} from "@rah/runtime-protocol";
import { RuntimeEngine } from "./runtime-engine";
import { isAllowedOrigin } from "./http-server-cors";

const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WEBSOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;

export { isLoopbackRemoteAddress } from "./http-server-client-address";

type BackpressureSocket = {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export function sendJsonWithBackpressure(
  socket: BackpressureSocket,
  message: unknown,
  options: { maxBufferedBytes?: number; closeReason?: string } = {},
): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  const maxBufferedBytes = Math.max(
    1,
    options.maxBufferedBytes ?? DEFAULT_MAX_WEBSOCKET_BUFFERED_BYTES,
  );
  if (socket.bufferedAmount > maxBufferedBytes) {
    socket.close(1013, options.closeReason ?? "client is too slow");
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

function installWebSocketHeartbeat(servers: WebSocketServer[]): () => void {
  const alive = new Map<WebSocket, boolean>();
  for (const server of servers) {
    server.on("connection", (socket) => {
      alive.set(socket, true);
      socket.on("pong", () => {
        alive.set(socket, true);
      });
      socket.on("close", () => {
        alive.delete(socket);
      });
    });
  }

  const timer = setInterval(() => {
    for (const server of servers) {
      for (const socket of server.clients) {
        if (socket.readyState !== WebSocket.OPEN) {
          alive.delete(socket);
          continue;
        }
        if (alive.get(socket) === false) {
          socket.terminate();
          alive.delete(socket);
          continue;
        }
        alive.set(socket, false);
        try {
          socket.ping();
        } catch {
          socket.terminate();
          alive.delete(socket);
        }
      }
    }
  }, WEBSOCKET_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    alive.clear();
  };
}

function replayGapForSubscription(
  engine: RuntimeEngine,
  filter: EventSubscriptionRequest,
): ReplayGapNotice | undefined {
  if (filter.replayFromSeq === undefined) {
    return undefined;
  }
  const oldestAvailableSeq = engine.eventBus.oldestSeq();
  if (oldestAvailableSeq === null || filter.replayFromSeq >= oldestAvailableSeq) {
    return undefined;
  }
  return {
    requestedFromSeq: filter.replayFromSeq,
    oldestAvailableSeq,
    newestAvailableSeq: engine.eventBus.newestSeq(),
  };
}

function sameEventSubscription(
  left: EventSubscriptionRequest,
  right: EventSubscriptionRequest,
): boolean {
  const leftSessionIds = left.sessionIds ?? [];
  const rightSessionIds = right.sessionIds ?? [];
  const leftEventTypes = left.eventTypes ?? [];
  const rightEventTypes = right.eventTypes ?? [];

  return (
    left.replayFromSeq === right.replayFromSeq &&
    leftSessionIds.length === rightSessionIds.length &&
    leftSessionIds.every((value, index) => value === rightSessionIds[index]) &&
    leftEventTypes.length === rightEventTypes.length &&
    leftEventTypes.every((value, index) => value === rightEventTypes[index])
  );
}

function parsePtyReplaySeq(raw: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.max(0, Math.floor(parsed));
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function attachWebSocketHandlers(
  server: Server,
  engine: RuntimeEngine,
): {
  close(): void;
} {
  const wssEvents = new WebSocketServer({ noServer: true });
  const wssPty = new WebSocketServer({ noServer: true });
  const stopHeartbeat = installWebSocketHeartbeat([wssEvents, wssPty]);

  wssEvents.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const replayFromSeq = url.searchParams.get("replayFromSeq");
    const sendEventFrame = (message: unknown): boolean => sendJsonWithBackpressure(socket, message, {
      closeReason: "Event client is too slow",
    });
    let filter: EventSubscriptionRequest = {};
    if (replayFromSeq && Number.isFinite(Number.parseInt(replayFromSeq, 10))) {
      filter.replayFromSeq = Number.parseInt(replayFromSeq, 10);
    }

    const initial = engine.listEvents(filter);
    const initialReplayGap = replayGapForSubscription(engine, filter);
    if (initial.length > 0 || initialReplayGap) {
      sendEventFrame({
        events: initial,
        initial: true,
        ...(initialReplayGap ? { replayGap: initialReplayGap } : {}),
      });
    }

    let unsubscribe: () => void = () => undefined;
    unsubscribe = engine.eventBus.subscribe(filter, (event) => {
      if (!sendEventFrame({ events: [event] })) {
        unsubscribe();
      }
    });

    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as EventSubscriptionRequest;
        if (sameEventSubscription(filter, parsed)) {
          return;
        }
        unsubscribe();
        filter = parsed;
        const replay = engine.listEvents(filter);
        const replayGap = replayGapForSubscription(engine, filter);
        if (replay.length > 0 || replayGap) {
          sendEventFrame({
            events: replay,
            ...(replayGap ? { replayGap } : {}),
          });
        }
        unsubscribe = engine.eventBus.subscribe(filter, (event) => {
          if (!sendEventFrame({ events: [event] })) {
            unsubscribe();
          }
        });
      } catch {
        sendEventFrame({ error: "Invalid subscription payload" });
      }
    });

    socket.on("close", () => {
      unsubscribe();
    });
  });

  wssPty.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/api\/pty\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      socket.close();
      return;
    }
    const sessionId = decodePathSegment(match[1]!);
    const replay = url.searchParams.get("replay") !== "false";
    const fromSeq = parsePtyReplaySeq(
      url.searchParams.get("fromSeq") ?? url.searchParams.get("cursor"),
    );
    let unsubscribe: () => void = () => undefined;
    let closeAfterSubscribe = false;
    unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
      const sent = sendJsonWithBackpressure(socket, frame, {
        closeReason: "PTY client is too slow",
      });
      if (!sent) {
        closeAfterSubscribe = true;
        unsubscribe();
      }
    }, { replay, ...(fromSeq !== undefined ? { fromSeq } : {}) });
    if (closeAfterSubscribe) {
      unsubscribe();
    }

    let surfaceClientId: string | null = null;
    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as PtyClientMessage;
        if (parsed.type === "pty.input") {
          engine.onPtyInput(sessionId, parsed.clientId, parsed.data);
        } else if (parsed.type === "pty.resize") {
          engine.onPtyResize(sessionId, parsed.clientId, parsed.cols, parsed.rows);
        } else if (parsed.type === "pty.surface.attach") {
          surfaceClientId = parsed.clientId;
          void engine
            .claimNativeTuiSurface(sessionId, {
              clientId: parsed.clientId,
              clientKind: parsed.clientKind,
              cols: parsed.cols,
              rows: parsed.rows,
            })
            .catch((error) => {
              sendJsonWithBackpressure(socket, {
                error: error instanceof Error ? error.message : String(error),
              });
            });
        } else if (parsed.type === "pty.surface.detach") {
          if (surfaceClientId === parsed.clientId) {
            surfaceClientId = null;
          }
          void engine
            .releaseNativeTuiSurface(sessionId, { clientId: parsed.clientId })
            .catch(() => undefined);
        }
      } catch (error) {
        sendJsonWithBackpressure(socket, {
          error: error instanceof Error ? error.message : "Invalid PTY client payload",
        });
      }
    });

    socket.on("close", () => {
      unsubscribe();
      if (surfaceClientId) {
        void engine
          .releaseNativeTuiSurface(sessionId, { clientId: surfaceClientId })
          .catch(() => undefined);
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/") && !isAllowedOrigin(req)) {
      socket.destroy();
      return;
    }
    if (url.pathname === "/api/events") {
      wssEvents.handleUpgrade(req, socket, head, (ws) => {
        wssEvents.emit("connection", ws, req);
      });
      return;
    }
    if (/^\/api\/pty\/[^/]+$/.test(url.pathname)) {
      wssPty.handleUpgrade(req, socket, head, (ws) => {
        wssPty.emit("connection", ws, req);
      });
      return;
    }
    socket.destroy();
  });

  return {
    close() {
      stopHeartbeat();
      wssEvents.close();
      wssPty.close();
    },
  };
}
