import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AddManualProviderModelRequest,
  ManualProviderModel,
  ModelCapabilityProfile,
  ProviderKind,
  ProviderModelCatalog,
  SessionConfigOption,
  SessionModelDescriptor,
  SessionReasoningOption,
  SessionReasoningOptionKind,
} from "@rah/runtime-protocol";

const STORAGE_VERSION = 1;
const SNAPSHOT_FILE = "manual-provider-models.json";
const CORE_PROVIDERS = new Set<ProviderKind>(["codex", "claude", "gemini", "opencode"]);
const OPTION_ORDER = new Map([
  ["default", 0],
  ["none", 1],
  ["low", 2],
  ["medium", 3],
  ["high", 4],
  ["xhigh", 5],
  ["max", 6],
]);
const OPTION_LABELS: Record<string, string> = {
  default: "Default",
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

type ManualProviderModelFile = {
  version: number;
  updatedAt: string;
  models?: unknown[];
};

type ProviderManualOptionSpec = {
  optionId: string;
  optionLabel: string;
  optionDescription: string;
  backendKey: string;
  reasoningKind: SessionReasoningOptionKind;
  traits: NonNullable<ModelCapabilityProfile["traits"]>;
};

function resolveRahHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah");
}

function defaultRootDir(): string {
  return path.join(resolveRahHome(), "runtime-daemon");
}

async function writeJsonAtomic(pathname: string, value: unknown): Promise<void> {
  const tmpPath = `${pathname}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tmpPath, pathname);
}

function requireCoreProvider(provider: ProviderKind): asserts provider is Exclude<ProviderKind, "custom"> {
  if (!CORE_PROVIDERS.has(provider)) {
    throw new Error(`Bad Request: provider ${provider} does not support manual model supplements.`);
  }
}

function normalizeId(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Bad Request: ${field} is required.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Bad Request: ${field} is required.`);
  }
  if (trimmed.length > 240) {
    throw new Error(`Bad Request: ${field} is too long.`);
  }
  return trimmed;
}

function normalizeManualModelId(provider: ProviderKind, value: unknown): string {
  const id = normalizeId(value, "model id");
  return id;
}

function providerOptionSpec(provider: ProviderKind): ProviderManualOptionSpec | null {
  switch (provider) {
    case "codex":
      return {
        optionId: "model_reasoning_effort",
        optionLabel: "Reasoning effort",
        optionDescription: "User-supplied Codex reasoning effort.",
        backendKey: "reasoning_effort",
        reasoningKind: "reasoning_effort",
        traits: { supportsEffort: true },
      };
    case "claude":
      return {
        optionId: "effort",
        optionLabel: "Effort",
        optionDescription: "User-supplied Claude thinking effort.",
        backendKey: "effort",
        reasoningKind: "reasoning_effort",
        traits: { supportsThinking: true, supportsThinkingLevel: true, supportsEffort: true },
      };
    case "opencode":
      return {
        optionId: "model_reasoning_variant",
        optionLabel: "Reasoning variant",
        optionDescription: "User-supplied OpenCode model variant.",
        backendKey: "variant",
        reasoningKind: "model_variant",
        traits: { supportsReasoningVariant: true },
      };
    case "gemini":
    case "custom":
      return null;
  }
}

