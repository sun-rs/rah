import type { SessionSummary } from "@rah/runtime-protocol";

function eventPredatesSessionUpdate(eventTs: string | undefined, updatedAt: string): boolean {
  if (!eventTs) {
    return false;
  }
  const eventTime = Date.parse(eventTs);
  const sessionTime = Date.parse(updatedAt);
  return Number.isFinite(eventTime) && Number.isFinite(sessionTime) && eventTime < sessionTime;
}

/**
 * Provider acceptance owns the startup boundary. Late idle/finished events
 * from replay or attachment must not erase that state while input is still
 * submitting or while an older event races a newer starting summary.
 */
export function shouldPreserveProviderBoundStartup(
  summary: SessionSummary,
  eventTs: string | undefined,
): boolean {
  return (
    summary.session.inputQueue?.some(
      (input) => (input.state ?? "queued") === "submitting",
    ) === true ||
    (summary.session.phase === "starting" &&
      eventPredatesSessionUpdate(eventTs, summary.session.updatedAt))
  );
}
