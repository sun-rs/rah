import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ModelCapabilityProfile,
  ProviderModelCatalog,
  SessionConfigOption,
  SessionModelDescriptor,
  SessionReasoningOption,
  SessionResolvedConfig,
} from "@rah/runtime-protocol";
import { resolveKimiCommand } from "./kimi-live-rpc";

const KIMI_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const KIMI_ACP_MODEL_TIMEOUT_MS = 8_000;
const KIMI_THINKING_SUFFIX = ",thinking";

type KimiAcpModelRecord = {
  modelId?: unknown;
  model_id?: unknown;
  id?: unknown;
  name?: unknown;
  label?: unknown;
  description?: unknown;
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function profileRevision(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

function splitKimiAcpModelId(modelId: string): {
  modelId: string;
  reasoningId: "default" | "thinking";
} {
  if (modelId.endsWith(KIMI_THINKING_SUFFIX)) {
    return {
      modelId: modelId.slice(0, -KIMI_THINKING_SUFFIX.length),
      reasoningId: "thinking",
    };
  }
  return { modelId, reasoningId: "default" };
}

function stripThinkingLabel(label: string): string {
  return label.replace(/\s*\(thinking\)\s*$/i, "").trim() || label;
}

function mapKimiAcpModel(entry: unknown): KimiAcpModelRecord | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  return entry as KimiAcpModelRecord;
}

function kimiReasoningOptions(args: {
  hasDefault: boolean;
  hasThinking: boolean;
}): SessionReasoningOption[] {
  const options: SessionReasoningOption[] = [];
  if (args.hasDefault) {
    options.push({
      id: "default",
      label: "No thinking",
      kind: "model_variant",
    });
  }
  if (args.hasThinking) {
    options.push({
      id: "thinking",
      label: "Thinking",
      kind: "thinking",
    });
  }
  return options;
}

function buildKimiThinkingConfigOption(args: {
  model: SessionModelDescriptor;
}): SessionConfigOption | null {
  const reasoningOptions = args.model.reasoningOptions ?? [];
  if (reasoningOptions.length === 0) {
    return null;
  }
  const defaultValue = args.model.defaultReasoningId ?? reasoningOptions[0]?.id;
  return {
    id: "model_thinking",
    label: "Thinking",
    description: "Kimi thinking variant for new turns.",
    kind: "select",
    scope: "model",
    source: "native_online",
    mutable: false,
    applyTiming: "restart_required",
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    options: reasoningOptions.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    availability: {
      modelIds: [args.model.id],
    },
    backendKey: "thinking",
  };
}

function buildKimiModelProfiles(models: SessionModelDescriptor[]): ModelCapabilityProfile[] {
  return models.map((model) => {
    const configOption = buildKimiThinkingConfigOption({ model });
    return {
      modelId: model.id,
      source: "native_online",
      freshness: "authoritative",
      traits: {
        ...(model.reasoningOptions?.some((option) => option.id === "thinking")
          ? { supportsThinking: true, supportsReasoningVariant: true }
          : {}),
      },
      configOptions: configOption ? [configOption] : [],
    };
  });
}

function buildKimiCatalog(args: {
  rawModels: unknown[];
  currentModelId?: string | null;
}): ProviderModelCatalog {
  const grouped = new Map<
    string,
    {
      label: string;
      description?: string;
      hasDefault: boolean;
      hasThinking: boolean;
    }
  >();
  for (const rawModel of args.rawModels) {
    const record = mapKimiAcpModel(rawModel);
    if (!record) {
      continue;
    }
    const rawModelId =
      asNonEmptyString(record.modelId) ??
      asNonEmptyString(record.model_id) ??
      asNonEmptyString(record.id);
    if (!rawModelId) {
      continue;
    }
    const split = splitKimiAcpModelId(rawModelId);
    const label = stripThinkingLabel(
      asNonEmptyString(record.name) ?? asNonEmptyString(record.label) ?? split.modelId,
    );
    const existing = grouped.get(split.modelId);
    grouped.set(split.modelId, {
      label: existing?.label ?? label,
      ...(existing?.description ?? asNonEmptyString(record.description)
        ? { description: existing?.description ?? asNonEmptyString(record.description)! }
        : {}),
      hasDefault: existing?.hasDefault === true || split.reasoningId === "default",
      hasThinking: existing?.hasThinking === true || split.reasoningId === "thinking",
    });
  }
  const current = args.currentModelId ? splitKimiAcpModelId(args.currentModelId) : null;
  const models = [...grouped.entries()].map(([modelId, entry]) => {
    const reasoningOptions = kimiReasoningOptions({
      hasDefault: entry.hasDefault,
      hasThinking: entry.hasThinking,
    });
    const defaultReasoningId = entry.hasDefault ? "default" : entry.hasThinking ? "thinking" : undefined;
    return {
      id: modelId,
      label: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
      ...(current?.modelId === modelId ? { isDefault: true } : {}),
      ...(reasoningOptions.length > 0
        ? {
            reasoningOptions,
            ...(defaultReasoningId ? { defaultReasoningId } : {}),
          }
        : {}),
    } satisfies SessionModelDescriptor;
  });
  const currentModel =
    (current?.modelId ? models.find((model) => model.id === current.modelId) : undefined) ??
    models.find((model) => model.isDefault) ??
    models[0];
  const currentReasoningId =
    current && currentModel?.id === current.modelId
      ? current.reasoningId
      : currentModel?.defaultReasoningId;
  return {
    provider: "kimi",
    ...(currentModel ? { currentModelId: currentModel.id } : {}),
    ...(currentReasoningId !== undefined ? { currentReasoningId } : {}),
    models,
    fetchedAt: new Date().toISOString(),
    source: "native",
    sourceDetail: "native_online",
    freshness: "authoritative",
    revision: profileRevision(
      models.map((model) => ({
        id: model.id,
        label: model.label,
        reasoningOptions: model.reasoningOptions?.map((option) => option.id) ?? [],
      })),
    ),
    modelsExact: true,
    optionsExact: true,
    modelProfiles: buildKimiModelProfiles(models),
  };
}

export function buildKimiFallbackModelCatalog(): ProviderModelCatalog {
  return {
    provider: "kimi",
    models: [],
    fetchedAt: new Date().toISOString(),
    source: "fallback",
    sourceDetail: "static_builtin",
    freshness: "stale",
    modelsExact: false,
    optionsExact: false,
    modelProfiles: [],
  };
}

function signalKimiAcpProcess(
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

export async function fetchKimiAcpModelCatalog(options?: {
  cwd?: string;
  timeoutMs?: number;
}): Promise<ProviderModelCatalog> {
  const cwd = options?.cwd ?? process.cwd();
  const timeoutMs = options?.timeoutMs ?? KIMI_ACP_MODEL_TIMEOUT_MS;
  const { command, args } = await resolveKimiCommand();

  return await new Promise<ProviderModelCatalog>((resolve, reject) => {
    const child = spawn(command, [...args, "acp"], {
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
      signalKimiAcpProcess(child, "SIGTERM");
      setTimeout(() => signalKimiAcpProcess(child, "SIGKILL"), 1_000).unref();
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
      fail(new Error("Kimi ACP model catalog request timed out."));
    }, timeoutMs);
    timeout.unref();

    const send = (id: number, method: string, params?: unknown) => {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        })}\n`,
        (error) => {
          if (error) {
            fail(error);
          }
        },
      );
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
            fail(new Error("Kimi ACP initialize failed."));
            return;
          }
          requestSession();
          continue;
        }
        if (message.id !== 2) {
          continue;
        }
        if (message.error) {
          fail(new Error("Kimi ACP session/new failed."));
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
        const availableModels = Array.isArray(rawModels.availableModels)
          ? rawModels.availableModels
          : [];
        if (availableModels.length === 0) {
          fail(new Error("Kimi ACP returned no models."));
          return;
        }
        succeed(
          buildKimiCatalog({
            rawModels: availableModels,
            currentModelId: asNonEmptyString(rawModels.currentModelId),
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
          `Kimi ACP exited before returning models (${code ?? "null"}/${signal ?? "null"})${suffix}`,
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

export function resolveKimiModelProfile(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string | null | undefined;
}): ModelCapabilityProfile | undefined {
  if (!args.catalog || !args.modelId) {
    return undefined;
  }
  return args.catalog.modelProfiles?.find((profile) => profile.modelId === args.modelId);
}

export function resolveKimiCliModelArgs(args: {
  modelId?: string | null | undefined;
  reasoningId?: string | null | undefined;
}): { model?: string; thinking?: boolean } {
  if (!args.modelId) {
    return {};
  }
  const split = splitKimiAcpModelId(args.modelId);
  const reasoningId = args.reasoningId ?? split.reasoningId;
  return {
    model: split.modelId,
    thinking: reasoningId === "thinking",
  };
}

export function buildKimiResolvedConfig(args: {
  reasoningId: string | null | undefined;
}): SessionResolvedConfig | undefined {
  if (args.reasoningId === undefined || args.reasoningId === null) {
    return undefined;
  }
  return {
    values: {
      model_thinking: args.reasoningId,
    },
    source: "runtime_session",
  };
}

export function resolveKimiRuntimeCapabilityState(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string | null | undefined;
  reasoningId: string | null | undefined;
}): {
  modelProfile?: ModelCapabilityProfile;
  config?: SessionResolvedConfig;
} {
  const modelProfile = resolveKimiModelProfile({
    catalog: args.catalog,
    modelId: args.modelId,
  });
  const config = buildKimiResolvedConfig({
    reasoningId: args.reasoningId,
  });
  return {
    ...(modelProfile ? { modelProfile } : {}),
    ...(config ? { config } : {}),
  };
}

export class KimiModelCatalogCache {
  private cached: ProviderModelCatalog | null = null;
  private inFlight: Promise<ProviderModelCatalog> | null = null;

  async listModels(options?: {
    cwd?: string;
    forceRefresh?: boolean;
  }): Promise<ProviderModelCatalog> {
    if (options?.forceRefresh) {
      return await this.refresh(options);
    }
    if (this.cached) {
      const ageMs = Date.now() - Date.parse(this.cached.fetchedAt);
      if (Number.isFinite(ageMs) && ageMs < KIMI_MODEL_CACHE_TTL_MS) {
        return this.cached;
      }
      void this.refresh(options).catch(() => undefined);
      return this.cached;
    }
    return await this.refresh(options);
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
        return this.remember(await fetchKimiAcpModelCatalog(options));
      } catch {
        return this.remember(buildKimiFallbackModelCatalog());
      } finally {
        this.inFlight = null;
      }
    })();
    return await this.inFlight;
  }
}
