import { useEffect, useState } from "react";
import type { SessionSummary } from "@rah/runtime-protocol";
import type { ErrorRecoveryDescriptor } from "../../../error-recovery";
import { describeTransportStatus, type TransportStatus } from "../../../transport-status";
import { StatusCallout } from "../../StatusCallout";
import { RefreshCcw } from "lucide-react";

export function GlobalWorkbenchCallout(props: {
  errorDescriptor: ErrorRecoveryDescriptor | null;
  transportStatus: TransportStatus;
  selectedSummary: SessionSummary | null;
  onRefresh: () => void;
  onClaimControl: (sessionId: string) => void;
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (props.transportStatus.phase === "connected") {
      return;
    }
    setNow(Date.now());
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => window.clearInterval(interval);
  }, [props.transportStatus]);

  const selectedLiveSession = Boolean(
    props.selectedSummary &&
      props.selectedSummary.session.status === "running" &&
      (props.selectedSummary.session.capabilities.steerInput ||
        props.selectedSummary.session.capabilities.livePermissions),
  );
  const transportDescriptor = describeTransportStatus(props.transportStatus, now, {
    selectedLiveSession,
  });
  const descriptor = props.errorDescriptor ?? transportDescriptor;

  if (!descriptor) {
    return null;
  }
  const transportIsSyncing =
    !props.errorDescriptor &&
    transportDescriptor?.title === "Syncing" &&
    props.transportStatus.phase !== "connected";
  const tone = props.errorDescriptor ? "warning" : transportDescriptor?.tone ?? "warning";
  const secondaryLabel = props.errorDescriptor ? "Dismiss" : transportDescriptor?.secondaryLabel;

  return (
    <div
      className="fixed left-1/2 z-[30] w-[min(92vw,48rem)] -translate-x-1/2"
      style={{ bottom: "var(--workbench-callout-anchor, calc(env(safe-area-inset-bottom, 0px) + 9.5rem))" }}
    >
      <StatusCallout
        tone={tone}
        title={descriptor.title}
        body={descriptor.body}
        {...(transportIsSyncing
          ? {
              icon: <RefreshCcw size={16} className="animate-spin text-[var(--app-hint)]" />,
            }
          : {})}
        {...(descriptor.primaryAction === "refresh"
          ? {
              primaryLabel: descriptor.primaryLabel ?? "Refresh sessions",
              onPrimary: props.onRefresh,
            }
          : descriptor.primaryAction === "claim_control" && props.selectedSummary
            ? {
                primaryLabel: descriptor.primaryLabel ?? "Claim control",
                onPrimary: () => props.onClaimControl(props.selectedSummary!.session.id),
              }
            : {})}
        {...(!transportIsSyncing && secondaryLabel !== undefined
          ? {
              secondaryLabel,
              onSecondary: props.onDismiss,
            }
          : {})}
      />
    </div>
  );
}
