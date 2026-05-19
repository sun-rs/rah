import type { ConversationMetaTone } from "./ConversationMetaBadge";

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
}): ConversationHeaderState {
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
