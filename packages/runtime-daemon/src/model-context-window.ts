import type {
  ContextUsage,
  ProviderKind,
  ProviderModelCatalog,
} from "@rah/runtime-protocol";

export type ModelContextWindowResolution = {
  contextWindow: number;
  precision: NonNullable<ContextUsage["precision"]>;
  source: string;
};

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizeModelId(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function longestKnownMatch(
  modelId: string,
  table: Record<string, number>,
): number | undefined {
  let bestKey = "";
  let bestValue: number | undefined;
  for (const [key, value] of Object.entries(table)) {
    if (modelId.includes(key) && key.length > bestKey.length) {
      bestKey = key;
      bestValue = value;
    }
  }
  return bestValue;
}

function catalogPrecision(args: {
  provider: ProviderKind;
  freshness: string | undefined;
}): NonNullable<ContextUsage["precision"]> {
  return args.provider === "opencode" && args.freshness === "authoritative"
    ? "exact"
    : "estimated";
}

// Base values mirror AionUi's modelContextLimits table. RAH keeps a few
// provider CLI aliases on top so terminal sessions can resolve the same window.
const GEMINI_CONTEXT_WINDOWS: Record<string, number> = {
  "auto-gemini-3": 1_048_576,
  "auto-gemini-2.5": 1_048_576,
  "gemini-3.1-pro-preview": 1_048_576,
  "gemini-3-pro-preview": 1_048_576,
  "gemini-3-flash-preview": 1_048_576,
  "gemini-3-pro-image-preview": 65_536,
  "gemini-3.1-flash-lite-preview": 1_048_576,
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-2.5-flash-lite": 1_048_576,
  "gemini-2.5-flash-image": 32_768,
  "gemini-2.0-flash": 1_048_576,
  "gemini-2.0-flash-lite": 1_048_576,
  "gemini-1.5-pro": 2_097_152,
  "gemini-1.5-flash": 1_048_576,
};

const CLAUDE_CONTEXT_WINDOWS: Record<string, number> = {
  "sonnet[1m]": 1_000_000,
  "opus[1m]": 1_000_000,
  "claude-sonnet-4.5": 1_000_000,
  "claude-sonnet-4": 1_000_000,
  "claude-opus-4.5": 200_000,
  "claude-haiku-4.5": 200_000,
  "claude-opus-4.1": 200_000,
  "claude-opus-4": 200_000,
  "claude-3.7-sonnet": 200_000,
  "claude-3.5-haiku": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-haiku": 200_000,
  haiku: 200_000,
};

const OPENAI_COMPAT_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.1-chat": 128_000,
  "gpt-5.1": 400_000,
  "gpt-5-chat": 128_000,
  "gpt-5": 400_000,
  "gpt-4o-mini": 128_000,
  "gpt-4o": 128_000,
  "gpt-4-turbo-preview": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "gpt-3.5-turbo-16k": 16_385,
  "gpt-3.5-turbo": 16_385,
  "o3-mini": 200_000,
  o3: 200_000,
  "o1-preview": 128_000,
  "o1-mini": 128_000,
  o1: 200_000,
};

export function knownModelContextWindow(args: {
  provider: ProviderKind;
  modelId?: string | null;
}): ModelContextWindowResolution | undefined {
  const modelId = normalizeModelId(args.modelId);
  if (args.provider === "gemini") {
    return {
      contextWindow:
        longestKnownMatch(modelId, GEMINI_CONTEXT_WINDOWS) ?? 1_048_576,
      precision: "estimated",
      source: "gemini.aionui_model_context_window",
    };
  }

  const table =
    args.provider === "claude"
      ? CLAUDE_CONTEXT_WINDOWS
      : args.provider === "custom"
        ? OPENAI_COMPAT_CONTEXT_WINDOWS
        : undefined;
  if (!table || !modelId) {
    return undefined;
  }
  const contextWindow = longestKnownMatch(modelId, table);
  return contextWindow
    ? {
        contextWindow,
        precision: "estimated",
        source: `${args.provider}.aionui_model_context_window`,
      }
    : undefined;
}

export function resolveModelContextWindow(args: {
  provider: ProviderKind;
  modelId?: string | null;
  catalog?: ProviderModelCatalog | null;
}): ModelContextWindowResolution | undefined {
  const modelId = args.modelId ?? args.catalog?.currentModelId ?? null;
  const profile = args.catalog?.modelProfiles?.find(
    (candidate) => candidate.modelId === modelId,
  );
  const profileWindow = positiveNumber(profile?.contextWindow);
  if (profileWindow !== undefined) {
    return {
      contextWindow: profileWindow,
      precision: catalogPrecision({
        provider: args.provider,
        freshness: profile?.freshness,
      }),
      source: `${args.provider}.model_profile.context_window`,
    };
  }

  const descriptor = args.catalog?.models.find((candidate) => candidate.id === modelId);
  const descriptorWindow = positiveNumber(descriptor?.contextWindow);
  if (descriptorWindow !== undefined) {
    return {
      contextWindow: descriptorWindow,
      precision: catalogPrecision({
        provider: args.provider,
        freshness: args.catalog?.freshness,
      }),
      source: `${args.provider}.model_descriptor.context_window`,
    };
  }

  return knownModelContextWindow({ provider: args.provider, modelId });
}

export function withModelContextWindow(
  usage: ContextUsage,
  resolution: ModelContextWindowResolution | undefined,
): ContextUsage {
  if (!resolution || usage.contextWindow !== undefined) {
    return usage;
  }
  return {
    ...usage,
    contextWindow: resolution.contextWindow,
    precision: usage.precision ?? resolution.precision,
    source: usage.source ?? resolution.source,
  };
}
