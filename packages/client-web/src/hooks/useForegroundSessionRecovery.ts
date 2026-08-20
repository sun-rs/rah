import { useCallback, useEffect, useMemo, useRef } from "react";
import * as api from "../api";
import {
  setVisibleNotificationTargets,
  type NotificationTarget,
} from "../browser-notifications";
import {
  foregroundClockWasSuspended,
  foregroundSurfaceHasAttention,
  runForegroundRecoveryLoop,
} from "../foreground-recovery";
import { isReadOnlyReplay } from "../session-capabilities";
import { sessionStoreTransportIsHealthy } from "../session-store-transport";
import { useSessionStore } from "../useSessionStore";
import { readPwaDisplayMode } from "./usePwaDisplayMode";

const FOREGROUND_RECOVERY_DEBOUNCE_MS = 120;
const FOREGROUND_RECOVERY_TIMEOUT_MS = 12_000;
const FOREGROUND_RECOVERY_RETRY_DELAYS_MS = [600, 1_800, 4_000, 8_000, 12_000] as const;
const VISIBLE_HISTORY_CATCHUP_FRESH_MS = 2_000;
const READ_ONLY_CONVERSATION_SOURCE_POLL_MS = 1_500;
const LEGACY_READ_ONLY_CONVERSATION_REFRESH_MS = 5_000;
const READ_ONLY_SOURCE_REVISION_RETRY_MS = 30_000;
const FOREGROUND_WAKE_HEARTBEAT_MS = 1_000;
const FOREGROUND_WAKE_SUSPENSION_MS = 5_000;

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

export type ForegroundSessionRecoveryController = {
  cancelForegroundRecovery: () => void;
  detectForegroundWake: () => void;
  reconcileVisibleUnreadState: () => void;
  scheduleForegroundRecovery: () => void;
};

