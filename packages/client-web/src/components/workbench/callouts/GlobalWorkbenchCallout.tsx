import type { SessionSummary } from "@rah/runtime-protocol";
import { LoaderCircle } from "lucide-react";
import type { ErrorRecoveryDescriptor } from "../../../error-recovery";
import { usePwaDisplayMode } from "../../../hooks/usePwaDisplayMode";
import type { ResponsiveTier } from "../../../responsive-layout";
import { StatusCallout } from "../../StatusCallout";

export type GlobalWorkbenchCalloutPlacement = "centered" | "desktop-corner";

export interface GlobalWorkbenchNotice {
  id: string;
  errorDescriptor: ErrorRecoveryDescriptor | null;
  selectedSummary: SessionSummary | null;
  onRefresh: () => void;
  onClaimControl: (sessionId: string) => void;
  onDismiss: () => void;
}

export function resolveGlobalWorkbenchCalloutPlacement(
  viewportTier: ResponsiveTier,
  isPwaDisplayMode: boolean,
): GlobalWorkbenchCalloutPlacement {
  return isPwaDisplayMode || viewportTier !== "wide" ? "centered" : "desktop-corner";
}

function GlobalWorkbenchCallout(props: GlobalWorkbenchNotice) {
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
        secondaryLabel="Dismiss"
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
  return (
    <div
      data-workbench-notice-host=""
      data-placement={placement}
      className={`pointer-events-none fixed z-[30] flex flex-col gap-2 overflow-y-auto overscroll-contain ${
        centered
          ? "left-1/2 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2"
          : "right-5 w-[min(26rem,calc(100vw-2.5rem))]"
      }`}
      style={
        centered
          ? {
              top: "calc(50% - (var(--workbench-keyboard-inset, 0px) / 2))",
              maxHeight:
                "calc(100dvh - var(--workbench-keyboard-inset, 0px) - 2rem)",
            }
          : {
              bottom:
                "var(--workbench-callout-anchor, calc(env(safe-area-inset-bottom, 0px) + 8.5rem))",
              right: "max(1.25rem, env(safe-area-inset-right, 0px))",
              maxHeight:
                "calc(100dvh - var(--workbench-callout-anchor, 8.5rem) - 1.25rem)",
            }
      }
    >
      {notices.map((notice) => (
        <GlobalWorkbenchCallout key={notice.id} {...notice} />
      ))}
    </div>
  );
}
