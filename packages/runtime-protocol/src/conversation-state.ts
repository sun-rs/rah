export type ConversationStatus = "running" | "stopped";

export type ConversationPhase =
  | "starting"
  | "ready"
  | "working"
  | "waiting_input"
  | "waiting_permission"
  | "stopping"
  | "failed"
  | "ended";

export interface ConversationState {
  status: ConversationStatus;
  phase: ConversationPhase;
}

export function conversationStateFromRuntimeState(runtimeState: string | undefined): ConversationState {
  switch (runtimeState) {
    case "starting":
      return { status: "running", phase: "starting" };
    case "running":
      return { status: "running", phase: "working" };
    case "waiting_input":
      return { status: "running", phase: "waiting_input" };
    case "waiting_permission":
      return { status: "running", phase: "waiting_permission" };
    case "failed":
      return { status: "stopped", phase: "failed" };
    case "stopped":
      return { status: "stopped", phase: "ended" };
    case "idle":
    default:
      return { status: "running", phase: "ready" };
  }
}

export function conversationStateFromLegacyCouncilRoomStatus(status: string | undefined): ConversationState {
  switch (status) {
    case "starting":
      return { status: "running", phase: "starting" };
    case "failed":
      return { status: "stopped", phase: "failed" };
    case "stopped":
      return { status: "stopped", phase: "ended" };
    case "running":
    case "idle":
    default:
      return { status: "running", phase: "ready" };
  }
}

export function isConversationRunning(state: ConversationState): boolean {
  return state.status === "running";
}

export function isConversationStopped(state: ConversationState): boolean {
  return state.status === "stopped";
}

export function conversationStatusLabel(status: ConversationStatus): string {
  return status === "running" ? "running" : "stopped";
}

export function conversationPhaseLabel(phase: ConversationPhase): string {
  switch (phase) {
    case "starting":
      return "starting";
    case "ready":
      return "ready";
    case "working":
      return "working";
    case "waiting_input":
      return "waiting input";
    case "waiting_permission":
      return "waiting permission";
    case "stopping":
      return "stopping";
    case "failed":
      return "failed";
    case "ended":
      return "ended";
  }
}

export function formatConversationState(state: ConversationState): string {
  return `${conversationStatusLabel(state.status)} · ${conversationPhaseLabel(state.phase)}`;
}
