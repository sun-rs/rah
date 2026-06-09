import { useEffect, useMemo } from "react";

const DEFAULT_HISTORY_TAIL_SYNC_INTERVAL_MS = 1_500;

export function useSessionHistoryTailSync(args: {
  sessionIds: readonly string[];
  refreshLatestHistory: (sessionId: string) => Promise<void>;
  intervalMs?: number;
}) {
  const sessionKey = useMemo(() => args.sessionIds.join("\0"), [args.sessionIds]);
  const intervalMs = args.intervalMs ?? DEFAULT_HISTORY_TAIL_SYNC_INTERVAL_MS;

  useEffect(() => {
    if (!sessionKey) {
      return;
    }
    const sessionIds = sessionKey.split("\0").filter(Boolean);
    let cancelled = false;
    const inFlight = new Set<string>();
    const syncSession = (sessionId: string) => {
      if (cancelled || inFlight.has(sessionId)) {
        return;
      }
      inFlight.add(sessionId);
      void args.refreshLatestHistory(sessionId)
        .catch(() => undefined)
        .finally(() => {
          inFlight.delete(sessionId);
        });
    };
    const syncVisibleHistoryTails = () => {
      for (const sessionId of sessionIds) {
        syncSession(sessionId);
      }
    };
    syncVisibleHistoryTails();
    const interval = window.setInterval(syncVisibleHistoryTails, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [args.refreshLatestHistory, intervalMs, sessionKey]);
}
