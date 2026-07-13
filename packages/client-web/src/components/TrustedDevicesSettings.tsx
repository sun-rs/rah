import { useEffect, useState } from "react";
import type { PairingCodeResponse, TrustedDeviceDescriptor } from "@rah/runtime-protocol";
import { Check, Copy, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import {
  createPairingCode,
  getPairingCodeStatus,
  listTrustedDevices,
  RAH_AUTH_REQUIRED_EVENT,
  revokeTrustedDevice,
} from "../api";
import { copyTextToClipboard } from "../clipboard";

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function TrustedDevicesSettings() {
  const [devices, setDevices] = useState<TrustedDeviceDescriptor[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | undefined>();
  const [pairing, setPairing] = useState<PairingCodeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingCode, setCreatingCode] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadDevices() {
    setLoading(true);
    setError(null);
    try {
      const response = await listTrustedDevices();
      setDevices(response.devices);
      setCurrentDeviceId(response.currentDeviceId);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load trusted devices.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDevices();
  }, []);

  useEffect(() => {
    if (!pairing) {
      return;
    }
    const pairingId = pairing.id;
    const expiresAtMs = Date.parse(pairing.expiresAt);
    let cancelled = false;
    let timer: number | undefined;

    const clearConsumedCode = () => {
      setPairing((current) => current?.id === pairingId ? null : current);
      setCopied(false);
      void loadDevices();
    };

    const checkStatus = async () => {
      if (cancelled) {
        return;
      }
      if (!Number.isNaN(expiresAtMs) && Date.now() >= expiresAtMs) {
        clearConsumedCode();
        return;
      }
      try {
        const status = await getPairingCodeStatus(pairingId);
        if (cancelled) {
          return;
        }
        if (!status.active) {
          clearConsumedCode();
          return;
        }
      } catch {
        // A transient connectivity failure must not invalidate a still-active code.
      }
      timer = window.setTimeout(() => void checkStatus(), 1_000);
    };

    timer = window.setTimeout(() => void checkStatus(), 1_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [pairing?.id]);

  async function generateCode() {
    setCreatingCode(true);
    setError(null);
    setCopied(false);
    try {
      setPairing(await createPairingCode());
    } catch (codeError) {
      setError(codeError instanceof Error ? codeError.message : "Could not create a pairing code.");
    } finally {
      setCreatingCode(false);
    }
  }

  async function copyCode() {
    if (!pairing) return;
    if ((await copyTextToClipboard(pairing.code)) === "copied") {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }
  }

  async function revoke(deviceId: string) {
    if (confirmRevokeId !== deviceId) {
      setConfirmRevokeId(deviceId);
      return;
    }
    setRevokingId(deviceId);
    setError(null);
    try {
      const response = await revokeTrustedDevice(deviceId);
      setDevices((current) => current.filter((device) => device.id !== deviceId));
      setConfirmRevokeId(null);
      if (response.revokedCurrentDevice) {
        window.dispatchEvent(new Event(RAH_AUTH_REQUIRED_EVENT));
      }
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Could not revoke device.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-base font-semibold text-[var(--app-fg)]">Trusted devices</div>
          <div className="mt-1 text-sm text-[var(--app-hint)]">
            Paired browsers remain trusted until they are revoked.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadDevices()}
          disabled={loading}
          aria-label="Refresh trusted devices"
          title="Refresh trusted devices"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)] disabled:opacity-60"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 md:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-[var(--app-fg)]">
              <KeyRound size={15} />
              Pair another device
            </div>
            <div className="mt-1 text-xs text-[var(--app-hint)]">
              Codes are single-use and expire after 10 minutes.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void generateCode()}
            disabled={creatingCode}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--app-border)] px-2.5 text-xs font-medium text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)] disabled:opacity-60"
          >
            {creatingCode ? <LoaderCircle size={13} className="animate-spin" /> : <KeyRound size={13} />}
            Generate
          </button>
        </div>
        {pairing ? (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2.5">
            <div className="min-w-0">
              <div className="font-mono text-base font-semibold tracking-[0.16em] text-[var(--app-fg)]">
                {pairing.code}
              </div>
              <div className="mt-0.5 truncate text-[10px] text-[var(--app-hint)]">
                Expires {formatTimestamp(pairing.expiresAt)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void copyCode()}
              aria-label="Copy pairing code"
              title="Copy pairing code"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-xl border border-[var(--app-danger)]/30 bg-[var(--app-danger-bg)] px-3 py-2 text-xs text-[var(--app-danger)]">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)]">
        {loading && devices.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-[var(--app-hint)]">
            <LoaderCircle size={16} className="animate-spin" />
          </div>
        ) : devices.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-[var(--app-hint)]">No trusted devices.</div>
        ) : (
          devices.map((device, index) => {
            const isCurrent = device.id === currentDeviceId;
            const confirming = confirmRevokeId === device.id;
            return (
              <div
                key={device.id}
                className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-[var(--app-border)]" : ""}`}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                  <ShieldCheck size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-[var(--app-fg)]">{device.name}</span>
                    {isCurrent ? (
                      <span className="shrink-0 rounded-full border border-[var(--app-border)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--app-hint)]">
                        This device
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-[var(--app-hint)]">
                    Last seen {formatTimestamp(device.lastSeenAt)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void revoke(device.id)}
                  disabled={revokingId === device.id}
                  className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors disabled:opacity-60 ${
                    confirming
                      ? "bg-[var(--app-danger-bg)] text-[var(--app-danger)]"
                      : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-danger)]"
                  }`}
                >
                  {revokingId === device.id ? (
                    <LoaderCircle size={13} className="animate-spin" />
                  ) : (
                    <Trash2 size={13} />
                  )}
                  {confirming ? "Confirm" : "Revoke"}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
