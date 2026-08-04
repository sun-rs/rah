import type {
  NativeTuiPromptState,
  SessionSummary,
} from "@rah/runtime-protocol";
import { canSessionSendInput, isReadOnlyReplay } from "./session-capabilities";

export type ComposerSurface =
  | { kind: "claim_control"; actionLabel: string; actionPending: boolean }
  | {
      kind: "compose";
      showStopButton: boolean;
      resumeOnSend?: boolean;
      stopDisabled?: boolean;
      stopTitle?: string;
      stopTone?: "danger" | "warning";
      stopAriaLabel?: string;
    }
  | { kind: "unavailable" };

/* ── Unified sizing tokens ── */
/* Touch (<700px) stays 40px; pointer layouts use Codex-dense 32/28px slots. */
const BTN = "h-10 w-10 md:h-8 md:w-8 lg:h-7 lg:w-7";
const GAP = "gap-1.5";
const ROUNDED = "rounded-xl";
const COMPOSER_GHOST_BASE =
  "border border-transparent bg-transparent text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] aria-expanded:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-40";
const PRIMARY_ACTION_SLOT = `rah-chat-composer-primary shrink-0 self-end ${BTN} rounded-full flex items-center justify-center`;
const PRIMARY_ACTION_BUTTON = `${PRIMARY_ACTION_SLOT} bg-primary text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40`;

/* ── Base textarea ── */
const TEXTAREA_BASE = `block w-full min-w-0 max-w-full resize-none overflow-x-hidden overflow-y-auto rah-scroll-textarea box-border border-0 bg-transparent text-base font-normal leading-6 md:text-sm md:leading-5 placeholder:text-[var(--app-hint)] placeholder:opacity-55 focus:outline-none focus:ring-0`;

export const COMPOSER_PLACEHOLDER = "Work with Rah";

export const COMPOSER_LAYOUT = {
  bottomPaddingStyle: {
    paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)",
    paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
    paddingRight: "max(0.75rem, env(safe-area-inset-right))",
  } as const,

  rowClassName: `flex items-end ${GAP}`,
  controlsGapClassName: GAP,

  /* One surface: textarea spans row one; the shared toolbar owns row two. */
  composeGridClassName: `relative flex min-w-0 flex-col justify-between gap-1 p-2.5 md:min-h-[6.25rem] md:px-3 md:py-2`,

  /* Borderless secondary controls match Codex Desktop's composerSm + ghost buttons. */
  attachButtonClassName: `rah-chat-composer-attach shrink-0 self-end ${BTN} rounded-full ${COMPOSER_GHOST_BASE} flex items-center justify-center`,
  settingsButtonClassName: `rah-chat-composer-settings shrink-0 self-end ${BTN} rounded-full ${COMPOSER_GHOST_BASE} flex items-center justify-center`,
  ghostIconButtonClassName: `shrink-0 self-end ${BTN} rounded-full ${COMPOSER_GHOST_BASE} flex items-center justify-center`,
  ghostTextButtonClassName: `inline-flex h-10 md:h-8 lg:h-7 min-w-0 items-center gap-1 rounded-full ${COMPOSER_GHOST_BASE} px-2 text-[13px] leading-[18px]`,

  /* Send and Stop replace one another in the same right-edge action slot. */
  primaryActionButtonClassName: PRIMARY_ACTION_BUTTON,
  sendButtonClassName: PRIMARY_ACTION_BUTTON,
  stopWarningActionButtonClassName: `${PRIMARY_ACTION_SLOT} border border-amber-400/70 bg-amber-100 text-[10px] font-semibold tracking-[0.02em] text-amber-700 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-amber-100`,

  textareaClassName: `${TEXTAREA_BASE} ${ROUNDED} min-h-[2.25rem] px-1 py-1 md:min-h-8 max-h-[280px]`,
  textareaContentClassName: `px-1 py-1 text-base font-normal leading-6 md:text-sm md:leading-5`,
} as const;

