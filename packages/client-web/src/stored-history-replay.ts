import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";

export function storedHistoryReplaySessionId(
  ref: Pick<StoredSessionRef, "provider" | "providerSessionId">,
): string {
  return `history:${ref.provider}:${ref.providerSessionId}`;
}

export function isStoredHistoryReplayShellSummary(summary: SessionSummary): boolean {
  const providerSessionId = summary.session.providerSessionId;
  return Boolean(
    providerSessionId &&
      summary.session.id ===
        storedHistoryReplaySessionId({
          provider: summary.session.provider,
          providerSessionId,
        }),
  );
}
