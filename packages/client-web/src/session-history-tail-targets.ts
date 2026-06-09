import { shouldPollSessionHistoryTail } from "./session-capabilities";
import type { SessionProjection } from "./types";

export function resolveVisibleSessionHistoryTailSessionIds(
  projections: ReadonlyArray<SessionProjection | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const sessionIds: string[] = [];
  for (const projection of projections) {
    if (!projection || !shouldPollSessionHistoryTail(projection.summary)) {
      continue;
    }
    const sessionId = projection.summary.session.id;
    if (seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    sessionIds.push(sessionId);
  }
  return sessionIds;
}
