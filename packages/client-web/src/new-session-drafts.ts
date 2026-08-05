import type { ProviderModelCatalog, SessionConfigValue } from "@rah/runtime-protocol";
import type { ProviderChoice } from "./components/ProviderSelector";
import { createDefaultModeDraft, type SessionModeDraft } from "./session-mode-ui";
import type { CanvasPaneId } from "./canvas-state";

export type ModelDraft = {
  modelId?: string | null;
  reasoningId?: string | null;
  optionValues?: Record<string, SessionConfigValue>;
};

export type CanvasNewSessionDraft = {
  provider: ProviderChoice;
  modeDrafts: Record<ProviderChoice, SessionModeDraft>;
  modelDrafts: Record<ProviderChoice, ModelDraft>;
};

const MODEL_DRAFT_STORAGE_KEY = "rah.modelDrafts.v2";
const LEGACY_MODEL_DRAFT_STORAGE_KEYS = ["rah.modelDrafts.v1"];
export const PROVIDER_CHOICES: ProviderChoice[] = ["codex", "claude", "opencode"];

export function emptyModelDrafts(): Record<ProviderChoice, ModelDraft> {
  return {
    codex: {},
    claude: {},
    opencode: {},
  };
}

export function createDefaultModeDrafts(): Record<ProviderChoice, SessionModeDraft> {
  return {
    codex: createDefaultModeDraft("codex"),
    claude: createDefaultModeDraft("claude"),
    opencode: createDefaultModeDraft("opencode"),
  };
}

export function createCanvasNewSessionDraft(
  provider: ProviderChoice = "codex",
): CanvasNewSessionDraft {
  return {
    provider,
    modeDrafts: createDefaultModeDrafts(),
    modelDrafts: readRememberedModelDrafts(),
  };
}

export function createEmptyCanvasNewSessionDrafts(): Record<
  CanvasPaneId,
  CanvasNewSessionDraft
> {
  return {
    "canvas-1": createCanvasNewSessionDraft(),
    "canvas-2": createCanvasNewSessionDraft(),
    "canvas-3": createCanvasNewSessionDraft(),
    "canvas-4": createCanvasNewSessionDraft(),
    "canvas-5": createCanvasNewSessionDraft(),
    "canvas-6": createCanvasNewSessionDraft(),
    "canvas-7": createCanvasNewSessionDraft(),
    "canvas-8": createCanvasNewSessionDraft(),
  };
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
    (entry): entry is [string, SessionConfigValue] => isSessionConfigValue(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sanitizeModelDraft(value: unknown): ModelDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Partial<ModelDraft>;
  if (typeof record.modelId !== "string" || !record.modelId) {
    return {};
  }
  const optionValues = sanitizeOptionValues(record.optionValues);
  return {
    modelId: record.modelId,
    ...(typeof record.reasoningId === "string" && record.reasoningId
      ? { reasoningId: record.reasoningId }
      : {}),
    ...(optionValues ? { optionValues } : {}),
  };
}

export function readRememberedModelDrafts(): Record<ProviderChoice, ModelDraft> {
  if (typeof window === "undefined") return emptyModelDrafts();
  try {
    const raw =
      window.localStorage.getItem(MODEL_DRAFT_STORAGE_KEY) ??
      LEGACY_MODEL_DRAFT_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(
        (value): value is string => Boolean(value),
      ) ??
      "{}";
    const parsed = JSON.parse(raw) as Partial<Record<ProviderChoice, unknown>>;
    return PROVIDER_CHOICES.reduce((drafts, provider) => {
      drafts[provider] = sanitizeModelDraft(parsed[provider]);
      return drafts;
    }, emptyModelDrafts());
  } catch {
    return emptyModelDrafts();
  }
}

export function writeRememberedModelDrafts(
  drafts: Record<ProviderChoice, ModelDraft>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_DRAFT_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Ignore storage failures; the in-memory draft still applies for this page.
  }
}

export function rememberModelDraft(provider: ProviderChoice, draft: ModelDraft): void {
  if (typeof window === "undefined") return;
  try {
    const current = readRememberedModelDrafts();
    current[provider] = sanitizeModelDraft(draft);
    writeRememberedModelDrafts(current);
  } catch {
    // Ignore storage failures; the in-memory draft still applies for this page.
  }
}

function catalogHasModel(
  catalog: ProviderModelCatalog | null | undefined,
  modelId: string | null | undefined,
): boolean {
  const normalizedModelId = modelId?.trim();
  if (!normalizedModelId || !catalog) {
    return false;
  }
  return catalog.models.some((model) => model.id === normalizedModelId);
}

export function pruneModelDraftForCatalog(
  catalog: ProviderModelCatalog | null | undefined,
  draft: ModelDraft | undefined,
): ModelDraft | undefined {
  if (!draft?.modelId) {
    return draft;
  }
  if (!catalog || catalogHasModel(catalog, draft.modelId)) {
    return draft;
  }
  return {};
}

export function sameModelDraft(
  left: ModelDraft | undefined,
  right: ModelDraft | undefined,
): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

export function draftModelIdForCatalog(
  catalog: ProviderModelCatalog | null | undefined,
  draft: ModelDraft | undefined,
): string | null {
  return catalogHasModel(catalog, draft?.modelId) ? draft!.modelId! : null;
}
