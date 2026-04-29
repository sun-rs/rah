import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  query as claudeQuery,
  type ModelInfo as ClaudeSdkModelInfo,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ModelCapabilityProfile,
  ProviderModelCatalog,
  SessionConfigOption,
  SessionResolvedConfig,
  SessionModelDescriptor,
  SessionReasoningOption,
} from "@rah/runtime-protocol";
import { knownModelContextWindow } from "./model-context-window";
import { defaultProviderModeId, providerModeDescriptors } from "./session-mode-utils";

type ClaudeSettingsFile = {
  env?: Record<string, unknown>;
  model?: unknown;
};

type ClaudeConfigState = {
  env: Record<string, string>;
  model: string | null;
};

const CLAUDE_CATALOG_CACHE_TTL_MS = 30_000;
const CLAUDE_MODEL_FETCH_TIMEOUT_MS = 15_000;
const CLAUDE_EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X High",
  max: "Max",
};
const FALLBACK_CLAUDE_MODELS: ClaudeSdkModelInfo[] = [
  {
    value: "default",
    displayName: "Default",
    description: "Use the default model.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    supportsAdaptiveThinking: true,
  },
  {
    value: "sonnet[1m]",
    displayName: "Sonnet (1M context)",
    description: "Sonnet long-context model.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    supportsAdaptiveThinking: true,
  },
  {
    value: "opus[1m]",
    displayName: "Opus (1M context)",
    description: "Opus long-context model.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Haiku model.",
  },
];
const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CLAUDE_DEFAULT_EFFORT = "high";

function profileRevision(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

function resolveClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readSettingsFile(filePath: string): ClaudeConfigState {
  if (!existsSync(filePath)) {
    return { env: {}, model: null };
  }
  const parsed = readJsonFile<ClaudeSettingsFile>(filePath);
  if (!parsed || typeof parsed !== "object") {
    return { env: {}, model: null };
  }
  const env = parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)
    ? Object.fromEntries(
        Object.entries(parsed.env).flatMap(([key, value]) =>
          typeof value === "string" && value.trim() ? [[key, value.trim()]] : [],
        ),
      )
    : {};
  const model =
    typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : null;
  return { env, model };
}

function mergeClaudeConfigStates(states: ClaudeConfigState[]): ClaudeConfigState {
  return states.reduce<ClaudeConfigState>(
    (merged, next) => ({
      env: {
        ...merged.env,
        ...next.env,
      },
      model: next.model ?? merged.model,
    }),
    { env: {}, model: null },
  );
}

function normalizeClaudeModelToken(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "haiku" || normalized.includes("haiku")) {
    return "haiku";
  }
  if (normalized === "opus" || normalized.includes("opus")) {
    return "opus";
  }
  if (normalized === "default") {
    return "default";
  }
  if (normalized === "sonnet" || normalized.includes("sonnet")) {
    return "sonnet";
  }
  return normalized;
}

export function resolveClaudeCatalogModelId(
  value: string | null | undefined,
  catalog?: ProviderModelCatalog | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (catalog?.models.some((model) => model.id === trimmed)) {
    return trimmed;
  }
  const token = normalizeClaudeModelToken(trimmed);
  if (!token) {
    return null;
  }
  const models = catalog?.models ?? [];
  const byIdPrefix = models.find((model) => model.id.toLowerCase().startsWith(token));
  if (byIdPrefix) {
    return byIdPrefix.id;
  }
  const byLabel = models.find((model) => model.label.toLowerCase().includes(token));
  if (byLabel) {
    return byLabel.id;
  }
  if (token === "sonnet") {
    return models.find((model) => model.id === "default")?.id ?? "default";
  }
  return token;
}

function claudeEffortReasoningOptions(levels: readonly string[]): SessionReasoningOption[] {
  return levels.map((level) => ({
    id: level,
    label: CLAUDE_EFFORT_LABELS[level] ?? level,
    kind: "reasoning_effort",
  }));
}

