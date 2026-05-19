import { createHash } from "node:crypto";
import type {
  ModelCapabilityProfile,
  ProviderModelCatalog,
  SessionConfigOption,
  SessionConfigValue,
  SessionModelDescriptor,
  SessionModeDescriptor,
  SessionReasoningOption,
  SessionResolvedConfig,
} from "@rah/runtime-protocol";
import {
  openCodeRequestJson,
  startOpenCodeServer,
  stopOpenCodeServer,
} from "./opencode-api";
import {
  buildOpenCodeAgentModeDescriptors,
  defaultProviderModeId,
  providerModeDescriptors,
} from "./session-mode-utils";

const OPENCODE_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

type OpenCodeConfigResponse = {
  model?: unknown;
};

type OpenCodeConfigProvidersResponse = {
  providers?: unknown;
  default?: unknown;
};

type OpenCodeAgentsResponse = unknown[];

type OpenCodeAgentRecord = {
  name?: unknown;
  id?: unknown;
  description?: unknown;
  mode?: unknown;
  hidden?: unknown;
};

type OpenCodeProviderRecord = {
  id?: unknown;
  name?: unknown;
  source?: unknown;
  models?: unknown;
};

type OpenCodeModelRecord = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  status?: unknown;
  limit?: unknown;
  capabilities?: unknown;
  variants?: unknown;
};

