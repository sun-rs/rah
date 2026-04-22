import type { SessionSummary } from "@rah/runtime-protocol";
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

  return (
    <div
      className="fixed left-1/2 z-[60] w-[min(92vw,48rem)] -translate-x-1/2"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 6rem)" }}
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
                primaryLabel: props.errorDescriptor.primaryLabel ?? "Claim control",
                onPrimary: () => props.onClaimControl(props.selectedSummary!.session.id),
              }
            : {})}
        secondaryLabel="Dismiss"
        onSecondary={props.onDismiss}
      />
    </div>
  );
}
