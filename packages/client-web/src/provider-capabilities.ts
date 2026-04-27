import type {
  ModelCapabilityProfile,
  ProviderModelCatalog,
  SessionSummary,
  SessionConfigOption,
  SessionConfigValue,
} from "@rah/runtime-protocol";

export type ConfigOptionPreviewRow = {
  id: string;
  label: string;
  kind: SessionConfigOption["kind"];
  applyTiming: SessionConfigOption["applyTiming"];
  source: SessionConfigOption["source"];
  currentValue: string | null;
  defaultValue: string | null;
  choiceCount: number;
};

export type CapabilityViewOrigin = "session-resolved" | "catalog-fallback" | "unavailable";
export type ConfigPreviewOrigin =
  | "session-resolved"
  | "catalog-profile"
  | "catalog-top-level"
  | "unavailable";

export function resolveEffectiveModelId(args: {
  summary?: SessionSummary | null | undefined;
  catalog?: ProviderModelCatalog | null | undefined;
  selectedModelId?: string | null | undefined;
}): string | null {
  return (
    args.selectedModelId ??
    args.summary?.session.model?.currentModelId ??
    args.catalog?.currentModelId ??
    null
  );
}

export function resolveCapabilityViewOriginLabel(
  origin: CapabilityViewOrigin,
): string {
  switch (origin) {
    case "session-resolved":
      return "runtime confirmed";
    case "catalog-fallback":
      return "preview only";
    case "unavailable":
      return "unavailable";
  }
}

export function resolveCapabilitySourceLabel(
  catalog: ProviderModelCatalog,
): string {
  return catalog.sourceDetail ?? catalog.source;
}

export function resolveCapabilityFreshnessLabel(
  catalog: ProviderModelCatalog,
): string | null {
  return catalog.freshness ?? null;
}

export function resolveCapabilityExactnessLabel(
  catalog: ProviderModelCatalog,
): string | null {
  if (catalog.modelsExact === true && catalog.optionsExact === true) {
    return "exact";
  }
  if (catalog.modelsExact === false || catalog.optionsExact === false) {
    return "provisional";
  }
  return null;
}

export function resolveActiveModelCapabilityProfile(args: {
  catalog: ProviderModelCatalog;
  summary?: SessionSummary | null | undefined;
  selectedModelId?: string | null | undefined;
}): ModelCapabilityProfile | null {
  const modelId = resolveEffectiveModelId(args);
  if (!modelId) {
    return null;
  }
  return (
    args.catalog.modelProfiles?.find((entry) => entry.modelId === modelId) ??
    null
  );
}

export function resolveVisibleConfigOptions(args: {
  catalog: ProviderModelCatalog;
  summary?: SessionSummary | null | undefined;
  selectedModelId?: string | null | undefined;
}): SessionConfigOption[] {
  const profile = resolveActiveModelCapabilityProfile(args);
  if (profile) {
    return profile.configOptions;
  }

  const modelId = resolveEffectiveModelId(args);
  const configOptions = args.catalog.configOptions ?? [];
  if (!modelId) {
    return configOptions;
  }

  return configOptions.filter((option) => {
    const modelIds = option.availability?.modelIds;
    return !modelIds || modelIds.includes(modelId);
  });
}

export function resolveVisibleConfigOptionLabels(args: {
  catalog: ProviderModelCatalog;
  summary?: SessionSummary | null | undefined;
  selectedModelId?: string | null | undefined;
}): string[] {
  return resolveVisibleConfigOptions(args).map((option) => option.label);
}

export function formatSessionConfigValue(
  value: SessionConfigValue | undefined,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? "on" : "off";
  }
  return String(value);
}

export function resolveConfigOptionPreviewRows(args: {
  catalog: ProviderModelCatalog;
  summary?: SessionSummary | null | undefined;
  selectedModelId?: string | null | undefined;
}): ConfigOptionPreviewRow[] {
  return resolveVisibleConfigOptions(args).map((option) => ({
    id: option.id,
    label: option.label,
    kind: option.kind,
    applyTiming: option.applyTiming,
    source: option.source,
    currentValue: formatSessionConfigValue(option.currentValue),
    defaultValue: formatSessionConfigValue(option.defaultValue),
    choiceCount: option.options?.length ?? 0,
  }));
}

