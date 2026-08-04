import type { SessionConfigValue } from "@rah/runtime-protocol";

export type SessionModelPreferenceDraft = {
  modelId?: string | null;
  reasoningId?: string | null;
  optionValues?: Record<string, SessionConfigValue>;
};

export type SessionModelPreferenceOwner = {
  id: string;
  provider: string;
  providerSessionId?: string | null;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

type StoredSessionModelPreference = SessionModelPreferenceDraft & {
  updatedAt: number;
};

type StoredSessionModelPreferences = {
  version: 1;
  entries: Record<string, StoredSessionModelPreference>;
};

export const SESSION_MODEL_PREFERENCES_STORAGE_KEY = "rah.sessionModelPreferences.v1";
export const SESSION_MODEL_PREFERENCES_MAX_ENTRIES = 256;

function normalizedText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isSessionConfigValue(value: unknown): value is SessionConfigValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function sanitizeOptionValues(
  value: unknown,
): Record<string, SessionConfigValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, SessionConfigValue] =>
      Boolean(entry[0].trim()) && isSessionConfigValue(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function sanitizeSessionModelPreferenceDraft(
  value: unknown,
): SessionModelPreferenceDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const modelId = normalizedText(record.modelId);
  if (!modelId) {
    return null;
  }
  const reasoningId =
    record.reasoningId === null ? null : normalizedText(record.reasoningId);
  const optionValues = sanitizeOptionValues(record.optionValues);
  return {
    modelId,
    ...(record.reasoningId === null || reasoningId
      ? { reasoningId }
      : {}),
    ...(optionValues ? { optionValues } : {}),
  };
}

export function sessionModelPreferenceKey(owner: SessionModelPreferenceOwner): string {
  const provider = normalizedText(owner.provider) ?? "unknown";
  const providerSessionId = normalizedText(owner.providerSessionId);
  if (providerSessionId) {
    return `provider:${encodeURIComponent(provider)}:${encodeURIComponent(providerSessionId)}`;
  }
  return `session:${encodeURIComponent(owner.id)}`;
}

function readStoredPreferences(storage: StorageLike | undefined): StoredSessionModelPreferences {
  if (!storage) {
    return { version: 1, entries: {} };
  }
  try {
    const raw = storage.getItem(SESSION_MODEL_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return { version: 1, entries: {} };
    }
    const parsed = JSON.parse(raw) as Partial<StoredSessionModelPreferences>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      return { version: 1, entries: {} };
    }
    const entries: Record<string, StoredSessionModelPreference> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      const draft = sanitizeSessionModelPreferenceDraft(value);
      if (!draft) {
        continue;
      }
      const updatedAt =
        typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
          ? value.updatedAt
          : 0;
      entries[key] = { ...draft, updatedAt };
    }
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

export function readSessionModelPreference(
  storage: StorageLike | undefined,
  owner: SessionModelPreferenceOwner,
): SessionModelPreferenceDraft | undefined {
  const stored = readStoredPreferences(storage).entries[sessionModelPreferenceKey(owner)];
  if (!stored) {
    return undefined;
  }
  const { updatedAt: _updatedAt, ...draft } = stored;
  void _updatedAt;
  return draft;
}

export function rememberSessionModelPreference(
  storage: StorageLike | undefined,
  owner: SessionModelPreferenceOwner,
  draft: SessionModelPreferenceDraft,
  updatedAt = Date.now(),
): void {
  if (!storage) {
    return;
  }
  const sanitized = sanitizeSessionModelPreferenceDraft(draft);
  if (!sanitized) {
    return;
  }
  try {
    const stored = readStoredPreferences(storage);
    stored.entries[sessionModelPreferenceKey(owner)] = {
      ...sanitized,
      updatedAt,
    };
    const boundedEntries = Object.fromEntries(
      Object.entries(stored.entries)
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
        .slice(0, SESSION_MODEL_PREFERENCES_MAX_ENTRIES),
    );
    storage.setItem(
      SESSION_MODEL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: boundedEntries }),
    );
  } catch {
    // Storage can be unavailable in private or constrained browser contexts.
  }
}
