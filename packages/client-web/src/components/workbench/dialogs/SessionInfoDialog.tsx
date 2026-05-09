import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, X } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  SessionRuntimeDescriptor,
  SessionRuntimeDiagnostics,
  SessionSummary,
} from "@rah/runtime-protocol";
import { providerLabel, type SessionProjection } from "../../../types";
import { writeHostClipboard } from "../../../api";

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "Unavailable";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function InfoRow(props: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 border-b border-[var(--app-border)] px-4 py-3 text-sm last:border-b-0">
      <div className="text-[var(--app-hint)]">{props.label}</div>
      <div
        className={
          props.mono
            ? "font-mono text-[13px] break-words [overflow-wrap:anywhere] text-[var(--app-fg)]"
            : "break-words [overflow-wrap:anywhere] text-[var(--app-fg)]"
        }
      >
        {props.value}
      </div>
    </div>
  );
}

function runtimeKindLabel(kind: SessionRuntimeDescriptor["kind"]): string {
  switch (kind) {
    case "native_local_server":
      return "Native local server";
    case "tui_mux_fallback":
      return "TUI mux fallback";
    case "stream_json_fifo":
      return "Stream JSON FIFO";
    case "native_cloud_remote":
      return "Native cloud remote";
    case "internal_experimental":
      return "Internal experimental";
    case "legacy_structured":
      return "Legacy structured";
  }
}

function protocolStabilityLabel(stability: SessionRuntimeDescriptor["protocolStability"]): string {
  switch (stability) {
    case "official_stable":
      return "official stable";
    case "project_native":
      return "project native";
    case "tui_stdio":
      return "TUI stdio";
    case "reverse_engineered_internal":
      return "reverse engineered";
  }
}

function formatSessionRuntime(runtime: SessionRuntimeDescriptor | undefined): string {
  if (!runtime) {
    return "Unavailable";
  }
  return `${runtimeKindLabel(runtime.kind)} · ${protocolStabilityLabel(runtime.protocolStability)}`;
}

function runtimeLiveSourceLabel(
  source: SessionRuntimeDescriptor["liveSource"] | undefined,
): string {
  switch (source) {
    case "provider_server":
      return "provider server";
    case "provider_history":
      return "provider history";
    case "rah_structured":
      return "RAH structured";
    case undefined:
      return "Unavailable";
  }
  return source;
}

function runtimeTuiRoleLabel(role: SessionRuntimeDescriptor["tuiRole"] | undefined): string {
  switch (role) {
    case "session_owner":
      return "session owner";
    case "client_view":
      return "client view";
    case "none":
      return "none";
    case undefined:
      return "Unavailable";
  }
  return role;
}

function formatBooleanCapability(value: boolean | undefined): string {
  if (value === undefined) {
    return "Unavailable";
  }
  return value ? "yes" : "no";
}

function runtimeFeatureStatusLabel(
  status:
    | NonNullable<SessionRuntimeDescriptor["features"]>[keyof NonNullable<
        SessionRuntimeDescriptor["features"]
      >]
    | undefined,
): string {
  switch (status) {
    case "available":
      return "available";
    case "unverified":
      return "unverified";
    case "unsupported":
      return "unsupported";
    case "experimental":
      return "experimental";
    case undefined:
      return "Unavailable";
  }
}

function formatRuntimeFeatureName(name: string): string {
  return name
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (char) => char.toUpperCase());
}

function RuntimeFeatureStatusList(props: {
  features: SessionRuntimeDescriptor["features"] | undefined;
}) {
  if (!props.features) {
    return "Unavailable";
  }
  return (
    <div className="grid gap-1">
      {Object.entries(props.features).map(([name, status]) => (
        <div key={name} className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[var(--app-muted)]">
            {formatRuntimeFeatureName(name)}
          </span>
          <span className="shrink-0 text-[var(--app-fg)]">
            {runtimeFeatureStatusLabel(status)}
          </span>
        </div>
      ))}
    </div>
  );
}

function runtimeAttachStateLabel(
  state: SessionRuntimeDiagnostics["attachState"] | undefined,
): string {
  switch (state) {
    case "ready":
      return "ready";
    case "unverified":
      return "unverified";
    case "failed":
      return "failed";
    case "unavailable":
      return "unavailable";
    case undefined:
      return "Unavailable";
  }
}

type CopyResult = "copied" | "failed";

