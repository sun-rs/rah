import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ManualProviderModel,
  NativeTuiDiagnostic,
  ProviderDiagnostic,
  ProviderModelCatalog,
  PtySessionStats,
  TuiMuxSessionDiagnostic,
} from "@rah/runtime-protocol";
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, Cpu, Info, ListRestart, LoaderCircle, MessageSquareText, Palette, Plus, RefreshCw, TerminalSquare, Waypoints, XCircle } from "lucide-react";
import {
  addManualProviderModel,
  closeTuiMuxSession,
  deleteManualProviderModel,
  listManualProviderModels,
  listNativeTuiDiagnostics,
  listProviderModels,
  listProviders,
  listPtyStats,
  listTuiMuxDiagnostics,
} from "../api";
import { providerLabel } from "../types";
import { nativeTuiDiagnosticLabel } from "../native-tui-diagnostics-ui";
import {
  comparePtyRuntimeHealth,
  formatPtyBytes,
  formatSignedCount,
  formatSignedPtyBytes,
  sortPtyStatsForDisplay,
  summarizePtyRuntimeHealth,
} from "../settings-runtime-health";
import { ProviderLogo } from "./ProviderLogo";
import { ModelCatalogList, ModelSourceBadge } from "./SessionModelControls";
import { ThemeToggle } from "./ThemeToggle";
import { OverlayScrollArea } from "./OverlayScrollArea";
import { useChatPreferences } from "../hooks/useChatPreferences";
import { useBrowserNotificationSettings } from "../browser-notifications";
import type { ProviderChoice } from "./ProviderSelector";
import { useSessionStore } from "../useSessionStore";

type SettingsTab = "chat" | "models" | "status" | "appearance" | "version" | "about";

const TABS: { id: SettingsTab; label: string; icon: typeof Palette }[] = [
  { id: "chat", label: "Chat", icon: MessageSquareText },
  { id: "models", label: "Models", icon: Cpu },
  { id: "status", label: "Status", icon: Activity },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "version", label: "Version", icon: Waypoints },
  { id: "about", label: "About", icon: Info },
];

const MODEL_PROVIDERS: ProviderChoice[] = ["codex", "claude", "gemini", "opencode"];
const MODEL_REFRESH_STATUS_RESET_MS = 2400;
const MODEL_REFRESH_POLL_INTERVAL_MS = 1000;
const MODEL_REFRESH_POLL_ATTEMPTS = 20;
const SETTINGS_REFRESH_BUTTON_CLASS =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-60 sm:h-auto sm:w-auto sm:gap-1.5 sm:px-2 sm:py-1";

type ModelRefreshStatus = "idle" | "loading" | "success" | "error";
type ModelRefreshState = {
  status: ModelRefreshStatus;
  error?: string;
};
type ManualModelFormState = {
  modelId: string;
  options: string;
};
type ManualModelActionState = {
  loading?: boolean;
  error?: string;
};

function emptyManualModelForm(): ManualModelFormState {
  return {
    modelId: "",
    options: "",
  };
}

function formatDiagnosticElapsed(elapsedMs: number | undefined): string | null {
  if (elapsedMs === undefined) {
    return null;
  }
  if (elapsedMs < 1000) {
    return `${elapsedMs}ms`;
  }
  return `${Math.round(elapsedMs / 1000)}s`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isAuthoritativeModelCatalog(catalog: ProviderModelCatalog): boolean {
  return catalog.source === "native" && catalog.freshness !== "stale";
}

function formatRefreshTimestamp(value: string | undefined): string {
  if (!value) {
    return "Never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Never";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function catalogTimestampMs(catalog: ProviderModelCatalog | null | undefined): number {
  if (!catalog?.fetchedAt) {
    return 0;
  }
  const time = Date.parse(catalog.fetchedAt);
  return Number.isNaN(time) ? 0 : time;
}

function newestModelCatalog(
  localCatalog: ProviderModelCatalog | null | undefined,
  storeCatalog: ProviderModelCatalog | null | undefined,
): ProviderModelCatalog | undefined {
  if (!localCatalog) {
    return storeCatalog ?? undefined;
  }
  if (!storeCatalog) {
    return localCatalog;
  }
  return catalogTimestampMs(storeCatalog) > catalogTimestampMs(localCatalog)
    ? storeCatalog
    : localCatalog;
}

function newestTimestamp(...values: Array<string | null | undefined>): string | undefined {
  let newest: string | undefined;
  let newestMs = 0;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const time = Date.parse(value);
    if (Number.isNaN(time) || time < newestMs) {
      continue;
    }
    newest = value;
    newestMs = time;
  }
  return newest;
}

function parseManualOptionIds(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[,\s]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      if (seen.has(entry)) {
        return false;
      }
      seen.add(entry);
      return true;
    });
}

function manualModelIsActive(catalog: ProviderModelCatalog | undefined, modelId: string): boolean {
  return catalog?.modelProfiles?.some(
    (profile) => profile.modelId === modelId && profile.source === "cached_runtime",
  ) === true;
}

function providerSupportsManualOptions(provider: ProviderChoice): boolean {
  return provider !== "gemini";
}

