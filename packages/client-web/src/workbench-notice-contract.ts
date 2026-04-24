import type { SessionSummary } from "@rah/runtime-protocol";
import { describeWorkbenchError, type ErrorRecoveryDescriptor } from "./error-recovery";
import { sessionInteractionNotice } from "./session-capabilities";
import type { SessionProjection } from "./types";

export interface InlineWorkbenchNotice {
  tone: "info" | "warning";
  message: string;
}

export interface WorkbenchNoticeState {
  interactionNotice: InlineWorkbenchNotice | null;
  historyNotice: InlineWorkbenchNotice | null;
  errorDescriptor: ErrorRecoveryDescriptor | null;
}

export function deriveWorkbenchNoticeState(args: {
  selectedSummary: SessionSummary | null;
  selectedProjection: SessionProjection | null;
  error: string | null;
}): WorkbenchNoticeState {
  const { selectedSummary, selectedProjection, error } = args;

  const interactionMessage = selectedSummary
    ? selectedSummary.session.launchSource === "terminal" &&
      selectedSummary.controlLease.holderKind === "terminal" &&
      selectedSummary.session.runtimeState === "running"
      ? "Terminal is handling this turn. Web can observe it, but can't interrupt it."
      : sessionInteractionNotice(selectedSummary)
    : null;
  const interactionNotice = interactionMessage
    ? {
        tone: "info" as const,
        message: interactionMessage,
      }
    : null;

  const historyNotice =
    selectedSummary?.session.providerSessionId && selectedProjection
      ? selectedProjection.history.phase === "loading" &&
        !selectedProjection.history.authoritativeApplied
        ? {
            tone: "info" as const,
            message: "Syncing session history…",
          }
        : selectedProjection.history.phase === "error" && selectedProjection.history.lastError
          ? {
              tone: "warning" as const,
              message: `History sync failed: ${selectedProjection.history.lastError}`,
            }
          : null
      : null;

  return {
    interactionNotice,
    historyNotice,
    errorDescriptor: error ? describeWorkbenchError(error, selectedSummary) : null,
  };
}
