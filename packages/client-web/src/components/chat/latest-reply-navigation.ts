import type { FeedEntry } from "../../types";
import { isInternalUserReminder } from "./internal-user-reminder";
import type { ChatDisplayRow } from "./assistant-process-groups";
import type { VirtualFeedLayout } from "./virtualized-feed-layout";

const LATEST_REPLY_TOP_VISIBILITY_TOLERANCE_PX = 4;

export type LatestReplyStartTarget = {
  entryKey: string;
  entryIndex: number;
  targetScrollTop: number;
};

type ReplyStartLayoutArgs = {
  entries: readonly FeedEntry[];
  displayRows?: readonly ChatDisplayRow[];
  layout: VirtualFeedLayout;
  contentTopOffset?: number;
  navigableAssistantKeys?: ReadonlySet<string>;
};

export type LatestReplyAutoNavigationState = {
  latestUserKey: string | null;
  latestReplyKey: string | null;
  generationActive: boolean;
  armed: boolean;
  pendingReplyKey: string | null;
};

function isAssistantReplyEntry(entry: FeedEntry): boolean {
  return entry.kind === "timeline" && entry.item.kind === "assistant_message";
}

function isNavigableAssistantReplyEntry(
  entry: FeedEntry,
  navigableAssistantKeys: ReadonlySet<string> | undefined,
): boolean {
  return isAssistantReplyEntry(entry) && (navigableAssistantKeys?.has(entry.key) ?? true);
}

function isVisibleConversationMessageEntry(entry: FeedEntry): boolean {
  if (isAssistantReplyEntry(entry)) {
    return true;
  }
  return (
    entry.kind === "timeline" &&
    entry.item.kind === "user_message" &&
    !isInternalUserReminder(entry.item.text)
  );
}

export function latestVisibleConversationMessageIndex(entries: readonly FeedEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && isVisibleConversationMessageEntry(entry)) {
      return index;
    }
  }
  return -1;
}

export function latestVisibleUserMessageKey(entries: readonly FeedEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.kind === "timeline" &&
      entry.item.kind === "user_message" &&
      !isInternalUserReminder(entry.item.text)
    ) {
      return entry.key;
    }
  }
  return null;
}

export function latestNavigableAssistantReplyKey(
  entries: readonly FeedEntry[],
  navigableAssistantKeys?: ReadonlySet<string>,
): string | null {
  const index = latestVisibleConversationMessageIndex(entries);
  const entry = index >= 0 ? entries[index] : undefined;
  return entry && isNavigableAssistantReplyEntry(entry, navigableAssistantKeys)
    ? entry.key
    : null;
}

export function latestNavigableAssistantReplyKeyAtOrAfter(
  entries: readonly FeedEntry[],
  navigableAssistantKeys: ReadonlySet<string>,
  minimumTimestampMs: number | null,
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || !isNavigableAssistantReplyEntry(entry, navigableAssistantKeys)) {
      continue;
    }
    if (minimumTimestampMs === null) {
      return entry.key;
    }
    const timestampMs = Date.parse(entry.ts);
    if (Number.isFinite(timestampMs) && timestampMs >= minimumTimestampMs - 250) {
      return entry.key;
    }
  }
  return null;
}

export function latestNavigableAssistantReplyKeyForTurn(
  entries: readonly FeedEntry[],
  navigableAssistantKeys: ReadonlySet<string>,
  turnId: string | null,
): string | null {
  if (!turnId) {
    return null;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.turnId === turnId &&
      isNavigableAssistantReplyEntry(entry, navigableAssistantKeys)
    ) {
      return entry.key;
    }
  }
  return null;
}

export function createLatestReplyAutoNavigationState(args: {
  latestUserKey: string | null;
  latestReplyKey: string | null;
  generationActive: boolean;
}): LatestReplyAutoNavigationState {
  return {
    latestUserKey: args.latestUserKey,
    latestReplyKey: args.latestReplyKey,
    generationActive: args.generationActive,
    // Mounting an already-running conversation is not evidence that the
    // reader stayed with this turn. Arm only when this mounted surface sees
    // the live turn begin or sees its user message arrive.
    armed: false,
    pendingReplyKey: null,
  };
}

/**
 * Leaving this conversation forfeits automatic navigation to a future final.
 * The foreground-restoration protocol then owns the viewport: sticky readers
 * return to latest, while detached readers keep their existing position.
 */
export function suspendLatestReplyAutoNavigationState(
  current: LatestReplyAutoNavigationState,
): LatestReplyAutoNavigationState {
  if (!current.armed && current.pendingReplyKey === null) {
    return current;
  }
  return {
    ...current,
    armed: false,
    pendingReplyKey: null,
  };
}

/**
 * Arms on a live turn, then targets the first canonical final that becomes the
 * latest visible conversation message. This follows turn identity rather than
 * waiting for the whole session runtime to become idle, which may happen later
 * when queued prompts or subagents are still active.
 */
