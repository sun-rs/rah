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
import {
  launchSpecForProvider,
  probeProviderDiagnostic,
  type CoreLiveDiagnosticProvider,
} from "../provider-diagnostics";
import type {
  ProviderCapabilityView,
  ProviderDebugAdapter,
  ProviderDiagnosticAdapter,
  ProviderEnhancedModelAdapter,
  ProviderStructuredLifecycleAdapter,
} from "../provider-adapter";
import type { HistorySnapshotStore } from "../history-snapshots";
import { defaultProviderModeId, providerModeDescriptors } from "../session-mode-utils";
import { assertExistingWorkingDirectory } from "../provider-working-directory";

type ProviderModelAdapter = ProviderCapabilityView<ProviderEnhancedModelAdapter>;
type ProviderDiagnosticCapabilityAdapter = ProviderCapabilityView<ProviderDiagnosticAdapter>;
type ProviderDebugCapabilityAdapter = ProviderCapabilityView<ProviderDebugAdapter>;
type ProviderStructuredLiveAdapter = ProviderCapabilityView<ProviderStructuredLifecycleAdapter>;
type StructuredSessionOwnerProvider = StartSessionResponse["session"]["session"]["provider"];

type RuntimeStructuredProviderCoordinatorDeps = {
  structuredLiveAdaptersByProvider: Map<string, ProviderStructuredLiveAdapter>;
  modelAdaptersByProvider: Map<string, ProviderModelAdapter>;
  diagnosticAdaptersByProvider: Map<string, ProviderDiagnosticCapabilityAdapter>;
  debugAdaptersById: Map<string, ProviderDebugCapabilityAdapter>;
  rememberStructuredSessionOwner: (sessionId: string, provider: StructuredSessionOwnerProvider) => void;
  pruneOrphanSessions: () => void;
  historySnapshots: HistorySnapshotStore;
};

/**
 * Explicit legacy/enhancement coordinator for the old structured live path.
 *
 * PTY-first live start/resume bypasses this class and goes through
 * RuntimeTerminalCoordinator + NativeTuiProviderRuntime. This coordinator remains
 * for stored-history catalogs, diagnostics, debug scenarios, and explicit
 * liveBackend: "structured" requests.
 */
export class RuntimeStructuredProviderCoordinator {
  constructor(private readonly deps: RuntimeStructuredProviderCoordinatorDeps) {}

  private requireStructuredAdapterForProvider(provider: string): ProviderStructuredLiveAdapter {
    const adapter = this.deps.structuredLiveAdaptersByProvider.get(provider);
    if (!adapter) {
      throw new Error(`No structured live adapter registered for provider ${provider}.`);
    }
    return adapter;
  }

  private requireStructuredLifecycleAdapter(
    provider: string,
    capability: "startSession" | "resumeSession",
  ): ProviderCapabilityView<Required<Pick<ProviderStructuredLifecycleAdapter, typeof capability>>> {
    const adapter = this.requireStructuredAdapterForProvider(provider);
    if (typeof adapter[capability] !== "function") {
      throw new Error(`Provider ${provider} does not support structured ${capability}.`);
    }
    return adapter as ProviderCapabilityView<
      Required<Pick<ProviderStructuredLifecycleAdapter, typeof capability>>
    >;
  }

  async listProviderDiagnostics(options?: { forceRefresh?: boolean }): Promise<ProviderDiagnostic[]> {
    const providers: CoreLiveDiagnosticProvider[] = ["codex", "claude", "opencode"];
    return Promise.all(
      providers.map(async (provider) => {
        const adapter = this.deps.diagnosticAdaptersByProvider.get(provider);
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
    const adapter = this.deps.modelAdaptersByProvider.get(provider);
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
    await assertExistingWorkingDirectory(request.cwd, "Session working directory");
    this.deps.pruneOrphanSessions();
    const adapter = this.requireStructuredLifecycleAdapter(request.provider, "startSession");
    const response = await adapter.startSession(request);
    this.deps.rememberStructuredSessionOwner(
      response.session.session.id,
      response.session.session.provider,
    );
    return response;
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (request.preferStoredReplay !== true && request.cwd) {
      await assertExistingWorkingDirectory(request.cwd, "Session working directory");
    }
    this.deps.pruneOrphanSessions();
    const adapter = this.requireStructuredLifecycleAdapter(request.provider, "resumeSession");
    const response = await adapter.resumeSession(request);
    this.deps.rememberStructuredSessionOwner(
      response.session.session.id,
      response.session.session.provider,
    );
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
    const adapter = this.deps.debugAdaptersById.get("debug");
    return adapter?.listDebugScenarios?.() ?? [];
  }

  startScenario(args: {
    scenarioId: string;
    attach?: StartSessionRequest["attach"];
  }): StartSessionResponse {
    const adapter = this.deps.debugAdaptersById.get("debug");
    if (!adapter?.startDebugScenario) {
      throw new Error("No debug adapter registered.");
    }
    const response = adapter.startDebugScenario(
      args.attach !== undefined
        ? { scenarioId: args.scenarioId, attach: args.attach }
        : { scenarioId: args.scenarioId },
    );
    this.deps.rememberStructuredSessionOwner(
      response.session.session.id,
      response.session.session.provider,
    );
    return response;
  }

  buildScenarioReplayScript(scenarioId: string): DebugReplayScript {
    const adapter = this.deps.debugAdaptersById.get("debug");
    if (!adapter?.buildDebugScenarioReplayScript) {
      throw new Error("No debug adapter registered.");
    }
    return adapter.buildDebugScenarioReplayScript(scenarioId);
  }
}
