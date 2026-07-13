import type {
  ConversationTurnProjection,
  ConversationTurnDirectoryItem,
} from "@rah/runtime-protocol";
import type { FeedEntry } from "../../types";
import { conversationItemFeedKey } from "../../conversation-feed";
import { isInternalUserReminder } from "./assistant-turn-headers";
import type { VirtualFeedLayout } from "./virtualized-feed-layout";

const PREVIEW_TEXT_LIMIT = 180;
const PREVIEW_FILE_LIMIT = 4;

export type ConversationTurnNavigationItem = {
  key: string;
  turnId?: string;
  userEntryKey?: string;
  anchorEntryKey?: string;
  userPreview: string;
  assistantPreview?: string;
  fileNames: string[];
  startOffset?: number;
  endOffset?: number;
};

type ConversationTurnAnchor = {
  entryKey: string;
  offsetTop: number;
};

export function conversationTurnIndexAtScrollableRailPosition(
  itemCount: number,
  offset: number,
  scrollTop: number,
  rowHeight: number,
): number {
  if (
    itemCount <= 0 ||
    rowHeight <= 0 ||
    !Number.isFinite(offset) ||
    !Number.isFinite(scrollTop)
  ) {
    return -1;
  }
  return Math.max(
    0,
    Math.min(itemCount - 1, Math.floor((Math.max(0, offset) + Math.max(0, scrollTop)) / rowHeight)),
  );
}

type ConversationTurnDraft = {
  key: string;
  turnId?: string;
  userEntryKey: string;
  userPreview: string;
  finalAssistantPreview?: string;
  latestAssistantPreview?: string;
};

type TimelineFeedEntry = Extract<FeedEntry, { kind: "timeline" }>;
type VisibleUserMessageEntry = TimelineFeedEntry & {
  item: Extract<TimelineFeedEntry["item"], { kind: "user_message" }>;
};

function compactPreviewText(text: string): string {
  const compact = text
    .replace(/data:image\/[^\s)]+/gi, "[image]")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= PREVIEW_TEXT_LIMIT) {
    return compact;
  }
  return `${compact.slice(0, PREVIEW_TEXT_LIMIT - 1).trimEnd()}…`;
}

function isVisibleUserMessage(entry: FeedEntry): entry is VisibleUserMessageEntry {
  return (
    entry.kind === "timeline" &&
    entry.item.kind === "user_message" &&
    !isInternalUserReminder(entry.item.text)
  );
}