function versionedClaudeLabel(info: ClaudeSdkModelInfo): string {
  const description = info.description.trim();
  const versionMatch = /\b(Opus|Sonnet|Haiku)\s+\d+(?:\.\d+)+/i.exec(description);
  if (info.value === "default") {
    return versionMatch ? `Default (${versionMatch[0]})` : info.displayName;
  }
  if (!versionMatch) {
    return info.displayName;
  }
  if (/\b1M\b/i.test(info.displayName) || /\b1M\b/i.test(description)) {
    return `${versionMatch[0]} (1M)`;
  }
  return versionMatch[0];
}

function supportedClaudeEffortLevels(model: SessionModelDescriptor): string[] {
  return (model.reasoningOptions ?? [])
    .map((option) => option.id)
    .filter((id) => CLAUDE_EFFORT_LEVELS.has(id));
}

function defaultClaudeEffort(levels: readonly string[], modelId: string): string | null {
  if (levels.length === 0) {
    return null;
  }
  if (modelId.toLowerCase().includes("opus") && levels.includes("xhigh")) {
    return "xhigh";
  }
  return levels.includes(CLAUDE_DEFAULT_EFFORT) ? CLAUDE_DEFAULT_EFFORT : levels[0] ?? null;
}

function buildClaudeEffortOption(model: SessionModelDescriptor): SessionConfigOption | null {
  const levels = supportedClaudeEffortLevels(model);
  if (levels.length === 0) {
    return null;
  }
  const defaultValue = defaultClaudeEffort(levels, model.id);
  return {
    id: "effort",
    label: "Effort",
    description: "Claude thinking effort level.",
    kind: "select",
    scope: "model",
    source: "native_local",
    mutable: true,
    applyTiming: "next_turn",
    ...(defaultValue ? { defaultValue } : {}),
    options: levels.map((level) => ({
      id: level,
      label: CLAUDE_EFFORT_LABELS[level] ?? level,
    })),
    availability: {
      modelIds: [model.id],
    },
    backendKey: "effort",
  };
}

function buildClaudeModelProfiles(models: SessionModelDescriptor[]): ModelCapabilityProfile[] {
  return models.map((model) => {
    const effort = buildClaudeEffortOption(model);
    const levels = supportedClaudeEffortLevels(model);
    return {
      modelId: model.id,
      source: "native_online",
      freshness: "authoritative",
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      traits: {
        supportsEffort: levels.length > 0,
        supportsThinkingLevel: levels.length > 0,
      },
      configOptions: effort ? [effort] : [],
    };
  });
}

function descriptorFromClaudeModelInfo(info: ClaudeSdkModelInfo): SessionModelDescriptor {
  const levels = info.supportsEffort
    ? (info.supportedEffortLevels ?? []).filter((level) => CLAUDE_EFFORT_LEVELS.has(level))
    : [];
  const defaultReasoningId = defaultClaudeEffort(levels, info.value);
  const description = info.description.trim();
  const contextWindow = knownModelContextWindow({
    provider: "claude",
    modelId: info.value,
  })?.contextWindow;
  const descriptor: SessionModelDescriptor = {
    id: info.value,
    label: versionedClaudeLabel(info),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(description ? { description } : {}),
    ...(info.value === "default" ? { isDefault: true } : {}),
  };
  if (levels.length === 0) {
    return descriptor;
  }
  return {
    ...descriptor,
    reasoningOptions: claudeEffortReasoningOptions(levels),
    ...(defaultReasoningId ? { defaultReasoningId } : {}),
  };
}

function buildClaudeModelDescriptors(modelInfos: readonly ClaudeSdkModelInfo[]): SessionModelDescriptor[] {
  const seen = new Set<string>();
  return modelInfos.flatMap((info) => {
    const id = info.value.trim();
    if (!id || seen.has(id)) {
      return [];
    }
    seen.add(id);
    return [descriptorFromClaudeModelInfo({ ...info, value: id })];
  });
}

