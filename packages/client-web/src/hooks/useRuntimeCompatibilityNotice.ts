import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import {
  browserRuntimeCompatibilityMutePersistence,
  deriveRuntimeCompatibilityDescriptor,
  isRuntimeCompatibilityMutedToday,
  isRuntimeCompatibilityMutedUntil,
  muteRuntimeCompatibilityForToday,
  RUNTIME_COMPATIBILITY_MUTED_DATE_KEY,
} from "../runtime-compatibility";

export function useRuntimeCompatibilityNotice() {
  const [descriptor, setDescriptor] =
    useState<ReturnType<typeof deriveRuntimeCompatibilityDescriptor>>(null);
  const [muted, setMuted] = useState(() =>
    isRuntimeCompatibilityMutedToday(browserRuntimeCompatibilityMutePersistence()),
  );
  const refreshRequestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    try {
      const identity = await api.readRuntimeIdentity();
      const nextDescriptor = deriveRuntimeCompatibilityDescriptor(
        __RAH_WEB_BUILD_ID__,
        identity,
      );
      let daemonMuted = false;
      try {
        const state = await api.readRuntimeCompatibilityNoticeState();
        daemonMuted = isRuntimeCompatibilityMutedUntil(state.mutedUntil);
      } catch {
        // A newly built Web client can be served by an older daemon that does
        // not own this endpoint yet. Browser persistence remains the bounded
        // compatibility fallback for exactly that mismatch window.
      }
      if (refreshRequestRef.current !== requestId) {
        return;
      }
      setDescriptor(nextDescriptor);
      // Re-read browser persistence after both asynchronous probes. Neither a
      // slow identity nor preference response may resurrect a notice muted in
      // another tab while it was in flight.
      setMuted(
        nextDescriptor !== null &&
          (daemonMuted ||
            isRuntimeCompatibilityMutedToday(
              browserRuntimeCompatibilityMutePersistence(),
            )),
      );
    } catch {
      // Authentication and transport recovery own their existing callouts.
      // Compatibility is advisory and must not obscure those higher-priority
      // states when the identity probe itself is unavailable.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const syncMute = (event?: StorageEvent) => {
      if (
        event &&
        event.key !== null &&
        event.key !== RUNTIME_COMPATIBILITY_MUTED_DATE_KEY
      ) {
        return;
      }
      void refresh();
    };
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") {
        syncMute();
      }
    };
    window.addEventListener("storage", syncMute);
    document.addEventListener("visibilitychange", syncWhenVisible);
    return () => {
      window.removeEventListener("storage", syncMute);
      document.removeEventListener("visibilitychange", syncWhenVisible);
    };
  }, [refresh]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 10_000);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

  const muteToday = useCallback(() => {
    muteRuntimeCompatibilityForToday(
      browserRuntimeCompatibilityMutePersistence(),
    );
    setMuted(true);
    void api
      .muteRuntimeCompatibilityNoticeForToday()
      .then((state) => {
        setMuted(
          isRuntimeCompatibilityMutedUntil(state.mutedUntil) ||
            isRuntimeCompatibilityMutedToday(
              browserRuntimeCompatibilityMutePersistence(),
            ),
        );
      })
      .catch(() => {
        // Old daemon / transient transport failure: local persistence already
        // hid the advisory notice for this client without obscuring errors.
      });
  }, []);

  return {
    descriptor: muted ? null : descriptor,
    muteToday,
    refresh,
  };
}
