import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type {
  EventSubscriptionRequest,
  PtyClientMessage,
  PtyServerMessage,
  RahEventType,
  ReplayGapNotice,
} from "@rah/runtime-protocol";
import { RuntimeEngine } from "./runtime-engine";
import { isAllowedOrigin } from "./http-server-cors";

const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WEBSOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;
const PTY_OUTPUT_FLUSH_DELAY_MS = 8;
const PTY_OUTPUT_MAX_BATCH_CHARS = 128 * 1024;

export { isLoopbackRemoteAddress } from "./http-server-client-address";

type RuntimeEngineHandle = () => Promise<RuntimeEngine>;

async function resolveRuntimeEngine(engine: RuntimeEngineHandle): Promise<RuntimeEngine> {
  return await engine();
}

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

function parseReplayFromSeq(url: URL): number | undefined {
  const raw = url.searchParams.get("replayFromSeq");
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRepeatedQueryValues(url: URL, repeatedName: string, legacyName: string): string[] {
  const repeated = url.searchParams.getAll(repeatedName);
  const legacy = url.searchParams
    .getAll(legacyName)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...repeated, ...legacy];
}

function eventSubscriptionFromUrl(url: URL): EventSubscriptionRequest {
  const sessionIds = parseRepeatedQueryValues(url, "sessionId", "sessionIds");
  const eventTypes = parseRepeatedQueryValues(url, "eventType", "eventTypes");
  const replayFromSeq = parseReplayFromSeq(url);
  return {
    ...(sessionIds.length > 0 ? { sessionIds } : {}),
    ...(eventTypes.length > 0 ? { eventTypes: eventTypes as RahEventType[] } : {}),
    ...(replayFromSeq !== undefined ? { replayFromSeq } : {}),
  };
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
  engineHandle: RuntimeEngineHandle,
): {
  close(): void;
} {
  const wssEvents = new WebSocketServer({ noServer: true });
  const wssPty = new WebSocketServer({ noServer: true });
  const stopHeartbeat = installWebSocketHeartbeat([wssEvents, wssPty]);

  wssEvents.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sendEventFrame = (message: unknown): boolean =>
      sendJsonWithBackpressure(socket, message, {
        closeReason: "Event client is too slow",
      });
    let runtimeEngine: RuntimeEngine | null = null;
    let filter = eventSubscriptionFromUrl(url);
    let unsubscribe: () => void = () => undefined;
    let closed = false;
    let queuedMessages: string[] = [];

    const subscribe = () => {
      if (!runtimeEngine || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      unsubscribe = runtimeEngine.eventBus.subscribe(filter, (event) => {
        if (!sendEventFrame({ events: [event] })) {
          unsubscribe();
        }
      });
    };

    const sendReplay = (initial: boolean) => {
      if (!runtimeEngine || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const replay = runtimeEngine.listEvents(filter);
      const replayGap = replayGapForSubscription(runtimeEngine, filter);
      if (replay.length > 0 || replayGap) {
        sendEventFrame({
          events: replay,
          ...(initial ? { initial: true } : {}),
          ...(replayGap ? { replayGap } : {}),
        });
      }
    };

    const applySubscription = (nextFilter: EventSubscriptionRequest) => {
      if (!runtimeEngine) {
        return;
      }
      if (sameEventSubscription(filter, nextFilter)) {
        return;
      }
      unsubscribe();
      filter = nextFilter;
      sendReplay(false);
      subscribe();
    };

    const handleSubscriptionMessage = (raw: string) => {
      if (!runtimeEngine) {
        queuedMessages.push(raw);
        return;
      }
      try {
        applySubscription(JSON.parse(raw) as EventSubscriptionRequest);
      } catch {
        sendEventFrame({ error: "Invalid subscription payload" });
      }
    };

    socket.on("message", (raw) => {
      handleSubscriptionMessage(raw.toString("utf8"));
    });
    socket.on("close", () => {
      closed = true;
      queuedMessages = [];
      unsubscribe();
    });

    void (async () => {
      runtimeEngine = await resolveRuntimeEngine(engineHandle);
      if (closed || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const pending = queuedMessages;
      queuedMessages = [];
      if (pending.length > 0) {
        try {
          const firstSubscription = JSON.parse(pending[0]!) as EventSubscriptionRequest;
          if (!sameEventSubscription(filter, firstSubscription)) {
            filter = firstSubscription;
          }
        } catch {
          sendEventFrame({ error: "Invalid subscription payload" });
        }
      }
      sendReplay(true);
      subscribe();
      for (const raw of pending) {
        handleSubscriptionMessage(raw);
      }
    })().catch((error) => {
      sendJsonWithBackpressure(socket, {
        error: error instanceof Error ? error.message : String(error),
      });
      socket.close(1011, "RAH runtime is not available");
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
    const tailBytes = parsePtyReplaySeq(url.searchParams.get("tailBytes"));
    let runtimeEngine: RuntimeEngine | null = null;
    let unsubscribe: () => void = () => undefined;
    let closeAfterSubscribe = false;
    let closed = false;
    let surfaceClientId: string | null = null;
    let pendingClientMessages: string[] = [];
    let pendingOutput: Extract<PtyServerMessage, { type: "pty.output" }> | null = null;
    let pendingOutputTimer: ReturnType<typeof setTimeout> | null = null;

    const sendFrame = (frame: PtyServerMessage): boolean =>
      sendJsonWithBackpressure(socket, frame, {
        closeReason: "PTY client is too slow",
      });

    const flushPendingOutput = () => {
      if (pendingOutputTimer) {
        clearTimeout(pendingOutputTimer);
        pendingOutputTimer = null;
      }
      if (!pendingOutput) {
        return;
      }
      const output = pendingOutput;
      pendingOutput = null;
      const sent = sendFrame(output);
      if (!sent) {
        closeAfterSubscribe = true;
        unsubscribe();
      }
    };

    const sendPtyFrame = (frame: PtyServerMessage) => {
      if (frame.type === "pty.output" && frame.replace !== true) {
        if (pendingOutput) {
          pendingOutput = {
            ...pendingOutput,
            data: `${pendingOutput.data}${frame.data}`,
            ...(frame.seq !== undefined ? { seq: frame.seq } : {}),
          };
        } else {
          pendingOutput = frame;
        }
        if (pendingOutput.data.length >= PTY_OUTPUT_MAX_BATCH_CHARS) {
          flushPendingOutput();
          return;
        }
        if (!pendingOutputTimer) {
          pendingOutputTimer = setTimeout(flushPendingOutput, PTY_OUTPUT_FLUSH_DELAY_MS);
        }
        return;
      }
      if (pendingOutput) {
        flushPendingOutput();
      }
      const sent = sendFrame(frame);
      if (!sent) {
        closeAfterSubscribe = true;
        unsubscribe();
      }
    };

    const handlePtyClientMessage = (raw: string) => {
      if (!runtimeEngine) {
        pendingClientMessages.push(raw);
        return;
      }
      try {
        const parsed = JSON.parse(raw) as PtyClientMessage;
        if (parsed.type === "pty.input") {
          runtimeEngine.onPtyInput(sessionId, parsed.clientId, parsed.data);
        } else if (parsed.type === "pty.resize") {
          runtimeEngine.onPtyResize(sessionId, parsed.clientId, parsed.cols, parsed.rows);
        } else if (parsed.type === "pty.surface.attach") {
          surfaceClientId = parsed.clientId;
          void runtimeEngine
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
          void runtimeEngine
            .releaseNativeTuiSurface(sessionId, { clientId: parsed.clientId })
            .catch(() => undefined);
        }
      } catch (error) {
        sendJsonWithBackpressure(socket, {
          error: error instanceof Error ? error.message : "Invalid PTY client payload",
        });
      }
    };

    socket.on("message", (raw) => {
      handlePtyClientMessage(raw.toString("utf8"));
    });

    socket.on("close", () => {
      closed = true;
      pendingClientMessages = [];
      if (pendingOutputTimer) {
        clearTimeout(pendingOutputTimer);
        pendingOutputTimer = null;
      }
      pendingOutput = null;
      unsubscribe();
      if (surfaceClientId && runtimeEngine) {
        void runtimeEngine
          .releaseNativeTuiSurface(sessionId, { clientId: surfaceClientId })
          .catch(() => undefined);
      }
    });

    void (async () => {
      runtimeEngine = await resolveRuntimeEngine(engineHandle);
      if (closed || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      unsubscribe = runtimeEngine.ptyHub.subscribe(sessionId, (frame) => {
        sendPtyFrame(frame);
      }, {
        replay,
        ...(fromSeq !== undefined ? { fromSeq } : {}),
        ...(fromSeq === undefined && tailBytes !== undefined ? { tailBytes } : {}),
      });
      if (closeAfterSubscribe) {
        unsubscribe();
      }
      const pending = pendingClientMessages;
      pendingClientMessages = [];
      for (const raw of pending) {
        handlePtyClientMessage(raw);
      }
    })().catch((error) => {
      sendJsonWithBackpressure(socket, {
        error: error instanceof Error ? error.message : String(error),
      });
      socket.close(1011, "RAH runtime is not available");
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