export function SettingsPane() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("chat");
  const workspaceDir = useSessionStore((state) => state.workspaceDir);
  const loadProviderModels = useSessionStore((state) => state.loadProviderModels);
  const rememberProviderModelCatalog = useSessionStore((state) => state.rememberProviderModelCatalog);
  const {
    hideToolCallsInChat,
    setHideToolCallsInChat,
    hideOpenCodeReasoningInChat,
    setHideOpenCodeReasoningInChat,
    hideGeminiReasoningInChat,
    setHideGeminiReasoningInChat,
    showModelInfoInChat,
    setShowModelInfoInChat,
  } = useChatPreferences();
  const browserNotifications = useBrowserNotificationSettings();
  const [providerDiagnostics, setProviderDiagnostics] = useState<ProviderDiagnostic[]>([]);
  const [modelCatalogs, setModelCatalogs] = useState<Partial<Record<ProviderChoice, ProviderModelCatalog>>>({});
  const storeModelCatalogs = useSessionStore((state) => state.modelCatalogs);
  const [manualModels, setManualModels] = useState<Partial<Record<ProviderChoice, ManualProviderModel[]>>>({});
  const [modelRefreshStates, setModelRefreshStates] = useState<Partial<Record<ProviderChoice, ModelRefreshState>>>({});
  const [expandedModelProviders, setExpandedModelProviders] =
    useState<Partial<Record<ProviderChoice, boolean>>>({});
  const [manualModelForms, setManualModelForms] = useState<Record<ProviderChoice, ManualModelFormState>>(() => ({
    codex: emptyManualModelForm(),
    claude: emptyManualModelForm(),
    gemini: emptyManualModelForm(),
    opencode: emptyManualModelForm(),
  }));
  const [manualModelActions, setManualModelActions] = useState<Partial<Record<ProviderChoice, ManualModelActionState>>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [providerDiagnosticsError, setProviderDiagnosticsError] = useState<string | null>(null);
  const [providerDiagnosticsLoading, setProviderDiagnosticsLoading] = useState(false);
  const [providerDiagnosticsLoaded, setProviderDiagnosticsLoaded] = useState(false);
  const [runtimeDiagnosticsError, setRuntimeDiagnosticsError] = useState<string | null>(null);
  const [runtimeDiagnosticsLoading, setRuntimeDiagnosticsLoading] = useState(false);
  const [runtimeDiagnosticsLoaded, setRuntimeDiagnosticsLoaded] = useState(false);
  const [nativeTuiDiagnostics, setNativeTuiDiagnostics] = useState<NativeTuiDiagnostic[]>([]);
  const [ptyStats, setPtyStats] = useState<PtySessionStats[]>([]);
  const [tuiMuxDiagnostics, setTuiMuxDiagnostics] = useState<TuiMuxSessionDiagnostic[]>([]);
  const [closingTuiMuxSessionNames, setClosingTuiMuxSessionNames] = useState<Set<string>>(() => new Set());
  const ptyStatsRef = useRef<PtySessionStats[] | null>(null);
  const [previousPtyStats, setPreviousPtyStats] = useState<PtySessionStats[] | null>(null);
  const mountedRef = useRef(true);
  const modelRefreshResetTimersRef = useRef<Partial<Record<ProviderChoice, number>>>({});

  const sortedProviderDiagnostics = useMemo(
    () => [...providerDiagnostics].sort((left, right) => left.provider.localeCompare(right.provider)),
    [providerDiagnostics],
  );
  const sortedNativeTuiDiagnostics = useMemo(
    () => [...nativeTuiDiagnostics].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    ),
    [nativeTuiDiagnostics],
  );
  const ptyRuntimeHealth = useMemo(() => summarizePtyRuntimeHealth(ptyStats), [ptyStats]);
  const ptyRuntimeTrend = useMemo(
    () => comparePtyRuntimeHealth(previousPtyStats, ptyStats),
    [previousPtyStats, ptyStats],
  );
  const sortedPtyStats = useMemo(() => sortPtyStatsForDisplay(ptyStats), [ptyStats]);
  const sortedTuiMuxDiagnostics = useMemo(
    () => [...tuiMuxDiagnostics].sort((left, right) => left.sessionName.localeCompare(right.sessionName)),
    [tuiMuxDiagnostics],
  );
  const unmanagedTuiMuxDiagnostics = useMemo(
    () =>
      sortedTuiMuxDiagnostics.filter(
        (session) => !session.managedSessionId && session.sessionName.startsWith("rah-"),
      ),
    [sortedTuiMuxDiagnostics],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const timer of Object.values(modelRefreshResetTimersRef.current)) {
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
      }
      modelRefreshResetTimersRef.current = {};
    };
  }, []);

  function rememberModelCatalog(provider: ProviderChoice, catalog: ProviderModelCatalog): void {
    setModelCatalogs((current) => ({ ...current, [provider]: catalog }));
    rememberProviderModelCatalog(provider, catalog);
  }

  function setProviderRefreshState(provider: ProviderChoice, state: ModelRefreshState): void {
    setModelRefreshStates((current) => ({ ...current, [provider]: state }));
  }

  function scheduleRefreshStateReset(provider: ProviderChoice): void {
    const existing = modelRefreshResetTimersRef.current[provider];
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }
    modelRefreshResetTimersRef.current[provider] = window.setTimeout(() => {
      if (mountedRef.current) {
        setProviderRefreshState(provider, { status: "idle" });
      }
      delete modelRefreshResetTimersRef.current[provider];
    }, MODEL_REFRESH_STATUS_RESET_MS);
  }

  async function waitForAuthoritativeCatalog(
    provider: ProviderChoice,
    initialCatalog: ProviderModelCatalog,
  ): Promise<ProviderModelCatalog> {
    let latest = initialCatalog;
    if (isAuthoritativeModelCatalog(latest)) {
      return latest;
    }
    for (let attempt = 0; attempt < MODEL_REFRESH_POLL_ATTEMPTS; attempt += 1) {
      await delay(MODEL_REFRESH_POLL_INTERVAL_MS);
      latest = await listProviderModels(provider, {
        ...(workspaceDir ? { cwd: workspaceDir } : {}),
      });
      if (isAuthoritativeModelCatalog(latest)) {
        return latest;
      }
    }
    return latest;
  }

  async function loadModelProvider(provider: ProviderChoice, forceRefresh = false): Promise<ProviderModelCatalog> {
    const catalog = await listProviderModels(provider, {
      ...(workspaceDir ? { cwd: workspaceDir } : {}),
      ...(forceRefresh ? { forceRefresh: true } : {}),
    });
    const manual = await listManualProviderModels(provider);
    if (mountedRef.current) {
      rememberModelCatalog(provider, catalog);
      void loadProviderModels(provider, {
        ...(workspaceDir ? { cwd: workspaceDir } : {}),
        background: true,
        reason: "settings-models-tab",
      }).catch(() => undefined);
      setManualModels((current) => ({ ...current, [provider]: manual }));
    }
    return catalog;
  }

  async function loadModelsTabData(): Promise<void> {
    setModelsLoading(true);
    setModelsError(null);
    const results = await Promise.allSettled(MODEL_PROVIDERS.map((provider) => loadModelProvider(provider)));
    if (!mountedRef.current) {
      return;
    }
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length > 0) {
      setModelsError(`Failed to load ${failed.length} provider model catalog${failed.length === 1 ? "" : "s"}.`);
    }
    setModelsLoaded(true);
    setModelsLoading(false);
  }

  async function refreshProviderModelCatalog(provider: ProviderChoice): Promise<void> {
    setProviderRefreshState(provider, { status: "loading" });
    setModelsError(null);
    try {
      const initialCatalog = await listProviderModels(provider, {
        ...(workspaceDir ? { cwd: workspaceDir } : {}),
        forceRefresh: true,
      });
      const catalog = await waitForAuthoritativeCatalog(provider, initialCatalog);
      const manual = await listManualProviderModels(provider);
      if (!mountedRef.current) {
        return;
      }
      rememberModelCatalog(provider, catalog);
      void loadProviderModels(provider, {
        ...(workspaceDir ? { cwd: workspaceDir } : {}),
        background: true,
        reason: "settings-model-refresh",
        staleMs: 0,
      }).catch(() => undefined);
      setManualModels((current) => ({ ...current, [provider]: manual }));
      if (!isAuthoritativeModelCatalog(catalog)) {
        setProviderRefreshState(provider, {
          status: "error",
          error: "Probe returned the fallback catalog.",
        });
      } else {
        setProviderRefreshState(provider, { status: "success" });
      }
      scheduleRefreshStateReset(provider);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setProviderRefreshState(provider, {
        status: "error",
        error: errorMessage(error, "Failed to refresh model catalog."),
      });
      scheduleRefreshStateReset(provider);
    }
  }

  function updateManualModelForm(provider: ProviderChoice, patch: Partial<ManualModelFormState>): void {
    setManualModelForms((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        ...patch,
      },
    }));
  }

  async function addManualModel(provider: ProviderChoice): Promise<void> {
    const form = manualModelForms[provider];
    const modelId = form.modelId.trim();
    if (!modelId) {
      setManualModelActions((current) => ({
        ...current,
        [provider]: { error: "Model id is required." },
      }));
      return;
    }
    const catalog = modelCatalogs[provider];
    const manual = manualModels[provider] ?? [];
    if (catalog?.models.some((model) => model.id === modelId) || manual.some((model) => model.id === modelId)) {
      setManualModelActions((current) => ({
        ...current,
        [provider]: { error: "That model id already exists." },
      }));
      return;
    }
    setManualModelActions((current) => ({ ...current, [provider]: { loading: true } }));
    try {
      const response = await addManualProviderModel(provider, {
        id: modelId,
        ...(providerSupportsManualOptions(provider)
          ? { optionIds: parseManualOptionIds(form.options) }
          : {}),
        ...(workspaceDir ? { cwd: workspaceDir } : {}),
      });
      const nextManualModels = await listManualProviderModels(provider);
      if (!mountedRef.current) {
        return;
      }
      rememberModelCatalog(provider, response.catalog);
      void loadProviderModels(provider, {
        ...(workspaceDir ? { cwd: workspaceDir } : {}),
        background: true,
        reason: "settings-manual-model-add",
        staleMs: 0,
      }).catch(() => undefined);
      setManualModels((current) => ({ ...current, [provider]: nextManualModels }));
      setManualModelForms((current) => ({ ...current, [provider]: emptyManualModelForm() }));
      setManualModelActions((current) => ({ ...current, [provider]: {} }));
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setManualModelActions((current) => ({
        ...current,
        [provider]: { error: errorMessage(error, "Failed to add manual model.") },
      }));
    }
  }

  async function deleteManualModel(provider: ProviderChoice, modelId: string): Promise<void> {
    setManualModelActions((current) => ({ ...current, [provider]: { loading: true } }));
    try {
      const response = await deleteManualProviderModel(provider, modelId, {
        ...(workspaceDir ? { cwd: workspaceDir } : {}),
      });
      const nextManualModels = await listManualProviderModels(provider);
      if (!mountedRef.current) {
        return;
      }
      rememberModelCatalog(provider, response.catalog);
      void loadProviderModels(provider, {
        ...(workspaceDir ? { cwd: workspaceDir } : {}),
        background: true,
        reason: "settings-manual-model-delete",
        staleMs: 0,
      }).catch(() => undefined);
      setManualModels((current) => ({ ...current, [provider]: nextManualModels }));
      setManualModelActions((current) => ({ ...current, [provider]: {} }));
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setManualModelActions((current) => ({
        ...current,
        [provider]: { error: errorMessage(error, "Failed to delete manual model.") },
      }));
    }
  }

  async function loadVersionDiagnostics(forceRefresh = false, signal?: AbortSignal) {
    setProviderDiagnosticsLoading(true);
    setProviderDiagnosticsError(null);
    try {
      const providers = await listProviders({
        forceRefresh,
        ...(signal ? { signal } : {}),
      });
      setProviderDiagnostics(providers);
      setProviderDiagnosticsLoaded(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setProviderDiagnosticsError(errorMessage(error, "Failed to load provider versions."));
    } finally {
      setProviderDiagnosticsLoading(false);
    }
  }

  async function loadStatusDiagnostics(signal?: AbortSignal) {
    setRuntimeDiagnosticsLoading(true);
    setRuntimeDiagnosticsError(null);
    try {
      const [nativeDiagnosticsResult, terminalStatsResult, tuiMuxDiagnosticsResult] =
        await Promise.allSettled([
          listNativeTuiDiagnostics({
            ...(signal ? { signal } : {}),
          }),
          listPtyStats({
            ...(signal ? { signal } : {}),
          }),
          listTuiMuxDiagnostics({
            ...(signal ? { signal } : {}),
          }),
        ]);

      for (const result of [nativeDiagnosticsResult, terminalStatsResult, tuiMuxDiagnosticsResult]) {
        if (
          result.status === "rejected" &&
          result.reason instanceof DOMException &&
          result.reason.name === "AbortError"
        ) {
          return;
        }
      }
      const errors: string[] = [];
      if (nativeDiagnosticsResult.status === "fulfilled") {
        setNativeTuiDiagnostics(nativeDiagnosticsResult.value);
      } else {
        errors.push(errorMessage(nativeDiagnosticsResult.reason, "Failed to load native TUI diagnostics."));
      }
      if (terminalStatsResult.status === "fulfilled") {
        setPreviousPtyStats(ptyStatsRef.current);
        setPtyStats(terminalStatsResult.value);
        ptyStatsRef.current = terminalStatsResult.value;
      } else {
        errors.push(errorMessage(terminalStatsResult.reason, "Failed to load PTY stats."));
      }
      if (tuiMuxDiagnosticsResult.status === "fulfilled") {
        setTuiMuxDiagnostics(tuiMuxDiagnosticsResult.value);
      } else {
        errors.push(errorMessage(tuiMuxDiagnosticsResult.reason, "Failed to load TUI mux diagnostics."));
      }
      if (errors.length > 0) {
        setRuntimeDiagnosticsError(errors.join(" "));
      }
      if (
        nativeDiagnosticsResult.status === "fulfilled" ||
        terminalStatsResult.status === "fulfilled" ||
        tuiMuxDiagnosticsResult.status === "fulfilled"
      ) {
        setRuntimeDiagnosticsLoaded(true);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setRuntimeDiagnosticsError(errorMessage(error, "Failed to load runtime status."));
    } finally {
      setRuntimeDiagnosticsLoading(false);
    }
  }

  async function closeTuiMuxSessionFromDiagnostics(sessionName: string): Promise<void> {
    setClosingTuiMuxSessionNames((current) => new Set(current).add(sessionName));
    setRuntimeDiagnosticsError(null);
    try {
      await closeTuiMuxSession(sessionName);
      await loadStatusDiagnostics();
    } catch (error) {
      setRuntimeDiagnosticsError(errorMessage(error, `Failed to close TUI mux session ${sessionName}.`));
    } finally {
      setClosingTuiMuxSessionNames((current) => {
        const next = new Set(current);
        next.delete(sessionName);
        return next;
      });
    }
  }

  async function closeAllUnmanagedTuiMuxSessions(): Promise<void> {
    if (unmanagedTuiMuxDiagnostics.length === 0) {
      return;
    }
    const names = unmanagedTuiMuxDiagnostics.map((session) => session.sessionName);
    setClosingTuiMuxSessionNames((current) => new Set([...current, ...names]));
    setRuntimeDiagnosticsError(null);
    try {
      const results = await Promise.allSettled(names.map((name) => closeTuiMuxSession(name)));
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        throw new Error(`Failed to close ${failed.length} unmanaged TUI mux session${failed.length === 1 ? "" : "s"}.`);
      }
      await loadStatusDiagnostics();
    } catch (error) {
      setRuntimeDiagnosticsError(errorMessage(error, "Failed to close unmanaged TUI mux sessions."));
    } finally {
      setClosingTuiMuxSessionNames((current) => {
        const next = new Set(current);
        for (const name of names) {
          next.delete(name);
        }
        return next;
      });
    }
  }

  function selectSettingsTab(tab: SettingsTab): void {
    setActiveTab(tab);
    if (tab === "version" && !providerDiagnosticsLoaded && !providerDiagnosticsLoading) {
      void loadVersionDiagnostics();
    }
    if (tab === "status" && !runtimeDiagnosticsLoaded && !runtimeDiagnosticsLoading) {
      void loadStatusDiagnostics();
    }
    if (tab === "models" && !modelsLoaded && !modelsLoading) {
      void loadModelsTabData();
    }
  }

  function toggleModelProvider(provider: ProviderChoice): void {
    setExpandedModelProviders((current) => ({ ...current, [provider]: !current[provider] }));
  }

  function renderModelProviderCard(provider: ProviderChoice) {
    const storeCatalogState = storeModelCatalogs[provider];
    const catalog = newestModelCatalog(modelCatalogs[provider], storeCatalogState?.catalog);
    const manual = manualModels[provider] ?? [];
    const refreshState = modelRefreshStates[provider] ?? { status: "idle" as const };
    const form = manualModelForms[provider];
    const action = manualModelActions[provider] ?? {};
    const supportsOptions = providerSupportsManualOptions(provider);
    const localCatalog = modelCatalogs[provider];
    const localUpdatedAt = localCatalog && isAuthoritativeModelCatalog(localCatalog)
      ? localCatalog.fetchedAt
      : null;
    const catalogTimestamp = newestTimestamp(
      localUpdatedAt,
      storeCatalogState?.lastSuccessfulFetchedAt,
    );
    const expanded = expandedModelProviders[provider] === true;
    const manualActiveCount = manual.filter((model) => manualModelIsActive(catalog, model.id)).length;
    const catalogSource = catalog
      ? `${catalog.sourceDetail ?? catalog.source}${catalog.freshness ? ` / ${catalog.freshness}` : ""}`
      : "not loaded";
    const refreshButtonClass =
      refreshState.status === "success"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : refreshState.status === "error"
          ? "border-[var(--app-danger)]/30 bg-[var(--app-danger-bg)] text-[var(--app-danger)]"
          : "border-[var(--app-border)] text-[var(--app-hint)] hover:text-[var(--app-fg)]";
    const RefreshIcon =
      refreshState.status === "loading"
        ? LoaderCircle
        : refreshState.status === "success"
          ? CheckCircle2
          : refreshState.status === "error"
            ? XCircle
            : RefreshCw;

    return (
      <div key={provider} className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <button
            type="button"
            onClick={() => toggleModelProvider(provider)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--app-subtle-bg)]/60"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${providerLabel(provider)} models`}
          >
            <ChevronDown
              size={15}
              className={`shrink-0 text-[var(--app-hint)] transition-transform ${expanded ? "" : "-rotate-90"}`}
            />
            <ProviderLogo provider={provider} className="h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-semibold text-[var(--app-fg)]">
                  {providerLabel(provider)}
                </span>
                {manualActiveCount > 0 ? <ModelSourceBadge manual /> : null}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--app-hint)]">
                <span>{catalog?.models.length ?? 0} models</span>
                <span>Updated: {formatRefreshTimestamp(catalogTimestamp)}</span>
                <span className="max-w-[14rem] truncate" title={catalogSource}>
                  {catalogSource}
                </span>
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => void refreshProviderModelCatalog(provider)}
            disabled={refreshState.status === "loading"}
            className={`${SETTINGS_REFRESH_BUTTON_CLASS} ${refreshButtonClass}`}
            aria-label={`Refresh ${providerLabel(provider)} models`}
            title={`Refresh ${providerLabel(provider)} models`}
          >
            <RefreshIcon size={14} className={refreshState.status === "loading" ? "animate-spin" : ""} />
            <span className="hidden whitespace-nowrap sm:inline">Refresh</span>
          </button>
        </div>

          {refreshState.status === "error" && refreshState.error ? (
            <div className="mx-3 mb-3 rounded-xl border border-[var(--app-danger)]/20 bg-[var(--app-danger-bg)] px-3 py-2 text-xs text-[var(--app-danger)]">
              {refreshState.error}
            </div>
          ) : null}

          {expanded ? (
            <div className="space-y-4 border-t border-[var(--app-border)] p-3">
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                    Effective models
                  </div>
                  <div className="truncate text-[11px] text-[var(--app-hint)]" title={catalogSource}>
                    {manualActiveCount > 0 ? `${manualActiveCount} manual` : catalogSource}
                  </div>
                </div>
                <OverlayScrollArea
                  className="mt-2 max-h-72 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)]"
                  viewportClassName="max-h-72"
                  contentClassName="p-1.5"
                  scrollAriaLabel={`${providerLabel(provider)} model list`}
                >
                  <ModelCatalogList
                    catalog={catalog}
                    loading={modelsLoading && !catalog}
                    readOnly
                    emptyLabel="No models loaded."
                    paramDisplay="responsive"
                    hideImplicitDefaultVariant
                    onDeleteManualModel={(modelId) => void deleteManualModel(provider, modelId)}
                    deleteManualModelDisabled={Boolean(action.loading)}
                  />
                </OverlayScrollArea>
              </div>

              <div className="min-w-0 border-t border-[var(--app-border)] pt-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                  Add manual model
                </div>
                <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(10rem,16rem)_auto]">
                  <input
                    value={form.modelId}
                    onChange={(event) => updateManualModelForm(provider, { modelId: event.target.value })}
                    placeholder={provider === "opencode" ? "openai/gpt-5.6" : "gpt-5.6"}
                    className="min-w-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs text-[var(--app-fg)] outline-none transition-colors placeholder:text-[var(--app-hint)] focus:border-primary"
                  />
                  {supportsOptions ? (
                    <input
                      value={form.options}
                      onChange={(event) => updateManualModelForm(provider, { options: event.target.value })}
                      placeholder={provider === "opencode" ? "low high max" : "low high"}
                      className="min-w-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs text-[var(--app-fg)] outline-none transition-colors placeholder:text-[var(--app-hint)] focus:border-primary"
                    />
                  ) : (
                    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1.5 text-xs text-[var(--app-hint)]">
                      No parameters
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => void addManualModel(provider)}
                    disabled={Boolean(action.loading) || !form.modelId.trim()}
                    className="inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--app-border)] px-2 py-1.5 text-xs font-medium text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)] disabled:cursor-default disabled:opacity-50 md:w-20"
                  >
                    {action.loading ? <LoaderCircle size={13} className="animate-spin" /> : <Plus size={13} />}
                    Add
                  </button>
                </div>
                {action.error ? (
                  <div className="mt-2 text-xs text-[var(--app-danger)]">{action.error}</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      );
    }

  const activeDiagnosticsLoading =
    activeTab === "version" ? providerDiagnosticsLoading : runtimeDiagnosticsLoading;
  const activeDiagnosticsLoaded =
    activeTab === "version" ? providerDiagnosticsLoaded : runtimeDiagnosticsLoaded;
  const activeDiagnosticsError =
    activeTab === "version" ? providerDiagnosticsError : runtimeDiagnosticsError;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="shrink-0 border-b border-[var(--app-border)] p-2 md:w-48 md:border-b-0 md:border-r md:p-3">
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-6 md:grid-cols-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => selectSettingsTab(tab.id)}
              className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors ${
                selected
                  ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                  : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]/60 hover:text-[var(--app-fg)]"
              }`}
            >
              <Icon size={14} />
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
        </div>
      </div>

      <OverlayScrollArea className="min-h-0 flex-1" viewportClassName="h-full p-4 md:p-6">
        {activeTab === "appearance" ? (
          <div className="space-y-5">
            <div>
              <div className="text-base font-semibold text-[var(--app-fg)]">Appearance</div>
              <div className="mt-1 text-sm text-[var(--app-hint)]">Choose how RAH looks.</div>
            </div>
            <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 md:p-5">
              <ThemeToggle />
            </div>
          </div>
        ) : activeTab === "chat" ? (
          <div className="space-y-5">
            <div>
              <div className="text-base font-semibold text-[var(--app-fg)]">Chat</div>
              <div className="mt-1 text-sm text-[var(--app-hint)]">Choose what the chat thread shows.</div>
            </div>
            <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 md:p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--app-fg)]">Hide completed tool calls</div>
                  <div className="mt-1 text-xs text-[var(--app-hint)]">
                    Completed tool cards disappear from the thread. Failed command or test results stay visible as result events.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={hideToolCallsInChat}
                  onClick={() => setHideToolCallsInChat(!hideToolCallsInChat)}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors ${
                    hideToolCallsInChat
                      ? "border-primary bg-primary"
                      : "border-[var(--app-border)] bg-[var(--app-subtle-bg)]"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform ${
                      hideToolCallsInChat ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
              <div className="mt-5 flex items-start justify-between gap-4 border-t border-[var(--app-border)] pt-5">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--app-fg)]">Hide OpenCode reasoning</div>
                  <div className="mt-1 text-xs text-[var(--app-hint)]">
                    OpenCode thinking entries stay in the timeline data but are hidden from chat by default.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={hideOpenCodeReasoningInChat}
                  onClick={() => setHideOpenCodeReasoningInChat(!hideOpenCodeReasoningInChat)}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors ${
                    hideOpenCodeReasoningInChat
                      ? "border-primary bg-primary"
                      : "border-[var(--app-border)] bg-[var(--app-subtle-bg)]"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform ${
                      hideOpenCodeReasoningInChat ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
              <div className="mt-5 flex items-start justify-between gap-4 border-t border-[var(--app-border)] pt-5">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--app-fg)]">Hide Gemini reasoning</div>
                  <div className="mt-1 text-xs text-[var(--app-hint)]">
                    Gemini thinking entries stay in the timeline data but are hidden from chat by default.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={hideGeminiReasoningInChat}
                  onClick={() => setHideGeminiReasoningInChat(!hideGeminiReasoningInChat)}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors ${
                    hideGeminiReasoningInChat
                      ? "border-primary bg-primary"
                      : "border-[var(--app-border)] bg-[var(--app-subtle-bg)]"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform ${
                      hideGeminiReasoningInChat ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            </div>
            <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 md:p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--app-fg)]">Notify on unread replies</div>
                  <div className="mt-1 text-xs text-[var(--app-hint)]">
                    Show a system notification when a session or Council gets a new reply while RAH is hidden or unfocused.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={browserNotifications.enabled}
                  disabled={
                    browserNotifications.pending ||
                    !browserNotifications.supported ||
                    browserNotifications.permission === "denied"
                  }
                  onClick={() => void browserNotifications.toggle()}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors disabled:cursor-default disabled:opacity-60 ${
                    browserNotifications.enabled
                      ? "border-primary bg-primary"
                      : "border-[var(--app-border)] bg-[var(--app-subtle-bg)]"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform ${
                      browserNotifications.enabled ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            </div>
            <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 md:p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--app-fg)]">Show model on assistant replies</div>
                  <div className="mt-1 text-xs text-[var(--app-hint)]">
                    Display a subtle model / effort label on replies for every provider when the provider exposes it.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showModelInfoInChat}
                  onClick={() => setShowModelInfoInChat(!showModelInfoInChat)}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors ${
                    showModelInfoInChat
                      ? "border-primary bg-primary"
                      : "border-[var(--app-border)] bg-[var(--app-subtle-bg)]"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform ${
                      showModelInfoInChat ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>
        ) : activeTab === "models" ? (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-base font-semibold text-[var(--app-fg)]">Models</div>
                <div className="mt-1 text-sm text-[var(--app-hint)]">
                  Refresh provider catalogs and supplement missing model ids.
                </div>
              </div>
              <button
                type="button"
                onClick={() => MODEL_PROVIDERS.forEach((provider) => void refreshProviderModelCatalog(provider))}
                disabled={MODEL_PROVIDERS.some((provider) => modelRefreshStates[provider]?.status === "loading")}
                className={`${SETTINGS_REFRESH_BUTTON_CLASS} border-[var(--app-border)] text-[var(--app-hint)] hover:text-[var(--app-fg)]`}
                aria-label="Refresh all model catalogs"
                title="Refresh all model catalogs"
              >
                {MODEL_PROVIDERS.some((provider) => modelRefreshStates[provider]?.status === "loading") ? (
                  <LoaderCircle size={14} className="animate-spin" />
                ) : (
                  <ListRestart size={14} />
                )}
                <span className="hidden whitespace-nowrap sm:inline">Refresh all</span>
              </button>
            </div>

            {modelsError ? (
              <div className="rounded-2xl border border-[var(--app-danger)]/30 bg-[var(--app-danger-bg)] p-3 text-xs text-[var(--app-danger)]">
                {modelsError}
              </div>
            ) : null}

            <div className="space-y-2">
              {MODEL_PROVIDERS.map((provider) => renderModelProviderCard(provider))}
            </div>
          </div>
        ) : activeTab === "version" || activeTab === "status" ? (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-base font-semibold text-[var(--app-fg)]">
                  {activeTab === "version" ? "Version" : "Status"}
                </div>
                <div className="mt-1 text-sm text-[var(--app-hint)]">
                  {activeTab === "version"
                    ? "Compare local and official CLI versions."
                    : "Inspect active native TUI, terminal replay, and TUI mux runtime state."}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (activeTab === "version") {
                    void loadVersionDiagnostics(true);
                    return;
                  }
                  void loadStatusDiagnostics();
                }}
                disabled={activeDiagnosticsLoading}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--app-border)] px-2 py-1 text-xs font-medium text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)] disabled:cursor-default disabled:opacity-60"
              >
                {activeDiagnosticsLoading ? (
                  <LoaderCircle size={13} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
                Refresh
              </button>
            </div>

            {activeDiagnosticsError ? (
              <div className="rounded-2xl border border-[var(--app-danger)]/30 bg-[var(--app-danger-bg)] p-3 text-xs text-[var(--app-danger)]">
                {activeDiagnosticsError}
              </div>
            ) : null}

            {activeDiagnosticsLoading && !activeDiagnosticsLoaded ? (
              <div className="flex h-40 items-center justify-center text-xs text-[var(--app-hint)]">
                <LoaderCircle size={16} className="mr-2 animate-spin" />
                {activeTab === "version" ? "Checking local and official versions…" : "Checking runtime status…"}
              </div>
            ) : (
              <div className="space-y-3">
                {activeTab === "version" ? (
                  <>
                    {sortedProviderDiagnostics.map((diagnostic) => (
                      <div
                        key={diagnostic.provider}
                        className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 md:p-5"
                      >
                        <div className="flex items-start gap-3">
                          <ProviderLogo provider={diagnostic.provider} className="mt-0.5 h-6 w-6 shrink-0" />
                          <div className="min-w-0 flex-1 space-y-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="min-w-0 text-sm font-medium text-[var(--app-fg)]">
                                {providerLabel(diagnostic.provider)}
                              </span>
                              <span
                                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                                  diagnostic.versionStatus === "update_available"
                                    ? "border-[var(--app-warning)]/20 bg-[var(--app-warning-bg)] text-[var(--app-warning)]"
                                    : diagnostic.versionStatus === "up_to_date"
                                      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                      : diagnostic.latestVersionError
                                        ? "border-[var(--app-danger)]/20 bg-[var(--app-danger-bg)] text-[var(--app-danger)]"
                                        : "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                                }`}
                              >
                                {diagnostic.versionStatus === "update_available"
                                  ? "Update available"
                                  : diagnostic.versionStatus === "up_to_date"
                                    ? "Up to date"
                                    : diagnostic.latestVersionError
                                      ? "Check failed"
                                      : "Unknown"}
                              </span>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                                <div className="text-xs font-medium uppercase tracking-wide text-[var(--app-hint)]">
                                  Installed
                                </div>
                                <div className="mt-1 break-words font-mono text-sm text-[var(--app-fg)] [overflow-wrap:anywhere]">
                                  {diagnostic.installedVersion ?? "Not found"}
                                </div>
                              </div>
                              <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                                <div className="text-xs font-medium uppercase tracking-wide text-[var(--app-hint)]">
                                  Latest
                                </div>
                                <div
                                  className={`mt-1 break-words font-mono text-sm [overflow-wrap:anywhere] ${
                                    diagnostic.versionStatus === "update_available"
                                      ? "text-[var(--app-warning)]"
                                      : diagnostic.versionStatus === "up_to_date"
                                        ? "text-emerald-700 dark:text-emerald-400"
                                        : diagnostic.latestVersionError
                                          ? "text-[var(--app-danger)]"
                                          : "text-[var(--app-hint)]"
                                  }`}
                                  title={diagnostic.latestVersionError ?? diagnostic.latestVersion}
                                >
                                  {diagnostic.latestVersion ??
                                    (diagnostic.latestVersionError ? "Check failed" : "Unavailable")}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                        {diagnostic.latestVersionError ? (
                          <div className="mt-3 text-xs text-[var(--app-danger)] break-words [overflow-wrap:anywhere]">
                            Latest version check failed: {diagnostic.latestVersionError}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 md:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-[var(--app-fg)]">Native TUI diagnostics</div>
                      <div className="mt-1 text-xs text-[var(--app-hint)]">
                        Active binding and chat mirror issues for daemon-owned native TUI sessions.
                      </div>
                    </div>
                    {sortedNativeTuiDiagnostics.length === 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 size={12} />
                        Clear
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--app-warning)]/20 bg-[var(--app-warning-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--app-warning)]">
                        <AlertTriangle size={12} />
                        {sortedNativeTuiDiagnostics.length} active
                      </span>
                    )}
                  </div>
                  {sortedNativeTuiDiagnostics.length === 0 ? (
                    <div className="mt-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
                      No active native TUI binding or chat mirror issues.
                    </div>
                  ) : (
                    <div className="mt-4 space-y-2">
                      {sortedNativeTuiDiagnostics.map((diagnostic) => {
                        const elapsed = formatDiagnosticElapsed(diagnostic.elapsedMs);
                        return (
                          <div
                            key={diagnostic.id}
                            className="rounded-xl border border-[var(--app-warning)]/20 bg-[var(--app-warning-bg)] px-3 py-2"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <ProviderLogo provider={diagnostic.provider} className="h-4 w-4 shrink-0" />
                              <span className="text-xs font-semibold text-[var(--app-fg)]">
                                {providerLabel(diagnostic.provider)}
                              </span>
                              <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
                                {nativeTuiDiagnosticLabel(diagnostic.kind)}
                              </span>
                              {elapsed ? (
                                <span className="text-[10px] text-[var(--app-hint)]">after {elapsed}</span>
                              ) : null}
                            </div>
                            <div className="mt-1 text-xs text-[var(--app-warning)]">
                              {diagnostic.message}
                            </div>
                            <div className="mt-1 break-words font-mono text-[10px] text-[var(--app-hint)] [overflow-wrap:anywhere]">
                              {diagnostic.providerSessionId ?? diagnostic.sessionId}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 md:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-[var(--app-fg)]">Terminal replay health</div>
                      <div className="mt-1 text-xs text-[var(--app-hint)]">
                        PTY replay memory, trim boundaries, and active native TUI subscribers.
                      </div>
                    </div>
                    {ptyRuntimeHealth.status === "idle" ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--app-hint)]">
                        <TerminalSquare size={12} />
                        Idle
                      </span>
                    ) : ptyRuntimeHealth.status === "trimmed" ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--app-warning)]/20 bg-[var(--app-warning-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--app-warning)]">
                        <AlertTriangle size={12} />
                        Trimmed
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 size={12} />
                        Healthy
                      </span>
                    )}
                  </div>

                  <div className="mt-4 grid gap-2 sm:grid-cols-4">
                    <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                        Sessions
                      </div>
                      <div className="mt-1 text-sm font-semibold text-[var(--app-fg)]">
                        {ptyRuntimeHealth.openSessions} open / {ptyRuntimeHealth.totalSessions} total
                      </div>
                      {ptyRuntimeTrend ? (
                        <div className="mt-1 text-[10px] text-[var(--app-hint)]">
                          {formatSignedCount(ptyRuntimeTrend.openSessionsDelta)} open since refresh
                        </div>
                      ) : null}
                    </div>
                    <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                        Replay
                      </div>
                      <div className="mt-1 text-sm font-semibold text-[var(--app-fg)]">
                        {formatPtyBytes(ptyRuntimeHealth.replayBytes)}
                      </div>
                      {ptyRuntimeTrend ? (
                        <div className="mt-1 text-[10px] text-[var(--app-hint)]">
                          {formatSignedPtyBytes(ptyRuntimeTrend.replayBytesDelta)} since refresh
                        </div>
                      ) : null}
                    </div>
                    <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                        Subscribers
                      </div>
                      <div className="mt-1 text-sm font-semibold text-[var(--app-fg)]">
                        {ptyRuntimeHealth.subscriberCount}
                      </div>
                      {ptyRuntimeTrend ? (
                        <div className="mt-1 text-[10px] text-[var(--app-hint)]">
                          {formatSignedCount(ptyRuntimeTrend.subscriberCountDelta)} since refresh
                        </div>
                      ) : null}
                    </div>
                    <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                        Trimmed
                      </div>
                      <div className="mt-1 text-sm font-semibold text-[var(--app-fg)]">
                        {ptyRuntimeHealth.trimmedSessions}
                      </div>
                      {ptyRuntimeTrend ? (
                        <div className="mt-1 text-[10px] text-[var(--app-hint)]">
                          {formatSignedCount(ptyRuntimeTrend.trimmedSessionsDelta)} since refresh
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {ptyRuntimeTrend ? (
                    <div className="mt-2 text-[11px] text-[var(--app-hint)]">
                      Replay chunks {formatSignedCount(ptyRuntimeTrend.replayChunksDelta)} since last refresh.
                    </div>
                  ) : null}

                  {sortedPtyStats.length === 0 ? (
                    <div className="mt-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
                      No active or replayable PTY sessions.
                    </div>
                  ) : (
                    <div className="mt-4 space-y-2">
                      {sortedPtyStats.slice(0, 6).map((stat) => (
                        <div
                          key={stat.sessionId}
                          className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0 flex items-center gap-2">
                              <span
                                className={`h-2 w-2 shrink-0 rounded-full ${
                                  stat.status === "open" ? "bg-emerald-500" : "bg-[var(--app-hint)]"
                                }`}
                              />
                              <span className="truncate font-mono text-[11px] text-[var(--app-fg)]">
                                {stat.sessionId}
                              </span>
                            </div>
                            <span className="shrink-0 text-[11px] font-medium text-[var(--app-hint)]">
                              {formatPtyBytes(stat.replayBytes)} / {stat.replayChunks} chunks
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--app-hint)]">
                            {stat.provider ? (
                              <span>{providerLabel(stat.provider)}</span>
                            ) : null}
                            {stat.liveBackend ? (
                              <span>{stat.liveBackend}</span>
                            ) : null}
                            {stat.runtimeState ? (
                              <span>{stat.runtimeState}</span>
                            ) : null}
                            {stat.mux?.backend === "tmux" ? (
                              <span className="font-mono">
                                {stat.mux.sessionName}/{stat.mux.paneId}
                              </span>
                            ) : null}
                            <span>{stat.subscriberCount} subscribers</span>
                            <span>next seq {stat.nextSeq}</span>
                            {stat.droppedBeforeSeq !== undefined ? (
                              <span className="text-[var(--app-warning)]">
                                dropped before {stat.droppedBeforeSeq}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ))}
                      {sortedPtyStats.length > 6 ? (
                        <div className="text-[11px] text-[var(--app-hint)]">
                          Showing 6 largest/open PTY sessions out of {sortedPtyStats.length}.
                        </div>
                      ) : null}
                    </div>
                  )}

                  <div className="mt-5 border-t border-[var(--app-border)] pt-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold text-[var(--app-fg)]">TUI mux sessions</div>
                        <div className="mt-1 text-[11px] text-[var(--app-hint)]">
                          Real tmux rah-* sessions and panes visible through the mux runtime.
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {unmanagedTuiMuxDiagnostics.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => void closeAllUnmanagedTuiMuxSessions()}
                            disabled={unmanagedTuiMuxDiagnostics.some((session) =>
                              closingTuiMuxSessionNames.has(session.sessionName),
                            )}
                            className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--app-warning)] transition-colors hover:border-[var(--app-warning)] disabled:cursor-default disabled:opacity-60"
                          >
                            Close unmanaged
                          </button>
                        ) : null}
                        <span className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
                          {sortedTuiMuxDiagnostics.length}
                        </span>
                      </div>
                    </div>
                    {sortedTuiMuxDiagnostics.length === 0 ? (
                      <div className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
                        No rah-* TUI mux sessions are visible.
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {sortedTuiMuxDiagnostics.slice(0, 6).map((session) => {
                          const activePane = session.panes.find((pane) => pane.paneId === session.paneId) ?? session.panes[0];
                          return (
                            <div
                              key={session.sessionName}
                              className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0 font-mono text-[11px] text-[var(--app-fg)]">
                                  {session.sessionName}
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                  <span className="text-[11px] text-[var(--app-hint)]">
                                    {session.panes.length} panes
                                  </span>
                                  {!session.managedSessionId && session.sessionName.startsWith("rah-") ? (
                                    <button
                                      type="button"
                                      onClick={() => void closeTuiMuxSessionFromDiagnostics(session.sessionName)}
                                      disabled={closingTuiMuxSessionNames.has(session.sessionName)}
                                      className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--app-warning)] transition-colors hover:border-[var(--app-warning)] disabled:cursor-default disabled:opacity-60"
                                    >
                                      {closingTuiMuxSessionNames.has(session.sessionName) ? "Closing" : "Close"}
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--app-hint)]">
                                {session.provider ? <span>{providerLabel(session.provider)}</span> : null}
                                {session.runtimeState ? <span>{session.runtimeState}</span> : null}
                                {session.managedSessionId ? (
                                  <span className="font-mono">{session.managedSessionId}</span>
                                ) : (
                                  <span className="text-[var(--app-warning)]">unmanaged</span>
                                )}
                                {activePane ? (
                                  <span className="font-mono">
                                    {activePane.paneId} {activePane.columns}x{activePane.rows}
                                  </span>
                                ) : null}
                                {activePane?.exited ? (
                                  <span className="text-[var(--app-warning)]">exited {activePane.exitStatus ?? ""}</span>
                                ) : null}
                              </div>
                              {session.error ? (
                                <div className="mt-1 break-words text-[10px] text-[var(--app-warning)] [overflow-wrap:anywhere]">
                                  {session.error}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                        {sortedTuiMuxDiagnostics.length > 6 ? (
                          <div className="text-[11px] text-[var(--app-hint)]">
                            Showing 6 TUI mux sessions out of {sortedTuiMuxDiagnostics.length}.
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              <div className="text-base font-semibold text-[var(--app-fg)]">About</div>
            </div>
            <div className="space-y-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 md:p-5 text-xs text-[var(--app-hint)]">
              <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] py-2">
                <span>Workbench</span>
                <span className="font-medium text-[var(--app-fg)]">{__RAH_WORKBENCH_VERSION__}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] py-2">
                <span>Client</span>
                <span className="font-medium text-[var(--app-fg)]">{__RAH_APP_VERSION__}</span>
              </div>
            </div>
          </div>
        )}
      </OverlayScrollArea>
    </div>
  );
}
