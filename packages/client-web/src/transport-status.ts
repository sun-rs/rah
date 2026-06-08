export const TRANSPORT_SYNC_VISIBLE_DELAY_MS = 700;

export type TransportStatus =
  | { phase: "connected" }
  | {
      phase: "syncing" | "offline";
      since: number;
      source?: "foreground_recovery" | "socket_reconnect" | undefined;
      message?: string | undefined;
    };

export type TransportCalloutDescriptor = {
  tone: "info" | "warning";
  title: string;
  body: string;
  primaryAction?: "refresh" | undefined;
  primaryLabel?: string | undefined;
  secondaryLabel?: string | undefined;
};

export function connectedTransportStatus(): TransportStatus {
  return { phase: "connected" };
}

export function syncingTransportStatus(now = Date.now()): TransportStatus {
  return { phase: "syncing", since: now, source: "foreground_recovery" };
}

export function nextReconnectTransportStatus(
  current: TransportStatus,
  message?: string,
  now = Date.now(),
): TransportStatus {
  if (current.phase === "connected") {
    return {
      phase: "syncing",
      since: now,
      source: "socket_reconnect",
      ...(message ? { message } : {}),
    };
  }
  return {
    phase: "syncing",
    since: current.since,
    source: current.source ?? "socket_reconnect",
    ...(message ? { message } : {}),
  };
}

export function offlineTransportStatus(
  current: TransportStatus,
  message?: string,
  now = Date.now(),
): TransportStatus {
  return {
    phase: "offline",
    since: current.phase === "connected" ? now : current.since,
    ...(message ? { message } : {}),
  };
}

export function describeTransportStatus(
  status: TransportStatus,
  now: number,
  options?: { selectedLiveSession?: boolean },
): TransportCalloutDescriptor | null {
  if (status.phase === "connected") {
    return null;
  }
  if (status.phase === "offline") {
    return {
      tone: "warning",
      title: "Connection issue",
      body:
        "The workbench could not reconnect to RAH. Reconnect now; if the problem continues, reload the page.",
      primaryAction: "refresh",
      primaryLabel: "Reconnect",
      secondaryLabel: "Dismiss",
    };
  }
  if (status.source === "socket_reconnect") {
    return null;
  }
  const elapsedMs = Math.max(0, now - status.since);
  if (elapsedMs < TRANSPORT_SYNC_VISIBLE_DELAY_MS) {
    return null;
  }
  return {
    tone: "info",
    title: "Syncing",
    body: options?.selectedLiveSession
      ? "Reconnecting to RAH and catching up missed session output..."
      : "Reconnecting to RAH and catching up session updates...",
  };
}