function copyTextWithSelection(value: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const previousActiveElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const previousSelection = window.getSelection();
  const previousRanges =
    previousSelection !== null
      ? Array.from({ length: previousSelection.rangeCount }, (_, index) =>
          previousSelection.getRangeAt(index).cloneRange(),
        )
      : [];
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.fontSize = "16px";
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (previousSelection !== null) {
      previousSelection.removeAllRanges();
      for (const range of previousRanges) {
        previousSelection.addRange(range);
      }
    }
    previousActiveElement?.focus({ preventScroll: true });
  }
}

async function copyTextToClipboard(value: string): Promise<CopyResult> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard?.writeText
    ) {
      await navigator.clipboard.writeText(value);
      if (!navigator.clipboard.readText) {
        throw new Error("Clipboard verification is unavailable.");
      }
      try {
        const clipboardValue = await navigator.clipboard.readText();
        if (clipboardValue !== value) {
          throw new Error("Clipboard verification failed.");
        }
      } catch {
        throw new Error("Clipboard verification failed.");
      }
      return "copied";
    }
  } catch {
    // Fall through to the selection-based fallback below.
  }
  try {
    await writeHostClipboard(value);
    return "copied";
  } catch {
    // Fall through to the selection-based fallback below.
  }
  if (!copyTextWithSelection(value)) {
    return "failed";
  }
  try {
    if (!navigator.clipboard?.readText) {
      return "failed";
    }
    return (await navigator.clipboard.readText()) === value ? "copied" : "failed";
  } catch {
    return "failed";
  }
}

