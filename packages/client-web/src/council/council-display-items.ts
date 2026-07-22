import type { CouncilSnapshot } from "@rah/runtime-protocol";

export type CouncilMessage = CouncilSnapshot["messages"][number];

export type CouncilDisplayItem =
  | { kind: "message"; message: CouncilMessage }
  | {
    kind: "agent-status";
    key: string;
    actorId: string;
    status: "sent" | "joined" | "ready";
    messageId: number;
  };

function messageText(message: CouncilMessage): string {
  return message.parts
    .map((part) => part.kind === "text" ? part.text : JSON.stringify(part.data))
    .join("\n")
    .trim();
}

function isCouncilSystemNoise(message: CouncilMessage): boolean {
  return (
    message.role === "system" &&
    /\bwait timed out;\s*no active listener is currently blocking on channel_wait_new\b/i.test(
      messageText(message),
    )
  );
}

function councilAgentSystemStatus(message: CouncilMessage): "sent" | "joined" | "ready" | null {
  if (message.role !== "system" || message.actorId === "system") {
    return null;
  }
  const text = messageText(message);
  if (text === `${message.actorId} sent`) return "sent";
  if (text === `${message.actorId} joined`) return "joined";
  if (text === `${message.actorId} listening`) return "ready";
  return null;
}

/** Keep one stable lifecycle row per agent and update it in place as the agent advances. */
export function projectCouncilDisplayItems(council: CouncilSnapshot): CouncilDisplayItem[] {
  const items: CouncilDisplayItem[] = [];
  const statusIndexByActorId = new Map<string, number>();

  for (const message of council.messages) {
    if (isCouncilSystemNoise(message)) {
      continue;
    }
    const status = councilAgentSystemStatus(message);
    if (!status) {
      items.push({ kind: "message", message });
      continue;
    }
    const item: CouncilDisplayItem = {
      kind: "agent-status",
      key: `agent-status:${message.actorId}`,
      actorId: message.actorId,
      status,
      messageId: message.id,
    };
    const existingIndex = statusIndexByActorId.get(message.actorId);
    if (existingIndex === undefined) {
      statusIndexByActorId.set(message.actorId, items.length);
      items.push(item);
    } else {
      items[existingIndex] = item;
    }
  }

  return items;
}
