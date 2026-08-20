import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import {
  browserRuntimeCompatibilityMutePersistence,
  deriveRuntimeCompatibilityDescriptor,
  isRuntimeCompatibilityMutedToday,
  muteRuntimeCompatibilityForToday,
  RUNTIME_COMPATIBILITY_MUTED_DATE_KEY,
} from "../runtime-compatibility";

export function useRuntimeCompatibilityNotice() {
  const [descriptor, setDescriptor] =
    useState<ReturnType<typeof deriveRuntimeCompatibilityDescriptor>>(null);
  const [muted, setMuted] = useState(() =>
    isRuntimeCompatibilityMutedToday(browserRuntimeCompatibilityMutePersistence()),
  );

  const refresh = useCallback(async () => {
    try {
      const identity = await api.readRuntimeIdentity();
      const nextDescriptor = deriveRuntimeCompatibilityDescriptor(
        __RAH_WEB_BUILD_ID__,
        identity,
      );
      setDescriptor(nextDescriptor);
      // Re-read persistence after the asynchronous identity probe. The probe
      // must never resurrect a notice muted while it was in flight.
      setMuted(
        nextDescriptor !== null &&
          isRuntimeCompatibilityMutedToday(
            browserRuntimeCompatibilityMutePersistence(),
          ),
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
      setMuted(
        isRuntimeCompatibilityMutedToday(
          browserRuntimeCompatibilityMutePersistence(),
        ),
      );
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
  }, []);

  const muteToday = useCallback(() => {
    muteRuntimeCompatibilityForToday(
      browserRuntimeCompatibilityMutePersistence(),
    );
    setMuted(true);
  }, []);

  return {
    descriptor: muted ? null : descriptor,
    muteToday,
    refresh,
  };
}
