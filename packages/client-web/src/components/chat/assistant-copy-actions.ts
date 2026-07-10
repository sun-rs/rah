import type { FeedEntry } from "../../types";
import { isInternalUserReminder } from "./assistant-turn-headers";

function isCopyableAssistantCandidate(entry: FeedEntry): boolean {
  return (
    entry.kind === "timeline" &&
    entry.item.kind === "assistant_message" &&
    entry.item.phase !== "commentary" &&
    entry.item.text.trim().length > 0
  );
}

function isVisibleUserTurnBoundary(entry: FeedEntry): boolean {
  return (
    entry.kind === "timeline" &&
    entry.item.kind === "user_message" &&
    !isInternalUserReminder(entry.item.text)
  );
}

function latestVisibleConversationEntry(entries: readonly FeedEntry[]): FeedEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    if (isCopyableAssistantCandidate(entry) || isVisibleUserTurnBoundary(entry)) {
      return entry;
    }
  }
  return null;
}

export function copyableAssistantMessageKeys(
  entries: readonly FeedEntry[],
  options: { generationActive?: boolean } = {},
): Set<string> {
  const explicitFinalByTurn = new Map<number, string>();
  const fallbackFinalByTurn = new Map<number, string>();
  let turnIndex = 0;

  for (const entry of entries) {
    if (isVisibleUserTurnBoundary(entry)) {
      turnIndex += 1;
      continue;
    }
    if (isCopyableAssistantCandidate(entry)) {
      if (
        entry.kind === "timeline" &&
        entry.item.kind === "assistant_message" &&
        entry.item.phase === "final_answer"
      ) {
        explicitFinalByTurn.set(turnIndex, entry.key);
      } else {
        fallbackFinalByTurn.set(turnIndex, entry.key);
      }
    }
  }

  const turnIndexes = new Set([
    ...explicitFinalByTurn.keys(),
    ...fallbackFinalByTurn.keys(),
  ]);
  const copyableKeys = new Set<string>();
  for (const index of turnIndexes) {
    const key = explicitFinalByTurn.get(index) ?? fallbackFinalByTurn.get(index);
    if (key) {
      copyableKeys.add(key);
    }
  }
  if (!options.generationActive) {
    return copyableKeys;
  }

  const latest = latestVisibleConversationEntry(entries);
  if (latest && isCopyableAssistantCandidate(latest)) {
    copyableKeys.delete(latest.key);
  }
  return copyableKeys;
}
