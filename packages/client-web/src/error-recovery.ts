import type { SessionSummary } from "@rah/runtime-protocol";
import {
  canSessionSendInput,
  canSessionRespondToPermissions,
  isReadOnlyReplay,
} from "./session-capabilities";

export type RecoveryAction = "refresh" | "claim_control" | "dismiss";

export interface ErrorRecoveryDescriptor {
  title: string;
  body: string;
  primaryAction?: RecoveryAction;
  primaryLabel?: string;
}

export function describeWorkbenchError(
  error: string,
  summary?: SessionSummary | null,
): ErrorRecoveryDescriptor {
  const message = error.trim();
  const lower = message.toLowerCase();

  if (summary && isReadOnlyReplay(summary) && lower.includes("read-only")) {
    return {
      title: "Read-only replay",
      body:
        "This session was restored from stored history. Review the transcript, files, and diffs here, then refresh sessions or resume the live thread if you need to continue working.",
      primaryAction: "refresh",
      primaryLabel: "Refresh sessions",
    };
  }

  if (summary && lower.includes("does not hold input control") && canSessionSendInput(summary)) {
    return {
      title: "Control required",
      body:
        "Another client currently holds input control for this session. Claim control here before sending input or interrupting the turn.",
      primaryAction: "claim_control",
      primaryLabel: "Claim control",
    };
  }

  if (
    summary &&
    lower.includes("permission") &&
    lower.includes("support") &&
    !canSessionRespondToPermissions(summary)
  ) {
    return {
      title: "Approval unavailable",
      body:
        "This session cannot answer live permission requests from the current client. Refresh sessions or reconnect to a live provider session before retrying.",
      primaryAction: "refresh",
      primaryLabel: "Refresh sessions",
    };
  }

  if (
    lower.includes("replay gap") ||
    lower.includes("stream fell behind")
  ) {
    return {
      title: "Realtime sync reset",
      body:
        "The event stream fell behind the daemon backlog, so the workbench rebuilt session state from the latest summaries. Refresh sessions if any transcript still looks incomplete.",
      primaryAction: "refresh",
      primaryLabel: "Refresh sessions",
    };
  }

  if (
    lower.includes("events socket failed") ||
    lower.includes("transport") ||
    lower.includes("unable to connect") ||
    lower.includes("networkerror") ||
    lower.includes("fetch")
  ) {
    return {
      title: "Connection issue",
      body:
        "The workbench lost contact with the daemon or event stream. Refresh sessions first; if the problem continues, reload the page.",
      primaryAction: "refresh",
      primaryLabel: "Refresh sessions",
    };
  }

  if (lower.includes("/history") || lower.includes("history")) {
    return {
      title: "History load failed",
      body:
        "Older session history could not be loaded right now. You can try again, or refresh sessions if this session was restored from provider history.",
      primaryAction: "refresh",
      primaryLabel: "Refresh sessions",
    };
  }

  if (lower.includes("choose a workspace directory first")) {
    return {
      title: "Choose a workspace",
      body:
        "Pick a workspace directory before starting a new session so the workbench can group history, files, and live sessions correctly.",
    };
  }

  return {
    title: "Action failed",
    body: message,
  };
}