async function* emptyClaudeInput(): AsyncGenerator<never> {}

async function fetchClaudeSupportedModels(cwd?: string): Promise<ClaudeSdkModelInfo[]> {
  if (process.env.RAH_CLAUDE_MODEL_CATALOG_OFFLINE === "1") {
    return [];
  }
  const query = claudeQuery({
    prompt: emptyClaudeInput(),
    options: cwd ? { cwd } : {},
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Timed out while reading Claude models.")), CLAUDE_MODEL_FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([query.supportedModels(), timeout]);
  } finally {
    query.close();
  }
}

function buildClaudeCatalogFromModelInfos(args: {
  modelInfos: readonly ClaudeSdkModelInfo[];
  cwd?: string;
  mergedConfig: ClaudeConfigState;
  source: ProviderModelCatalog["source"];
  sourceDetail: NonNullable<ProviderModelCatalog["sourceDetail"]>;
  freshness: NonNullable<ProviderModelCatalog["freshness"]>;
  modelsExact: boolean;
  optionsExact: boolean;
}): ProviderModelCatalog {
  const models = buildClaudeModelDescriptors(args.modelInfos);
  const currentModelId =
    resolveClaudeCatalogModelId(args.mergedConfig.model, { provider: "claude", models, fetchedAt: "", source: args.source }) ??
    resolveClaudeCatalogModelId(args.mergedConfig.env.ANTHROPIC_MODEL, { provider: "claude", models, fetchedAt: "", source: args.source }) ??
    models.find((model) => model.isDefault)?.id ??
    models[0]?.id;
  const currentReasoningId = currentModelId
    ? models.find((model) => model.id === currentModelId)?.defaultReasoningId ?? null
    : undefined;
  return {
    provider: "claude",
    ...(currentModelId ? { currentModelId } : {}),
    ...(currentReasoningId !== undefined ? { currentReasoningId } : {}),
    models,
    fetchedAt: new Date().toISOString(),
    source: args.source,
    sourceDetail: args.sourceDetail,
    freshness: args.freshness,
    revision: profileRevision({
      cwd: args.cwd ?? null,
      model: args.mergedConfig.model,
      env: {
        ANTHROPIC_MODEL: args.mergedConfig.env.ANTHROPIC_MODEL ?? null,
      },
      models: models.map((model) => ({
        id: model.id,
        label: model.label,
        contextWindow: model.contextWindow ?? null,
        defaultReasoningId: model.defaultReasoningId ?? null,
      })),
    }),
    modelsExact: args.modelsExact,
    optionsExact: args.optionsExact,
    defaultModeId: defaultProviderModeId("claude")!,
    modes: providerModeDescriptors("claude"),
    modelProfiles: buildClaudeModelProfiles(models).map((profile) => ({
      ...profile,
      source: args.sourceDetail,
      freshness: args.freshness,
      configOptions: profile.configOptions.map((option) => ({
        ...option,
        source: args.sourceDetail,
      })),
    })),
  };
}

function readMergedClaudeConfig(cwd?: string): ClaudeConfigState {
  const claudeConfigDir = resolveClaudeConfigDir();
  const globalSettings = readSettingsFile(path.join(claudeConfigDir, "settings.json"));
  const globalLocalSettings = readSettingsFile(path.join(claudeConfigDir, "settings.local.json"));
  const projectSettings = cwd
    ? readSettingsFile(path.join(cwd, ".claude", "settings.json"))
    : { env: {}, model: null };
  const projectLocalSettings = cwd
    ? readSettingsFile(path.join(cwd, ".claude", "settings.local.json"))
    : { env: {}, model: null };
  return mergeClaudeConfigStates([
    globalSettings,
    globalLocalSettings,
    projectSettings,
    projectLocalSettings,
  ]);
}

function buildClaudeFallbackCatalog(options?: {
  cwd?: string;
}): ProviderModelCatalog {
  const merged = readMergedClaudeConfig(options?.cwd);
  return buildClaudeCatalogFromModelInfos({
    modelInfos: FALLBACK_CLAUDE_MODELS,
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    mergedConfig: merged,
    source: "fallback",
    sourceDetail: "static_builtin",
    freshness: "stale",
    modelsExact: false,
    optionsExact: false,
  });
}

export async function buildClaudeModelCatalog(options?: {
  cwd?: string;
}): Promise<ProviderModelCatalog> {
  const merged = readMergedClaudeConfig(options?.cwd);
  try {
    const modelInfos = await fetchClaudeSupportedModels(options?.cwd);
    if (modelInfos.length > 0) {
      return buildClaudeCatalogFromModelInfos({
        modelInfos,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        mergedConfig: merged,
        source: "native",
        sourceDetail: "native_online",
        freshness: "authoritative",
        modelsExact: true,
        optionsExact: true,
      });
    }
  } catch {
    // Fall back to the built-in SDK-shaped catalog when Claude cannot be initialized.
  }
  return buildClaudeCatalogFromModelInfos({
    modelInfos: FALLBACK_CLAUDE_MODELS,
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    mergedConfig: merged,
    source: "fallback",
    sourceDetail: "static_builtin",
    freshness: "stale",
    modelsExact: false,
    optionsExact: false,
  });
}

export function buildClaudeCachedFallbackModelCatalog(options?: {
  cwd?: string;
}): ProviderModelCatalog {
  return buildClaudeFallbackCatalog(options);
}

export function resolveClaudeRuntimeModelId(
  model: SessionModelDescriptor,
): string | undefined {
  if (model.id === "default") {
    return undefined;
  }
  return model.id;
}

export function resolveClaudeModelProfile(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string | null | undefined;
}): ModelCapabilityProfile | undefined {
  if (!args.catalog || !args.modelId) {
    return undefined;
  }
  return args.catalog.modelProfiles?.find((profile) => profile.modelId === args.modelId);
}

