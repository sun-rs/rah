import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import {
  getDeviceAuthStatus,
  pairDevice,
  RAH_AUTH_REQUIRED_EVENT,
} from "../api";
import {
  deviceAuthRetryDelay,
  deviceAuthStatusIsFresh,
  deviceAuthStateForFailure,
  deviceAuthStateForStatus,
  readDeviceAuthTrustHint,
  writeDeviceAuthTrustHint,
  type DeviceAuthTrustStorage,
  type DeviceAuthViewState,
} from "../device-auth-recovery";

const AUTH_STATUS_TIMEOUT_MS = 8_000;
const AUTH_STATUS_FOREGROUND_FRESH_MS = 15_000;

function suggestedDeviceName(): string {
  if (typeof navigator === "undefined") {
    return "Browser";
  }
  const userAgent = navigator.userAgent;
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
  if (/Android/i.test(userAgent)) return "Android device";
  return "Browser";
}

function normalizePairingCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 8);
}

function browserTrustStorage(): DeviceAuthTrustStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function DeviceAuthGate({ children }: { children: ReactNode }) {
  const initialTrustHint = useMemo(
    () => readDeviceAuthTrustHint(browserTrustStorage()),
    [],
  );
  const hasReachedTrustedRef = useRef(initialTrustHint);
  const [state, setState] = useState<DeviceAuthViewState>(
    initialTrustHint ? "trusted" : "loading",
  );
  const [hasTrustedDevices, setHasTrustedDevices] = useState(false);
  const [deviceName, setDeviceName] = useState(() => suggestedDeviceName());
  const [pairingCode, setPairingCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pairingReady = useMemo(
    () => pairingCode.length === 8 && deviceName.trim().length > 0,
    [deviceName, pairingCode],
  );

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let rerunAfterFlight = false;
    let retryAttempt = 0;
    let retryTimer: number | undefined;
    let pendingUnauthenticatedMessage: string | undefined;
    let lastSuccessfulCheckAt: number | undefined;

    const clearRetry = () => {
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };

    const scheduleRetry = () => {
      clearRetry();
      const delay = deviceAuthRetryDelay(retryAttempt);
      retryAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void check(undefined, { force: true });
      }, delay);
    };

    const check = async (
      unauthenticatedMessage?: string,
      options: { force?: boolean } = {},
    ) => {
      if (unauthenticatedMessage) {
        pendingUnauthenticatedMessage = unauthenticatedMessage;
      }
      if (inFlight) {
        if (options.force || unauthenticatedMessage) {
          rerunAfterFlight = true;
        }
        return;
      }
      if (
        !options.force &&
        deviceAuthStatusIsFresh(
          lastSuccessfulCheckAt,
          Date.now(),
          AUTH_STATUS_FOREGROUND_FRESH_MS,
        )
      ) {
        return;
      }

      clearRetry();
      inFlight = true;
      const messageForThisCheck = pendingUnauthenticatedMessage;
      pendingUnauthenticatedMessage = undefined;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), AUTH_STATUS_TIMEOUT_MS);
      try {
        const status = await getDeviceAuthStatus({ signal: controller.signal });
        if (cancelled) return;
        lastSuccessfulCheckAt = Date.now();
        retryAttempt = 0;
        setHasTrustedDevices(status.hasTrustedDevices);
        hasReachedTrustedRef.current = status.authenticated;
        writeDeviceAuthTrustHint(browserTrustStorage(), status.authenticated);
        setState(deviceAuthStateForStatus(status.authenticated));
        setError(status.authenticated ? null : messageForThisCheck ?? null);
      } catch {
        if (cancelled) return;
        setState(deviceAuthStateForFailure(hasReachedTrustedRef.current));
        setError(null);
        scheduleRetry();
      } finally {
        window.clearTimeout(timeout);
        inFlight = false;
        if (!cancelled && rerunAfterFlight) {
          rerunAfterFlight = false;
          void check(undefined, { force: true });
        }
      }
    };

    const requireAuth = () => {
      void check("This device is no longer trusted.", { force: true });
    };
    const recheck = () => {
      void check();
    };
    const forceRecheck = () => {
      void check(undefined, { force: true });
    };
    const recheckWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void check();
      }
    };

    window.addEventListener(RAH_AUTH_REQUIRED_EVENT, requireAuth);
    window.addEventListener("online", forceRecheck);
    window.addEventListener("focus", recheck);
    window.addEventListener("pageshow", recheck);
    document.addEventListener("visibilitychange", recheckWhenVisible);
    void check(undefined, { force: true });

    return () => {
      cancelled = true;
      clearRetry();
      window.removeEventListener(RAH_AUTH_REQUIRED_EVENT, requireAuth);
      window.removeEventListener("online", forceRecheck);
      window.removeEventListener("focus", recheck);
      window.removeEventListener("pageshow", recheck);
      document.removeEventListener("visibilitychange", recheckWhenVisible);
    };
  }, []);

  async function submitPairing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pairingReady || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await pairDevice({ code: pairingCode, name: deviceName.trim() });
      hasReachedTrustedRef.current = true;
      writeDeviceAuthTrustHint(browserTrustStorage(), true);
      setState("trusted");
      setPairingCode("");
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : "Pairing failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "trusted") {
    return children;
  }

  if (state === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[var(--app-bg)] text-[var(--app-hint)]">
        <LoaderCircle size={22} className="animate-spin" aria-label="Checking device trust" />
      </div>
    );
  }

  if (state === "reconnecting") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[var(--app-bg)] px-5 text-[var(--app-fg)]">
        <div className="flex max-w-sm items-center gap-3">
          <LoaderCircle
            size={21}
            className="shrink-0 animate-spin text-[var(--app-hint)]"
            aria-label="Reconnecting to RAH"
          />
          <div>
            <h1 className="text-sm font-medium">Reconnecting to RAH</h1>
            <p className="mt-1 text-xs leading-5 text-[var(--app-hint)]">
              Waiting for this device to reach the trusted RAH server.
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--app-bg)] px-5 py-10 text-[var(--app-fg)]">
      <form
        onSubmit={(event) => void submitPairing(event)}
        className="w-full max-w-sm rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-6 shadow-xl"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--app-subtle-bg)]">
            <ShieldCheck size={21} />
          </div>
          <div>
            <h1 className="text-base font-semibold">Trust this device</h1>
            <p className="mt-0.5 text-xs text-[var(--app-hint)]">
              {hasTrustedDevices ? "Approve another device for RAH." : "Pair the first device with RAH."}
            </p>
          </div>
        </div>

        <label className="block text-xs font-medium text-[var(--app-hint)]">
          Device name
          <input
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            maxLength={64}
            autoComplete="off"
            className="mt-1.5 h-10 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm text-[var(--app-fg)] outline-none focus:border-primary"
          />
        </label>

        <label className="mt-4 block text-xs font-medium text-[var(--app-hint)]">
          Pairing code
          <div className="relative mt-1.5">
            <KeyRound
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--app-hint)]"
            />
            <input
              value={pairingCode}
              onChange={(event) => setPairingCode(normalizePairingCode(event.target.value))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="00000000"
              aria-label="8 digit pairing code"
              className="h-10 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] pl-9 pr-3 font-mono text-sm tracking-[0.18em] text-[var(--app-fg)] outline-none placeholder:tracking-[0.18em] placeholder:text-[var(--app-hint)] focus:border-primary"
            />
          </div>
        </label>

        <p className="mt-3 text-xs leading-5 text-[var(--app-hint)]">
          Run <code className="rounded bg-[var(--app-subtle-bg)] px-1.5 py-0.5">rah pair</code> on the Mac, or generate a code from a trusted device.
        </p>

        {error ? (
          <div className="mt-4 rounded-lg border border-[var(--app-danger)]/30 bg-[var(--app-danger-bg)] px-3 py-2 text-xs text-[var(--app-danger)]">
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={!pairingReady || submitting}
          className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--app-fg)] px-4 text-sm font-medium text-[var(--app-bg)] transition-opacity disabled:cursor-default disabled:opacity-40"
        >
          {submitting ? <LoaderCircle size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
          Trust device
        </button>
      </form>
    </main>
  );
}
