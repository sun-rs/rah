import { createHash } from "node:crypto";
import type {
  ModelCapabilityProfile,
  ProviderModelCatalog,
  SessionResolvedConfig,
  SessionConfigOption,
  SessionConfigValue,
  SessionModelDescriptor,
  SessionReasoningOption,
} from "@rah/runtime-protocol";
import type { CodexJsonRpcClient } from "./codex-live-rpc";
import { createCodexAppServerClient } from "./codex-live-client";
import { defaultProviderModeId, providerModeDescriptors } from "./session-mode-utils";

const CODEX_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

type CodexReasoningOption = {
  reasoningEffort?: unknown;
  reasoning_effort?: unknown;
  description?: unknown;
};

type CodexModel = {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  display_name?: unknown;
  description?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
  is_default?: unknown;
  supportedReasoningEfforts?: unknown;
  supported_reasoning_efforts?: unknown;
  defaultReasoningEffort?: unknown;
  default_reasoning_effort?: unknown;
};

type CodexModelListResponse = {
  data?: unknown;
  nextCursor?: unknown;
  next_cursor?: unknown;
};

function humanizeReasoningId(value: string): string {
  switch (value) {
    case "xhigh":
      return "XHigh";
    case "none":
      return "Default";
    default:
      return value.slice(0, 1).toUpperCase() + value.slice(1);
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readReasoningEffort(option: CodexReasoningOption): string | null {
  return asNonEmptyString(option.reasoningEffort) ?? asNonEmptyString(option.reasoning_effort);
}

function mapReasoningOptions(model: CodexModel): SessionReasoningOption[] {
  const rawOptions = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
    : Array.isArray(model.supported_reasoning_efforts)
      ? model.supported_reasoning_efforts
      : [];
  const options: SessionReasoningOption[] = [];
  const seen = new Set<string>();
  for (const rawOption of rawOptions) {
    if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) {
      continue;
    }
    const option = rawOption as CodexReasoningOption;
    const id = readReasoningEffort(option);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    options.push({
      id,
      label: humanizeReasoningId(id),
      kind: "reasoning_effort",
      ...(typeof option.description === "string" && option.description.trim()
        ? { description: option.description }
        : {}),
    });
  }
  return options;
}

function mapCodexModel(model: CodexModel): SessionModelDescriptor | null {
  const id = asNonEmptyString(model.id) ?? asNonEmptyString(model.model);
  if (!id) {
    return null;
  }
  const label =
    asNonEmptyString(model.displayName) ??
    asNonEmptyString(model.display_name) ??
    asNonEmptyString(model.model) ??
    id;
  const reasoningOptions = mapReasoningOptions(model);
  const defaultReasoningId =
    asNonEmptyString(model.defaultReasoningEffort) ??
    asNonEmptyString(model.default_reasoning_effort) ??
    reasoningOptions[0]?.id;
  return {
    id,
    label,
    ...(typeof model.description === "string" && model.description.trim()
      ? { description: model.description }
      : {}),
    ...(typeof model.hidden === "boolean" ? { hidden: model.hidden } : {}),
    ...(typeof model.isDefault === "boolean"
      ? { isDefault: model.isDefault }
      : typeof model.is_default === "boolean"
        ? { isDefault: model.is_default }
        : {}),
    ...(reasoningOptions.length > 0 ? { reasoningOptions } : {}),
    ...(defaultReasoningId ? { defaultReasoningId } : {}),
  };
}

function profileRevision(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

function buildCodexReasoningConfigOption(args: {
  model: SessionModelDescriptor;
}): SessionConfigOption | null {
  const reasoningOptions = args.model.reasoningOptions ?? [];
  if (reasoningOptions.length === 0) {
    return null;
  }
  return {
    id: "model_reasoning_effort",
    label: "Reasoning effort",
    description: "Codex model-specific reasoning effort.",
    kind: "select",
    scope: "model",
    source: "native_online",
    mutable: true,
    applyTiming: "next_turn",
    ...(args.model.defaultReasoningId !== undefined
      ? { defaultValue: args.model.defaultReasoningId }
      : {}),
    options: reasoningOptions.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    availability: {
      modelIds: [args.model.id],
    },
    backendKey: "reasoning_effort",
  };
}

function buildCodexModelProfiles(
  models: SessionModelDescriptor[],
): ModelCapabilityProfile[] {
  return models.map((model) => {
    const reasoningOption = buildCodexReasoningConfigOption({ model });
    return {
      modelId: model.id,
      source: "native_online",
      freshness: "authoritative",
      configOptions: reasoningOption ? [reasoningOption] : [],
    };
  });
}

export function resolveCodexModelProfile(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string | null | undefined;
}): ModelCapabilityProfile | undefined {
  if (!args.catalog || !args.modelId) {
    return undefined;
  }
  return args.catalog.modelProfiles?.find((profile) => profile.modelId === args.modelId);
}

export function buildCodexResolvedConfig(args: {
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
      model_reasoning_effort: args.reasoningId,
    },
    source: "runtime_session",
  };
}

