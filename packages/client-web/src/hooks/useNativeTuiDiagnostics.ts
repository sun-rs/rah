import { useEffect, useState } from "react";
import type { NativeTuiDiagnostic } from "@rah/runtime-protocol";
import { listNativeTuiDiagnostics } from "../api";

const REFRESH_INTERVAL_MS = 2_000;

export function useNativeTuiDiagnostics(sessionId: string | null | undefined): NativeTuiDiagnostic[] {
  const [diagnostics, setDiagnostics] = useState<NativeTuiDiagnostic[]>([]);

  useEffect(() => {
    if (!sessionId) {
      setDiagnostics([]);
      return;
    }

    let active = true;
    let timer: number | undefined;
    const controller = new AbortController();

    const refresh = async () => {
      try {
        const next = await listNativeTuiDiagnostics({
          sessionId,
          signal: controller.signal,
        });
        if (active) {
          setDiagnostics(next);
        }
      } catch {
        if (active) {
          setDiagnostics([]);
        }
      }
    };

    const schedule = () => {
      if (!active) {
        return;
      }
      timer = window.setTimeout(() => {
        void refresh().finally(schedule);
      }, REFRESH_INTERVAL_MS);
    };

    void refresh().finally(schedule);
    return () => {
      active = false;
      controller.abort();
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [sessionId]);

  return diagnostics;
}