function buildTurnDrafts(entries: readonly FeedEntry[]): ConversationTurnDraft[] {
  const drafts: ConversationTurnDraft[] = [];
  let current: ConversationTurnDraft | null = null;

  for (const entry of entries) {
    if (isVisibleUserMessage(entry)) {
      current = {
        key: `conversation-turn:${entry.providerTurnId ?? entry.canonicalTurnId ?? entry.turnId ?? entry.key}`,
        ...(entry.providerTurnId ?? entry.canonicalTurnId ?? entry.turnId
          ? { turnId: entry.providerTurnId ?? entry.canonicalTurnId ?? entry.turnId }
          : {}),
        userEntryKey: entry.key,
        userPreview: compactPreviewText(entry.item.text) || "Message",
      };
      drafts.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (entry.kind !== "timeline" || entry.item.kind !== "assistant_message") {
      continue;
    }
    const preview = compactPreviewText(entry.item.text);
    if (!preview) {
      continue;
    }
    if (entry.item.phase === "final_answer") {
      current.finalAssistantPreview = preview;
    } else {
      current.latestAssistantPreview = preview;
    }
  }

  return drafts;
}

function conversationTurnIdentityKeys(turn: ConversationTurnProjection): string[] {
  return turn.providerTurnId && turn.providerTurnId !== turn.id
    ? [turn.id, turn.providerTurnId]
    : [turn.id];
}

function buildConversationTurnAnchors(
  turns: readonly ConversationTurnProjection[],
  rowByKey: ReadonlyMap<string, VirtualFeedLayout["rows"][number]>,
): Map<string, ConversationTurnAnchor> {
  const anchors = new Map<string, ConversationTurnAnchor>();
  for (const turn of turns) {
    const candidateKeys = [
      ...turn.items.map((item) => conversationItemFeedKey(item.id)),
      `conversation-process:${turn.id}`,
      `conversation-outputs:${turn.id}`,
    ];
    const anchor = candidateKeys
      .map((entryKey) => {
        const row = rowByKey.get(entryKey);
        return row ? { entryKey, offsetTop: row.offsetTop } : null;
      })
      .filter((candidate): candidate is ConversationTurnAnchor => candidate !== null)
      .sort((left, right) => left.offsetTop - right.offsetTop)[0];
    if (!anchor) {
      continue;
    }
    for (const identity of conversationTurnIdentityKeys(turn)) {
      anchors.set(identity, anchor);
    }
  }
  return anchors;
}

function canonicalTurnUserPreview(turn: ConversationTurnProjection): string {
  const userItem = turn.items.find(
    (item) =>
      item.role === "user" &&
      item.content.kind === "timeline" &&
      item.content.item.kind === "user_message",
  );
  if (
    userItem?.content.kind === "timeline" &&
    userItem.content.item.kind === "user_message"
  ) {
    return compactPreviewText(userItem.content.item.text) || "Message";
  }
  return "Session activity";
}

function canonicalTurnAssistantPreview(
  turn: ConversationTurnProjection,
): string | undefined {
  const final = [...turn.items].reverse().find(
    (item) =>
      item.role === "final" &&
      item.content.kind === "timeline" &&
      item.content.item.kind === "assistant_message",
  );
  if (
    final?.content.kind === "timeline" &&
    final.content.item.kind === "assistant_message"
  ) {
    return compactPreviewText(final.content.item.text) || undefined;
  }
  return undefined;
}

function addTurnEndOffsets(
  items: readonly ConversationTurnNavigationItem[],
  layout: VirtualFeedLayout,
): ConversationTurnNavigationItem[] {
  return items.map((item, index) => {
    if (item.startOffset === undefined) {
      return item;
    }
    let nextOffset: number | undefined;
    for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
      const candidate = items[nextIndex];
      if (candidate?.startOffset !== undefined) {
        nextOffset = candidate.startOffset;
        break;
      }
    }
    return {
      ...item,
      endOffset: Math.max(item.startOffset + 1, nextOffset ?? layout.totalHeight),
    };
  });
}