function optionLabel(id: string): string {
  return OPTION_LABELS[id] ?? id
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeOptionIds(provider: ProviderKind, values: readonly unknown[] | undefined): string[] {
  const spec = providerOptionSpec(provider);
  if (!spec) {
    return [];
  }
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const id = normalizeId(value, "model option").toLowerCase();
    if (provider === "opencode" && (id === "default" || id === "base")) {
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push(id);
  }
  return next.sort((left, right) => {
    const leftRank = OPTION_ORDER.get(left);
    const rightRank = OPTION_ORDER.get(right);
    if (leftRank !== undefined && rightRank !== undefined) {
      return leftRank - rightRank;
    }
    if (leftRank !== undefined) {
      return -1;
    }
    if (rightRank !== undefined) {
      return 1;
    }
    return 0;
  });
}

function isStoredManualModel(value: unknown): value is ManualProviderModel {
  if (!value || typeof value !== "object") {
    return false;
  }
  const model = value as Partial<ManualProviderModel>;
  return (
    typeof model.provider === "string" &&
    CORE_PROVIDERS.has(model.provider as ProviderKind) &&
    typeof model.id === "string" &&
    model.id.trim().length > 0 &&
    (model.optionIds === undefined || Array.isArray(model.optionIds)) &&
    typeof model.createdAt === "string" &&
    typeof model.updatedAt === "string"
  );
}

function sanitizeStoredModel(value: ManualProviderModel): ManualProviderModel | null {
  try {
    const provider = value.provider;
    requireCoreProvider(provider);
    const id = normalizeManualModelId(provider, value.id);
    const optionIds = normalizeOptionIds(provider, value.optionIds ?? []);
    return {
      provider,
      id,
      ...(optionIds.length > 0 ? { optionIds } : {}),
      createdAt: Number.isNaN(Date.parse(value.createdAt)) ? new Date().toISOString() : value.createdAt,
      updatedAt: Number.isNaN(Date.parse(value.updatedAt)) ? new Date().toISOString() : value.updatedAt,
    };
  } catch {
    return null;
  }
}

function cloneManualModel(model: ManualProviderModel): ManualProviderModel {
  return {
    ...model,
    ...(model.optionIds ? { optionIds: [...model.optionIds] } : {}),
  };
}

function manualModelKey(provider: ProviderKind, modelId: string): string {
  return `${provider}:${modelId}`;
}

function manualReasoningOptions(provider: ProviderKind, optionIds: readonly string[] | undefined): SessionReasoningOption[] {
  const spec = providerOptionSpec(provider);
  if (!spec || !optionIds || optionIds.length === 0) {
    return [];
  }
  return optionIds.map((id) => ({
    id,
    label: optionLabel(id),
    kind: spec.reasoningKind,
  }));
}

function manualConfigOption(args: {
  provider: ProviderKind;
  modelId: string;
  options: readonly SessionReasoningOption[];
}): SessionConfigOption | null {
  const spec = providerOptionSpec(args.provider);
  if (!spec || args.options.length === 0) {
    return null;
  }
  return {
    id: spec.optionId,
    label: spec.optionLabel,
    description: spec.optionDescription,
    kind: "select",
    scope: "model",
    source: "cached_runtime",
    mutable: true,
    applyTiming: "next_turn",
    ...(args.options.at(-1)?.id ? { defaultValue: args.options.at(-1)!.id } : {}),
    options: args.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    availability: {
      modelIds: [args.modelId],
    },
    backendKey: spec.backendKey,
  };
}

function manualDescriptor(model: ManualProviderModel): SessionModelDescriptor {
  const reasoningOptions = manualReasoningOptions(model.provider, model.optionIds);
  const defaultReasoningId = reasoningOptions.at(-1)?.id;
  return {
    id: model.id,
    ...(reasoningOptions.length > 0
      ? {
          reasoningOptions,
          ...(defaultReasoningId ? { defaultReasoningId } : {}),
        }
      : {}),
  };
}

function manualProfile(model: ManualProviderModel): ModelCapabilityProfile {
  const options = manualReasoningOptions(model.provider, model.optionIds);
  const configOption = manualConfigOption({
    provider: model.provider,
    modelId: model.id,
    options,
  });
  const spec = providerOptionSpec(model.provider);
  return {
    modelId: model.id,
    source: "cached_runtime",
    freshness: "stale",
    ...(spec && options.length > 0 ? { traits: spec.traits } : {}),
    configOptions: configOption ? [configOption] : [],
  };
}

export class ManualProviderModelStore {
  private readonly rootDir: string;
  private readonly snapshotPath: string;
  private loaded = false;
  private models: ManualProviderModel[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(rootDir = defaultRootDir()) {
    this.rootDir = rootDir;
    this.snapshotPath = path.join(rootDir, SNAPSHOT_FILE);
    mkdirSync(this.rootDir, { recursive: true });
  }

  list(provider?: ProviderKind): ManualProviderModel[] {
    this.loadIfNeeded();
    return this.models
      .filter((model) => !provider || model.provider === provider)
      .map(cloneManualModel);
  }

  async add(provider: ProviderKind, request: AddManualProviderModelRequest): Promise<ManualProviderModel> {
    requireCoreProvider(provider);
    this.loadIfNeeded();
    const id = normalizeManualModelId(provider, request.id);
    const optionIds = normalizeOptionIds(provider, request.optionIds ?? []);
    if (this.models.some((model) => model.provider === provider && model.id === id)) {
      throw new Error(`Bad Request: manual model '${id}' already exists for ${provider}.`);
    }
    const now = new Date().toISOString();
    const model: ManualProviderModel = {
      provider,
      id,
      ...(optionIds.length > 0 ? { optionIds } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.models = [...this.models, model].sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
    );
    await this.persist();
    return cloneManualModel(model);
  }

  async remove(provider: ProviderKind, modelId: string): Promise<void> {
    requireCoreProvider(provider);
    this.loadIfNeeded();
    const id = normalizeId(modelId, "model id");
    const before = this.models.length;
    this.models = this.models.filter((model) => !(model.provider === provider && model.id === id));
    if (this.models.length === before) {
      throw new Error(`Unknown manual model ${provider}/${id}.`);
    }
    await this.persist();
  }

  async removeOption(provider: ProviderKind, modelId: string, optionId: string): Promise<ManualProviderModel> {
    requireCoreProvider(provider);
    if (!providerOptionSpec(provider)) {
      throw new Error(`Bad Request: provider ${provider} does not support manual model options.`);
    }
    this.loadIfNeeded();
    const id = normalizeId(modelId, "model id");
    const option = normalizeId(optionId, "model option");
    const existing = this.models.find((model) => model.provider === provider && model.id === id);
    if (!existing) {
      throw new Error(`Unknown manual model ${provider}/${id}.`);
    }
    const currentOptions = existing.optionIds ?? [];
    if (!currentOptions.includes(option)) {
      throw new Error(`Unknown manual model option ${provider}/${id}/${option}.`);
    }
    const nextOptionIds = currentOptions.filter((entry) => entry !== option);
    const { optionIds: _removedOptionIds, ...existingWithoutOptionIds } = existing;
    const updated: ManualProviderModel =
      nextOptionIds.length > 0
        ? { ...existing, optionIds: nextOptionIds, updatedAt: new Date().toISOString() }
        : { ...existingWithoutOptionIds, updatedAt: new Date().toISOString() };
    this.models = this.models.map((model) =>
      model.provider === provider && model.id === id ? updated : model,
    );
    await this.persist();
    return cloneManualModel(updated);
  }

  private loadIfNeeded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    if (!existsSync(this.snapshotPath)) {
      this.models = [];
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.snapshotPath, "utf8")) as ManualProviderModelFile;
      const models = Array.isArray(raw.models)
        ? raw.models.filter(isStoredManualModel).flatMap((value) => {
            const model = sanitizeStoredModel(value);
            return model ? [model] : [];
          })
        : [];
      const unique = new Map<string, ManualProviderModel>();
      for (const model of models) {
        unique.set(manualModelKey(model.provider, model.id), model);
      }
      this.models = [...unique.values()].sort((left, right) =>
        left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
      );
    } catch (error) {
      console.error("[rah] failed to load manual provider models", { error });
      this.models = [];
    }
  }

  private async persist(): Promise<void> {
    const snapshot: ManualProviderModelFile = {
      version: STORAGE_VERSION,
      updatedAt: new Date().toISOString(),
      models: this.models.map(cloneManualModel),
    };
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.rootDir, { recursive: true });
        await writeJsonAtomic(this.snapshotPath, snapshot);
      });
    this.writeQueue = write;
    await write;
  }
}