export function resolveCodexRuntimeCapabilityState(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string | null | undefined;
  reasoningId: string | null | undefined;
  optionValues?: Record<string, SessionConfigValue>;
}): {
  modelProfile?: ModelCapabilityProfile;
  config?: SessionResolvedConfig;
} {
  const modelProfile = resolveCodexModelProfile({
    catalog: args.catalog,
    modelId: args.modelId,
  });
  const config = buildCodexResolvedConfig({
    reasoningId: args.reasoningId,
    optionValues: args.optionValues,
  });
  return {
    ...(modelProfile ? { modelProfile } : {}),
    ...(config ? { config } : {}),
  };
}

async function requestModelListPage(
  client: CodexJsonRpcClient,
  cursor?: string,
): Promise<CodexModelListResponse> {
  const response = await client.request(
    "model/list",
    cursor ? { cursor, limit: 100 } : { limit: 100 },
  );
  return response && typeof response === "object" && !Array.isArray(response)
    ? (response as CodexModelListResponse)
    : {};
}

export async function fetchCodexModelCatalogWithClient(
  client: CodexJsonRpcClient,
): Promise<ProviderModelCatalog> {
  const models: SessionModelDescriptor[] = [];
  let cursor: string | undefined;
  do {
    const page = await requestModelListPage(client, cursor);
    const data = Array.isArray(page.data) ? page.data : [];
    for (const entry of data) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const model = mapCodexModel(entry as CodexModel);
      if (model) {
        models.push(model);
      }
    }
    cursor =
      asNonEmptyString(page.nextCursor) ??
      asNonEmptyString(page.next_cursor) ??
      undefined;
  } while (cursor);

  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const modelProfiles = buildCodexModelProfiles(models);
  return {
    provider: "codex",
    ...(defaultModel ? { currentModelId: defaultModel.id } : {}),
    ...(defaultModel?.defaultReasoningId !== undefined
      ? { currentReasoningId: defaultModel.defaultReasoningId }
      : {}),
    models,
    fetchedAt: new Date().toISOString(),
    source: "native",
    sourceDetail: "native_online",
    freshness: "authoritative",
    revision: profileRevision({
      models: models.map((model) => ({
        id: model.id,
        defaultReasoningId: model.defaultReasoningId ?? null,
        reasoningOptions: (model.reasoningOptions ?? []).map((option) => option.id),
      })),
    }),
    modelsExact: true,
    optionsExact: true,
    defaultModeId: defaultProviderModeId("codex")!,
    modes: providerModeDescriptors("codex", { planAvailable: true }),
    modelProfiles,
  };
}

export class CodexModelCatalogCache {
  private cached: ProviderModelCatalog | null = null;
  private inFlight: Promise<ProviderModelCatalog> | null = null;

  listModels(options?: { forceRefresh?: boolean }): Promise<ProviderModelCatalog> {
    if (!options?.forceRefresh && this.cached) {
      const ageMs = Date.now() - Date.parse(this.cached.fetchedAt);
      if (Number.isFinite(ageMs) && ageMs < CODEX_MODEL_CACHE_TTL_MS) {
        return Promise.resolve(this.cached);
      }
      void this.refresh();
      return Promise.resolve(this.cached);
    }
    return this.refresh();
  }

  getCached(): ProviderModelCatalog | null {
    return this.cached;
  }

  remember(catalog: ProviderModelCatalog): ProviderModelCatalog {
    this.cached = catalog;
    return catalog;
  }

  private refresh(): Promise<ProviderModelCatalog> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = (async () => {
      const client = await createCodexAppServerClient();
      try {
        return this.remember(await fetchCodexModelCatalogWithClient(client));
      } finally {
        await client.dispose();
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
