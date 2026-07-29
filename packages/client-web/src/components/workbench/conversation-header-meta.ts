import type { ConversationMetaTone } from "./ConversationMetaBadge";
import type {
  ConversationProjection,
  SessionSideLifecycleState,
} from "@rah/runtime-protocol";

export type ConversationLifecycleStatus = "running" | "stopped";

export type ConversationPhase =
  | "starting"
  | "ready"
  | "working"
  | "waiting_input"
  | "waiting_permission"
  | "stopping"
  | "failed"
  | "ended";

export type ConversationHeaderStateIcon = "activity" | "running" | "stopped";

export type ConversationHeaderState = {
  label: string;
  tone: ConversationMetaTone;
  icon: ConversationHeaderStateIcon;
  title: string;
};

function formatPhaseLabel(phase: ConversationPhase): string {
  switch (phase) {
    case "starting":
      return "Starting";
    case "ready":
      return "Ready";
    case "working":
      return "Working";
    case "waiting_input":
      return "Input";
    case "waiting_permission":
      return "Approval";
    case "stopping":
      return "Stopping";
    case "failed":
      return "Failed";
    case "ended":
      return "Ended";
  }
}

export function resolveConversationHeaderState(input: {
  status: ConversationLifecycleStatus;
  phase: ConversationPhase;
  sideState?: SessionSideLifecycleState;
  externalActivity?: boolean;
}): ConversationHeaderState {
  switch (input.sideState) {
    case "active":
      return {
        label: "Working",
        tone: "working",
        icon: "activity",
        title: "Side task: Working",
      };
    case "completed":
      return {
        label: "Completed",
        tone: "running",
        icon: "running",
        title: "Side task: Completed and available for another turn",
      };
    case "expired":
      return {
        label: "Expired",
        tone: "stopped",
        icon: "stopped",
        title: "Side task: Expired",
      };
    case "cleanup_failed":
      return {
        label: "Cleanup failed",
        tone: "failed",
        icon: "stopped",
        title: "Side task cleanup failed; discard again to retry",
      };
    case "discarded":
      return {
        label: "Discarded",
        tone: "stopped",
        icon: "stopped",
        title: "Side task: Discarded",
      };
    case "ready":
    case undefined:
      break;
  }
  if (input.status === "stopped" && input.externalActivity) {
    return {
      label: "Working externally",
      tone: "working",
      icon: "activity",
      title: "Provider activity is continuing outside RAH",
    };
  }
  if (input.status === "stopped") {
    if (input.phase === "failed") {
      return {
        label: "Failed",
        tone: "failed",
        icon: "stopped",
        title: "Status: Failed",
      };
    }
    return {
      label: "Stopped",
      tone: "stopped",
      icon: "stopped",
      title: "Status: Stopped",
    };
  }

  switch (input.phase) {
    case "ready":
      return {
        label: "Ready",
        tone: "running",
        icon: "running",
        title: "Status: Ready",
      };
    case "starting":
    case "working":
    case "stopping": {
      const label = formatPhaseLabel(input.phase);
      return {
        label,
        tone: "working",
        icon: "activity",
        title: `Status: ${label}`,
      };
    }
    case "waiting_input":
    case "waiting_permission": {
      const label = formatPhaseLabel(input.phase);
      return {
        label,
        tone: "permission",
        icon: "activity",
        title: `Status: ${label}`,
      };
    }
    case "failed":
      return {
        label: "Failed",
        tone: "failed",
        icon: "stopped",
        title: "Status: Failed",
      };
    case "ended":
      return {
        label: "Stopped",
        tone: "stopped",
        icon: "stopped",
        title: "Status: Stopped",
      };
  }
}

export function conversationHasExternalActivity(
  conversation: Pick<ConversationProjection, "turns"> | null | undefined,
): boolean {
  const latestTurn = conversation?.turns.at(-1);
  if (!latestTurn) {
    return false;
  }
  return (
    latestTurn.status === "in_progress" ||
    latestTurn.items.some(
      (item) => item.status === "pending" || item.status === "running",
    )
  );
}
