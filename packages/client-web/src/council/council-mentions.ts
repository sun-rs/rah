import type { CouncilAgent } from "@rah/runtime-protocol";

export type CouncilMentionTrigger = {
  start: number;
  end: number;
  query: string;
};

export type CouncilMentionOption = {
  id: string;
  label: string;
  insertText: string;
  description: string;
  agent?: CouncilAgent;
};

function normalizeMentionSearch(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, "");
}

export function findCouncilMentionTrigger(
  value: string,
  caret: number,
): CouncilMentionTrigger | null {
  const safeCaret = Math.max(0, Math.min(value.length, caret));
  const prefix = value.slice(0, safeCaret);
  const atIndex = prefix.lastIndexOf("@");
  if (atIndex < 0) {
    return null;
  }
  const query = prefix.slice(atIndex + 1);
  if (query.includes("@") || /\s/.test(query)) {
    return null;
  }
  const before = atIndex > 0 ? prefix[atIndex - 1] : "";
  if (before && !/[\s([{"'`]/.test(before)) {
    return null;
  }
  return {
    start: atIndex,
    end: safeCaret,
    query,
  };
}

export function buildCouncilMentionOptions(agents: CouncilAgent[]): CouncilMentionOption[] {
  return [
    {
      id: "all",
      label: "all",
      insertText: "@all",
      description: "Invite every agent into the discussion",
    },
    ...agents.map((agent) => ({
      id: agent.id,
      label: agent.label,
      insertText: `@${agent.label}`,
      description: agent.modelId ?? agent.provider,
      agent,
    })),
  ];
}

export function filterCouncilMentionOptions(
  options: CouncilMentionOption[],
  query: string,
): CouncilMentionOption[] {
  const normalizedQuery = normalizeMentionSearch(query);
  if (!normalizedQuery) {
    return options;
  }
  return options.filter((option) => {
    const haystack = normalizeMentionSearch(
      `${option.label} ${option.id} ${option.description} ${option.agent?.provider ?? ""}`,
    );
    return haystack.includes(normalizedQuery);
  });
}

export function applyCouncilMention(
  value: string,
  trigger: CouncilMentionTrigger,
  option: CouncilMentionOption,
): { nextValue: string; caret: number } {
  const before = value.slice(0, trigger.start);
  const after = value.slice(trigger.end);
  const suffix = after.length > 0
    ? /^\s/.test(after)
      ? after.replace(/^\s+/, "")
      : ` ${after}`
    : "";
  const inserted = `${option.insertText} `;
  return {
    nextValue: `${before}${inserted}${suffix}`,
    caret: before.length + inserted.length,
  };
}
