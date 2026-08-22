import type { CouncilMessage } from "@rah/runtime-protocol";

export function councilMessageText(message: CouncilMessage): string {
  return message.parts
    .map((part) => part.kind === "text" ? part.text : JSON.stringify(part.data) ?? String(part.data))
    .join("\n");
}

export function isClientVisibleCouncilMessage(message: CouncilMessage): boolean {
  if (message.role !== "system") {
    return true;
  }
  return !/\bwait timed out;\s*no active listener is currently blocking on channel_wait_new\b/i.test(
    councilMessageText(message),
  );
}

/** Lifecycle/status rows are UI evidence, not conversational input for agents. */
export function isAgentDeliverableCouncilMessage(message: CouncilMessage): boolean {
  return message.role === "user" || message.role === "agent";
}
