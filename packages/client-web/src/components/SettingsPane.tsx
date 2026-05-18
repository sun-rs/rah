import { useMemo, useRef, useState } from "react";
import type {
  NativeTuiDiagnostic,
  ProviderDiagnostic,
  PtySessionStats,
  ZellijMuxSessionDiagnostic,
} from "@rah/runtime-protocol";
import { Activity, AlertTriangle, CheckCircle2, Info, LoaderCircle, MessageSquareText, Palette, RefreshCw, TerminalSquare, Waypoints } from "lucide-react";
import {
  closeZellijMuxSession,
  listNativeTuiDiagnostics,
  listProviders,
  listPtyStats,
  listZellijMuxDiagnostics,
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
import { ThemeToggle } from "./ThemeToggle";
import { useChatPreferences } from "../hooks/useChatPreferences";
import type { ProviderChoice } from "./ProviderSelector";

type SettingsTab = "chat" | "status" | "appearance" | "version" | "about";

const TABS: { id: SettingsTab; label: string; icon: typeof Palette }[] = [
  { id: "chat", label: "Chat", icon: MessageSquareText },
  { id: "status", label: "Status", icon: Activity },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "version", label: "Version", icon: Waypoints },
  { id: "about", label: "About", icon: Info },
];

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

export function SettingsPane() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("chat");
  const {
    hideToolCallsInChat,
    setHideToolCallsInChat,
    hideOpenCodeReasoningInChat,
    setHideOpenCodeReasoningInChat,
    showModelInfoInChat,
    setShowModelInfoInChat,
  } = useChatPreferences();
  const [providerDiagnostics, setProviderDiagnostics] = useState<ProviderDiagnostic[]>([]);
  const [providerDiagnosticsError, setProviderDiagnosticsError] = useState<string | null>(null);
  const [providerDiagnosticsLoading, setProviderDiagnosticsLoading] = useState(false);
  const [providerDiagnosticsLoaded, setProviderDiagnosticsLoaded] = useState(false);
  const [runtimeDiagnosticsError, setRuntimeDiagnosticsError] = useState<string | null>(null);
  const [runtimeDiagnosticsLoading, setRuntimeDiagnosticsLoading] = useState(false);
  const [runtimeDiagnosticsLoaded, setRuntimeDiagnosticsLoaded] = useState(false);
  const [nativeTuiDiagnostics, setNativeTuiDiagnostics] = useState<NativeTuiDiagnostic[]>([]);
  const [ptyStats, setPtyStats] = useState<PtySessionStats[]>([]);
  const [zellijMuxDiagnostics, setZellijMuxDiagnostics] = useState<ZellijMuxSessionDiagnostic[]>([]);
  const [closingZellijSessionNames, setClosingZellijSessionNames] = useState<Set<string>>(() => new Set());
  const ptyStatsRef = useRef<PtySessionStats[] | null>(null);
  const [previousPtyStats, setPreviousPtyStats] = useState<PtySessionStats[] | null>(null);

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
  const sortedZellijMuxDiagnostics = useMemo(
    () => [...zellijMuxDiagnostics].sort((left, right) => left.sessionName.localeCompare(right.sessionName)),
    [zellijMuxDiagnostics],
  );
  const unmanagedZellijMuxDiagnostics = useMemo(
    () =>
      sortedZellijMuxDiagnostics.filter(
        (session) => !session.managedSessionId && session.sessionName.startsWith("rah-"),
      ),
    [sortedZellijMuxDiagnostics],
  );

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
      const [nativeDiagnosticsResult, terminalStatsResult, zellijMuxDiagnosticsResult] =
        await Promise.allSettled([
          listNativeTuiDiagnostics({
            ...(signal ? { signal } : {}),
          }),
          listPtyStats({
            ...(signal ? { signal } : {}),
          }),
          listZellijMuxDiagnostics({
            ...(signal ? { signal } : {}),
          }),
        ]);

      for (const result of [nativeDiagnosticsResult, terminalStatsResult, zellijMuxDiagnosticsResult]) {
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
      if (zellijMuxDiagnosticsResult.status === "fulfilled") {
        setZellijMuxDiagnostics(zellijMuxDiagnosticsResult.value);
      } else {
        errors.push(errorMessage(zellijMuxDiagnosticsResult.reason, "Failed to load zellij diagnostics."));
      }
      if (errors.length > 0) {
        setRuntimeDiagnosticsError(errors.join(" "));
      }
      if (
        nativeDiagnosticsResult.status === "fulfilled" ||
        terminalStatsResult.status === "fulfilled" ||
        zellijMuxDiagnosticsResult.status === "fulfilled"
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

  async function closeZellijSessionFromDiagnostics(sessionName: string): Promise<void> {
    setClosingZellijSessionNames((current) => new Set(current).add(sessionName));
    setRuntimeDiagnosticsError(null);
    try {
      await closeZellijMuxSession(sessionName);
      await loadStatusDiagnostics();
    } catch (error) {
      setRuntimeDiagnosticsError(errorMessage(error, `Failed to close zellij session ${sessionName}.`));
    } finally {
      setClosingZellijSessionNames((current) => {
        const next = new Set(current);
        next.delete(sessionName);
        return next;
      });
    }
  }

  async function closeAllUnmanagedZellijSessions(): Promise<void> {
    if (unmanagedZellijMuxDiagnostics.length === 0) {
      return;
    }
    const names = unmanagedZellijMuxDiagnostics.map((session) => session.sessionName);
    setClosingZellijSessionNames((current) => new Set([...current, ...names]));
    setRuntimeDiagnosticsError(null);
    try {
      const results = await Promise.allSettled(names.map((name) => closeZellijMuxSession(name)));
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        throw new Error(`Failed to close ${failed.length} unmanaged zellij session${failed.length === 1 ? "" : "s"}.`);
      }
      await loadStatusDiagnostics();
    } catch (error) {
      setRuntimeDiagnosticsError(errorMessage(error, "Failed to close unmanaged zellij sessions."));
    } finally {
      setClosingZellijSessionNames((current) => {
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
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-5 md:grid-cols-1">
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

      <div className="min-h-0 flex-1 overflow-y-auto rah-scroll-panel rah-scroll-panel-y p-4 md:p-6">
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
                    Completed tool cards disappear from the thread as soon as the call finishes. Running and failed tools stay visible.
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
            </div>
            <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 md:p-5">
              <div>
                <div className="text-sm font-medium text-[var(--app-fg)]">Show model on assistant replies</div>
                <div className="mt-1 text-xs text-[var(--app-hint)]">
                  Display a subtle model / effort label when the provider exposes it for a reply.
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {(["codex", "claude", "opencode"] as ProviderChoice[]).map((provider) => (
                  <div key={provider} className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-2 text-sm text-[var(--app-fg)]">
                      <ProviderLogo provider={provider} className="h-4 w-4" />
                      <span className="capitalize">{provider}</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={showModelInfoInChat[provider]}
                      onClick={() => setShowModelInfoInChat(provider, !showModelInfoInChat[provider])}
                      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors ${
                        showModelInfoInChat[provider]
                          ? "border-primary bg-primary"
                          : "border-[var(--app-border)] bg-[var(--app-subtle-bg)]"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform ${
                          showModelInfoInChat[provider] ? "translate-x-5" : "translate-x-0.5"
                        }`}
                      />
                    </button>
                  </div>
                ))}
              </div>
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
                    : "Inspect active native TUI, terminal replay, and zellij runtime state."}
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
                            {stat.mux?.backend === "zellij" ? (
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
                        <div className="text-xs font-semibold text-[var(--app-fg)]">Zellij mux sessions</div>
                        <div className="mt-1 text-[11px] text-[var(--app-hint)]">
                          Real zellij rah-* sessions and panes visible through the mux socket.
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {unmanagedZellijMuxDiagnostics.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => void closeAllUnmanagedZellijSessions()}
                            disabled={unmanagedZellijMuxDiagnostics.some((session) =>
                              closingZellijSessionNames.has(session.sessionName),
                            )}
                            className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--app-warning)] transition-colors hover:border-[var(--app-warning)] disabled:cursor-default disabled:opacity-60"
                          >
                            Close unmanaged
                          </button>
                        ) : null}
                        <span className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
                          {sortedZellijMuxDiagnostics.length}
                        </span>
                      </div>
                    </div>
                    {sortedZellijMuxDiagnostics.length === 0 ? (
                      <div className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
                        No rah-* zellij sessions are visible.
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {sortedZellijMuxDiagnostics.slice(0, 6).map((session) => {
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
                                      onClick={() => void closeZellijSessionFromDiagnostics(session.sessionName)}
                                      disabled={closingZellijSessionNames.has(session.sessionName)}
                                      className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--app-warning)] transition-colors hover:border-[var(--app-warning)] disabled:cursor-default disabled:opacity-60"
                                    >
                                      {closingZellijSessionNames.has(session.sessionName) ? "Closing" : "Close"}
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
                        {sortedZellijMuxDiagnostics.length > 6 ? (
                          <div className="text-[11px] text-[var(--app-hint)]">
                            Showing 6 zellij sessions out of {sortedZellijMuxDiagnostics.length}.
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
      </div>
    </div>
  );
}
