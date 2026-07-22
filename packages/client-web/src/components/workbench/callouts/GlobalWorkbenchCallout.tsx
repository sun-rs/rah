import type { SessionSummary } from "@rah/runtime-protocol";
import { LoaderCircle } from "lucide-react";
import type { ErrorRecoveryDescriptor } from "../../../error-recovery";
import { StatusCallout } from "../../StatusCallout";

export function GlobalWorkbenchCallout(props: {
  errorDescriptor: ErrorRecoveryDescriptor | null;
  selectedSummary: SessionSummary | null;
  onRefresh: () => void;
  onClaimControl: (sessionId: string) => void;
  onDismiss: () => void;
}) {
  if (!props.errorDescriptor) {
    return null;
  }

  if (props.errorDescriptor.presentation === "passive") {
    return (
      <div
        className="pointer-events-none fixed left-1/2 z-[30] -translate-x-1/2"
        style={{
          bottom:
            "var(--workbench-callout-anchor, calc(env(safe-area-inset-bottom, 0px) + 8.5rem))",
        }}
      >
        <div
          role="status"
          aria-live="polite"
          className="flex max-w-[min(88vw,32rem)] items-center gap-2 rounded-full border border-[var(--app-border)] bg-[color:var(--app-surface)]/92 px-3 py-2 text-xs text-[var(--app-muted)] shadow-sm backdrop-blur"
        >
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span className="shrink-0 font-medium text-[var(--app-text)]">
            {props.errorDescriptor.title}
          </span>
          <span className="hidden min-w-0 truncate sm:inline">
            {props.errorDescriptor.body}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed left-1/2 z-[30] w-[min(92vw,48rem)] -translate-x-1/2"
      style={{ bottom: "var(--workbench-callout-anchor, calc(env(safe-area-inset-bottom, 0px) + 9.5rem))" }}
    >
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