function CopyValueButton(props: { value: string; label: string }) {
  const [copyState, setCopyState] = useState<"idle" | CopyResult>("idle");

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }
    const timeout = window.setTimeout(
      () => setCopyState("idle"),
      copyState === "failed" ? 2200 : 1200,
    );
    return () => {
      window.clearTimeout(timeout);
    };
  }, [copyState]);

  const handleCopy = async () => {
    setCopyState(await copyTextToClipboard(props.value));
  };

  const buttonStateClassName =
    copyState === "failed"
      ? "border-[var(--app-danger)]/50 bg-[var(--app-danger)]/8 text-[var(--app-danger)] hover:bg-[var(--app-danger)]/12 hover:text-[var(--app-danger)]"
      : "border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]";

  return (
    <button
      type="button"
      onClick={() => {
        void handleCopy();
      }}
      className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors ${buttonStateClassName}`}
      title={`Copy ${props.label}`}
      aria-live="polite"
    >
      {copyState === "copied" ? <Check size={12} /> : copyState === "failed" ? <X size={12} /> : <Copy size={12} />}
      <span>{copyState === "copied" ? "Copied" : copyState === "failed" ? "Failed" : "Copy"}</span>
    </button>
  );
}

export function SessionInfoDialog(props: {
  open: boolean;
  summary: SessionSummary | null;
  projection: SessionProjection | null;
  onOpenChange: (open: boolean) => void;
}) {
  const summary = props.summary;
  const session = summary?.session;
  const providerSessionId = session?.providerSessionId ?? "Unavailable";
  const resumeCommand =
    session?.providerSessionId && session.provider !== "custom"
      ? `rah ${session.provider} resume ${session.providerSessionId}`
      : null;
  const attachCommand =
    session?.liveBackend === "zellij_tui" || session?.liveBackend === "native_tui"
      ? `rah attach ${session.id}`
      : null;
  const zellijCommand =
    session?.mux?.backend === "zellij"
      ? `ZELLIJ_SOCKET_DIR=${session.mux.socketDir} zellij attach ${session.mux.sessionName} options --mirror-session true --pane-frames false --show-startup-tips false`
      : null;
  const runtimeStatus = props.projection?.currentRuntimeStatus ?? null;
  const runtimeDiagnostics = session?.runtimeDiagnostics;

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[min(78dvh,680px)] w-[min(720px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl focus:outline-none max-md:inset-0 max-md:h-[100dvh] max-md:w-screen max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]">
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-sm font-semibold text-[var(--app-fg)]">
                Session Info
              </Dialog.Title>
              <div className="mt-0.5 truncate text-xs text-[var(--app-hint)]">
                {session?.title ?? session?.id ?? "Unknown session"}
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
            <InfoRow label="Provider" value={session ? providerLabel(session.provider) : "Unavailable"} />
            <InfoRow
              label="Session ID"
              mono
              value={
                <div className="flex flex-wrap items-start gap-2">
                  <span className="min-w-0 flex-1">{providerSessionId}</span>
                  {session?.providerSessionId ? (
                    <CopyValueButton value={session.providerSessionId} label="session ID" />
                  ) : null}
                </div>
              }
            />
            <InfoRow
              label="Resume"
              mono
              value={
                resumeCommand ? (
                  <div className="flex flex-wrap items-start gap-2">
                    <span className="min-w-0 flex-1">{resumeCommand}</span>
                    <CopyValueButton value={resumeCommand} label="resume command" />
                  </div>
                ) : (
                  "Unavailable"
                )
              }
            />
            <InfoRow
              label="Attach"
              mono
              value={
                attachCommand ? (
                  <div className="flex flex-wrap items-start gap-2">
                    <span className="min-w-0 flex-1">{attachCommand}</span>
                    <CopyValueButton value={attachCommand} label="attach command" />
                  </div>
                ) : (
                  "Unavailable"
                )
              }
            />
            {zellijCommand ? (
              <InfoRow
                label="Zellij"
                mono
                value={
                  <div className="flex flex-wrap items-start gap-2">
                    <span className="min-w-0 flex-1">{zellijCommand}</span>
                    <CopyValueButton value={zellijCommand} label="zellij attach command" />
                  </div>
                }
              />
            ) : null}
            {runtimeDiagnostics?.attachCommand ? (
              <InfoRow
                label="Native attach"
                mono
                value={
                  <div className="flex flex-wrap items-start gap-2">
                    <span className="min-w-0 flex-1">{runtimeDiagnostics.attachCommand}</span>
                    <CopyValueButton value={runtimeDiagnostics.attachCommand} label="native attach command" />
                  </div>
                }
              />
            ) : null}
            <InfoRow label="Launch" value={session?.launchSource ?? "Unavailable"} />
            <InfoRow label="Backend" value={session?.liveBackend ?? "Unavailable"} />
            <InfoRow label="State" value={session?.runtimeState ?? "Unavailable"} />
            <InfoRow label="Runtime" value={formatSessionRuntime(session?.runtime)} />
            <InfoRow label="Live source" value={runtimeLiveSourceLabel(session?.runtime?.liveSource)} />
            <InfoRow label="TUI role" value={runtimeTuiRoleLabel(session?.runtime?.tuiRole)} />
            <InfoRow
              label="Events"
              value={formatBooleanCapability(session?.runtime?.structuredLiveEvents)}
            />
            <InfoRow
              label="Continuity"
              value={formatBooleanCapability(session?.runtime?.tuiContinuity)}
            />
            <InfoRow
              label="Feature truth"
              value={<RuntimeFeatureStatusList features={session?.runtime?.features} />}
            />
            <InfoRow
              label="Attach state"
              value={runtimeAttachStateLabel(runtimeDiagnostics?.attachState)}
            />
            <InfoRow
              label="Server"
              mono
              value={runtimeDiagnostics?.serverEndpoint ?? "Unavailable"}
            />
            <InfoRow
              label="Server PID"
              value={
                runtimeDiagnostics?.serverPid !== undefined
                  ? String(runtimeDiagnostics.serverPid)
                  : "Unavailable"
              }
            />
            <InfoRow
              label="Cursor"
              mono
              value={runtimeDiagnostics?.lastEventCursor ?? "Unavailable"}
            />
            <InfoRow
              label="Last error"
              value={runtimeDiagnostics?.lastError ?? "Unavailable"}
            />
            <InfoRow label="Status" value={runtimeStatus ?? "Unavailable"} />
            <InfoRow label="Attached" value={summary ? String(summary.attachedClients.length) : "0"} />
            <InfoRow
              label="Control"
              value={
                summary?.controlLease.holderClientId
                  ? `${summary.controlLease.holderKind ?? "unknown"} · ${summary.controlLease.holderClientId}`
                  : "Unclaimed"
              }
            />
            <InfoRow label="Workspace" mono value={session?.rootDir ?? "Unavailable"} />
            <InfoRow label="Cwd" mono value={session?.cwd ?? "Unavailable"} />
            <InfoRow label="Created" value={formatDateTime(session?.createdAt)} />
            <InfoRow label="Updated" value={formatDateTime(session?.updatedAt)} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
