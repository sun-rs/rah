import type {
  ModelCapabilityProfile,
  ProviderModelCatalog,
  SessionModeDescriptor,
  SessionModelDescriptor,
  SessionModeRole,
} from "@rah/runtime-protocol";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { probeGeminiAcpCatalog, type GeminiAcpMode, type GeminiAcpModel } from "./gemini-acp-probe";
import { knownModelContextWindow } from "./model-context-window";
import { resolveConfiguredBinary } from "./provider-binary-utils";
import {
  buildGeminiModeDescriptorsFromHelp,
  defaultProviderModeId,
  providerModeDescriptors,
} from "./session-mode-utils";

const GEMINI_HELP_FETCH_TIMEOUT_MS = 2_000;
const GEMINI_ACP_PROBE_TIMEOUT_MS = 2_500;
const GEMINI_BACKGROUND_ACP_PROBE_TIMEOUT_MS = 15_000;
const GEMINI_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

const GEMINI_STATIC_MODEL_IDS = [
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
];

const GEMINI_MODELS: SessionModelDescriptor[] = GEMINI_STATIC_MODEL_IDS.map((id, index) => ({
  id,
  label: id,
  ...(index === 0 ? { isDefault: true } : {}),
}));

function profileRevision(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

function withContextWindow(model: SessionModelDescriptor): SessionModelDescriptor {
  const contextWindow = knownModelContextWindow({
    provider: "gemini",
    modelId: model.id,
  })?.contextWindow;
  return {
    ...model,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

function modelProfile(
  model: SessionModelDescriptor,
  args?: {
    source?: ModelCapabilityProfile["source"];
    freshness?: ModelCapabilityProfile["freshness"];
  },
): ModelCapabilityProfile {
  return {
    modelId: model.id,
    source: args?.source ?? "static_builtin",
    freshness: args?.freshness ?? "provisional",
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    configOptions: [],
  };
}

async function fetchGeminiModeDescriptorsFromHelp(): Promise<SessionModeDescriptor[]> {
  const binary = await resolveConfiguredBinary("RAH_GEMINI_BINARY", "gemini");
  const helpText = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      binary,
      ["--help"],
      { timeout: GEMINI_HELP_FETCH_TIMEOUT_MS, maxBuffer: 128_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(`${stdout}\n${stderr}`);
      },
    );
    child.stdin?.destroy();
  });
  return buildGeminiModeDescriptorsFromHelp(helpText);
}

function geminiModeRole(modeId: string): SessionModeRole {
  switch (modeId) {
    case "default":
      return "ask";
    case "auto_edit":
    case "autoEdit":
      return "auto_edit";
    case "yolo":
      return "full_auto";
    case "plan":
      return "plan";
    default:
      return "custom";
  }
}

function modeDescriptorFromAcp(mode: GeminiAcpMode): SessionModeDescriptor {
  return {
    id: mode.id,
    role: geminiModeRole(mode.id),
    label: mode.label,
    ...(mode.description ? { description: mode.description } : {}),
    applyTiming: "startup_only",
    hotSwitch: false,
  };
}

function modelDescriptorFromAcp(
  model: GeminiAcpModel,
  currentModelId: string | undefined,
): SessionModelDescriptor {
  return withContextWindow({
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(currentModelId === model.id ? { isDefault: true } : {}),
  });
}

function ensureCurrentModel(
  models: SessionModelDescriptor[],
  currentModelId: string | undefined,
): SessionModelDescriptor[] {
  if (!currentModelId) {
    return models;
  }
  if (models.some((model) => model.id === currentModelId)) {
    return models.map((model) => ({
      ...model,
      ...(model.id === currentModelId ? { isDefault: true } : { isDefault: false }),
    }));
  }
  return [
    withContextWindow({
      id: currentModelId,
      label: currentModelId,
      isDefault: true,
    }),
    ...models,
  ];
}

function buildGeminiStaticModelCatalog(args: {
  modes: SessionModeDescriptor[];
  fetchedAt?: string;
}): ProviderModelCatalog {
  const models = GEMINI_MODELS.map(withContextWindow);
  const currentModelId = models.find((model) => model.isDefault)?.id ?? models[0]?.id;
  const defaultModeId = defaultProviderModeId("gemini");
  return {
    provider: "gemini",
    ...(currentModelId ? { currentModelId } : {}),
    models,
    fetchedAt: args.fetchedAt ?? new Date().toISOString(),
    source: "static",
    sourceDetail: "static_builtin",
    freshness: "provisional",
    revision: "gemini-static-v2",
    modelsExact: false,
    optionsExact: false,
    ...(defaultModeId ? { defaultModeId } : {}),
    modes: args.modes,
    modelProfiles: models.map((model) => modelProfile(model)),
  };
}

function buildFastGeminiStaticModelCatalog(): ProviderModelCatalog {
  return buildGeminiStaticModelCatalog({
    modes: providerModeDescriptors("gemini"),
  });
}

function isAuthoritativeGeminiCatalog(catalog: ProviderModelCatalog): boolean {
  return catalog.source === "native" && catalog.freshness === "authoritative";
}

