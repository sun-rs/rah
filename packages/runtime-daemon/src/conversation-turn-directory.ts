import { createHash } from "node:crypto";
import type {
  ConversationItemProjection,
  ConversationTurnProjection,
  ConversationTurnsPageResponse,
  ConversationTurnDirectoryItem,
  ConversationTurnDirectoryResponse,
} from "@rah/runtime-protocol";

type DirectoryDraft = ConversationTurnDirectoryItem & {
  revision: number;
};

function timelineText(item: ConversationItemProjection | undefined): string | undefined {
  if (item?.content.kind !== "timeline" || !("text" in item.content.item)) {
    return undefined;
  }
  const text = item.content.item.text.trim();
  return text || undefined;
}

function firstText(
  turn: ConversationTurnProjection,
  predicate: (item: ConversationItemProjection) => boolean,
): string | undefined {
  for (const item of turn.items) {
    if (!predicate(item)) {
      continue;
    }
    const text = timelineText(item);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function turnDraft(turn: ConversationTurnProjection): DirectoryDraft | null {
  const userPreview = firstText(
    turn,
    (item) => item.role === "user" && item.content.kind === "timeline",
  );
  if (!userPreview) {
    return null;
  }
  const finalItem = turn.finalAnswerItemId
    ? turn.items.find((item) => item.id === turn.finalAnswerItemId)
    : undefined;
  const assistantPreview = timelineText(finalItem) ?? firstText(
    turn,
    (item) => item.role === "final" && item.content.kind === "timeline",
  );
  const startedAt = turn.startedAt ?? turn.items.find((item) => item.startedAt)?.startedAt;
  if (!startedAt) {
    return null;
  }
  return {
    id: turn.providerTurnId ?? turn.id,
    ordinal: 0,
    userPreview,
    ...(assistantPreview ? { assistantPreview } : {}),
    startedAt,
    ...(turn.completedAt ? { completedAt: turn.completedAt } : {}),
    ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
    status: turn.status,
    revision: turn.revision,
  };
}

function mergeDraft(current: DirectoryDraft | undefined, incoming: DirectoryDraft): DirectoryDraft {
  if (!current) {
    return incoming;
  }
  const newest = incoming.revision > current.revision ? incoming : current;
  const assistantPreview = current.assistantPreview ?? incoming.assistantPreview;
  const completedAt = current.completedAt ?? incoming.completedAt;
  const durationMs = current.durationMs ?? incoming.durationMs;
  return {
    ...current,
    ...newest,
    userPreview: current.userPreview || incoming.userPreview,
    startedAt: current.startedAt < incoming.startedAt ? current.startedAt : incoming.startedAt,
    ...(assistantPreview !== undefined ? { assistantPreview } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    revision: Math.max(current.revision, incoming.revision),
  };
}

function directoryRevision(items: readonly DirectoryDraft[], pageRevisions: readonly number[]): string {
  const hash = createHash("sha256");
  for (const revision of pageRevisions) {
    hash.update(`${revision}:`);
  }
  for (const item of items) {
    hash.update(`${item.id}:${item.revision}:${item.status}:`);
  }
  return hash.digest("base64url").slice(0, 22);
}

export async function buildConversationTurnDirectory(args: {
  sessionId: string;
  loadPage: (cursor?: string) => Promise<ConversationTurnsPageResponse>;
  maxPages?: number;
}): Promise<ConversationTurnDirectoryResponse> {
  const maxPages = Math.max(1, args.maxPages ?? 10_000);
  const drafts = new Map<string, DirectoryDraft>();
  const seenCursors = new Set<string>();
  const pageRevisions: number[] = [];
  let cursor: string | undefined;
  let sourceBytes = 0;
  let complete = false;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await args.loadPage(cursor);
    pageRevisions.push(page.revision);
    sourceBytes += page.approximateBytes ?? 0;
    for (const turn of page.turns) {
      const draft = turnDraft(turn);
      if (draft) {
        drafts.set(draft.id, mergeDraft(drafts.get(draft.id), draft));
      }
    }
    const nextCursor = page.nextCursor;
    if (!nextCursor) {
      complete = true;
      break;
    }
    if (seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  const ordered = [...drafts.values()].sort(
    (left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
  );
  return {
    sessionId: args.sessionId,
    revision: directoryRevision(ordered, pageRevisions),
    items: ordered.map(({ revision: _revision, ...item }, ordinal) => ({ ...item, ordinal })),
    complete,
    ...(sourceBytes > 0 ? { sourceBytes } : {}),
    generatedAt: new Date().toISOString(),
  };
}
