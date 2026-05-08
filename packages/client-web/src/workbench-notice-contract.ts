import type { NativeTuiDiagnostic, SessionSummary } from "@rah/runtime-protocol";
import { describeWorkbenchError, type ErrorRecoveryDescriptor } from "./error-recovery";
import { nativeTuiDiagnosticNoticeMessage } from "./native-tui-diagnostics-ui";
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
  nativeTuiDiagnostics?: readonly NativeTuiDiagnostic[];
  error: string | null;
}): WorkbenchNoticeState {
  const { selectedSummary, selectedProjection, nativeTuiDiagnostics = [], error } = args;

  const nativeTuiDiagnosticMessage = nativeTuiDiagnostics[0]
    ? nativeTuiDiagnosticNoticeMessage(nativeTuiDiagnostics[0])
    : null;
  const nativeTuiStoppedMessage =
    selectedSummary?.session.nativeTui && selectedSummary.session.runtimeState === "stopped"
      ? "Native TUI process is stopped. Archive this session or resume it from history to continue."
      : null;
  const nativeTuiQueuedInputCount =
    selectedSummary?.session.nativeTui?.queuedInputCount ?? 0;
  const nativeTuiQueuedInputMessage =
    nativeTuiQueuedInputCount > 0
      ? `${nativeTuiQueuedInputCount} Chat message${
          nativeTuiQueuedInputCount === 1 ? "" : "s"
        } queued. It will send after the TUI prompt is clear.`
      : null;
  const nativeTuiPromptDirtyMessage =
    selectedSummary?.session.nativeTui?.promptState === "prompt_dirty"
      ? "Native TUI has an unsent local draft. Chat input will queue until the TUI prompt is clear."
      : null;
  const interactionMessage = selectedSummary
    ? selectedSummary.session.launchSource === "terminal" &&
      selectedSummary.controlLease.holderKind === "terminal" &&
      selectedSummary.session.runtimeState === "running"
      ? "Terminal started this turn. Web can observe it and request interrupt."
      : sessionInteractionNotice(selectedSummary)
    : null;
  const interactionNotice = nativeTuiDiagnosticMessage
    ? {
        tone: "warning" as const,
        message: nativeTuiDiagnosticMessage,
      }
    : nativeTuiStoppedMessage
    ? {
        tone: "warning" as const,
        message: nativeTuiStoppedMessage,
      }
    : nativeTuiQueuedInputMessage
    ? {
        tone: "info" as const,
        message: nativeTuiQueuedInputMessage,
      }
    : nativeTuiPromptDirtyMessage
    ? {
        tone: "warning" as const,
        message: nativeTuiPromptDirtyMessage,
      }
    : interactionMessage
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