export function useForegroundSessionRecovery(options: {
  visibleNotificationTargets: NotificationTarget[];
  projections: SessionStoreState["projections"];
  isInitialLoaded: boolean;
  refreshConversation: SessionStoreState["refreshConversation"];
  recoverTransport: SessionStoreState["recoverTransport"];
  reconcileUnreadFromLastSeen: SessionStoreState["reconcileUnreadFromLastSeen"];
  markSessionsRead: SessionStoreState["markSessionsRead"];
  setVisibleSessionIds: SessionStoreState["setVisibleSessionIds"];
}): ForegroundSessionRecoveryController {
  const visibleSessionIds = useMemo(
    () =>
      options.visibleNotificationTargets.flatMap((target) =>
        target.kind === "session" ? [target.id] : [],
      ),
    [options.visibleNotificationTargets],
  );
  const visibleSessionIdsRef = useRef(visibleSessionIds);
  const projectionsRef = useRef(options.projections);
  const isInitialLoadedRef = useRef(options.isInitialLoaded);
  const visibleConversationCatchupFreshRef = useRef(
    new Map<string, { key: string; at: number }>(),
  );
  const visibleConversationSourceRevisionRef = useRef(new Map<string, string>());
  const visibleConversationLegacyRefreshAtRef = useRef(new Map<string, number>());
  const sourceRevisionProbeUnavailableUntilRef = useRef(0);
  const foregroundRecoveryTimerRef = useRef<number | null>(null);
  const foregroundRecoveryControllerRef = useRef<AbortController | null>(null);
  const foregroundWakeTickAtRef = useRef(Date.now());

  useEffect(() => {
    visibleSessionIdsRef.current = visibleSessionIds;
    options.setVisibleSessionIds(visibleSessionIds);
  }, [options.setVisibleSessionIds, visibleSessionIds]);

  useEffect(() => {
    projectionsRef.current = options.projections;
  }, [options.projections]);

  useEffect(() => {
    isInitialLoadedRef.current = options.isInitialLoaded;
  }, [options.isInitialLoaded]);

  const workbenchHasForegroundAttention = useCallback(() => {
    if (typeof document === "undefined") {
      return true;
    }
    return foregroundSurfaceHasAttention({
      visibilityState: document.visibilityState,
      documentHasFocus:
        typeof document.hasFocus !== "function" || document.hasFocus(),
      pwaDisplayMode: readPwaDisplayMode(),
    });
  }, []);

  const catchUpVisibleConversations = useCallback(
    async (signal: AbortSignal) => {
      if (!isInitialLoadedRef.current) {
        return true;
      }
      const requests: Promise<boolean>[] = [];
      for (const sessionId of visibleSessionIdsRef.current) {
        const projection = projectionsRef.current.get(sessionId);
        if (!projection?.summary.session.providerSessionId) {
          continue;
        }
        const freshnessKey = `${projection.summary.session.updatedAt ?? ""}:${projection.lastSeq}`;
        const fresh = visibleConversationCatchupFreshRef.current.get(sessionId);
        if (
          fresh?.key === freshnessKey &&
          Date.now() - fresh.at < VISIBLE_HISTORY_CATCHUP_FRESH_MS
        ) {
          continue;
        }
        const request = options.refreshConversation(sessionId, {
          signal,
          replaceActive: true,
          suppressError: true,
        }).then((succeeded) => {
          if (!succeeded || signal.aborted) {
            return false;
          }
          const refreshedProjection = useSessionStore.getState().projections.get(sessionId);
          if (refreshedProjection) {
            visibleConversationCatchupFreshRef.current.set(sessionId, {
              key: `${refreshedProjection.summary.session.updatedAt ?? ""}:${refreshedProjection.lastSeq}`,
              at: Date.now(),
            });
          }
          return true;
        });
        requests.push(request);
      }
      const results = await Promise.all(requests);
      return results.every(Boolean);
    },
    [options.refreshConversation],
  );

  const reconcileVisibleUnreadState = useCallback(() => {
    const activeVisibleSessionIds = workbenchHasForegroundAttention()
      ? visibleSessionIdsRef.current
      : [];
    options.reconcileUnreadFromLastSeen(activeVisibleSessionIds);
  }, [options.reconcileUnreadFromLastSeen, workbenchHasForegroundAttention]);

  const runForegroundRecovery = useCallback(async () => {
    foregroundRecoveryControllerRef.current?.abort();
    const recoveryController = new AbortController();
    foregroundRecoveryControllerRef.current = recoveryController;
    try {
      await runForegroundRecoveryLoop({
        signal: recoveryController.signal,
        retryDelaysMs: FOREGROUND_RECOVERY_RETRY_DELAYS_MS,
        isVisible: () =>
          typeof document === "undefined" || document.visibilityState === "visible",
        onConversationRecovered: reconcileVisibleUnreadState,
        runAttempt: async ({ signal }) => {
          const attemptController = new AbortController();
          const abortAttempt = () => attemptController.abort(signal.reason);
          signal.addEventListener("abort", abortAttempt, { once: true });
          const timeout = window.setTimeout(
            () => attemptController.abort(),
            FOREGROUND_RECOVERY_TIMEOUT_MS,
          );
          try {
            const [transportRecovered, conversationRecovered] = await Promise.all([
              options.recoverTransport({
                signal: attemptController.signal,
                replaceActive: true,
                suppressError: true,
              }).then(
                () => true,
                () => false,
              ),
              catchUpVisibleConversations(attemptController.signal).catch(() => false),
            ]);
            return { transportRecovered, conversationRecovered };
          } finally {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", abortAttempt);
          }
        },
      });
    } finally {
      if (foregroundRecoveryControllerRef.current === recoveryController) {
        foregroundRecoveryControllerRef.current = null;
      }
    }
  }, [catchUpVisibleConversations, options.recoverTransport, reconcileVisibleUnreadState]);

  const scheduleForegroundRecovery = useCallback(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      return;
    }
    if (foregroundRecoveryControllerRef.current) {
      return;
    }
    if (foregroundRecoveryTimerRef.current !== null) {
      window.clearTimeout(foregroundRecoveryTimerRef.current);
    }
    foregroundRecoveryTimerRef.current = window.setTimeout(() => {
      foregroundRecoveryTimerRef.current = null;
      void runForegroundRecovery();
    }, FOREGROUND_RECOVERY_DEBOUNCE_MS);
  }, [runForegroundRecovery]);

  const cancelForegroundRecovery = useCallback(() => {
    if (foregroundRecoveryTimerRef.current !== null) {
      window.clearTimeout(foregroundRecoveryTimerRef.current);
      foregroundRecoveryTimerRef.current = null;
    }
    foregroundRecoveryControllerRef.current?.abort();
    foregroundRecoveryControllerRef.current = null;
  }, []);

  const detectForegroundWake = useCallback(() => {
    const now = Date.now();
    const previousTickAt = foregroundWakeTickAtRef.current;
    foregroundWakeTickAtRef.current = now;
    if (document.visibilityState !== "visible") {
      return;
    }
    if (foregroundClockWasSuspended(previousTickAt, now, FOREGROUND_WAKE_SUSPENSION_MS)) {
      scheduleForegroundRecovery();
    }
  }, [scheduleForegroundRecovery]);

  useEffect(() => {
    let disposed = false;
    let pollInFlight = false;
    const controller = new AbortController();

    const pollVisibleReadOnlySources = async () => {
      if (
        disposed ||
        pollInFlight ||
        !isInitialLoadedRef.current ||
        (typeof document !== "undefined" && document.visibilityState !== "visible")
      ) {
        return;
      }
      pollInFlight = true;
      const followedSessionIds = new Set<string>();
      const refreshLegacySource = async (sessionId: string) => {
        const now = Date.now();
        const previous = visibleConversationLegacyRefreshAtRef.current.get(sessionId) ?? 0;
        if (now - previous < LEGACY_READ_ONLY_CONVERSATION_REFRESH_MS) {
          return;
        }
        visibleConversationLegacyRefreshAtRef.current.set(sessionId, now);
        await options.refreshConversation(sessionId, {
          signal: controller.signal,
          replaceActive: true,
          suppressError: true,
        });
      };
      try {
        await Promise.all(
          visibleSessionIdsRef.current.map(async (sessionId) => {
            const projection = projectionsRef.current.get(sessionId);
            if (
              !projection?.summary.session.providerSessionId ||
              !isReadOnlyReplay(projection.summary)
            ) {
              return;
            }
            followedSessionIds.add(sessionId);
            if (projection.conversation?.phase === "loading") {
              return;
            }
            if (Date.now() < sourceRevisionProbeUnavailableUntilRef.current) {
              await refreshLegacySource(sessionId);
              return;
            }
            try {
              const response = await api.readSessionConversationSourceRevision(sessionId, {
                signal: controller.signal,
              });
              if (disposed || controller.signal.aborted) {
                return;
              }
              sourceRevisionProbeUnavailableUntilRef.current = 0;
              if (!response.sourceRevision) {
                await refreshLegacySource(sessionId);
                return;
              }
              const previous =
                visibleConversationSourceRevisionRef.current.get(sessionId) ??
                projection.conversation?.sourceRevision ??
                undefined;
              visibleConversationSourceRevisionRef.current.set(
                sessionId,
                response.sourceRevision,
              );
              if (previous === response.sourceRevision) {
                return;
              }
              await options.refreshConversation(sessionId, {
                signal: controller.signal,
                replaceActive: true,
                suppressError: true,
              });
            } catch {
              if (disposed || controller.signal.aborted) {
                return;
              }
              sourceRevisionProbeUnavailableUntilRef.current =
                Date.now() + READ_ONLY_SOURCE_REVISION_RETRY_MS;
              await refreshLegacySource(sessionId);
            }
          }),
        );
        for (const sessionId of visibleConversationSourceRevisionRef.current.keys()) {
          if (!followedSessionIds.has(sessionId)) {
            visibleConversationSourceRevisionRef.current.delete(sessionId);
          }
        }
        for (const sessionId of visibleConversationLegacyRefreshAtRef.current.keys()) {
          if (!followedSessionIds.has(sessionId)) {
            visibleConversationLegacyRefreshAtRef.current.delete(sessionId);
          }
        }
      } finally {
        pollInFlight = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void pollVisibleReadOnlySources();
      }
    };
    void pollVisibleReadOnlySources();
    const timer = window.setInterval(
      () => void pollVisibleReadOnlySources(),
      READ_ONLY_CONVERSATION_SOURCE_POLL_MS,
    );
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [options.refreshConversation]);

  useEffect(() => {
    setVisibleNotificationTargets(options.visibleNotificationTargets);
    return () => setVisibleNotificationTargets([]);
  }, [options.visibleNotificationTargets]);

  useEffect(() => {
    if (!workbenchHasForegroundAttention()) {
      return;
    }
    options.markSessionsRead(visibleSessionIds);
  }, [
    options.markSessionsRead,
    options.projections,
    visibleSessionIds,
    workbenchHasForegroundAttention,
  ]);

  return useMemo(
    () => ({
      cancelForegroundRecovery,
      detectForegroundWake,
      reconcileVisibleUnreadState,
      scheduleForegroundRecovery,
    }),
    [
      cancelForegroundRecovery,
      detectForegroundWake,
      reconcileVisibleUnreadState,
      scheduleForegroundRecovery,
    ],
  );
}