function buildGeminiAcpModelCatalog(args: {
  currentModelId?: string;
  models: GeminiAcpModel[];
  currentModeId?: string;
  modes: GeminiAcpMode[];
  fallbackModes: SessionModeDescriptor[];
}): ProviderModelCatalog | null {
  const acpModels = ensureCurrentModel(
    args.models.map((model) => modelDescriptorFromAcp(model, args.currentModelId)),
    args.currentModelId,
  );
  if (acpModels.length === 0) {
    return null;
  }
  const currentModelId =
    args.currentModelId ?? acpModels.find((model) => model.isDefault)?.id ?? acpModels[0]?.id;
  const modes = args.modes.length > 0
    ? args.modes.map(modeDescriptorFromAcp)
    : args.fallbackModes;
  const currentModeId = args.currentModeId ?? defaultProviderModeId("gemini");
  return {
    provider: "gemini",
    ...(currentModelId ? { currentModelId } : {}),
    models: acpModels,
    fetchedAt: new Date().toISOString(),
    source: "native",
    sourceDetail: "native_online",
    freshness: "authoritative",
    revision: `gemini-acp-${profileRevision({
      models: acpModels.map((model) => model.id),
      modes: modes.map((mode) => mode.id),
      currentModelId,
      currentModeId,
    })}`,
    modelsExact: true,
    optionsExact: true,
    ...(currentModeId ? { defaultModeId: currentModeId } : {}),
    modes,
    modelProfiles: acpModels.map((model) =>
      modelProfile(model, { source: "native_online", freshness: "authoritative" }),
    ),
  };
}

export async function buildGeminiModelCatalog(options?: {
  cwd?: string;
  acpProbeTimeoutMs?: number;
}): Promise<ProviderModelCatalog> {
  const cwd = options?.cwd ?? process.cwd();
  const acpResult = await probeGeminiAcpCatalog({
    cwd,
    timeoutMs: options?.acpProbeTimeoutMs ?? GEMINI_ACP_PROBE_TIMEOUT_MS,
  }).catch(() => null);
  if (acpResult) {
    const fallbackModes = acpResult.modes.length === 0
      ? await fetchGeminiModeDescriptorsFromHelp().catch(() => providerModeDescriptors("gemini"))
      : providerModeDescriptors("gemini");
    const acpCatalog = buildGeminiAcpModelCatalog({
      ...acpResult,
      fallbackModes,
    });
    if (acpCatalog) {
      return acpCatalog;
    }
  }
  const fallbackModes = await fetchGeminiModeDescriptorsFromHelp().catch(() =>
    providerModeDescriptors("gemini"),
  );
  return buildGeminiStaticModelCatalog({ modes: fallbackModes });
}

export class GeminiModelCatalogCache {
  private readonly cachedByKey = new Map<string, ProviderModelCatalog>();
  private readonly expiresAtByKey = new Map<string, number>();
  private readonly inFlightByKey = new Map<string, Promise<ProviderModelCatalog>>();

  async listModels(options?: {
    cwd?: string;
    forceRefresh?: boolean;
  }): Promise<ProviderModelCatalog> {
    const key = options?.cwd ?? "";
    const now = Date.now();
    const cached = this.cachedByKey.get(key) ?? null;
    if (
      !options?.forceRefresh &&
      cached &&
      now < (this.expiresAtByKey.get(key) ?? 0)
    ) {
      if (!isAuthoritativeGeminiCatalog(cached)) {
        this.refreshInBackground(key, options);
      }
      return cached;
    }

    if (options?.forceRefresh) {
      return await this.refresh(key, {
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        acpProbeTimeoutMs: GEMINI_BACKGROUND_ACP_PROBE_TIMEOUT_MS,
      });
    }

    if (cached) {
      this.refreshInBackground(key, options);
      return cached;
    }

    const fallback = this.remember(key, buildFastGeminiStaticModelCatalog());
    this.refreshInBackground(key, options);
    return fallback;
  }

  getCached(options?: { cwd?: string }): ProviderModelCatalog | null {
    return this.cachedByKey.get(options?.cwd ?? "") ?? null;
  }

  private remember(key: string, catalog: ProviderModelCatalog): ProviderModelCatalog {
    this.cachedByKey.set(key, catalog);
    this.expiresAtByKey.set(key, Date.now() + GEMINI_MODEL_CACHE_TTL_MS);
    return catalog;
  }

  private refreshInBackground(key: string, options?: { cwd?: string }): void {
    void this.refresh(key, {
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      acpProbeTimeoutMs: GEMINI_BACKGROUND_ACP_PROBE_TIMEOUT_MS,
    }).catch(() => undefined);
  }

  private async refresh(key: string, options?: {
    cwd?: string;
    acpProbeTimeoutMs?: number;
  }): Promise<ProviderModelCatalog> {
    const inFlight = this.inFlightByKey.get(key);
    if (inFlight) {
      return await inFlight;
    }
    let request!: Promise<ProviderModelCatalog>;
    request = buildGeminiModelCatalog(options)
      .then((catalog) => this.remember(key, catalog))
      .catch(() => this.remember(key, buildFastGeminiStaticModelCatalog()))
      .finally(() => {
        if (this.inFlightByKey.get(key) === request) {
          this.inFlightByKey.delete(key);
        }
      });
    this.inFlightByKey.set(key, request);
    return await request;
  }
}