export function advanceLatestReplyAutoNavigationState(
  current: LatestReplyAutoNavigationState,
  args: {
    latestUserKey: string | null;
    latestReplyKey: string | null;
    generationActive: boolean;
  },
): LatestReplyAutoNavigationState {
  const userChanged = args.latestUserKey !== current.latestUserKey;
  const replyChanged = args.latestReplyKey !== current.latestReplyKey;
  // A runtime-status transition is not proof that this mounted reader sent
  // the turn. Foreground catch-up can reveal an already-running background
  // turn after a Session is opened; arming from that transition makes its
  // eventual final pull the viewport away from the explicit latest-position
  // navigation. A new canonical/optimistic user identity is the causal owner.
  let armed = current.armed;
  let pendingReplyKey = current.pendingReplyKey;

  if (userChanged) {
    pendingReplyKey = null;
    const currentWasLocalOptimistic =
      current.latestUserKey?.startsWith("optimistic:user:") ?? false;
    const nextIsLocalOptimistic =
      args.latestUserKey?.startsWith("optimistic:user:") ?? false;
    if (nextIsLocalOptimistic) {
      armed = true;
    } else if (!currentWasLocalOptimistic) {
      // Canonical users arriving through history hydration, foreground
      // catch-up, another client, or a reconnect are not proof that this
      // mounted reader submitted the turn. They must never steal the explicit
      // Session-entry bottom lease by jumping to the beginning of a reply.
      armed = false;
    }
  }
  if (replyChanged && args.latestReplyKey && armed) {
    pendingReplyKey = args.latestReplyKey;
    armed = false;
  }

  return {
    latestUserKey: args.latestUserKey,
    latestReplyKey: args.latestReplyKey,
    generationActive: args.generationActive,
    armed,
    pendingReplyKey,
  };
}

export function resolveReplyStartTarget(args: ReplyStartLayoutArgs & {
  entryKey: string;
}): LatestReplyStartTarget | null {
  const entryIndex = args.entries.findIndex((entry) => entry.key === args.entryKey);
  if (entryIndex < 0) {
    return null;
  }
  const entry = args.entries[entryIndex];
  if (!entry || !isNavigableAssistantReplyEntry(entry, args.navigableAssistantKeys)) {
    return null;
  }
  const rowIndex = args.displayRows
    ? args.displayRows.findIndex(
        (candidate) => candidate.kind === "feed_entry" && candidate.entry.key === entry.key,
      )
    : args.layout.rows.findIndex((candidate) => candidate.key === entry.key);
  const row = rowIndex >= 0 ? args.layout.rows[rowIndex] : undefined;
  if (!row) {
    return null;
  }
  return {
    entryKey: entry.key,
    entryIndex,
    targetScrollTop: row.offsetTop + (args.contentTopOffset ?? 0),
  };
}

export function resolveRequestedReplyStartTarget(args: ReplyStartLayoutArgs & {
  navigableAssistantKeys: ReadonlySet<string>;
  entryKey: string | null;
  turnId: string | null;
  minimumTimestampMs: number | null;
}): LatestReplyStartTarget | null {
  const resolve = (entryKey: string) => resolveReplyStartTarget({ ...args, entryKey });
  const direct = args.entryKey ? resolve(args.entryKey) : null;
  if (direct) {
    return direct;
  }
  const turnReplyKey = latestNavigableAssistantReplyKeyForTurn(
    args.entries,
    args.navigableAssistantKeys,
    args.turnId,
  );
  if (turnReplyKey) {
    return resolve(turnReplyKey);
  }
  const timestampReplyKey = latestNavigableAssistantReplyKeyAtOrAfter(
    args.entries,
    args.navigableAssistantKeys,
    args.minimumTimestampMs,
  );
  return timestampReplyKey ? resolve(timestampReplyKey) : null;
}

export function resolveLatestReplyStartTarget(args: ReplyStartLayoutArgs & {
  scrollTop: number;
  viewportHeight: number;
}): LatestReplyStartTarget | null {
  if (args.viewportHeight <= 0) {
    return null;
  }
  const entryIndex = latestVisibleConversationMessageIndex(args.entries);
  if (entryIndex < 0) {
    return null;
  }
  const entry = args.entries[entryIndex];
  if (!entry) {
    return null;
  }
  const target = resolveReplyStartTarget({
    entries: args.entries,
    ...(args.displayRows ? { displayRows: args.displayRows } : {}),
    layout: args.layout,
    ...(args.contentTopOffset !== undefined
      ? { contentTopOffset: args.contentTopOffset }
      : {}),
    ...(args.navigableAssistantKeys
      ? { navigableAssistantKeys: args.navigableAssistantKeys }
      : {}),
    entryKey: entry.key,
  });
  if (
    !target ||
    args.scrollTop <=
      target.targetScrollTop + LATEST_REPLY_TOP_VISIBILITY_TOLERANCE_PX
  ) {
    return null;
  }
  return target;
}
