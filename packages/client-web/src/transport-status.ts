export const TRANSPORT_SYNC_VISIBLE_DELAY_MS = 700;
export const TRANSPORT_CONNECTION_ISSUE_VISIBLE_DELAY_MS = 60_000;

export type TransportStatus =
  | { phase: "connected" }
  | {
      phase: "syncing" | "offline";
      since: number;
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
  return { phase: "syncing", since: now };
}

export function nextReconnectTransportStatus(
  current: TransportStatus,
  message?: string,
  now = Date.now(),
): TransportStatus {
  if (current.phase === "connected") {
    return { phase: "syncing", since: now, ...(message ? { message } : {}) };
  }
  return { phase: "syncing", since: current.since, ...(message ? { message } : {}) };
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
  options?: { selectedSession?: boolean },
): TransportCalloutDescriptor | null {
  if (status.phase === "connected") {
    return null;
  }
  const elapsedMs = Math.max(0, now - status.since);
  if (elapsedMs < TRANSPORT_SYNC_VISIBLE_DELAY_MS) {
    return null;
  }
  if (elapsedMs >= TRANSPORT_CONNECTION_ISSUE_VISIBLE_DELAY_MS) {
    return {
      tone: "warning",
      title: "Connection issue",
      body:
        "The workbench has been trying to reconnect to RAH for a while. Reconnect now; if the problem continues, reload the page.",
      primaryAction: "refresh",
      primaryLabel: "Reconnect",
      secondaryLabel: "Dismiss",
    };
  }
  return {
    tone: "info",
    title: "Syncing",
    body: options?.selectedSession
      ? "Reconnecting to RAH and catching up missed session output..."
      : "Reconnecting to RAH and catching up session updates...",
  };
}