type OpenCodeVariantRecord = {
  reasoningEffort?: unknown;
  reasoning_effort?: unknown;
  thinking?: unknown;
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function mapOpenCodeAgentModeDescriptors(
  agents: readonly unknown[],
): SessionModeDescriptor[] {
  return buildOpenCodeAgentModeDescriptors(
    agents.flatMap((rawAgent) => {
      const agent = asRecord(rawAgent) as OpenCodeAgentRecord | null;
      if (!agent) {
        return [];
      }
      const mode = asNonEmptyString(agent.mode);
      if (mode === "subagent") {
        return [];
      }
      if (agent.hidden === true) {
        return [];
      }
      const id = asNonEmptyString(agent.name) ?? asNonEmptyString(agent.id);
      if (!id) {
        return [];
      }
      return [{
        id,
        label: id,
        ...(asNonEmptyString(agent.description)
          ? { description: asNonEmptyString(agent.description)! }
          : {}),
      }];
    }),
  );
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function openCodeContextWindow(model: OpenCodeModelRecord | null | undefined): number | undefined {
  return positiveNumber(asRecord(model?.limit)?.context);
}

function profileRevision(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

function humanizeOpenCodeVariantId(value: string): string {
  switch (value) {
    case "default":
      return "Base";
    case "xhigh":
      return "XHigh";
    case "none":
      return "None";
    case "max":
      return "Max";
    default:
      return value.slice(0, 1).toUpperCase() + value.slice(1);
  }
}

function openCodeVariantKind(
  variant: OpenCodeVariantRecord | null,
): SessionReasoningOption["kind"] {
  if (
    asNonEmptyString(variant?.reasoningEffort) ??
    asNonEmptyString(variant?.reasoning_effort)
  ) {
    return "reasoning_effort";
  }
  if (variant?.thinking !== undefined) {
    return "thinking";
  }
  return "model_variant";
}

function mapOpenCodeReasoningOptions(
  variants: Record<string, unknown>,
): SessionReasoningOption[] {
  const options: SessionReasoningOption[] = [
    {
      id: "default",
      label: "Base",
      kind: "model_variant",
    },
  ];
  for (const [variantId, rawVariant] of Object.entries(variants)) {
    if (!variantId.trim()) {
      continue;
    }
    const variant = asRecord(rawVariant) as OpenCodeVariantRecord | null;
    options.push({
      id: variantId,
      label: humanizeOpenCodeVariantId(variantId),
      kind: openCodeVariantKind(variant),
    });
  }
  return options;
}

function mapOpenCodeModel(args: {
  providerId: string;
  providerName: string;
  modelId: string;
  model: OpenCodeModelRecord;
  isDefault: boolean;
}): SessionModelDescriptor | null {
  const id = `${args.providerId}/${args.modelId}`;
  const label = `${args.providerName}/${asNonEmptyString(args.model.name) ?? args.modelId}`;
  const variants = asRecord(args.model.variants) ?? {};
  const reasoningOptions =
    Object.keys(variants).length > 0 ? mapOpenCodeReasoningOptions(variants) : [];
  const contextWindow = openCodeContextWindow(args.model);
  return {
    id,
    label,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(asNonEmptyString(args.model.description)
      ? { description: asNonEmptyString(args.model.description)! }
      : {}),
    ...(args.isDefault ? { isDefault: true } : {}),
    ...(reasoningOptions.length > 0 ? { reasoningOptions, defaultReasoningId: "default" } : {}),
  };
}

function buildOpenCodeReasoningConfigOption(args: {
  model: SessionModelDescriptor;
}): SessionConfigOption | null {
  const reasoningOptions = args.model.reasoningOptions ?? [];
  if (reasoningOptions.length === 0) {
    return null;
  }
  return {
    id: "model_reasoning_variant",
    label: "Reasoning variant",
    description: "OpenCode model variant for the next turn.",
    kind: "select",
    scope: "model",
    source: "native_online",
    mutable: true,
    applyTiming: "next_turn",
    defaultValue: args.model.defaultReasoningId ?? "default",
    options: reasoningOptions.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    availability: {
      modelIds: [args.model.id],
    },
    backendKey: "variant",
  };
}

function buildOpenCodeModelProfiles(args: {
  models: SessionModelDescriptor[];
  providerModels: Map<string, OpenCodeModelRecord>;
}): ModelCapabilityProfile[] {
  return args.models.map((model) => {
    const rawModel = args.providerModels.get(model.id);
    const capabilities = asRecord(rawModel?.capabilities) ?? {};
    const variants = asRecord(rawModel?.variants) ?? {};
    const contextWindow = openCodeContextWindow(rawModel);
    const variantValues = Object.values(variants).flatMap((value) => {
      const record = asRecord(value);
      return record ? [record as OpenCodeVariantRecord] : [];
    });
    const configOption = buildOpenCodeReasoningConfigOption({ model });
    const hasReasoningEffort = variantValues.some(
      (variant) =>
        Boolean(asNonEmptyString(variant.reasoningEffort)) ||
        Boolean(asNonEmptyString(variant.reasoning_effort)),
    );
    const hasThinkingVariant = variantValues.some((variant) => variant.thinking !== undefined);
    return {
      modelId: model.id,
      source: "native_online",
      freshness: "authoritative",
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      traits: {
        ...(capabilities.reasoning === true || hasThinkingVariant
          ? { supportsThinking: true }
          : {}),
        ...(hasReasoningEffort ? { supportsEffort: true } : {}),
        ...(Object.keys(variants).length > 0 ? { supportsReasoningVariant: true } : {}),
      },
      configOptions: configOption ? [configOption] : [],
    };
  });
}

function normalizeOpenCodeCurrentModel(args: {
  rawCurrentModelId: string | null;
  models: SessionModelDescriptor[];
}): { modelId?: string; reasoningId?: string | null } {
  if (!args.rawCurrentModelId) {
    const defaultModel = args.models.find((model) => model.isDefault) ?? args.models[0];
    return {
      ...(defaultModel ? { modelId: defaultModel.id } : {}),
      ...(defaultModel?.defaultReasoningId !== undefined
        ? { reasoningId: defaultModel.defaultReasoningId }
        : {}),
    };
  }
  const exact = args.models.find((model) => model.id === args.rawCurrentModelId);
  if (exact) {
    return {
      modelId: exact.id,
      ...(exact.defaultReasoningId !== undefined ? { reasoningId: exact.defaultReasoningId } : {}),
    };
  }
  const model = [...args.models]
    .sort((a, b) => b.id.length - a.id.length)
    .find((candidate) => args.rawCurrentModelId?.startsWith(`${candidate.id}/`));
  if (!model) {
    return { modelId: args.rawCurrentModelId };
  }
  const suffix = args.rawCurrentModelId.slice(model.id.length + 1);
  const hasSuffix = model.reasoningOptions?.some((option) => option.id === suffix);
  return {
    modelId: model.id,
    reasoningId: hasSuffix ? suffix : model.defaultReasoningId ?? null,
  };
}

function buildOpenCodeCatalog(args: {
  providers: OpenCodeProviderRecord[];
  defaultByProvider: Record<string, unknown>;
  currentModelId?: string | null;
  modes?: SessionModeDescriptor[];
}): ProviderModelCatalog {
  const models: SessionModelDescriptor[] = [];
  const providerModels = new Map<string, OpenCodeModelRecord>();
  for (const provider of args.providers) {
    const providerId = asNonEmptyString(provider.id);
    if (!providerId) {
      continue;
    }
    const providerName = asNonEmptyString(provider.name) ?? providerId;
    const rawModels = asRecord(provider.models) ?? {};
    const defaultModelId = asNonEmptyString(args.defaultByProvider[providerId]);
    for (const [modelId, rawModel] of Object.entries(rawModels)) {
      const modelRecord = asRecord(rawModel) as OpenCodeModelRecord | null;
      if (!modelRecord) {
        continue;
      }
      const mapped = mapOpenCodeModel({
        providerId,
        providerName,
        modelId,
        model: modelRecord,
        isDefault: defaultModelId === modelId,
      });
      if (!mapped) {
        continue;
      }
      models.push(mapped);
      providerModels.set(mapped.id, modelRecord);
    }
  }
  const current = normalizeOpenCodeCurrentModel({
    rawCurrentModelId: args.currentModelId ?? null,
    models,
  });
  return {
    provider: "opencode",
    ...(current.modelId ? { currentModelId: current.modelId } : {}),
    ...(current.reasoningId !== undefined ? { currentReasoningId: current.reasoningId } : {}),
    models,
    fetchedAt: new Date().toISOString(),
    source: "native",
    sourceDetail: "native_online",
    freshness: "authoritative",
    revision: profileRevision({
      models: models.map((model) => ({
        id: model.id,
        label: model.label,
        contextWindow: model.contextWindow ?? null,
        reasoningOptions: model.reasoningOptions?.map((option) => option.id) ?? [],
      })),
      modes: (args.modes ?? []).map((mode) => mode.id),
    }),
    modelsExact: true,
    optionsExact: true,
    defaultModeId: defaultProviderModeId("opencode")!,
    modes: args.modes && args.modes.length > 0
      ? args.modes
      : providerModeDescriptors("opencode"),
    modelProfiles: buildOpenCodeModelProfiles({ models, providerModels }),
  };
}

export function buildOpenCodeFallbackModelCatalog(): ProviderModelCatalog {
  return {
    provider: "opencode",
    models: [],
    fetchedAt: new Date().toISOString(),
    source: "fallback",
    sourceDetail: "static_builtin",
    freshness: "stale",
    modelsExact: false,
    optionsExact: false,
    defaultModeId: defaultProviderModeId("opencode")!,
    modes: providerModeDescriptors("opencode"),
    modelProfiles: [],
  };
}

export async function fetchOpenCodeModelCatalog(options?: {
  cwd?: string;
}): Promise<ProviderModelCatalog> {
  const cwd = options?.cwd ?? process.cwd();
  const server = await startOpenCodeServer({ cwd });
  try {
    const [config, configProviders, agents] = await Promise.all([
      openCodeRequestJson<OpenCodeConfigResponse>(server, "/config"),
      openCodeRequestJson<OpenCodeConfigProvidersResponse>(server, "/config/providers"),
      openCodeRequestJson<OpenCodeAgentsResponse>(server, "/agent").catch(() => []),
    ]);
    const providers = Array.isArray(configProviders.providers)
      ? (configProviders.providers as OpenCodeProviderRecord[])
      : [];
    const defaultByProvider = asRecord(configProviders.default) ?? {};
    const modes = Array.isArray(agents)
      ? mapOpenCodeAgentModeDescriptors(agents)
      : providerModeDescriptors("opencode");
    return buildOpenCodeCatalog({
      providers,
      defaultByProvider,
      currentModelId: asNonEmptyString(config.model),
      modes,
    });
  } finally {
    await stopOpenCodeServer(server).catch(() => undefined);
  }
}

export function resolveOpenCodeModelProfile(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string | null | undefined;
}): ModelCapabilityProfile | undefined {
  if (!args.catalog || !args.modelId) {
    return undefined;
  }
  return args.catalog.modelProfiles?.find((profile) => profile.modelId === args.modelId);
}

export function buildOpenCodeProviderModelId(args: {
  modelId: string;
  reasoningId?: string | null | undefined;
}): string {
  if (!args.reasoningId || args.reasoningId === "default") {
    return args.modelId;
  }
  return `${args.modelId}/${args.reasoningId}`;
}

export function buildOpenCodeResolvedConfig(args: {
  reasoningId: string | null | undefined;
  optionValues?: Record<string, SessionConfigValue>;
}): SessionResolvedConfig | undefined {
  if (args.optionValues !== undefined) {
    return {
      values: args.optionValues,
      source: "runtime_session",
    };
  }
  if (args.reasoningId === undefined || args.reasoningId === null) {
    return undefined;
  }
  return {
    values: {
      model_reasoning_variant: args.reasoningId,
    },
    source: "runtime_session",
  };
}

export function resolveOpenCodeRuntimeCapabilityState(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string | null | undefined;
  reasoningId: string | null | undefined;
  optionValues?: Record<string, SessionConfigValue>;
}): {
  modelProfile?: ModelCapabilityProfile;
  config?: SessionResolvedConfig;
} {
  const modelProfile = resolveOpenCodeModelProfile({
    catalog: args.catalog,
    modelId: args.modelId,
  });
  const config = buildOpenCodeResolvedConfig({
    reasoningId: args.reasoningId,
    ...(args.optionValues !== undefined ? { optionValues: args.optionValues } : {}),
  });
  return {
    ...(modelProfile ? { modelProfile } : {}),
    ...(config ? { config } : {}),
  };
}

export class OpenCodeModelCatalogCache {
  private readonly cachedByKey = new Map<string, ProviderModelCatalog>();
  private readonly inFlightByKey = new Map<string, Promise<ProviderModelCatalog>>();

  async listModels(options?: {
    cwd?: string;
    forceRefresh?: boolean;
  }): Promise<ProviderModelCatalog> {
    const key = options?.cwd ?? "";
    if (options?.forceRefresh) {
      return await this.refresh(key, options);
    }
    const cached = this.cachedByKey.get(key) ?? null;
    if (cached) {
      const ageMs = Date.now() - Date.parse(cached.fetchedAt);
      if (Number.isFinite(ageMs) && ageMs < OPENCODE_MODEL_CACHE_TTL_MS) {
        return cached;
      }
      void this.refresh(key, options).catch(() => undefined);
      return cached;
    }
    return await this.refresh(key, options);
  }

  getCached(options?: { cwd?: string }): ProviderModelCatalog | null {
    return this.cachedByKey.get(options?.cwd ?? "") ?? null;
  }

  remember(key: string, catalog: ProviderModelCatalog): ProviderModelCatalog {
    this.cachedByKey.set(key, catalog);
    return catalog;
  }

  private async refresh(key: string, options?: { cwd?: string }): Promise<ProviderModelCatalog> {
    const inFlight = this.inFlightByKey.get(key);
    if (inFlight) {
      return await inFlight;
    }
    let request!: Promise<ProviderModelCatalog>;
    request = (async () => {
      try {
        return this.remember(key, await fetchOpenCodeModelCatalog(options));
      } catch {
        return this.remember(key, buildOpenCodeFallbackModelCatalog());
      } finally {
        if (this.inFlightByKey.get(key) === request) {
          this.inFlightByKey.delete(key);
        }
      }
    })();
    this.inFlightByKey.set(key, request);
    return await request;
  }
}
