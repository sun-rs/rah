import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ModelCapabilityProfile,
  ProviderModelCatalog,
  SessionModelDescriptor,
} from "@rah/runtime-protocol";
import { knownModelContextWindow } from "./model-context-window";
import { resolveConfiguredBinary } from "./provider-binary-utils";
import { defaultProviderModeId, providerModeDescriptors } from "./session-mode-utils";

const GEMINI_MODEL_DESCRIPTORS: SessionModelDescriptor[] = [
  {
    id: "auto-gemini-3",
    label: "Auto (Gemini 3)",
    description:
      "Let Gemini CLI choose the best Gemini 3 model for the task.",
    isDefault: true,
  },
  {
    id: "auto-gemini-2.5",
    label: "Auto (Gemini 2.5)",
    description:
      "Let Gemini CLI choose the best Gemini 2.5 model for the task.",
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "gemini-3.1-pro-preview",
    description: "Manual Gemini 3.1 Pro preview selection.",
  },
  {
    id: "gemini-3-flash-preview",
    label: "gemini-3-flash-preview",
    description: "Manual Gemini 3 Flash preview selection.",
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    label: "gemini-3.1-flash-lite-preview",
    description: "Manual Gemini 3.1 Flash Lite preview selection.",
  },
  {
    id: "gemini-2.5-pro",
    label: "gemini-2.5-pro",
    description: "Manual Gemini 2.5 Pro selection.",
  },
  {
    id: "gemini-2.5-flash",
    label: "gemini-2.5-flash",
    description: "Manual Gemini 2.5 Flash selection.",
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "gemini-2.5-flash-lite",
    description: "Manual Gemini 2.5 Flash Lite selection.",
  },
];

const GEMINI_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const GEMINI_ACP_MODEL_TIMEOUT_MS = 8_000;
const GEMINI_ONLINE_CATALOG_ENV = "RAH_GEMINI_ONLINE_MODEL_CATALOG";

function buildGeminiModelProfiles(
  models: SessionModelDescriptor[],
  source: ModelCapabilityProfile["source"],
  freshness: ModelCapabilityProfile["freshness"],
): ModelCapabilityProfile[] {
  return models.map((model) => {
    const contextWindow = model.contextWindow ?? geminiContextWindow(model.id);
    return {
      modelId: model.id,
      source,
      freshness,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      configOptions: [],
    };
  });
}

function profileRevision(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function geminiContextWindow(modelId: string): number | undefined {
  return knownModelContextWindow({ provider: "gemini", modelId })?.contextWindow;
}

export function normalizeGeminiModelId(value: string | null | undefined): string | null {
  const modelId = value?.trim();
  if (!modelId) {
    return null;
  }
  return modelId === "auto" ? "auto-gemini-3" : modelId;
}

function mapGeminiAcpModel(entry: unknown): SessionModelDescriptor | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const id =
    normalizeGeminiModelId(asNonEmptyString(record.modelId) ?? asNonEmptyString(record.model_id) ?? asNonEmptyString(record.id));
  if (!id) {
    return null;
  }
  const contextWindow = geminiContextWindow(id);
  return {
    id,
    label: asNonEmptyString(record.name) ?? asNonEmptyString(record.label) ?? id,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(asNonEmptyString(record.description)
      ? { description: asNonEmptyString(record.description)! }
      : {}),
  };
}

function buildGeminiCatalog(args: {
  models: SessionModelDescriptor[];
  currentModelId?: string | null;
  source: ProviderModelCatalog["source"];
  sourceDetail: NonNullable<ProviderModelCatalog["sourceDetail"]>;
  freshness: NonNullable<ProviderModelCatalog["freshness"]>;
  modelsExact: boolean;
  optionsExact: boolean;
}): ProviderModelCatalog {
  const currentModelId =
    normalizeGeminiModelId(args.currentModelId) ??
    args.models.find((model) => model.isDefault)?.id ??
    args.models[0]?.id;
  const models = args.models.map((model) => ({
    ...model,
    ...(model.id === currentModelId ? { isDefault: true } : {}),
  }));
  return {
    provider: "gemini",
    ...(currentModelId ? { currentModelId } : {}),
    models,
    fetchedAt: new Date().toISOString(),
    source: args.source,
    sourceDetail: args.sourceDetail,
    freshness: args.freshness,
    revision: profileRevision(
      models.map((descriptor) => ({
        id: descriptor.id,
        label: descriptor.label,
      })),
    ),
    modelsExact: args.modelsExact,
    optionsExact: args.optionsExact,
    defaultModeId: defaultProviderModeId("gemini")!,
    modes: providerModeDescriptors("gemini"),
    modelProfiles: buildGeminiModelProfiles(
      models,
      args.sourceDetail,
      args.freshness,
    ),
  };
}

export function buildGeminiModelCatalog(): ProviderModelCatalog {
  return buildGeminiCatalog({
    currentModelId: "auto-gemini-3",
    models: GEMINI_MODEL_DESCRIPTORS.map((descriptor) => ({ ...descriptor })),
    source: "static",
    sourceDetail: "static_builtin",
    freshness: "provisional",
    modelsExact: false,
    optionsExact: false,
  });
}

function signalGeminiAcpProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.exitCode !== null) {
    return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

async function resolveGeminiBinary(): Promise<string> {
  return await resolveConfiguredBinary("RAH_GEMINI_BINARY", "gemini");
}

export async function fetchGeminiAcpModelCatalog(options?: {
  cwd?: string;
  timeoutMs?: number;
}): Promise<ProviderModelCatalog> {
  const cwd = options?.cwd ?? process.cwd();
  const timeoutMs = options?.timeoutMs ?? GEMINI_ACP_MODEL_TIMEOUT_MS;
  const binary = await resolveGeminiBinary();

  return await new Promise<ProviderModelCatalog>((resolve, reject) => {
    const child = spawn(binary, ["--acp"], {
      cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let finished = false;

    const cleanup = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.stdin.off("error", onError);
      child.off("error", onError);
      child.off("exit", onExit);
      clearTimeout(timeout);
      signalGeminiAcpProcess(child, "SIGTERM");
      setTimeout(() => signalGeminiAcpProcess(child, "SIGKILL"), 1_000).unref();
    };
    const fail = (error: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      reject(error);
    };
    const succeed = (catalog: ProviderModelCatalog) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resolve(catalog);
    };
    const timeout = setTimeout(() => {
      fail(new Error("Gemini ACP model catalog request timed out."));
    }, timeoutMs);
    timeout.unref();

    const send = (id: number, method: string, params?: unknown) => {
      const payload = `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      })}\n`;
      child.stdin.write(payload, (error) => {
        if (error) {
          fail(error);
        }
      });
    };
    const requestSession = () => {
      send(2, "session/new", {
        cwd,
        mcpServers: [],
        additionalDirectories: [],
      });
    };

    function onStdout(chunk: Buffer | string) {
      stdoutBuffer += chunk.toString();
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        const message = parsed as Record<string, unknown>;
        if (message.id === 1) {
          if (message.error) {
            fail(new Error("Gemini ACP initialize failed."));
            return;
          }
          requestSession();
          continue;
        }
        if (message.id !== 2) {
          continue;
        }
        if (message.error) {
          fail(new Error("Gemini ACP session/new failed."));
          return;
        }
        const result =
          message.result && typeof message.result === "object" && !Array.isArray(message.result)
            ? (message.result as Record<string, unknown>)
            : {};
        const rawModels =
          result.models && typeof result.models === "object" && !Array.isArray(result.models)
            ? (result.models as Record<string, unknown>)
            : {};
        const models = Array.isArray(rawModels.availableModels)
          ? rawModels.availableModels.flatMap((entry) => {
              const model = mapGeminiAcpModel(entry);
              return model ? [model] : [];
            })
          : [];
        if (models.length === 0) {
          fail(new Error("Gemini ACP returned no models."));
          return;
        }
        succeed(
          buildGeminiCatalog({
            currentModelId: asNonEmptyString(rawModels.currentModelId),
            models,
            source: "native",
            sourceDetail: "native_online",
            freshness: "authoritative",
            modelsExact: true,
            optionsExact: false,
          }),
        );
      }
    }
    function onStderr(chunk: Buffer | string) {
      stderrBuffer = (stderrBuffer + chunk.toString()).slice(-8192);
    }
    function onError(error: Error) {
      fail(error);
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      const suffix = stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : "";
      fail(
        new Error(
          `Gemini ACP exited before returning models (${code ?? "null"}/${signal ?? "null"})${suffix}`,
        ),
      );
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdin.on("error", onError);
    child.once("error", onError);
    child.once("exit", onExit);
    send(1, "initialize", {
      protocolVersion: 1,
      clientInfo: { name: "RAH", version: "1.0.0" },
      clientCapabilities: {},
    });
  });
}

export function resolveGeminiModelProfile(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string | null | undefined;
}): ModelCapabilityProfile | undefined {
  if (!args.catalog || !args.modelId) {
    return undefined;
  }
  return args.catalog.modelProfiles?.find((profile) => profile.modelId === args.modelId);
}

export function resolveGeminiRuntimeCapabilityState(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string | null | undefined;
}): {
  modelProfile?: ModelCapabilityProfile;
} {
  const modelProfile = resolveGeminiModelProfile({
    catalog: args.catalog,
    modelId: args.modelId,
  });
  return {
    ...(modelProfile ? { modelProfile } : {}),
  };
}

export class GeminiModelCatalogCache {
  private cached: ProviderModelCatalog | null = null;
  private inFlight: Promise<ProviderModelCatalog> | null = null;

  async listModels(options?: {
    cwd?: string;
    forceRefresh?: boolean;
  }): Promise<ProviderModelCatalog> {
    if (process.env[GEMINI_ONLINE_CATALOG_ENV] !== "1") {
      return this.remember(buildGeminiModelCatalog());
    }
    if (options?.forceRefresh) {
      return await this.refresh(options);
    }
    if (!options?.forceRefresh && this.cached) {
      const ageMs = Date.now() - Date.parse(this.cached.fetchedAt);
      if (Number.isFinite(ageMs) && ageMs < GEMINI_MODEL_CACHE_TTL_MS) {
        return this.cached;
      }
      void this.refresh(options).catch(() => undefined);
      return this.cached;
    }
    const fallback = this.remember(buildGeminiModelCatalog());
    void this.refresh(options).catch(() => undefined);
    return fallback;
  }

  getCached(): ProviderModelCatalog | null {
    return this.cached;
  }

  remember(catalog: ProviderModelCatalog): ProviderModelCatalog {
    this.cached = catalog;
    return catalog;
  }

  private async refresh(options?: { cwd?: string }): Promise<ProviderModelCatalog> {
    if (this.inFlight) {
      return await this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        return this.remember(
          await fetchGeminiAcpModelCatalog(options?.cwd ? { cwd: options.cwd } : undefined),
        );
      } catch {
        return this.remember(buildGeminiModelCatalog());
      } finally {
        this.inFlight = null;
      }
    })();
    return await this.inFlight;
  }
}
