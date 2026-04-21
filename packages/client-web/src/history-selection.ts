const LAST_HISTORY_SELECTION_KEY = "rah.lastHistorySelection";

export interface HistorySelection {
  provider: string;
  providerSessionId: string;
  workspaceDir?: string;
}

function readStorageValue(key: string): string | null {
  try {
    const sessionValue = window.sessionStorage.getItem(key);
    if (sessionValue) {
      return sessionValue;
    }
  } catch {}
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readLastHistorySelection(): HistorySelection | null {
  try {
    const raw = readStorageValue(LAST_HISTORY_SELECTION_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.provider !== "string" ||
      typeof parsed.providerSessionId !== "string"
    ) {
      return null;
    }
    return {
      provider: parsed.provider,
      providerSessionId: parsed.providerSessionId,
      ...(typeof parsed.workspaceDir === "string" ? { workspaceDir: parsed.workspaceDir } : {}),
    };
  } catch {
    return null;
  }
}

export function writeLastHistorySelection(value: HistorySelection) {
  const serialized = JSON.stringify(value);
  try {
    window.sessionStorage.setItem(LAST_HISTORY_SELECTION_KEY, serialized);
  } catch {}
  try {
    window.localStorage.removeItem(LAST_HISTORY_SELECTION_KEY);
  } catch {}
}

export function clearLastHistorySelection() {
  try {
    window.sessionStorage.removeItem(LAST_HISTORY_SELECTION_KEY);
  } catch {}
  try {
    window.localStorage.removeItem(LAST_HISTORY_SELECTION_KEY);
  } catch {}
}
