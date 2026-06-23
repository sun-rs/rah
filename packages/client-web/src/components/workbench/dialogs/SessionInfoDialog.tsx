import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { SessionLiveBackend, SessionSummary } from "@rah/runtime-protocol";
import { conversationPhaseLabel } from "@rah/runtime-protocol";
import { providerLabel, type SessionProjection } from "../../../types";
import { writeHostClipboard } from "../../../api";
import { OverlayScrollArea } from "../../OverlayScrollArea";

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
    <div className="grid grid-cols-[7rem_1fr] gap-3 border-b border-[var(--app-border)] px-4 py-2.5 text-sm last:border-b-0">
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

function InfoSectionHeader(props: { children: React.ReactNode }) {
  return (
    <div className="border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--app-muted)] first:border-t-0">
      {props.children}
    </div>
  );
}

function capitalizeValue(value: string): string {
  return value.length > 0 ? value.slice(0, 1).toUpperCase() + value.slice(1) : value;
}

function formatStatus(session: SessionSummary["session"] | undefined): string {
  if (!session) {
    return "Unavailable";
  }
  return `${capitalizeValue(session.status)} · ${capitalizeValue(conversationPhaseLabel(session.phase))}`;
}

function formatBackend(value: SessionLiveBackend | undefined): string {
  switch (value) {
    case "structured":
      return "Structured events";
    case "native_local_server":
      return "Native local server";
    case "native_tui":
      return "Native TUI";
    case "tui_mux":
      return "Terminal mux";
    default:
      return "Unavailable";
  }
}

function formatSessionOrigin(session: SessionSummary["session"] | undefined): ReactNode | null {
  if (session?.origin?.kind !== "council") {
    return null;
  }
  const origin = session.origin;
  return (
    <div className="grid min-w-0 gap-1">
      <div className="font-medium text-[var(--app-fg)]">Council agent session</div>
      <div className="text-[12px] text-[var(--app-muted)]">
        Council: {origin.councilTitle ?? origin.councilId}
      </div>
      <div className="text-[12px] text-[var(--app-muted)]">
        Agent: {origin.agentLabel ?? origin.agentId}
      </div>
    </div>
  );
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
  const providerSessionId = session?.providerSessionId ?? null;
  const resumeCommand =
    session?.providerSessionId && session.provider !== "custom"
      ? `rah ${session.provider} resume ${session.providerSessionId}`
      : null;
  const rahAttachCommand = session ? `rah attach ${session.id}` : null;
  const isRunningSession = session?.status === "running";
  const launchSource =
    session?.launchSource === "terminal"
      ? "Terminal"
      : session?.launchSource === "web"
        ? "Web"
        : session?.launchSource ?? "Unavailable";
  const origin = formatSessionOrigin(session);
  const showCwd = Boolean(session?.cwd && session.rootDir && session.cwd !== session.rootDir);

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(68dvh,560px)] w-[min(640px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl focus:outline-none max-md:inset-0 max-md:h-[100dvh] max-md:max-h-[100dvh] max-md:w-screen max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]">
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
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <OverlayScrollArea className="min-h-0 flex-1" viewportClassName="h-full">
            <InfoSectionHeader>Session</InfoSectionHeader>
            <InfoRow label="Provider" value={session ? providerLabel(session.provider) : "Unavailable"} />
            <InfoRow label="Status" value={formatStatus(session)} />
            {providerSessionId ? (
              <InfoRow
                label="Session ID"
                mono
                value={
                  <div className="flex flex-wrap items-start gap-2">
                    <span className="min-w-0 flex-1">{providerSessionId}</span>
                    <CopyValueButton value={providerSessionId} label="session ID" />
                  </div>
                }
              />
            ) : null}
            {!isRunningSession && resumeCommand ? (
              <InfoRow
                label="Resume"
                mono
                value={
                  <div className="flex flex-wrap items-start gap-2">
                    <span className="min-w-0 flex-1">{resumeCommand}</span>
                    <CopyValueButton value={resumeCommand} label="resume command" />
                  </div>
                }
              />
            ) : null}
            {origin ? <InfoRow label="Created by" value={origin} /> : null}
            <InfoRow label="Workspace" mono value={session?.rootDir ?? "Unavailable"} />
            {showCwd ? <InfoRow label="Working dir" mono value={session?.cwd ?? "Unavailable"} /> : null}
            <InfoRow label="Last updated" value={formatDateTime(session?.updatedAt)} />
            {isRunningSession ? (
              <>
                <InfoSectionHeader>Runtime</InfoSectionHeader>
                <InfoRow label="Backend" value={formatBackend(session?.liveBackend)} />
                <InfoRow label="Started from" value={launchSource} />
                <InfoRow
                  label="Runtime ID"
                  mono
                  value={
                    <div className="flex flex-wrap items-start gap-2">
                      <span className="min-w-0 flex-1">{session?.id ?? "Unavailable"}</span>
                      {session?.id ? (
                        <CopyValueButton value={session.id} label="runtime ID" />
                      ) : null}
                    </div>
                  }
                />
                <InfoRow
                  label="Attach"
                  mono
                  value={
                    rahAttachCommand ? (
                      <div className="flex flex-wrap items-start gap-2">
                        <span className="min-w-0 flex-1">{rahAttachCommand}</span>
                        <CopyValueButton value={rahAttachCommand} label="attach command" />
                      </div>
                    ) : (
                      "Unavailable"
                    )
                  }
                />
              </>
            ) : null}
          </OverlayScrollArea>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
