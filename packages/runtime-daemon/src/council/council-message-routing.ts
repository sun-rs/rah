import type { CouncilMessage } from "@rah/runtime-protocol";

/** Explicit @mentions narrow delivery; messages without a known target remain broadcasts. */
export function councilMessageTargetAgentIds(
  message: CouncilMessage,
  agentIds: readonly string[],
): Set<string> | null {
  const text = message.parts
    .map((part) => part.kind === "text" ? part.text : "")
    .join("\n");
  if (mentionPattern("all").test(text)) {
    return null;
  }
  const targets = new Set<string>();
  for (const agentId of agentIds) {
    if (mentionPattern(agentId).test(text)) {
      targets.add(agentId);
    }
  }
  return targets.size > 0 ? targets : null;
}

export function councilMessageTargetsAgent(
  message: CouncilMessage,
  agentId: string,
  councilAgentIds: readonly string[],
): boolean {
  const targets = councilMessageTargetAgentIds(message, councilAgentIds);
  return targets === null || targets.has(agentId);
}

function mentionPattern(target: string): RegExp {
  return new RegExp(
    `(^|[\\s（(\\[\\{“\"'，,：:；;])@${escapeRegExp(target)}(?=$|[\\s）)\\]\\}”\"'，,。.!！?？：:；;])`,
    "iu",
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