export function resolveCapabilityCautionText(args: {
  catalog?: ProviderModelCatalog | null | undefined;
  summary?: SessionSummary | null | undefined;
}): string | null {
  if (resolveCapabilityViewOrigin(args) === "session-resolved") {
    return null;
  }
  const catalog = args.catalog;
  if (!catalog) {
    return null;
  }
  if (catalog.freshness === "provisional" || catalog.freshness === "stale") {
    return "Prelaunch capability view may change after the session starts.";
  }
  if (catalog.modelsExact === false || catalog.optionsExact === false) {
    return "Catalog is incomplete and may be refined by live session data.";
  }
  return null;
}

export function resolveSessionCapabilitySourceLabel(
  summary: SessionSummary | null | undefined,
): string | null {
  const source =
    summary?.session.modelProfile?.source ??
    summary?.session.config?.source ??
    null;
  return source;
}

export function resolveSessionCapabilityFreshnessLabel(
  summary: SessionSummary | null | undefined,
): string | null {
  return summary?.session.modelProfile?.freshness ?? null;
}

export function resolveCapabilityViewOrigin(args: {
  summary?: SessionSummary | null | undefined;
  catalog?: ProviderModelCatalog | null | undefined;
}): CapabilityViewOrigin {
  if (args.summary?.session.model || args.summary?.session.modelProfile || args.summary?.session.config) {
    return "session-resolved";
  }
  if (args.catalog) {
    return "catalog-fallback";
  }
  return "unavailable";
}

export function resolveConfigPreviewOrigin(args: {
  summary?: SessionSummary | null | undefined;
  catalog?: ProviderModelCatalog | null | undefined;
  selectedModelId?: string | null | undefined;
}): ConfigPreviewOrigin {
  if (args.summary?.session.modelProfile || args.summary?.session.config) {
    return "session-resolved";
  }
  if (args.catalog) {
    const profile = resolveActiveModelCapabilityProfile({
      catalog: args.catalog,
      summary: args.summary,
      selectedModelId: args.selectedModelId,
    });
    return profile ? "catalog-profile" : "catalog-top-level";
  }
  return "unavailable";
}

export function resolveConfigPreviewOriginLabel(origin: ConfigPreviewOrigin): string | null {
  switch (origin) {
    case "session-resolved":
      return "live option state";
    case "catalog-profile":
      return "catalog profile";
    case "catalog-top-level":
      return "catalog fallback";
    case "unavailable":
      return null;
  }
}

export function resolveCapabilityHeadline(args: {
  summary?: SessionSummary | null | undefined;
  catalog?: ProviderModelCatalog | null | undefined;
  selectedModelId?: string | null | undefined;
}): string | null {
  const capabilityOrigin = resolveCapabilityViewOrigin(args);
  const configOrigin = resolveConfigPreviewOrigin(args);

  if (capabilityOrigin === "session-resolved" && configOrigin === "session-resolved") {
    return "Model and advanced options are confirmed by the live session.";
  }
  if (capabilityOrigin === "session-resolved" && configOrigin === "catalog-profile") {
    return "Current model is confirmed by the live session. Advanced options are inferred from the provider catalog.";
  }
  if (capabilityOrigin === "session-resolved" && configOrigin === "catalog-top-level") {
    return "Current model is confirmed by the live session. Advanced options are shown from the provider catalog fallback.";
  }
  if (capabilityOrigin === "catalog-fallback") {
    return "Capability preview is based on prelaunch provider data.";
  }
  return null;
}

export function resolveSessionConfigPreviewRows(
  summary: SessionSummary | null | undefined,
): ConfigOptionPreviewRow[] {
  const profile = summary?.session.modelProfile;
  const values = summary?.session.config?.values ?? {};
  if (!profile) {
    return [];
  }
  return profile.configOptions.map((option) => ({
    id: option.id,
    label: option.label,
    kind: option.kind,
    applyTiming: option.applyTiming,
    source: option.source,
    currentValue: formatSessionConfigValue(
      values[option.id] ?? option.currentValue,
    ),
    defaultValue: formatSessionConfigValue(option.defaultValue),
    choiceCount: option.options?.length ?? 0,
  }));
}

export function resolveCapabilityExactnessDisplay(args: {
  catalog?: ProviderModelCatalog | null | undefined;
  summary?: SessionSummary | null | undefined;
}): string | null {
  if (args.summary?.session.modelProfile || args.summary?.session.config) {
    return null;
  }
  if (!args.catalog) {
    return null;
  }
  return resolveCapabilityExactnessLabel(args.catalog);
}
