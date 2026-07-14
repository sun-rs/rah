import { useEffect, useRef } from "react";
import type { CouncilMessage, CouncilSummary } from "@rah/runtime-protocol";
import * as api from "../api";

export function useCouncilTransport(options: {
  onMessage: (council: CouncilSummary, message: CouncilMessage) => void;
  onRefresh: () => void | Promise<void>;
}): void {
  const onMessageRef = useRef(options.onMessage);
  const onRefreshRef = useRef(options.onRefresh);
  onMessageRef.current = options.onMessage;
  onRefreshRef.current = options.onRefresh;

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;

    const refresh = () => {
      void Promise.resolve(onRefreshRef.current()).catch(() => {
        // The owning surface decides whether a refresh failure is user-visible.
      });
    };
    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) return;
      const baseDelay = document.visibilityState === "visible" ? 750 : 3_000;
      const delay = Math.min(30_000, baseDelay * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };
    const connect = () => {
      if (cancelled) return;
      socket = api.createEventsSocket(
        { eventTypes: ["council.message.created"] },
        (batch) => {
          for (const event of batch.events) {
            if (event.type === "council.message.created") {
              onMessageRef.current(event.payload.council, event.payload.message);
            }
          }
        },
        () => {
          if (socket && socket.readyState < WebSocket.CLOSING) {
            socket.close();
          }
        },
        {
          onOpen: () => {
            reconnectAttempt = 0;
            refresh();
          },
          onClose: (event) => {
            if (cancelled) return;
            refresh();
            if (event.code !== 4001) {
              scheduleReconnect();
            }
          },
          initialReplay: false,
        },
      );
    };
    const handleForegroundResume = () => {
      if (document.visibilityState !== "visible") return;
      refresh();
      if (!socket || socket.readyState >= WebSocket.CLOSING) {
        clearReconnectTimer();
        connect();
      }
    };

    document.addEventListener("visibilitychange", handleForegroundResume);
    connect();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleForegroundResume);
      clearReconnectTimer();
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
    };
  }, []);
}
