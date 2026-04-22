import { useEffect, useMemo, useState } from "react";
import type { ProviderDiagnostic } from "@rah/runtime-protocol";
import { Info, LoaderCircle, MessageSquareText, Palette, RefreshCw, Waypoints } from "lucide-react";
import { listProviders } from "../api";
import { providerLabel } from "../types";
import { ProviderLogo } from "./ProviderLogo";
import { ThemeToggle } from "./ThemeToggle";
import { useChatPreferences } from "../hooks/useChatPreferences";

type SettingsTab = "appearance" | "chat" | "version" | "about";

const TABS: { id: SettingsTab; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "chat", label: "Chat", icon: MessageSquareText },
  { id: "version", label: "Version", icon: Waypoints },
  { id: "about", label: "About", icon: Info },
];

export function SettingsPane() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");
  const { hideToolCallsInChat, setHideToolCallsInChat } = useChatPreferences();
  const [providerDiagnostics, setProviderDiagnostics] = useState<ProviderDiagnostic[]>([]);
  const [providerDiagnosticsError, setProviderDiagnosticsError] = useState<string | null>(null);
  const [providerDiagnosticsLoading, setProviderDiagnosticsLoading] = useState(false);
  const [providerDiagnosticsLoaded, setProviderDiagnosticsLoaded] = useState(false);

  const sortedProviderDiagnostics = useMemo(
    () => [...providerDiagnostics].sort((left, right) => left.provider.localeCompare(right.provider)),
    [providerDiagnostics],
  );

  useEffect(() => {
    if (activeTab !== "version" || providerDiagnosticsLoaded || providerDiagnosticsLoading) {
      return;
    }
    void loadProviderDiagnostics();
  }, [activeTab, providerDiagnosticsLoaded, providerDiagnosticsLoading]);

  async function loadProviderDiagnostics(forceRefresh = false) {
    setProviderDiagnosticsLoading(true);
    setProviderDiagnosticsError(null);
    try {
      setProviderDiagnostics(await listProviders({ forceRefresh }));
      setProviderDiagnosticsLoaded(true);
    } catch (error) {
      setProviderDiagnosticsError(error instanceof Error ? error.message : "Failed to load provider versions.");
    } finally {
      setProviderDiagnosticsLoading(false);
    }
  }

  return (
    <div className="flex h-[420px]">
      {/* Left sidebar tabs */}
      <div className="w-40 shrink-0 border-r border-[var(--app-border)] p-2 space-y-0.5">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors text-left ${
                selected
                  ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                  : "text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/50"
              }`}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Right content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-5">
        {activeTab === "appearance" ? (
          <div className="space-y-4">
            <div className="text-sm font-semibold text-[var(--app-fg)]">Appearance</div>
            <div className="text-xs text-[var(--app-hint)]">Choose how RAH looks.</div>
            <div className="mt-4">
              <ThemeToggle />
            </div>
          </div>
        ) : activeTab === "chat" ? (
          <div className="space-y-4">
            <div className="text-sm font-semibold text-[var(--app-fg)]">Chat</div>
            <div className="text-xs text-[var(--app-hint)]">Choose what the chat thread shows.</div>
            <div className="mt-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--app-fg)]">
                    Hide completed tool calls
                  </div>
                  <div className="mt-1 text-xs text-[var(--app-hint)]">
                    Running and failed tools still stay visible in chat.
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
            </div>
          </div>
        ) : activeTab === "version" ? (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-[var(--app-fg)]">Version</div>
                <div className="mt-1 text-xs text-[var(--app-hint)]">
                  Compare installed CLI versions with each provider&apos;s official latest release.
                </div>
              </div>
              <button
                type="button"
                onClick={() => void loadProviderDiagnostics(true)}
                disabled={providerDiagnosticsLoading}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--app-border)] px-2 py-1 text-xs font-medium text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)] disabled:cursor-default disabled:opacity-60"
              >
                {providerDiagnosticsLoading ? (
                  <LoaderCircle size={13} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
                Refresh
              </button>
            </div>

            {providerDiagnosticsError ? (
              <div className="rounded-xl border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/8 p-3 text-xs text-[var(--app-danger)]">
                {providerDiagnosticsError}
              </div>
            ) : null}

            {providerDiagnosticsLoading && !providerDiagnosticsLoaded ? (
              <div className="flex h-40 items-center justify-center text-xs text-[var(--app-hint)]">
                <LoaderCircle size={16} className="mr-2 animate-spin" />
                Checking local and official versions…
              </div>
            ) : (
              <div className="space-y-2.5">
                {sortedProviderDiagnostics.map((diagnostic) => (
                  <div
                    key={diagnostic.provider}
                    className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2"
                  >
                    <div className="flex items-center gap-3">
                      <ProviderLogo provider={diagnostic.provider} className="h-6 w-6 shrink-0" />
                      <span className="min-w-0 flex-1 text-sm font-medium text-[var(--app-fg)] truncate">
                        {providerLabel(diagnostic.provider)}
                      </span>
                      <div className="ml-auto grid grid-cols-[4rem_auto_5.5rem] items-center gap-1 text-xs tabular-nums font-mono">
                        <span className="truncate text-left text-[var(--app-fg)]">
                          {diagnostic.installedVersion ?? "Not found"}
                        </span>
                        <span className="text-[var(--app-hint)] text-center">→</span>
                        <span
                          className={`truncate text-left font-medium ${
                            diagnostic.versionStatus === "update_available"
                              ? "text-[var(--app-warning)]"
                              : diagnostic.versionStatus === "up_to_date"
                                ? "text-emerald-600 dark:text-emerald-400"
                                : diagnostic.latestVersionError
                                  ? "text-[var(--app-danger)]"
                                  : "text-[var(--app-hint)]"
                          }`}
                          title={diagnostic.latestVersionError ?? diagnostic.latestVersion}
                        >
                          {diagnostic.latestVersion ??
                            (diagnostic.latestVersionError ? "Check failed" : "Unavailable")}
                        </span>
                      </div>
                    </div>
                    {diagnostic.latestVersionError ? (
                      <div className="mt-2 text-[11px] text-[var(--app-danger)] break-words [overflow-wrap:anywhere]">
                        Latest version check failed: {diagnostic.latestVersionError}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-sm font-semibold text-[var(--app-fg)]">About</div>
            <div className="mt-4 space-y-3 text-xs text-[var(--app-hint)]">
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--app-border)]">
                <span>Workbench</span>
                <span className="font-medium text-[var(--app-fg)]">{__RAH_WORKBENCH_VERSION__}</span>
              </div>
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--app-border)]">
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