export function buildConversationTurnNavigationItems(
  entries: readonly FeedEntry[],
  layout: VirtualFeedLayout,
  directory: readonly ConversationTurnDirectoryItem[] = [],
  conversationTurns: readonly ConversationTurnProjection[] = [],
): ConversationTurnNavigationItem[] {
  const rowByKey = new Map(layout.rows.map((row) => [row.key, row]));
  const anchorByTurnId = buildConversationTurnAnchors(conversationTurns, rowByKey);
  const outputLabelsByTurnId = new Map<string, string[]>();
  for (const turn of conversationTurns) {
    const labels = (turn.outputs ?? [])
      .map((output) => output.label)
      .filter((label, index, all) => Boolean(label) && all.indexOf(label) === index)
      .slice(0, PREVIEW_FILE_LIMIT);
    if (labels.length === 0) {
      continue;
    }
    outputLabelsByTurnId.set(turn.id, labels);
    if (turn.providerTurnId) {
      outputLabelsByTurnId.set(turn.providerTurnId, labels);
    }
  }
  const drafts = buildTurnDrafts(entries).filter((draft) => rowByKey.has(draft.userEntryKey));
  const loadedItems: ConversationTurnNavigationItem[] = drafts.map((draft) => {
    const userRow = rowByKey.get(draft.userEntryKey)!;
    const anchor = (draft.turnId ? anchorByTurnId.get(draft.turnId) : undefined) ?? {
      entryKey: draft.userEntryKey,
      offsetTop: userRow.offsetTop,
    };
    return {
      key: draft.key,
      ...(draft.turnId ? { turnId: draft.turnId } : {}),
      userEntryKey: draft.userEntryKey,
      anchorEntryKey: anchor.entryKey,
      userPreview: draft.userPreview,
      ...(draft.finalAssistantPreview || draft.latestAssistantPreview
        ? { assistantPreview: draft.finalAssistantPreview ?? draft.latestAssistantPreview }
        : {}),
      fileNames:
        (draft.turnId ? outputLabelsByTurnId.get(draft.turnId) : undefined) ?? [],
      startOffset: anchor.offsetTop,
    };
  });
  if (directory.length === 0) {
    const representedTurnIds = new Set(
      loadedItems.flatMap((item) => (item.turnId ? [item.turnId] : [])),
    );
    const canonicalFallbacks = conversationTurns.flatMap((turn) => {
      const identities = conversationTurnIdentityKeys(turn);
      if (identities.some((identity) => representedTurnIds.has(identity))) {
        return [];
      }
      const anchor = anchorByTurnId.get(turn.providerTurnId ?? turn.id);
      if (!anchor) {
        return [];
      }
      const assistantPreview = canonicalTurnAssistantPreview(turn);
      return [{
        key: `conversation-turn:${turn.providerTurnId ?? turn.id}`,
        turnId: turn.providerTurnId ?? turn.id,
        anchorEntryKey: anchor.entryKey,
        userPreview: canonicalTurnUserPreview(turn),
        ...(assistantPreview ? { assistantPreview } : {}),
        fileNames: outputLabelsByTurnId.get(turn.providerTurnId ?? turn.id) ?? [],
        startOffset: anchor.offsetTop,
      } satisfies ConversationTurnNavigationItem];
    });
    return addTurnEndOffsets(
      [...loadedItems, ...canonicalFallbacks].sort(
        (left, right) => (left.startOffset ?? 0) - (right.startOffset ?? 0),
      ),
      layout,
    );
  }
  const loadedByTurnId = new Map(
    loadedItems
      .filter((item): item is ConversationTurnNavigationItem & { turnId: string } =>
        Boolean(item.turnId),
      )
      .map((item) => [item.turnId, item] as const),
  );
  const directoryTurnIds = new Set(directory.map((item) => item.id));
  const indexed: ConversationTurnNavigationItem[] = directory.map((item) => {
    const loaded = loadedByTurnId.get(item.id);
    const anchor = anchorByTurnId.get(item.id);
    const anchorEntryKey = anchor?.entryKey ?? loaded?.anchorEntryKey;
    // Live/projected text is newer than a background directory snapshot.
    const assistantPreview = loaded?.assistantPreview ?? item.assistantPreview;
    return {
      key: `conversation-turn:${item.id}`,
      turnId: item.id,
      ...(loaded?.userEntryKey ? { userEntryKey: loaded.userEntryKey } : {}),
      ...(anchorEntryKey ? { anchorEntryKey } : {}),
      userPreview: item.userPreview || loaded?.userPreview || "Message",
      ...(assistantPreview !== undefined ? { assistantPreview } : {}),
      fileNames: loaded?.fileNames ?? [],
      ...(anchor?.offsetTop !== undefined
        ? { startOffset: anchor.offsetTop }
        : loaded?.startOffset !== undefined
          ? { startOffset: loaded.startOffset }
          : {}),
    };
  });
  return addTurnEndOffsets(
    [
      ...indexed,
      ...loadedItems.filter((item) => !item.turnId || !directoryTurnIds.has(item.turnId)),
    ],
    layout,
  );
}

export function visibleConversationTurnKeys(args: {
  items: readonly ConversationTurnNavigationItem[];
  scrollTop: number;
  viewportHeight: number;
  contentTopOffset?: number;
}): Set<string> {
  if (args.viewportHeight <= 0) {
    return new Set();
  }
  const loadedItems = args.items.filter(
    (
      item,
    ): item is ConversationTurnNavigationItem & { startOffset: number; endOffset: number } =>
      item.startOffset !== undefined && item.endOffset !== undefined,
  );
  const contentTopOffset = args.contentTopOffset ?? 0;
  const viewportStart = args.scrollTop - contentTopOffset;
  const viewportEnd = viewportStart + args.viewportHeight;
  let low = 0;
  let high = loadedItems.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (loadedItems[middle]!.endOffset > viewportStart) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const visible = new Set<string>();
  for (let index = low; index < loadedItems.length; index += 1) {
    const item = loadedItems[index]!;
    if (item.startOffset >= viewportEnd) {
      break;
    }
    visible.add(item.key);
  }
  return visible;
}