export const EMPTY_STATE_COMPOSER_LAYOUT = {
  textareaWrapperClassName: "max-w-full",

  /* Landing textarea — generous bottom padding so the inline controls never overlap typed text */
  textareaClassName: `${TEXTAREA_BASE} rounded-2xl px-1 py-1 min-h-[2.25rem] md:min-h-8 max-h-[50vh]`,
  textareaContentClassName: `px-1 py-1 text-base font-normal leading-6 min-h-[2.25rem] md:min-h-8 md:text-sm md:leading-5`,

  /* Controls row — part of the same white surface, below the textarea. */
  controlsRowClassName:
    "mt-1 md:mt-0",

  leftControlsClassName:
    "flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-visible",

  rightControlsClassName:
    "flex min-w-0 shrink-0 flex-nowrap items-center justify-end gap-1 overflow-visible",

  /* New-task-only workspace control, expressed with the same ghost language. */
  workspaceButtonClassName: `inline-flex h-7 w-auto max-w-[12rem] shrink min-w-0 items-center gap-1.5 rounded-lg ${COMPOSER_GHOST_BASE} px-1.5 text-[13px] leading-[18px]`,

  /* Attach and Send retain touch targets; only Send carries a solid surface. */
  attachButtonClassName: `shrink-0 self-end ${BTN} rounded-full ${COMPOSER_GHOST_BASE} flex items-center justify-center`,

  /* Send button */
  sendButtonClassName: `shrink-0 self-end ${BTN} rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 disabled:opacity-40 transition-colors`,
} as const;

function bestEffortEscTuiProviderLabel(provider: string): string | undefined {
  if (provider === "claude") {
    return "Claude";
  }
  return undefined;
}

export function canSubmitComposerInput(args: {
  composerSurface: ComposerSurface;
  draft: string;
  attachmentCount?: number | undefined;
  sendPending: boolean;
  nativeTuiPromptState?: NativeTuiPromptState | undefined;
}): boolean {
  if (args.composerSurface.kind !== "compose") {
    return false;
  }
  if (!args.draft.trim() && (args.attachmentCount ?? 0) <= 0) {
    return false;
  }
  if (args.sendPending && args.nativeTuiPromptState === undefined) {
    return false;
  }
  return true;
}

export function shouldShowComposerStopAction(args: {
  composerSurface: ComposerSurface;
  draft: string;
  attachmentCount?: number | undefined;
}): boolean {
  return (
    args.composerSurface.kind === "compose" &&
    args.composerSurface.showStopButton &&
    !args.draft.trim() &&
    (args.attachmentCount ?? 0) <= 0
  );
}

export function deriveComposerSurface(args: {
  selectedSummary: SessionSummary | null;
  historyArchived?: boolean;
  hasControl: boolean;
  isGenerating: boolean;
  pendingSessionAction: {
    kind: "attach_session" | "claim_control" | "resume_history";
    sessionId: string;
  } | null;
}): ComposerSurface {
  const {
    selectedSummary,
    historyArchived = false,
    hasControl,
    isGenerating,
    pendingSessionAction,
  } = args;
  if (!selectedSummary) {
    return { kind: "unavailable" };
  }

  const isResumingControl =
    pendingSessionAction?.kind === "claim_control" &&
    pendingSessionAction.sessionId === selectedSummary.session.id;
  if (!canSessionSendInput(selectedSummary)) {
    return isReadOnlyReplay(selectedSummary) &&
      selectedSummary.session.providerSessionId &&
      !historyArchived
      ? {
          kind: "compose",
          showStopButton: false,
          resumeOnSend: true,
        }
      : { kind: "unavailable" };
  }

  const bestEffortEscLabel = bestEffortEscTuiProviderLabel(
    selectedSummary.session.provider,
  );
  if (bestEffortEscLabel) {
    return {
      kind: "compose",
      showStopButton: true,
      stopTone: "warning",
      stopAriaLabel: `Send Esc to ${bestEffortEscLabel} TUI`,
      stopTitle: `Send Esc to the ${bestEffortEscLabel} TUI. Chat is a TUI mirror, so this is best-effort.`,
    };
  }

  if (!hasControl) {
    if (selectedSummary.session.liveBackend === "native_local_server") {
      return {
        kind: "compose",
        showStopButton: isGenerating,
        stopTitle: "Interrupt the native TUI turn from Web.",
      };
    }
    return {
      kind: "claim_control",
      actionLabel: isResumingControl ? "Resuming…" : "Resume",
      actionPending: isResumingControl,
    };
  }

  return {
    kind: "compose",
    showStopButton: isGenerating,
  };
}
