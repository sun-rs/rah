import type { SessionSummary } from "@rah/runtime-protocol";
import { canSessionSendInput, isReadOnlyReplay } from "./session-capabilities";

export type ComposerSurface =
  | { kind: "history_claim"; actionLabel: string; actionPending: boolean }
  | { kind: "claim_control"; actionLabel: string; actionPending: boolean }
  | { kind: "compose"; showStopButton: boolean }
  | { kind: "unavailable" };

/* ── Unified sizing tokens ── */
/*  iOS (<768px) 40px | iPad (768–1023px) 36px | Desktop (≥1024px) 32px  */
const BTN = "h-10 w-10 md:h-9 md:w-9 lg:h-8 lg:w-8";
const GAP = "gap-1.5 md:gap-2";
const ROUNDED = "rounded-xl";

/* ── Base textarea ── */
const TEXTAREA_BASE =
  `block w-full resize-none overflow-y-auto custom-scrollbar box-border bg-[var(--app-subtle-bg)] border border-[var(--app-border)] text-base leading-5 focus:outline-none focus:ring-1 focus:ring-[var(--ring)]`;

export const COMPOSER_LAYOUT = {
  bottomPaddingStyle: {
    paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)",
    paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
    paddingRight: "max(0.75rem, env(safe-area-inset-right))",
  } as const,

  rowClassName: `flex items-end ${GAP}`,
  controlsGapClassName: GAP,

  /* Grid: [attach] [settings] [textarea] [stop?] [send] */
  composeGridWithoutStopClassName:
    `grid items-end grid-cols-[auto_auto_1fr_auto] ${GAP}`,
  composeGridWithStopClassName:
    `grid items-end grid-cols-[auto_auto_1fr_auto_auto] ${GAP}`,

  /* Attach button (left of textarea) */
  attachButtonClassName:
    `shrink-0 self-end ${BTN} rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)] flex items-center justify-center hover:text-[var(--app-fg)] hover:bg-[var(--app-bg)] transition-colors`,

  settingsButtonClassName:
    `shrink-0 self-end ${BTN} rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)] flex items-center justify-center hover:text-[var(--app-fg)] hover:bg-[var(--app-bg)] transition-colors`,

  /* Send button (right of textarea) */
  sendButtonClassName:
    `shrink-0 self-end ${BTN} rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 disabled:opacity-40 transition-colors`,

  /* Stop / generating spinner */
  stopWrapperClassName: `relative shrink-0 self-end ${BTN}`,
  stopSpinnerClassName:
    "pointer-events-none absolute inset-0 rounded-full border-2 border-[var(--app-danger)]/30 border-t-white/90 animate-[spin_0.95s_linear_infinite]",
  stopButtonClassName:
    "absolute inset-[3px] rounded-full bg-[var(--app-danger)] text-white flex items-center justify-center transition-all duration-200 hover:opacity-90 active:scale-95",

  textareaClassName:
    `${TEXTAREA_BASE} ${ROUNDED} min-h-10 md:min-h-9 lg:min-h-8 px-3 py-2 md:px-3 md:py-2 lg:py-1.5 max-h-[280px]`,
  textareaContentClassName:
    `px-3 py-2 md:px-3 md:py-2 lg:py-1.5 text-base leading-5`,
} as const;

export const EMPTY_STATE_COMPOSER_LAYOUT = {
  /* Landing textarea — generous bottom padding so the inline controls never overlap typed text */
  textareaClassName:
    `${TEXTAREA_BASE} rounded-2xl px-4 pt-3.5 pb-20 md:px-5 md:pt-4 md:pb-20 min-h-[7.5rem] md:min-h-[8rem] max-h-[50vh]`,
  textareaContentClassName:
    `px-4 pt-3.5 pb-20 md:px-5 md:pt-4 md:pb-20 text-base leading-5 min-h-[7.5rem] md:min-h-[8rem]`,

  /* Controls row — anchored to the bottom edge of the textarea card */
  controlsRowClassName:
    "absolute bottom-3 left-3 right-3 z-10 flex items-end justify-between gap-2",

  leftControlsClassName:
    "flex min-w-0 flex-1 flex-nowrap items-center gap-1 md:gap-2 overflow-visible",

  /* Secondary pills */
  pillClassName:
    `inline-flex h-10 md:h-9 lg:h-8 w-[3.75rem] md:w-[7.25rem] lg:w-[8rem] shrink-0 min-w-0 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2 md:px-3 text-[11px] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]`,

  /* Attach button */
  attachButtonClassName:
    `shrink-0 self-end ${BTN} rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] flex items-center justify-center hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors`,

  /* Send button */
  sendButtonClassName:
    `shrink-0 self-end ${BTN} rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 disabled:opacity-40 transition-colors`,

  /* Provider / model config row — sits *outside* the textarea, directly beneath it */
  configRowClassName:
    `flex flex-wrap items-center gap-2 mt-3 md:mt-4`,
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
    if (selectedSummary.session.launchSource === "terminal") {
      return {
        kind: "compose",
        showStopButton: isGenerating,
      };
    }
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
