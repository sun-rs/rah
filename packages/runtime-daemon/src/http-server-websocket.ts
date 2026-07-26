import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type {
  ConversationProjectionDelta,
  EventSubscriptionRequest,
  PtyClientMessage,
  PtyServerMessage,
  RahEvent,
  ReplayGapNotice,
} from "@rah/runtime-protocol";
import { composeConversationProjectionDeltas } from "@rah/runtime-protocol";
import { RuntimeEngine } from "./runtime-engine";
import { isAllowedOrigin } from "./http-server-cors";
import type { DeviceAuthManager } from "./device-auth";
import { boundedJsonByteLength } from "./bounded-json-size";
import { LiveEventTransportBatch } from "./live-event-transport-batch";
import { PtyOutputTransportBatch } from "./pty-output-transport-batch";

const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WEBSOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_WEBSOCKET_MESSAGE_BYTES = 4 * 1024 * 1024;
const EVENT_BATCH_SEMANTIC_FLUSH_DELAY_MS = 8;
const EVENT_BATCH_DATA_FLUSH_DELAY_MS = 50;
const EVENT_BATCH_MAX_EVENTS = 256;
const EVENT_BATCH_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const EVENT_BATCH_MAX_COALESCED_OUTPUT_CHARS = 128 * 1024;
const EVENT_REPLAY_MAX_EVENTS = 96;
const EVENT_REPLAY_MAX_BYTES = 512 * 1024;
const EVENT_REPLAY_MAX_PENDING_LIVE_EVENTS = 1_024;
const EVENT_REPLAY_MAX_PENDING_LIVE_BYTES = 4 * 1024 * 1024;
const PTY_OUTPUT_FLUSH_DELAY_MS = 8;
const PTY_OUTPUT_MAX_BATCH_CHARS = 128 * 1024;

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
  options: {
    maxBufferedBytes?: number;
    maxMessageBytes?: number;
    closeReason?: string;
    oversizedCloseReason?: string;
  } = {},
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
  const maxMessageBytes = Math.max(
    1,
    options.maxMessageBytes ?? DEFAULT_MAX_WEBSOCKET_MESSAGE_BYTES,
  );
  if (boundedJsonByteLength(message, maxMessageBytes) > maxMessageBytes) {
    socket.close(1009, options.oversizedCloseReason ?? "message is too large");
    return false;
  }
  const serialized = JSON.stringify(message);
  if (Buffer.byteLength(serialized, "utf8") > maxMessageBytes) {
    socket.close(1009, options.oversizedCloseReason ?? "message is too large");
    return false;
  }
  socket.send(serialized);
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

export interface EventReplayChunk {
  events: RahEvent[];
  conversationDeltas: ConversationProjectionDelta[];
}