export function resolveClaudeEffortValue(
  value: unknown,
): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!CLAUDE_EFFORT_LEVELS.has(normalized)) {
    return undefined;
  }
  return normalized;
}

export function buildClaudeResolvedConfig(args: {
  effort: string | number | undefined;
}): SessionResolvedConfig | undefined {
  if (args.effort === undefined) {
    return undefined;
  }
  return {
    values: {
      effort: args.effort,
    },
    source: "runtime_session",
  };
}

export function resolveClaudeRuntimeCapabilityState(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string | null | undefined;
  effort: string | number | undefined;
}): {
  modelProfile?: ModelCapabilityProfile;
  config?: SessionResolvedConfig;
} {
  const modelProfile = resolveClaudeModelProfile({
    catalog: args.catalog,
    modelId: args.modelId,
  });
  const supportsEffort = modelProfile?.configOptions.some((option) => option.id === "effort") === true;
  const config = supportsEffort
    ? buildClaudeResolvedConfig({ effort: args.effort })
    : undefined;
  return {
    ...(modelProfile ? { modelProfile } : {}),
    ...(config ? { config } : {}),
  };
}

export class ClaudeModelCatalogCache {
  private readonly cachedByKey = new Map<string, ProviderModelCatalog>();

  getCached(options?: { cwd?: string }): ProviderModelCatalog | null {
    return this.cachedByKey.get(options?.cwd ?? "") ?? null;
  }

  async listModels(options?: { cwd?: string; forceRefresh?: boolean }): Promise<ProviderModelCatalog> {
    const key = options?.cwd ?? "";
    const cached = this.cachedByKey.get(key) ?? null;
    if (!options?.forceRefresh && cached) {
      const ageMs = Date.now() - Date.parse(cached.fetchedAt);
      if (Number.isFinite(ageMs) && ageMs < CLAUDE_CATALOG_CACHE_TTL_MS) {
        return cached;
      }
    }
    const nextCatalog = await buildClaudeModelCatalog(options);
    this.cachedByKey.set(key, nextCatalog);
    return nextCatalog;
  }
}