export function useForegroundWakeRecovery(
  recovery: ForegroundSessionRecoveryController,
): void {
  useEffect(() => {
    const recoverIfTransportNeedsIt = () => {
      recovery.reconcileVisibleUnreadState();
      recovery.detectForegroundWake();
      if (!sessionStoreTransportIsHealthy()) {
        recovery.scheduleForegroundRecovery();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        recoverIfTransportNeedsIt();
        return;
      }
      recovery.detectForegroundWake();
      recovery.cancelForegroundRecovery();
    };
    const handleForegroundResume = () => recoverIfTransportNeedsIt();
    const handlePageShow = (event: PageTransitionEvent) => {
      recovery.reconcileVisibleUnreadState();
      recovery.detectForegroundWake();
      if (event.persisted || !sessionStoreTransportIsHealthy()) {
        recovery.scheduleForegroundRecovery();
      }
    };
    const handleOnline = () => {
      recovery.reconcileVisibleUnreadState();
      recovery.scheduleForegroundRecovery();
    };
    const wakeTimer = window.setInterval(
      recovery.detectForegroundWake,
      FOREGROUND_WAKE_HEARTBEAT_MS,
    );

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleForegroundResume);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("online", handleOnline);
    window.addEventListener("pointerdown", recovery.detectForegroundWake, { passive: true });
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleForegroundResume);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("pointerdown", recovery.detectForegroundWake);
      window.clearInterval(wakeTimer);
      recovery.cancelForegroundRecovery();
    };
  }, [recovery]);
}
