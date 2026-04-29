import {
  formatRahConformanceReport,
  validateProviderModelCatalog,
} from "@rah/runtime-protocol";
import type {
  DebugScenarioDescriptor,
  DebugReplayScript,
  ProviderDiagnostic,
  ProviderKind,
  ProviderModelCatalog,
  ResumeSessionRequest,
  ResumeSessionResponse,
  StartSessionRequest,
  StartSessionResponse,
} from "@rah/runtime-protocol";
import { launchSpecForProvider, probeProviderDiagnostic } from "./provider-diagnostics";
import type { ProviderAdapter } from "./provider-adapter";
import type { HistorySnapshotStore } from "./history-snapshots";
import { defaultProviderModeId, providerModeDescriptors } from "./session-mode-utils";

type RuntimeProviderCoordinatorDeps = {
  adaptersByProvider: Map<string, ProviderAdapter>;
  adaptersById: Map<string, ProviderAdapter>;
  rememberSessionOwner: (sessionId: string, adapter: ProviderAdapter) => void;
  pruneOrphanSessions: () => void;
  historySnapshots: HistorySnapshotStore;
};

export class RuntimeProviderCoordinator {
  constructor(private readonly deps: RuntimeProviderCoordinatorDeps) {}

  private requireAdapterForProvider(provider: string): ProviderAdapter {
    const adapter = this.deps.adaptersByProvider.get(provider);
    if (!adapter) {
      throw new Error(`No adapter registered for provider ${provider}.`);
    }
    return adapter;
  }

  async listProviderDiagnostics(options?: { forceRefresh?: boolean }): Promise<ProviderDiagnostic[]> {
    const providers: ProviderKind[] = ["codex", "claude", "kimi", "gemini", "opencode"];
    return Promise.all(
      providers.map(async (provider) => {
        const adapter = this.deps.adaptersByProvider.get(provider);
        if (adapter?.getProviderDiagnostic) {
          return await adapter.getProviderDiagnostic(options);
        }
        const launchSpec = await launchSpecForProvider(provider);
        if (launchSpec) {
          return await probeProviderDiagnostic(provider, launchSpec, options);
        }
        return {
          provider,
          status: "launch_error" as const,
          launchCommand: "",
          detail: "Provider adapter is not implemented yet in this runtime.",
          auth: "provider_managed" as const,
          versionStatus: "unknown" as const,
        };
      }),
    );
  }

  async listProviderModels(
    provider: ProviderKind,
    options?: { cwd?: string; forceRefresh?: boolean },
  ): Promise<ProviderModelCatalog> {
    const adapter = this.deps.adaptersByProvider.get(provider);
    if (adapter?.listModels) {
      const catalog = await adapter.listModels(options);
      const report = validateProviderModelCatalog(catalog);
      if (!report.ok) {
        throw new Error(
          `Adapter ${adapter.id} returned invalid provider model catalog.\n${formatRahConformanceReport(report)}`,
        );
      }
      return catalog;
    }
    const defaultModeId = defaultProviderModeId(provider);
    const modes = providerModeDescriptors(provider);
    const catalog: ProviderModelCatalog = {
      provider,
      models: [],
      fetchedAt: new Date().toISOString(),
      source: "fallback",
      sourceDetail: "static_builtin",
      freshness: "stale",
      modelsExact: false,
      optionsExact: false,
      ...(defaultModeId ? { defaultModeId } : {}),
      ...(modes.length > 0 ? { modes } : {}),
    };
    const report = validateProviderModelCatalog(catalog);
    if (!report.ok) {
      throw new Error(
        `Fallback provider model catalog for ${provider} failed protocol validation.\n${formatRahConformanceReport(report)}`,
      );
    }
    return catalog;
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    this.deps.pruneOrphanSessions();
    const adapter = this.requireAdapterForProvider(request.provider);
    const response = await adapter.startSession(request);
    this.deps.rememberSessionOwner(response.session.session.id, adapter);
    return response;
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.deps.pruneOrphanSessions();
    const adapter = this.requireAdapterForProvider(request.provider);
    const response = await adapter.resumeSession(request);
    this.deps.rememberSessionOwner(response.session.session.id, adapter);
    if (
      request.historySourceSessionId &&
      request.historySourceSessionId !== response.session.session.id
    ) {
      this.deps.historySnapshots.transfer(
        request.historySourceSessionId,
        response.session.session.id,
      );
    }
    return response;
  }

  listScenarios(): DebugScenarioDescriptor[] {
    const adapter = this.deps.adaptersById.get("debug");
    return adapter?.listDebugScenarios?.() ?? [];
  }

  startScenario(args: {
    scenarioId: string;
    attach?: StartSessionRequest["attach"];
  }): StartSessionResponse {
    const adapter = this.deps.adaptersById.get("debug");
    if (!adapter?.startDebugScenario) {
      throw new Error("No debug adapter registered.");
    }
    const response = adapter.startDebugScenario(
      args.attach !== undefined
        ? { scenarioId: args.scenarioId, attach: args.attach }
        : { scenarioId: args.scenarioId },
    );
    this.deps.rememberSessionOwner(response.session.session.id, adapter);
    return response;
  }

  buildScenarioReplayScript(scenarioId: string): DebugReplayScript {
    const adapter = this.deps.adaptersById.get("debug");
    if (!adapter?.buildDebugScenarioReplayScript) {
      throw new Error("No debug adapter registered.");
    }
    return adapter.buildDebugScenarioReplayScript(scenarioId);
  }
}