export function chunkEventReplay(
  events: readonly RahEvent[],
  deltaForSourceSeq: (sourceSeq: number) => ConversationProjectionDelta | undefined,
  options: {
    maxEvents?: number;
    maxBytes?: number;
  } = {},
): EventReplayChunk[] {
  const maxEvents = Math.max(1, options.maxEvents ?? EVENT_REPLAY_MAX_EVENTS);
  const maxBytes = Math.max(1, options.maxBytes ?? EVENT_REPLAY_MAX_BYTES);
  const chunks: EventReplayChunk[] = [];
  let chunkEvents: RahEvent[] = [];
  let chunkDeltas: ConversationProjectionDelta[] = [];
  let chunkBytes = 0;

  const flush = () => {
    if (chunkEvents.length === 0) {
      return;
    }
    chunks.push({
      events: chunkEvents,
      conversationDeltas: composeConversationProjectionDeltas(chunkDeltas),
    });
    chunkEvents = [];
    chunkDeltas = [];
    chunkBytes = 0;
  };

  for (const event of events) {
    const delta = deltaForSourceSeq(event.seq);
    const entryBytes =
      boundedJsonByteLength(event, maxBytes) +
      (delta ? boundedJsonByteLength(delta, maxBytes) : 0);
    if (
      chunkEvents.length > 0 &&
      (chunkEvents.length >= maxEvents || chunkBytes + entryBytes > maxBytes)
    ) {
      flush();
    }
    chunkEvents.push(event);
    if (delta) {
      chunkDeltas.push(delta);
    }
    chunkBytes = Math.min(maxBytes + 1, chunkBytes + entryBytes);
  }
  flush();
  return chunks;
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function attachWebSocketHandlers(
  server: Server,
  engine: RuntimeEngine,
  auth?: DeviceAuthManager,
): {
  close(): Promise<void>;
} {
  const wssEvents = new WebSocketServer({ noServer: true });
  const wssPty = new WebSocketServer({ noServer: true });
  const stopHeartbeat = installWebSocketHeartbeat([wssEvents, wssPty]);
  let closePromise: Promise<void> | undefined;

  wssEvents.on("connection", (socket, req) => {
    const principal = auth?.authenticate(req);
    const unsubscribeRevocation = principal?.kind === "device"
      ? auth?.subscribeDeviceRevocation(principal.device.id, () => {
          socket.close(4001, "device trust revoked");
        })
      : undefined;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const replayFromSeq = url.searchParams.get("replayFromSeq");
    const initialReplayEnabled = url.searchParams.get("initialReplay") !== "false";
    const sendEventFrame = (message: unknown): boolean => sendJsonWithBackpressure(socket, message, {
      closeReason: "Event client is too slow",
    });
    let filter: EventSubscriptionRequest = {};
    const pendingBatch = new LiveEventTransportBatch({
      maxCoalescedOutputChars: EVENT_BATCH_MAX_COALESCED_OUTPUT_CHARS,
      sizeBudgetBytes: EVENT_BATCH_MAX_QUEUED_BYTES,
    });
    let eventFlushTimer: ReturnType<typeof setTimeout> | undefined;
    let eventFlushUrgent = false;
    let unsubscribe: () => void = () => undefined;
    let replayActive = false;
    let replayGeneration = 0;
    let closed = false;

    const clearPendingEventBatch = () => {
      if (eventFlushTimer !== undefined) {
        clearTimeout(eventFlushTimer);
        eventFlushTimer = undefined;
      }
      pendingBatch.clear();
      eventFlushUrgent = false;
    };
    const flushPendingEventBatch = (): boolean => {
      if (eventFlushTimer !== undefined) {
        clearTimeout(eventFlushTimer);
        eventFlushTimer = undefined;
      }
      if (pendingBatch.eventCount === 0) {
        return true;
      }
      const { events, conversationDeltas } = pendingBatch.take();
      eventFlushUrgent = false;
      return sendEventFrame({
        events,
        ...(conversationDeltas.length > 0 ? { conversationDeltas } : {}),
      });
    };
    const schedulePendingEventFlush = () => {
      if (replayActive || pendingBatch.eventCount === 0) {
        return;
      }
      const urgent = pendingBatch.hasUrgentEvents;
      if (eventFlushTimer !== undefined) {
        if (!urgent || eventFlushUrgent) {
          return;
        }
        clearTimeout(eventFlushTimer);
        eventFlushTimer = undefined;
      }
      eventFlushUrgent = urgent;
      eventFlushTimer = setTimeout(() => {
        eventFlushTimer = undefined;
        eventFlushUrgent = false;
        if (!flushPendingEventBatch()) {
          unsubscribe();
        }
      }, urgent
        ? EVENT_BATCH_SEMANTIC_FLUSH_DELAY_MS
        : EVENT_BATCH_DATA_FLUSH_DELAY_MS);
      eventFlushTimer.unref?.();
    };
    const enqueueEventFrame = (
      event: RahEvent,
      conversationDelta: ReturnType<typeof engine.conversationStore.deltaForSourceSeq>,
    ): boolean => {
      pendingBatch.append(event, conversationDelta);
      if (replayActive) {
        if (
          pendingBatch.eventCount >= EVENT_REPLAY_MAX_PENDING_LIVE_EVENTS ||
          pendingBatch.byteLength >= EVENT_REPLAY_MAX_PENDING_LIVE_BYTES
        ) {
          socket.close(1013, "Live event backlog exceeded replay budget");
          unsubscribe();
          return false;
        }
        return true;
      }
      if (
        pendingBatch.eventCount >= EVENT_BATCH_MAX_EVENTS ||
        pendingBatch.byteLength >= EVENT_BATCH_MAX_QUEUED_BYTES
      ) {
        return flushPendingEventBatch();
      }
      schedulePendingEventFlush();
      return true;
    };

    const sessionIds = url.searchParams.getAll("sessionId");
    const eventTypes = url.searchParams.getAll("eventType") as NonNullable<EventSubscriptionRequest["eventTypes"]>;
    if (sessionIds.length > 0) {
      filter.sessionIds = sessionIds;
    }
    if (eventTypes.length > 0) {
      filter.eventTypes = eventTypes;
    }
    if (replayFromSeq && Number.isFinite(Number.parseInt(replayFromSeq, 10))) {
      filter.replayFromSeq = Number.parseInt(replayFromSeq, 10);
    }

    const beginSubscription = (
      nextFilter: EventSubscriptionRequest,
      options: { replay: boolean; initial: boolean },
    ) => {
      clearPendingEventBatch();
      unsubscribe();
      filter = nextFilter;
      const generation = ++replayGeneration;
      const replayGap = options.replay
        ? replayGapForSubscription(engine, filter)
        : undefined;
      const replayEvents =
        options.replay && !replayGap ? engine.listEvents(filter) : [];
      replayActive =
        options.replay &&
        (options.initial || replayGap !== undefined || replayEvents.length > 0);

      // Subscribe before yielding to the replay pump. New events are queued
      // behind the snapshot and cannot overtake retained history.
      unsubscribe = engine.eventBus.subscribe(filter, (event) => {
        const conversationDelta = engine.conversationStore.deltaForSourceSeq(event.seq);
        if (!enqueueEventFrame(event, conversationDelta)) {
          unsubscribe();
        }
      });

      if (!replayActive) {
        return;
      }
      const chunks = chunkEventReplay(
        replayEvents,
        (sourceSeq) => engine.conversationStore.deltaForSourceSeq(sourceSeq),
      );
      void (async () => {
        const frameCount = Math.max(1, chunks.length);
        for (let index = 0; index < frameCount; index += 1) {
          if (closed || generation !== replayGeneration) {
            return;
          }
          const chunk = chunks[index] ?? {
            events: [],
            conversationDeltas: [],
          };
          const complete = index === frameCount - 1;
          const sent = sendEventFrame({
            events: chunk.events,
            ...(chunk.conversationDeltas.length > 0
              ? { conversationDeltas: chunk.conversationDeltas }
              : {}),
            replay: true,
            ...(options.initial ? { initial: true } : {}),
            replayComplete: complete,
            ...(complete && replayGap ? { replayGap } : {}),
          });
          if (!sent) {
            unsubscribe();
            return;
          }
          if (!complete) {
            await yieldEventLoop();
          }
        }
        if (closed || generation !== replayGeneration) {
          return;
        }
        replayActive = false;
        if (
          pendingBatch.eventCount >= EVENT_BATCH_MAX_EVENTS ||
          pendingBatch.byteLength >= EVENT_BATCH_MAX_QUEUED_BYTES
        ) {
          if (!flushPendingEventBatch()) {
            unsubscribe();
          }
          return;
        }
        schedulePendingEventFlush();
      })();
    };

    beginSubscription(filter, {
      replay: initialReplayEnabled,
      initial: initialReplayEnabled,
    });

    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as EventSubscriptionRequest;
        if (sameEventSubscription(filter, parsed)) {
          return;
        }
        beginSubscription(parsed, { replay: true, initial: false });
      } catch {
        sendEventFrame({ error: "Invalid subscription payload" });
      }
    });

    socket.on("close", () => {
      closed = true;
      replayGeneration += 1;
      replayActive = false;
      clearPendingEventBatch();
      unsubscribe();
      unsubscribeRevocation?.();
    });
  });

  wssPty.on("connection", (socket, req) => {
    const principal = auth?.authenticate(req);
    const unsubscribeRevocation = principal?.kind === "device"
      ? auth?.subscribeDeviceRevocation(principal.device.id, () => {
          socket.close(4001, "device trust revoked");
        })
      : undefined;
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
    let unsubscribe: () => void = () => undefined;
    let closeAfterSubscribe = false;
    const pendingOutput = new PtyOutputTransportBatch();
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
      if (pendingOutput.empty) {
        return;
      }
      const output = pendingOutput.take();
      if (!output) {
        return;
      }
      const sent = sendFrame(output);
      if (!sent) {
        closeAfterSubscribe = true;
        unsubscribe();
      }
    };

    const sendPtyFrame = (frame: PtyServerMessage) => {
      if (frame.type === "pty.output" && frame.replace !== true) {
        pendingOutput.append(frame);
        if (pendingOutput.charLength >= PTY_OUTPUT_MAX_BATCH_CHARS) {
          flushPendingOutput();
          return;
        }
        if (!pendingOutputTimer) {
          pendingOutputTimer = setTimeout(flushPendingOutput, PTY_OUTPUT_FLUSH_DELAY_MS);
        }
        return;
      }
      if (!pendingOutput.empty) {
        flushPendingOutput();
      }
      const sent = sendFrame(frame);
      if (!sent) {
        closeAfterSubscribe = true;
        unsubscribe();
      }
    };

    unsubscribe = engine.ptyHub.subscribe(sessionId, (frame) => {
      sendPtyFrame(frame);
    }, {
      replay,
      ...(fromSeq !== undefined ? { fromSeq } : {}),
      ...(fromSeq === undefined && tailBytes !== undefined ? { tailBytes } : {}),
    });
    if (closeAfterSubscribe) {
      unsubscribe();
    }

    let surfaceClientId: string | null = null;
    let surfaceId: string | undefined;
    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as PtyClientMessage;
        if (parsed.type === "pty.input") {
          engine.onPtyInput(sessionId, parsed.clientId, parsed.data);
        } else if (parsed.type === "pty.resize") {
          engine.onPtyResize(sessionId, parsed.clientId, parsed.cols, parsed.rows);
        } else if (parsed.type === "pty.client.ping") {
          sendJsonWithBackpressure(socket, {
            type: "pty.server.pong",
            sessionId,
            nonce: parsed.nonce,
          });
        } else if (parsed.type === "pty.surface.attach") {
          surfaceClientId = parsed.clientId;
          surfaceId = parsed.surfaceId;
          void engine
            .claimNativeTuiSurface(sessionId, {
              clientId: parsed.clientId,
              ...(parsed.surfaceId !== undefined ? { surfaceId: parsed.surfaceId } : {}),
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
            surfaceId = undefined;
          }
          void engine
            .releaseNativeTuiSurface(sessionId, {
              clientId: parsed.clientId,
              ...(parsed.surfaceId !== undefined ? { surfaceId: parsed.surfaceId } : {}),
            })
            .catch(() => undefined);
        }
      } catch (error) {
        sendJsonWithBackpressure(socket, {
          error: error instanceof Error ? error.message : "Invalid PTY client payload",
        });
      }
    });

    socket.on("close", () => {
      unsubscribeRevocation?.();
      if (pendingOutputTimer) {
        clearTimeout(pendingOutputTimer);
        pendingOutputTimer = null;
      }
      pendingOutput.clear();
      unsubscribe();
      if (surfaceClientId) {
        void engine
          .releaseNativeTuiSurface(sessionId, {
            clientId: surfaceClientId,
            ...(surfaceId !== undefined ? { surfaceId } : {}),
          })
          .catch(() => undefined);
      }
    });
  });

  const handleUpgrade: Parameters<Server["on"]>[1] = (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/") && !isAllowedOrigin(req)) {
      socket.destroy();
      return;
    }
    if (url.pathname.startsWith("/api/") && auth && !auth.authenticate(req)) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
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
  };
  server.on("upgrade", handleUpgrade);

  const closeWebSocketServer = (webSocketServer: WebSocketServer): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(forceTimer);
        resolve();
      };
      const forceTimer = setTimeout(() => {
        for (const client of webSocketServer.clients) {
          client.terminate();
        }
        finish();
      }, 500);
      forceTimer.unref?.();

      webSocketServer.close(finish);
      for (const client of webSocketServer.clients) {
        try {
          client.close(1001, "RAH daemon is shutting down");
        } catch {
          client.terminate();
        }
      }
    });

  return {
    close() {
      if (!closePromise) {
        server.off("upgrade", handleUpgrade);
        stopHeartbeat();
        closePromise = Promise.all([
          closeWebSocketServer(wssEvents),
          closeWebSocketServer(wssPty),
        ]).then(() => undefined);
      }
      return closePromise;
    },
  };
}
