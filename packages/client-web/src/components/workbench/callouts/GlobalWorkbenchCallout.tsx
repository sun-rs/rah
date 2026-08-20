import type { SessionSummary } from "@rah/runtime-protocol";
import { AlertTriangle, BellOff, LoaderCircle, RefreshCcw, X } from "lucide-react";
import type { ErrorRecoveryDescriptor } from "../../../error-recovery";
import { usePwaDisplayMode } from "../../../hooks/usePwaDisplayMode";
import type { ResponsiveTier } from "../../../responsive-layout";
import { StatusCallout } from "../../StatusCallout";
import { pwaWorkbenchNoticeTop } from "../workbench-header-contract";

export type GlobalWorkbenchCalloutPlacement =
  | "centered"
  | "desktop-corner"
  | "pwa-top";

export interface GlobalWorkbenchNotice {
  id: string;
  errorDescriptor: ErrorRecoveryDescriptor | null;
  selectedSummary: SessionSummary | null;
  onRefresh: () => void;
  onClaimControl: (sessionId: string) => void;
  onDismiss: () => void;
  dismissLabel?: string;
}

export function resolveGlobalWorkbenchCalloutPlacement(
  viewportTier: ResponsiveTier,
  isPwaDisplayMode: boolean,
): GlobalWorkbenchCalloutPlacement {
  if (isPwaDisplayMode) {
    return "pwa-top";
  }
  return viewportTier !== "wide" ? "centered" : "desktop-corner";
}

