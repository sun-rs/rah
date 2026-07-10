import type { SessionTurnDirectoryItem } from "@rah/runtime-protocol";
import type { FeedEntry } from "../../types";
import { isInternalUserReminder } from "./assistant-turn-headers";
import type { VirtualFeedLayout } from "./virtualized-feed-layout";

const PREVIEW_TEXT_LIMIT = 180;
const PREVIEW_FILE_LIMIT = 4;

export type ConversationTurnNavigationItem = {
  key: string;
  turnId?: string;
  userEntryKey?: string;
  userPreview: string;
  assistantPreview?: string;
  fileNames: string[];
  startOffset?: number;
  endOffset?: number;
};

type ConversationTurnDraft = {
  key: string;
  turnId?: string;
  userEntryKey: string;
  userPreview: string;
  finalAssistantPreview?: string;
  latestAssistantPreview?: string;
  fileNames: string[];
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

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function appendFileName(draft: ConversationTurnDraft, path: string | undefined): void {
  if (!path || draft.fileNames.length >= PREVIEW_FILE_LIMIT) {
    return;
  }
  const name = baseName(path);
  if (name && !draft.fileNames.includes(name)) {
    draft.fileNames.push(name);
  }
}

function appendEntryFiles(draft: ConversationTurnDraft, entry: FeedEntry): void {
  if (entry.kind === "timeline" && entry.item.kind === "attachment") {
    appendFileName(draft, entry.item.path ?? entry.item.label);
    return;
  }
  if (entry.kind !== "tool_call") {
    return;
  }
  for (const artifact of entry.toolCall.detail?.artifacts ?? []) {
    if (artifact.kind === "file_refs") {
      for (const file of artifact.files) {
        appendFileName(draft, file);
      }
    } else if (artifact.kind === "image") {
      appendFileName(draft, artifact.path);
    }
  }
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
        fileNames: [],
      };
      drafts.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    appendEntryFiles(current, entry);
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

export function buildConversationTurnNavigationItems(
  entries: readonly FeedEntry[],
  layout: VirtualFeedLayout,
  directory: readonly SessionTurnDirectoryItem[] = [],
): ConversationTurnNavigationItem[] {
  const rowByKey = new Map(layout.rows.map((row) => [row.key, row]));
  const drafts = buildTurnDrafts(entries).filter((draft) => rowByKey.has(draft.userEntryKey));
  const loadedItems: ConversationTurnNavigationItem[] = drafts.map((draft, index) => {
    const row = rowByKey.get(draft.userEntryKey)!;
    const nextDraft = drafts[index + 1];
    const nextRow = nextDraft ? rowByKey.get(nextDraft.userEntryKey) : undefined;
    return {
      key: draft.key,
      ...(draft.turnId ? { turnId: draft.turnId } : {}),
      userEntryKey: draft.userEntryKey,
      userPreview: draft.userPreview,
      ...(draft.finalAssistantPreview || draft.latestAssistantPreview
        ? { assistantPreview: draft.finalAssistantPreview ?? draft.latestAssistantPreview }
        : {}),
      fileNames: draft.fileNames,
      startOffset: row.offsetTop,
      endOffset: Math.max(row.offsetTop + 1, nextRow?.offsetTop ?? layout.totalHeight),
    };
  });
  if (directory.length === 0) {
    return loadedItems;
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
    // Live/projected text is newer than a background directory snapshot.
    const assistantPreview = loaded?.assistantPreview ?? item.assistantPreview;
    return {
      key: `conversation-turn:${item.id}`,
      turnId: item.id,
      ...(loaded?.userEntryKey ? { userEntryKey: loaded.userEntryKey } : {}),
      userPreview: item.userPreview || loaded?.userPreview || "Message",
      ...(assistantPreview !== undefined ? { assistantPreview } : {}),
      fileNames: loaded?.fileNames ?? [],
      ...(loaded?.startOffset !== undefined ? { startOffset: loaded.startOffset } : {}),
      ...(loaded?.endOffset !== undefined ? { endOffset: loaded.endOffset } : {}),
    };
  });
  return [
    ...indexed,
    ...loadedItems.filter((item) => !item.turnId || !directoryTurnIds.has(item.turnId)),
  ];
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
