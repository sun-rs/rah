import { isReadOnlyReplay } from "./session-capabilities";
import type { FeedEntry, SessionProjection } from "./types";

export const LIVE_FEED_RETENTION_MAX_ENTRIES = 900;
export const LIVE_FEED_RETENTION_TARGET_ENTRIES = 650;
const LIVE_FEED_RETENTION_BOUNDARY_LOOKBACK = 80;

function canRecoverTrimmedFeedFromHistory(projection: SessionProjection): boolean {
  return (
    projection.summary.session.providerSessionId !== undefined &&
    !isReadOnlyReplay(projection.summary)
  );
}

function isUserTimelineEntry(entry: FeedEntry | undefined): boolean {
  return entry?.kind === "timeline" && entry.item.kind === "user_message";
}

function findRetainStartIndex(feed: readonly FeedEntry[]): number {
  const desiredStart = Math.max(0, feed.length - LIVE_FEED_RETENTION_TARGET_ENTRIES);
  const boundaryFloor = Math.max(0, desiredStart - LIVE_FEED_RETENTION_BOUNDARY_LOOKBACK);
  for (let index = desiredStart; index >= boundaryFloor; index -= 1) {
    if (isUserTimelineEntry(feed[index])) {
      return index;
    }
  }
  return desiredStart;
}

export function compactRecoverableLiveProjectionFeed(
  projection: SessionProjection,
): SessionProjection {
  if (!canRecoverTrimmedFeedFromHistory(projection)) {
    return projection;
  }
  if (projection.feed.length <= LIVE_FEED_RETENTION_MAX_ENTRIES) {
    return projection;
  }

  const retainStart = findRetainStartIndex(projection.feed);
  if (retainStart <= 0) {
    return projection;
  }

  return {
    ...projection,
    feed: projection.feed.slice(retainStart),
  };
}
