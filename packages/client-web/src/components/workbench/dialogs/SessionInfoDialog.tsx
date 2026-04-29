import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { SessionSummary } from "@rah/runtime-protocol";
import { providerLabel, type SessionProjection } from "../../../types";

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

function copyTextWithSelection(value: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const previousActiveElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.left = "0";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
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
    previousActiveElement?.focus({ preventScroll: true });
  }
}

async function copyTextToClipboard(value: string): Promise<boolean> {
  // iOS Safari requires the legacy selection copy to happen synchronously in
  // the tap handler. Try it before awaiting Clipboard API fallback.
  if (copyTextWithSelection(value)) {
    return true;
  }

  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function CopyValueButton(props: { value: string; label: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }
    const timeout = window.setTimeout(() => setCopyState("idle"), 1200);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [copyState]);

  const handleCopy = async () => {
    setCopyState((await copyTextToClipboard(props.value)) ? "copied" : "failed");
  };

  return (
    <button
      type="button"
      onClick={() => {
        void handleCopy();
      }}
      className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--app-border)] px-2 text-[11px] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
      title={`Copy ${props.label}`}
    >
      {copyState === "copied" ? <Check size={12} /> : <Copy size={12} />}
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
  const runtimeStatus = props.projection?.currentRuntimeStatus ?? null;

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
            <InfoRow label="Launch" value={session?.launchSource ?? "Unavailable"} />
            <InfoRow label="State" value={session?.runtimeState ?? "Unavailable"} />
            <InfoRow label="Runtime" value={runtimeStatus ?? "Unavailable"} />
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
