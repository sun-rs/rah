import type {
  RahEvent,
  ConversationEvidencePage,
} from "@rah/runtime-protocol";
import { scanSelectedJsonlLines } from "./bounded-jsonl-reader";
import type { CodexStoredSessionRecord } from "./codex-stored-session-types";
import {
  collapseDuplicateCodexTimelineEvents,
  translateCodexRolloutWindowToHistoryEvents,
} from "./codex-stored-session-history";
import {
  fullHistoryPage,
  historyEventMatchesItem,
  summarizeHistoryPage,
} from "./history-event-projection";

function shouldTranslateLine(line: string): boolean {
  const head = line.slice(0, 1_024);
  if (/"type"\s*:\s*"event_msg"/.test(head)) {
    return /"type"\s*:\s*"(?:task_started|task_complete|turn_aborted|user_message|agent_message|context_compacted)"/.test(
      head,
    );
  }
  if (!/"type"\s*:\s*"response_item"/.test(head)) {
    return false;
  }
  return /"type"\s*:\s*"(?:message|reasoning)"/.test(head);
}

function shouldTranslateConversationLine(line: string): boolean {
  const head = line.slice(0, 1_024);
  if (/"type"\s*:\s*"response_item"/.test(head)) {
    return true;
  }
  if (!/"type"\s*:\s*"event_msg"/.test(head)) {
    return false;
  }
  return /"type"\s*:\s*"(?:task_started|task_complete|turn_aborted|user_message|agent_message|agent_reasoning|context_compacted|web_search_begin|web_search_end)"/.test(
    head,
  );
}

async function readRelevantTurnLines(args: {
  rolloutPath: string;
  startOffset: number;
  endOffset: number;
  includeProcess?: boolean;
}): Promise<string[]> {
  if (args.endOffset <= args.startOffset) {
    return [];
  }
  const lines: string[] = [];
  await scanSelectedJsonlLines({
    filePath: args.rolloutPath,
    startOffset: args.startOffset,
    endOffset: args.endOffset,
    // A selected user message can legitimately contain one pasted image.
    // Irrelevant tool lines are discarded after their head, so this larger
    // bound applies only to message/reasoning lines inside one requested turn.
    maxSelectedLineBytes: 16 * 1024 * 1024,
    selectHead: args.includeProcess ? shouldTranslateConversationLine : shouldTranslateLine,
    onLine: ({ text }) => lines.push(text),
  });
  return lines;
}

async function translatedTurnEvents(args: {
  sessionId: string;
  turnId: string;
  record: CodexStoredSessionRecord;
  range: { startOffset: number; endOffset: number };
  includeProcess: boolean;
}): Promise<RahEvent[]> {
  const lines = await readRelevantTurnLines({
    rolloutPath: args.record.rolloutPath,
    ...args.range,
    includeProcess: args.includeProcess,
  });
  const translated = translateCodexRolloutWindowToHistoryEvents({
    sessionId: args.sessionId,
    providerSessionId: args.record.ref.providerSessionId,
    cwd: args.record.ref.cwd ?? process.cwd(),
    rootDir: args.record.ref.rootDir ?? args.record.ref.cwd ?? process.cwd(),
    ...(args.record.ref.title !== undefined ? { title: args.record.ref.title } : {}),
    ...(args.record.ref.preview !== undefined ? { preview: args.record.ref.preview } : {}),
    lines,
    finalizePendingTools: false,
  });
  const reanchored = reanchorTurnEvents(
    args.sessionId,
    args.turnId,
    translated,
  );
  return collapseDuplicateCodexTimelineEvents(reanchored, {
    providerSessionId: args.record.ref.providerSessionId,
  });
}

function reanchorTurnEvents(
  sessionId: string,
  turnId: string,
  events: readonly RahEvent[],
): RahEvent[] {
  return events.map((event, index) => {
    const payload =
      (event.type === "timeline.item.added" || event.type === "timeline.item.updated") &&
      event.payload.identity
        ? {
            ...event.payload,
            identity: {
              ...event.payload.identity,
              turnKey: `turn:${turnId}`,
            },
          }
        : event.payload;
    return {
      ...event,
      id: `history-turn:${sessionId}:${turnId}:${index}`,
      sessionId,
      turnId,
      seq: 1_100_000_000 + index,
      payload,
    } as RahEvent;
  });
}

export async function readCodexConversationTurnDetail(args: {
  sessionId: string;
  turnId: string;
  record: CodexStoredSessionRecord;
  range: { startOffset: number; endOffset: number };
}): Promise<ConversationEvidencePage> {
  const events = await translatedTurnEvents({ ...args, includeProcess: true });
  return summarizeHistoryPage({
    sessionId: args.sessionId,
    events,
  });
}

export async function readCodexConversationItemDetail(args: {
  sessionId: string;
  turnId: string;
  itemId: string;
  record: CodexStoredSessionRecord;
  range: { startOffset: number; endOffset: number };
}): Promise<ConversationEvidencePage | undefined> {
  const turnEvents = await translatedTurnEvents({ ...args, includeProcess: true });
  const events = turnEvents.filter(
    (event) =>
      historyEventMatchesItem(event, "tool_call", args.itemId) ||
      historyEventMatchesItem(event, "observation", args.itemId),
  );
  return events.length > 0
    ? fullHistoryPage({ sessionId: args.sessionId, events })
    : undefined;
}
