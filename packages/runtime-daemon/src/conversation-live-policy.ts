import type { ManagedSession, RahEvent } from "@rah/runtime-protocol";

/**
 * Selects events that may advance the resident live conversation projection.
 * Persisted replay is history, not a second live source. Providers without a
 * structured server may still surface live JSONL updates as persisted events.
 */
export function conversationEventBelongsToLiveProjection(
  session: ManagedSession | undefined,
  event: RahEvent,
): boolean {
  if (event.source.channel === "structured_live") {
    return true;
  }
  if (event.source.channel !== "structured_persisted" || !session) {
    return false;
  }
  if (session.runtime?.kind === "stored_history") {
    return false;
  }
  return session.runtime?.structuredLiveEvents !== true;
}