export function GlobalWorkbenchCallout(
  props: GlobalWorkbenchNotice & { compact?: boolean; cornerCompact?: boolean },
) {
  if (!props.errorDescriptor) {
    return null;
  }

  if (props.errorDescriptor.presentation === "passive") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-full items-center gap-2 self-end rounded-full border border-[var(--app-border)] bg-[color:var(--app-surface)]/92 px-3 py-2 text-xs text-[var(--app-muted)] shadow-sm backdrop-blur"
      >
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
        <span className="shrink-0 font-medium text-[var(--app-text)]">
          {props.errorDescriptor.title}
        </span>
        <span className="hidden min-w-0 truncate sm:inline">
          {props.errorDescriptor.body}
        </span>
      </div>
    );
  }

  const onPrimary =
    props.errorDescriptor.primaryAction === "refresh"
      ? props.onRefresh
      : props.errorDescriptor.primaryAction === "claim_control" && props.selectedSummary
        ? () => props.onClaimControl(props.selectedSummary!.session.id)
        : undefined;

  if (props.compact) {
    const title = props.errorDescriptor.title;
    const body = props.errorDescriptor.body;
    const primaryLabel = props.errorDescriptor.primaryLabel ?? "Retry";
    return (
      <div
        role="alert"
        data-workbench-callout-variant="pwa-compact"
        className="rah-recovery-notice pointer-events-auto w-full rounded-xl border px-2.5 py-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="rah-recovery-notice-icon rah-recovery-notice-symbol flex h-7 w-7 shrink-0 items-center justify-center rounded-full">
            <AlertTriangle
              size={14}
              strokeWidth={1.9}
              aria-hidden="true"
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold leading-4 text-[var(--app-fg)]">
              {title}
            </div>
            <div className="mt-0.5 hidden line-clamp-2 text-xs leading-4 text-[var(--app-hint)] sm:block">
              {body}
            </div>
          </div>
          {onPrimary ? (
            <button
              type="button"
              className="icon-click-feedback inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 text-xs font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] active:bg-[var(--app-border)]"
              onClick={onPrimary}
            >
              <RefreshCcw size={12} aria-hidden="true" />
              <span>{primaryLabel}</span>
            </button>
          ) : null}
          {props.dismissLabel ? (
            <button
              type="button"
              className="icon-click-feedback inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] active:bg-[var(--app-border)]"
              onClick={props.onDismiss}
              aria-label={props.dismissLabel}
              title={props.dismissLabel}
            >
              <BellOff size={13} aria-hidden="true" />
              <span>{props.dismissLabel}</span>
            </button>
          ) : (
            <button
              type="button"
              className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] active:bg-[var(--app-border)]"
              onClick={props.onDismiss}
              aria-label="Dismiss notice"
              title="Dismiss"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    );
  }

  if (props.cornerCompact) {
    const title = props.errorDescriptor.title;
    const body = props.errorDescriptor.body;
    const primaryLabel = props.errorDescriptor.primaryLabel ?? "Retry";
    return (
      <div
        role="alert"
        data-workbench-callout-variant="desktop-compact"
        className="rah-recovery-notice pointer-events-auto w-full rounded-xl border px-2.5 py-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          <AlertTriangle
            size={14}
            strokeWidth={1.9}
            className="rah-recovery-notice-symbol shrink-0"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold leading-4 text-[var(--app-fg)]">
              {title}
            </div>
            <div
              className="line-clamp-2 text-[11px] leading-[15px] text-[var(--app-hint)]"
              title={body}
            >
              {body}
            </div>
          </div>
          {onPrimary ? (
            <button
              type="button"
              className="icon-click-feedback inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 text-[11px] font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
              onClick={onPrimary}
            >
              <RefreshCcw size={11} aria-hidden="true" />
              <span>{primaryLabel}</span>
            </button>
          ) : null}
          {props.dismissLabel ? (
            <button
              type="button"
              className="icon-click-feedback inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
              onClick={props.onDismiss}
              aria-label={props.dismissLabel}
              title={props.dismissLabel}
            >
              <BellOff size={12} aria-hidden="true" />
              <span>{props.dismissLabel}</span>
            </button>
          ) : (
            <button
              type="button"
              className="icon-click-feedback inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
              onClick={props.onDismiss}
              aria-label="Dismiss notice"
              title="Dismiss"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div role="alert" className="pointer-events-auto w-full">
      <StatusCallout
        tone="warning"
        title={props.errorDescriptor.title}
        body={props.errorDescriptor.body}
        {...(props.errorDescriptor.primaryAction === "refresh"
          ? {
              primaryLabel: props.errorDescriptor.primaryLabel ?? "Refresh sessions",
              onPrimary: props.onRefresh,
            }
          : props.errorDescriptor.primaryAction === "claim_control" && props.selectedSummary
            ? {
                primaryLabel: props.errorDescriptor.primaryLabel ?? "Resume",
                onPrimary: () => props.onClaimControl(props.selectedSummary!.session.id),
              }
            : {})}
        secondaryLabel={props.dismissLabel ?? "Dismiss"}
        onSecondary={props.onDismiss}
      />
    </div>
  );
}

export function GlobalWorkbenchNoticeHost(props: {
  notices: readonly GlobalWorkbenchNotice[];
  viewportTier: ResponsiveTier;
}) {
  const isPwaDisplayMode = usePwaDisplayMode();
  const placement = resolveGlobalWorkbenchCalloutPlacement(
    props.viewportTier,
    isPwaDisplayMode,
  );
  const notices = props.notices.filter((notice) => notice.errorDescriptor !== null);
  if (notices.length === 0) {
    return null;
  }

  const centered = placement === "centered";
  const pwaTop = placement === "pwa-top";
  return (
    <div
      data-workbench-notice-host=""
      data-placement={placement}
      className={`pointer-events-none fixed z-[30] flex flex-col gap-2 overflow-y-auto overscroll-contain ${
        pwaTop
          ? "p-1"
          : centered
          ? "left-1/2 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2"
          : "right-4 w-[min(24rem,calc(100vw-2rem))]"
      }`}
      style={
        pwaTop
          ? {
              top: pwaWorkbenchNoticeTop(),
              left: "max(0.75rem, env(safe-area-inset-left, 0px))",
              right: "max(0.75rem, env(safe-area-inset-right, 0px))",
              maxHeight:
                "calc(100dvh - var(--workbench-keyboard-inset, 0px) - env(safe-area-inset-top, 0px) - 4rem)",
            }
          : centered
          ? {
              top: "calc(50% - (var(--workbench-keyboard-inset, 0px) / 2))",
              maxHeight:
                "calc(100dvh - var(--workbench-keyboard-inset, 0px) - 2rem)",
            }
          : {
              bottom: "max(1rem, env(safe-area-inset-bottom, 0px))",
              right: "max(1rem, env(safe-area-inset-right, 0px))",
              maxHeight:
                "calc(100dvh - env(safe-area-inset-bottom, 0px) - 2rem)",
            }
      }
    >
      {notices.map((notice) => (
        <GlobalWorkbenchCallout
          key={notice.id}
          {...notice}
          compact={pwaTop}
          cornerCompact={placement === "desktop-corner"}
        />
      ))}
    </div>
  );
}