let defaultStore: ManualProviderModelStore | null = null;

function getDefaultStore(): ManualProviderModelStore {
  defaultStore ??= new ManualProviderModelStore();
  return defaultStore;
}

export function resetDefaultManualProviderModelStoreForTests(rootDir?: string): void {
  defaultStore = rootDir === undefined ? null : new ManualProviderModelStore(rootDir);
}

export function listManualProviderModels(provider?: ProviderKind): ManualProviderModel[] {
  return getDefaultStore().list(provider);
}

export async function addManualProviderModel(
  provider: ProviderKind,
  request: AddManualProviderModelRequest,
): Promise<ManualProviderModel> {
  return getDefaultStore().add(provider, request);
}

export async function deleteManualProviderModel(provider: ProviderKind, modelId: string): Promise<void> {
  await getDefaultStore().remove(provider, modelId);
}

export async function deleteManualProviderModelOption(
  provider: ProviderKind,
  modelId: string,
  optionId: string,
): Promise<ManualProviderModel> {
  return getDefaultStore().removeOption(provider, modelId, optionId);
}

export function mergeManualProviderModels(
  catalog: ProviderModelCatalog,
  store: ManualProviderModelStore = getDefaultStore(),
): ProviderModelCatalog {
  const existingModelIds = new Set(catalog.models.map((model) => model.id));
  const additions = store
    .list(catalog.provider)
    .filter((model) => !existingModelIds.has(model.id));
  if (additions.length === 0) {
    return catalog;
  }
  const manualModels = additions.map(manualDescriptor);
  const manualProfiles = additions.map(manualProfile);
  return {
    ...catalog,
    models: [...catalog.models, ...manualModels],
    modelProfiles: [...(catalog.modelProfiles ?? []), ...manualProfiles],
    modelsExact: false,
    optionsExact: false,
  };
}
