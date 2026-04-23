import type { SessionSummary } from "@rah/runtime-protocol";
import { canSessionSendInput, isReadOnlyReplay } from "./session-capabilities";

export type ComposerSurface =
  | { kind: "history_claim"; actionLabel: string; actionPending: boolean }
  | { kind: "claim_control"; actionLabel: string; actionPending: boolean }
  | { kind: "compose"; showStopButton: boolean }
  | { kind: "unavailable" };

export const COMPOSER_LAYOUT = {
  bottomPaddingStyle: {
    paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)",
  } as const,
  rowClassName: "flex items-end gap-2 md:gap-3",
  controlButtonClassName:
    "shrink-0 self-end h-11 w-11 md:h-12 md:w-12 rounded-full flex items-center justify-center transition-colors",
  roundSecondaryButtonClassName:
    "shrink-0 self-end h-11 w-11 md:h-12 md:w-12 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)] flex items-center justify-center hover:text-[var(--app-fg)] transition-colors",
  roundPrimaryButtonClassName:
    "shrink-0 self-end h-11 w-11 md:h-12 md:w-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 disabled:opacity-40 transition-colors",
  stopWrapperClassName: "relative shrink-0 self-end h-11 w-11 md:h-12 md:w-12",
  stopButtonClassName:
    "absolute inset-[2px] rounded-full bg-[var(--app-danger)] text-white flex items-center justify-center transition-all duration-200 hover:opacity-90 hover:scale-105 active:scale-95",
  textareaClassName:
    "w-full resize-none overflow-y-auto custom-scrollbar bg-[var(--app-subtle-bg)] rounded-xl border border-[var(--app-border)] px-3 py-2 md:px-4 md:py-3 text-base leading-5 focus:outline-none focus:ring-1 focus:ring-[var(--ring)] min-h-11 md:min-h-12 max-h-[280px]",
  textareaContentClassName:
    "px-3 py-2 md:px-4 md:py-3 text-base leading-5 min-h-11 md:min-h-12",
} as const;

export function deriveComposerSurface(args: {
  selectedSummary: SessionSummary | null;
  hasControl: boolean;
  isGenerating: boolean;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "claim_history";
        sessionId: string;
      }
    | null;
}): ComposerSurface {
  const { selectedSummary, hasControl, isGenerating, pendingSessionAction } = args;
  if (!selectedSummary) {
    return { kind: "unavailable" };
  }

  const isClaimingControl =
    pendingSessionAction?.kind === "claim_control" &&
    pendingSessionAction.sessionId === selectedSummary.session.id;
  const isClaimingHistory =
    pendingSessionAction?.kind === "claim_history" &&
    pendingSessionAction.sessionId === selectedSummary.session.id;

  if (!canSessionSendInput(selectedSummary)) {
    return isReadOnlyReplay(selectedSummary) && selectedSummary.session.providerSessionId
      ? {
          kind: "history_claim",
          actionLabel: isClaimingHistory ? "Claiming…" : "Claim control",
          actionPending: isClaimingHistory,
        }
      : { kind: "unavailable" };
  }

  if (!hasControl) {
    return {
      kind: "claim_control",
      actionLabel: isClaimingControl ? "Claiming…" : "Claim control",
      actionPending: isClaimingControl,
    };
  }

  return {
    kind: "compose",
    showStopButton: isGenerating,
  };
}
