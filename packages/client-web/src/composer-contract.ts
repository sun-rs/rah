import type { SessionSummary } from "@rah/runtime-protocol";
import { canSessionSendInput, isReadOnlyReplay } from "./session-capabilities";

export type ComposerSurface =
  | { kind: "history_claim"; actionLabel: string; actionPending: boolean }
  | { kind: "claim_control"; actionLabel: string; actionPending: boolean }
  | { kind: "compose"; showStopButton: boolean }
  | { kind: "unavailable" };

const COMPOSER_CONTROL_SIZE_CLASS_NAME = "h-11 w-11 md:h-12 md:w-12";
const COMPOSER_CONTROLS_GAP_CLASS_NAME = "gap-2 md:gap-3";
const COMPOSER_TEXT_BASE_CLASS_NAME = "text-base leading-5";
const COMPOSER_TEXT_PADDING_CLASS_NAME = "px-3 py-2 md:px-4 md:py-3";
const COMPOSER_TEXTAREA_BASE_CLASS_NAME = `block w-full resize-none overflow-y-auto custom-scrollbar box-border bg-[var(--app-subtle-bg)] border border-[var(--app-border)] ${COMPOSER_TEXT_BASE_CLASS_NAME} focus:outline-none focus:ring-1 focus:ring-[var(--ring)]`;

export const COMPOSER_LAYOUT = {
  bottomPaddingStyle: {
    paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)",
  } as const,
  rowClassName: `flex items-end ${COMPOSER_CONTROLS_GAP_CLASS_NAME}`,
  controlsGapClassName: COMPOSER_CONTROLS_GAP_CLASS_NAME,
  composeGridWithoutStopClassName:
    `grid items-end grid-cols-[auto_minmax(0,1fr)_2.75rem] ${COMPOSER_CONTROLS_GAP_CLASS_NAME} md:grid-cols-[auto_minmax(0,1fr)_3rem]`,
  composeGridWithStopClassName:
    `grid items-end grid-cols-[auto_minmax(0,1fr)_2.75rem_2.75rem] ${COMPOSER_CONTROLS_GAP_CLASS_NAME} md:grid-cols-[auto_minmax(0,1fr)_3rem_3rem]`,
  controlButtonClassName:
    `shrink-0 self-end ${COMPOSER_CONTROL_SIZE_CLASS_NAME} rounded-full flex items-center justify-center transition-colors`,
  roundSecondaryButtonClassName:
    `shrink-0 self-end ${COMPOSER_CONTROL_SIZE_CLASS_NAME} rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)] flex items-center justify-center hover:text-[var(--app-fg)] transition-colors`,
  roundPrimaryButtonClassName:
    `shrink-0 self-end ${COMPOSER_CONTROL_SIZE_CLASS_NAME} rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 disabled:opacity-40 transition-colors`,
  stopWrapperClassName: `relative shrink-0 self-end ${COMPOSER_CONTROL_SIZE_CLASS_NAME}`,
  stopSpinnerClassName:
    "pointer-events-none absolute inset-0 rounded-full border-2 border-[var(--app-danger)]/30 border-t-white/90 animate-[spin_0.95s_linear_infinite]",
  stopButtonClassName:
    "absolute inset-[3px] rounded-full bg-[var(--app-danger)] text-white flex items-center justify-center transition-all duration-200 hover:opacity-90 active:scale-95",
  textareaClassName:
    `${COMPOSER_TEXTAREA_BASE_CLASS_NAME} rounded-xl ${COMPOSER_TEXT_PADDING_CLASS_NAME} h-11 md:h-12 min-h-11 md:min-h-12 max-h-[280px]`,
  textareaContentClassName:
    `${COMPOSER_TEXT_PADDING_CLASS_NAME} ${COMPOSER_TEXT_BASE_CLASS_NAME} min-h-11 md:min-h-12`,
} as const;

export const EMPTY_STATE_COMPOSER_LAYOUT = {
  textareaClassName:
    `${COMPOSER_TEXTAREA_BASE_CLASS_NAME} rounded-2xl ${COMPOSER_TEXT_PADDING_CLASS_NAME} pr-16 pb-16 md:pr-[4.5rem] md:pb-[4.5rem] min-h-[120px]`,
  textareaContentClassName:
    `${COMPOSER_TEXT_PADDING_CLASS_NAME} pr-16 pb-16 md:pr-[4.5rem] md:pb-[4.5rem] ${COMPOSER_TEXT_BASE_CLASS_NAME} min-h-[120px]`,
  roundSecondaryButtonClassName: COMPOSER_LAYOUT.roundSecondaryButtonClassName,
  roundPrimaryButtonClassName: COMPOSER_LAYOUT.roundPrimaryButtonClassName,
  controlsInsetClassName: "bottom-3 left-3 right-3",
  controlsRowClassName:
    "absolute bottom-3 left-3 right-3 z-10 flex items-end justify-between gap-3",
  leftControlsClassName: `flex min-w-0 items-end ${COMPOSER_CONTROLS_GAP_CLASS_NAME}`,
  workspaceTriggerClassName:
    "inline-flex h-11 md:h-12 max-w-[11rem] items-center gap-1.5 rounded-xl px-3 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-bg)] transition-colors",
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
