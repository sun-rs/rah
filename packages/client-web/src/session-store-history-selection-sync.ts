import { isReadOnlyReplay } from "./session-capabilities";
import type { SessionProjection } from "./types";

type HistorySelectionSyncState = {
  selectedSessionId: string | null;
  projections: Map<string, SessionProjection>;
  workspaceDir: string;
};

let lastSyncedHistorySelectionKey: string | null = null;
const CLEARED_HISTORY_SELECTION_KEY = "__cleared__";

export function syncHistorySelectionSubscription(args: {
  state: HistorySelectionSyncState;
  syncLastHistorySelectionFromState: (state: HistorySelectionSyncState) => void;
}) {
  const selectedSummary = args.state.selectedSessionId
    ? args.state.projections.get(args.state.selectedSessionId)?.summary ?? null
    : null;
  if (!selectedSummary) {
    return;
  }

  if (selectedSummary.session.providerSessionId && isReadOnlyReplay(selectedSummary)) {
    const historyWorkspaceDir =
      selectedSummary.session.rootDir || selectedSummary.session.cwd || args.state.workspaceDir;
    const nextKey = JSON.stringify({
      provider: selectedSummary.session.provider,
      providerSessionId: selectedSummary.session.providerSessionId,
      ...(historyWorkspaceDir ? { workspaceDir: historyWorkspaceDir } : {}),
    });
    if (nextKey === lastSyncedHistorySelectionKey) {
      return;
    }
    lastSyncedHistorySelectionKey = nextKey;
    args.syncLastHistorySelectionFromState(args.state);
    return;
  }

  if (lastSyncedHistorySelectionKey !== CLEARED_HISTORY_SELECTION_KEY) {
    lastSyncedHistorySelectionKey = CLEARED_HISTORY_SELECTION_KEY;
    args.syncLastHistorySelectionFromState(args.state);
  }
}
