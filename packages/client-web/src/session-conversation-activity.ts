import type { SessionSummary } from "@rah/runtime-protocol";
import type { FeedEntry, SessionProjection } from "./types";

type TimelineFeedEntry = Extract<FeedEntry, { kind: "timeline" }>;

function isConversationTimelineEntry(entry: FeedEntry): entry is TimelineFeedEntry {
  return (
    entry.kind === "timeline" &&
    (entry.item.kind === "user_message" || entry.item.kind === "assistant_message")
  );
}

export function deriveSessionConversationActivityAt(
  projection: Pick<SessionProjection, "summary" | "feed">,
  options?: { fallbackActivityAt?: string | undefined },
): string {
  let latestFeedActivityAt: string | undefined;
  for (let index = projection.feed.length - 1; index >= 0; index -= 1) {
    const entry = projection.feed[index];
    if (entry && isConversationTimelineEntry(entry)) {
      latestFeedActivityAt = entry.ts;
      break;
    }
  }
  if (latestFeedActivityAt && options?.fallbackActivityAt) {
    return latestFeedActivityAt.localeCompare(options.fallbackActivityAt) >= 0
      ? latestFeedActivityAt
      : options.fallbackActivityAt;
  }
  return latestFeedActivityAt ?? options?.fallbackActivityAt ?? projection.summary.session.createdAt;
}

export function runningSessionActivityAt(
  summary: SessionSummary,
  activityAt: string | undefined,
): string {
  return activityAt ?? summary.session.createdAt;
}
