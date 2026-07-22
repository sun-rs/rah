const TRANSPORT_ERROR_MARKERS = [
  "events socket failed",
  "transport",
  "unable to connect",
  "cannot connect to the server",
  "could not connect to the server",
  "connection refused",
  "connection reset",
  "connection was lost",
  "connection closed",
  "connection timed out",
  "internet connection appears to be offline",
  "load failed",
  "networkerror",
  "network request failed",
  "network route unavailable",
  "network connection was lost",
  "failed to fetch",
  "failed to load resource",
  "fetch failed",
  "server with the specified hostname could not be found",
  "socket hang up",
  "stream disconnected before completion",
  "websocket is closed",
  "econnrefused",
  "econnreset",
  "enotfound",
  "etimedout",
] as const;

const TRANSIENT_HTTP_STATUS_PATTERN =
  /(?:request failed:\s*)?(?:408|425|429|502|503|504)\b|bad gateway|gateway timeout|service unavailable/i;

export function isTransportErrorMessage(error: string): boolean {
  const lower = error.trim().toLowerCase();
  return (
    TRANSPORT_ERROR_MARKERS.some((marker) => lower.includes(marker)) ||
    TRANSIENT_HTTP_STATUS_PATTERN.test(lower)
  );
}
