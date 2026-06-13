import type { TimelineRuntimeModel } from "@rah/runtime-protocol";
import type { FeedEntry } from "../../types";

export type AssistantTurnHeaders = Map<string, TimelineRuntimeModel | undefined>;

function isUserTimelineEntry(entry: FeedEntry): boolean {
  return (
    entry.kind === "timeline" &&
    entry.item.kind === "user_message" &&
    !isInternalUserReminder(entry.item.text)
  );
}

export function isInternalUserReminder(text: string): boolean {
  if (/<!--\s*OMO_INTERNAL_INITIATOR\s*-->/.test(text)) {
    return true;
  }
  if (!/^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/m.test(text)) {
    return false;
  }
  return /\[(?:ALL BACKGROUND TASKS COMPLETE|BACKGROUND TASK COMPLETED|BACKGROUND TASK FAILED)\]/.test(text);
}

function isAssistantOwnedEntry(entry: FeedEntry): boolean {
  switch (entry.kind) {
    case "timeline":
      return (
        entry.item.kind === "assistant_message" ||
        entry.item.kind === "reasoning" ||
        entry.item.kind === "plan" ||
        entry.item.kind === "step" ||
        entry.item.kind === "todo" ||
        entry.item.kind === "side_question"
      );
    case "tool_call":
    case "message_part":
    case "observation":
    case "permission":
    case "operation":
      return true;
    case "runtime_status":
    case "notification":
      return false;
  }
}

function runtimeModelFromEntry(entry: FeedEntry): TimelineRuntimeModel | undefined {
  if (
    entry.kind !== "timeline" ||
    !(
      entry.item.kind === "assistant_message" ||
      entry.item.kind === "reasoning" ||
      entry.item.kind === "step"
    )
  ) {
    return undefined;
  }
  return entry.item.runtimeModel;
}

export function buildAssistantTurnHeaders(entries: FeedEntry[]): AssistantTurnHeaders {
  const firstEntryKeyBySegment = new Map<string, string>();
  const runtimeModelBySegment = new Map<string, TimelineRuntimeModel>();
  let segmentIndex = 0;
  let segmentKey = "segment:prelude";

  for (const entry of entries) {
    if (isUserTimelineEntry(entry)) {
      segmentIndex += 1;
      segmentKey = `segment:${segmentIndex}`;
      continue;
    }
    if (!isAssistantOwnedEntry(entry)) {
      continue;
    }
    if (!firstEntryKeyBySegment.has(segmentKey)) {
      firstEntryKeyBySegment.set(segmentKey, entry.key);
    }
    const runtimeModel = runtimeModelFromEntry(entry);
    if (runtimeModel && !runtimeModelBySegment.has(segmentKey)) {
      runtimeModelBySegment.set(segmentKey, runtimeModel);
    }
  }

  const headers: AssistantTurnHeaders = new Map();
  for (const [segmentKey, entryKey] of firstEntryKeyBySegment) {
    headers.set(entryKey, runtimeModelBySegment.get(segmentKey));
  }
  return headers;
}
