import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionResponseRequest } from "@rah/runtime-protocol";
import { Menu, PanelRight, History, Send, Square, X, Settings } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { InspectorPane } from "./InspectorPane";
import { SessionSidebar } from "./SessionSidebar";
import {
  deriveWorkspaceInfos,
  deriveWorkspaceSections,
  groupLiveSessionsByDirectory,
} from "./session-browser";
import { providerLabel } from "./types";
import { useSessionStore } from "./useSessionStore";
import { ChatThread } from "./components/chat/ChatThread";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { ProviderLogo } from "./components/ProviderLogo";
import { SettingsPane } from "./components/SettingsPane";
import { SessionHistoryDialog } from "./components/SessionHistoryDialog";
import { Sheet } from "./components/Sheet";
import { StatusCallout } from "./components/StatusCallout";
import { describeWorkbenchError } from "./error-recovery";
import {
  clearLastHistorySelection,
  writeLastHistorySelection,
} from "./history-selection";
import { useChatPreferences } from "./hooks/useChatPreferences";
import { initializeTheme } from "./hooks/useTheme";
import {
  canSessionRespondToPermissions,
  isSessionActivelyRunning,
  canSessionSendInput,
  isReadOnlyReplay,
  sessionInteractionNotice,
} from "./session-capabilities";

export function App() {
  const {
    init,
    refreshWorkbenchState,
    projections,
    storedSessions,
    recentSessions,
    workspaceDirs,
    debugScenarios,
    selectedSessionId,
    workspaceDir,
    newSessionProvider,
    launchStatus,
    clientId,
    isInitialLoaded,
    error,
    clearError,
    setWorkspaceDir,
    addWorkspace,
    removeWorkspace,
    setSelectedSessionId,
    setNewSessionProvider,
    startSession,
    startScenario,
    resumeStoredSession,
    closeSession,
    claimHistorySession,
    claimControl,
    releaseControl,
    interruptSession,
    sendInput,
    loadOlderHistory,
    respondToPermission,
  } = useSessionStore();
  const [draft, setDraft] = useState("");
  const [leftOpen, setLeftOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem("rah-sidebar-open") !== "false"; } catch { return true; }
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return Math.max(200, Math.min(480, Number(localStorage.getItem("rah-sidebar-width")) || 288)); } catch { return 288; }
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const lastAutoClaimKeyRef = useRef<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const { hideToolCallsInChat } = useChatPreferences();

  useEffect(() => {
    initializeTheme();
    void init();
  }, [init]);

  const sessionEntries = useMemo(
    () =>
      [...projections.values()].sort((a, b) =>
        b.summary.session.updatedAt.localeCompare(a.summary.session.updatedAt),
      ),
    [projections],
  );
  const attachedLiveSessionEntries = useMemo(
    () => sessionEntries.filter((entry) => !isReadOnlyReplay(entry.summary)),
    [sessionEntries],
  );

  const liveGroups = useMemo(
    () =>
      groupLiveSessionsByDirectory(
        attachedLiveSessionEntries.map((entry) => entry.summary),
        workspaceDir,
      ),
    [attachedLiveSessionEntries, workspaceDir],
  );

  const liveSessionByProviderSessionId = useMemo(
    () =>
      new Map(
        attachedLiveSessionEntries
          .filter((entry) => entry.summary.session.providerSessionId)
          .map((entry) => [entry.summary.session.providerSessionId!, entry.summary]),
      ),
    [attachedLiveSessionEntries],
  );

  const workspaceInfos = useMemo(
    () =>
      deriveWorkspaceInfos(
        workspaceDirs,
        sessionEntries.map((entry) => entry.summary),
        storedSessions,
      ),
    [sessionEntries, storedSessions, workspaceDirs],
  );

  const workspaceSections = useMemo(
    () =>
      deriveWorkspaceSections(
        workspaceInfos,
        attachedLiveSessionEntries.map((entry) => entry.summary),
      ),
    [attachedLiveSessionEntries, workspaceInfos],
  );

  const selectedProjection = selectedSessionId ? projections.get(selectedSessionId) ?? null : null;
  const selectedSummary = selectedProjection?.summary ?? null;
  const isAttached = Boolean(
    selectedSummary?.attachedClients.some((client) => client.id === clientId),
  );
  const hasControl = selectedSummary?.controlLease.holderClientId === clientId;
  const canRespondToPermission = selectedSummary
    ? canSessionRespondToPermissions(selectedSummary)
    : false;
  const canSendInput = selectedSummary ? canSessionSendInput(selectedSummary) : false;
  const selectedIsReadOnlyReplay = selectedSummary ? isReadOnlyReplay(selectedSummary) : false;
  const interactionNotice = selectedSummary ? sessionInteractionNotice(selectedSummary) : null;
  const historyNotice =
    selectedSummary?.session.providerSessionId && selectedProjection
      ? selectedProjection.history.phase === "loading" &&
        !selectedProjection.history.authoritativeApplied
        ? "Syncing session history…"
        : selectedProjection.history.phase === "error" && selectedProjection.history.lastError
          ? `History sync failed: ${selectedProjection.history.lastError}`
          : null
      : null;
  const errorDescriptor = error ? describeWorkbenchError(error, selectedSummary) : null;
  const isGenerating = selectedSummary ? isSessionActivelyRunning(selectedSummary) : false;

  useEffect(() => {
    if (selectedSummary?.session.providerSessionId && selectedIsReadOnlyReplay) {
      const historyWorkspaceDir =
        selectedSummary.session.rootDir || selectedSummary.session.cwd || workspaceDir;
      writeLastHistorySelection({
        provider: selectedSummary.session.provider,
        providerSessionId: selectedSummary.session.providerSessionId,
        ...(historyWorkspaceDir ? { workspaceDir: historyWorkspaceDir } : {}),
      });
      return;
    }
    if (selectedSummary && !selectedIsReadOnlyReplay) {
      clearLastHistorySelection();
    }
  }, [selectedIsReadOnlyReplay, selectedSummary, workspaceDir]);

  useEffect(() => {
    if (!selectedSummary || !canSendInput || hasControl || selectedIsReadOnlyReplay) {
      lastAutoClaimKeyRef.current = null;
      return;
    }
    const key = `${selectedSummary.session.id}:${selectedSummary.controlLease.holderClientId ?? ""}`;
    if (lastAutoClaimKeyRef.current === key) {
      return;
    }
    lastAutoClaimKeyRef.current = key;
    void claimControl(selectedSummary.session.id).catch(() => {});
  }, [canSendInput, claimControl, hasControl, selectedIsReadOnlyReplay, selectedSummary]);

  const handleSend = async () => {
    if (!selectedSummary || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    await sendInput(selectedSummary.session.id, text);
  };

  const handlePermissionResponse = async (
    requestId: string,
    response: PermissionResponseRequest,
  ) => {
    if (!selectedSummary) return;
    await respondToPermission(selectedSummary.session.id, requestId, response);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizing) return;
      setSidebarWidth(Math.max(200, Math.min(480, e.clientX)));
    };
    const onUp = () => {
      if (!isResizing) return;
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem("rah-sidebar-width", String(sidebarWidthRef.current)); } catch {}
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isResizing]);

  useEffect(() => {
    try { localStorage.setItem("rah-sidebar-open", String(sidebarOpen)); } catch {}
  }, [sidebarOpen]);

  if (!isInitialLoaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-background text-foreground">
        <div className="text-center space-y-3 px-6">
          <div className="text-2xl font-semibold tracking-tight">RAH</div>
          <div className="text-[var(--app-hint)]">Initializing workbench…</div>
        </div>
      </div>
    );
  }

  const sidebarContent = (
    <SessionSidebar
      workspaceSections={workspaceSections}
      onAddWorkspace={(dir) => {
        void addWorkspace(dir);
        setLeftOpen(false);
      }}
      onRemoveWorkspace={(dir) => void removeWorkspace(dir)}
      onOpenNewSession={() => setNewSessionOpen(true)}
      onRefresh={() => void refreshWorkbenchState()}
      selectedSessionId={selectedSessionId}
      onSelectSession={(id) => {
        setSelectedSessionId(id);
        setLeftOpen(false);
      }}
      debugScenarios={debugScenarios}
      onStartScenario={(scenario) => {
        void startScenario(scenario);
        setLeftOpen(false);
      }}
    />
  );

  const handleActivateHistorySession = (ref: typeof storedSessions[number]) => {
    const existingLive = liveSessionByProviderSessionId.get(ref.providerSessionId);
    if (existingLive) {
      setSelectedSessionId(existingLive.session.id);
      return;
    }
    void resumeStoredSession(ref, { preferStoredReplay: true });
  };

  const defaultWorkspaceDirForNewSession =
    selectedSummary?.session.rootDir || selectedSummary?.session.cwd || workspaceDir;

  const inspectorContent =
    selectedSummary ? (
      <InspectorPane
        sessionId={selectedSummary.session.id}
        events={selectedProjection?.events ?? []}
      />
    ) : (
      <div className="h-full" />
    );

  return (
    <div className="h-screen flex overflow-hidden bg-background text-foreground">
      {/* Desktop left sidebar */}
      <aside
        className="hidden md:flex flex-col bg-[var(--app-subtle-bg)] shrink-0 transition-[width] duration-200 overflow-hidden"
        style={{ width: sidebarOpen ? sidebarWidth : 0 }}
      >
        <div className="h-14 px-4 flex items-center justify-between shrink-0">
          {sidebarOpen && (
            <>
              <div className="shrink-0">
                <div className="text-lg font-semibold tracking-tight">RAH</div>
                <div className="text-xs text-[var(--app-hint)]">Workbench</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <SessionHistoryDialog
                  storedSessions={storedSessions}
                  recentSessions={recentSessions}
                  liveSessions={attachedLiveSessionEntries.map((entry) => entry.summary)}
                  onActivate={handleActivateHistorySession}
                >
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
                    aria-label="Session history"
                    title="Session history"
                  >
                    <History size={18} />
                  </button>
                </SessionHistoryDialog>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
                  onClick={() => setSettingsOpen(true)}
                  aria-label="Open settings"
                  title="Settings"
                >
                  <Settings size={16} />
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar"
                >
                  <Menu size={18} />
                </button>
              </div>
            </>
          )}
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar p-3">{sidebarContent}</div>
      </aside>

      {/* Resize handle */}
      {sidebarOpen && (
        <div
          className={`hidden md:block resize-handle ${isResizing ? "dragging" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            setIsResizing(true);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
        />
      )}

      {/* Mobile left sheet */}
      <Sheet
        open={leftOpen}
        onOpenChange={setLeftOpen}
        side="left"
        title="Workbench"
        headerRight={
          <div className="flex items-center gap-1">
            <SessionHistoryDialog
              storedSessions={storedSessions}
              recentSessions={recentSessions}
              liveSessions={attachedLiveSessionEntries.map((entry) => entry.summary)}
              onActivate={handleActivateHistorySession}
            >
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
                aria-label="Session history"
                title="Session history"
              >
                <History size={18} />
              </button>
            </SessionHistoryDialog>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
              title="Settings"
            >
              <Settings size={16} />
            </button>
          </div>
        }
      >
        <div className="p-3">{sidebarContent}</div>
      </Sheet>

      <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[85vh] w-[90vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none z-50 flex flex-col">
            <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
              <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">Settings</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              <SettingsPane />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <NewSessionDialog
        open={newSessionOpen}
        onOpenChange={setNewSessionOpen}
        workspaceDirs={workspaceDirs}
        defaultWorkspaceDir={defaultWorkspaceDirForNewSession}
        defaultProvider={newSessionProvider}
        onCreate={async (input) => {
          if (!workspaceDirs.includes(input.cwd)) {
            await addWorkspace(input.cwd);
          }
          await startSession(input);
          setNewSessionProvider(input.provider);
          setLeftOpen(false);
        }}
      />

      {/* Center chat */}
      <main className="flex-1 flex flex-col min-w-0">
        {selectedSummary ? (
          <>
            <header className="h-14 flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 bg-[var(--app-bg)]/80 backdrop-blur-sm shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors md:hidden"
                  onClick={() => setLeftOpen(true)}
                  aria-label="Open sidebar"
                >
                  <Menu size={18} />
                </button>
                {!sidebarOpen && (
                  <button
                    type="button"
                    className="hidden md:inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                    onClick={() => setSidebarOpen(true)}
                    aria-label="Expand sidebar"
                    title="Expand sidebar"
                  >
                    <Menu size={16} />
                  </button>
                )}
                <ProviderLogo provider={selectedSummary.session.provider} className="h-6 w-6" />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate text-[var(--app-fg)]">
                    {selectedSummary.session.title ?? selectedSummary.session.id}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] md:text-xs text-[var(--app-hint)] mt-0.5">
                    <span className="capitalize hidden sm:inline">{providerLabel(selectedSummary.session.provider)}</span>
                    <span className="hidden sm:inline">·</span>
                    <span>{selectedSummary.session.runtimeState}</span>
                    {selectedIsReadOnlyReplay ? (
                      <>
                        <span className="hidden sm:inline">·</span>
                        <span className="inline-flex rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
                          History
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="hidden sm:inline">·</span>
                        <span className="inline-flex rounded-full border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                          Live
                        </span>
                      </>
                    )}
                    {selectedSummary.usage?.percentRemaining !== undefined ? (
                      <>
                        <span className="hidden sm:inline">·</span>
                        <span className="hidden sm:inline">{selectedSummary.usage.percentRemaining}% context</span>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--app-border)] px-2 text-xs text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40 transition-colors"
                  disabled={!isAttached}
                  onClick={() => void closeSession(selectedSummary.session.id)}
                  title={isAttached ? "Close this session" : "This client is not attached"}
                >
                  <X size={14} className="mr-1" />
                  <span>Close</span>
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors md:hidden"
                  onClick={() => setRightOpen(true)}
                  aria-label="Open inspector"
                >
                  <PanelRight size={18} />
                </button>
              </div>
            </header>

            {interactionNotice ? (
              <div className="shrink-0 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3 text-sm text-[var(--app-hint)]">
                {interactionNotice}
              </div>
            ) : null}
            {historyNotice ? (
              <div className="shrink-0 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-2 text-xs text-[var(--app-hint)]">
                {historyNotice}
              </div>
            ) : null}

            <ChatThread
              feed={selectedProjection?.feed ?? []}
              hideToolCalls={hideToolCallsInChat}
              canLoadOlderHistory={Boolean(
                selectedSummary?.session.providerSessionId &&
                  selectedProjection?.history.authoritativeApplied &&
                  selectedProjection.history.nextBeforeTs,
              )}
              historyLoading={selectedProjection?.history.phase === "loading"}
              onLoadOlderHistory={() => {
                if (selectedSummary) {
                  void loadOlderHistory(selectedSummary.session.id);
                }
              }}
              canRespondToPermission={canRespondToPermission}
              onPermissionRespond={handlePermissionResponse}
            />

            {/* Composer */}
            <div className="shrink-0 border-t border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 md:px-4 md:py-3">
              {!canSendInput ? (
                <div className="mx-auto max-w-3xl">
                  {selectedIsReadOnlyReplay && selectedSummary?.session.providerSessionId ? (
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-[var(--app-fg)]">History only</div>
                        <div className="text-xs text-[var(--app-hint)]">Claim control to continue here.</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          clearLastHistorySelection();
                          void claimHistorySession(selectedSummary.session.id);
                        }}
                        className="shrink-0 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
                      >
                        Claim control
                      </button>
                    </div>
                  ) : (
                    <div className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3 text-sm text-[var(--app-hint)]">
                      Input is unavailable for this session.
                    </div>
                  )}
                </div>
              ) : (
                <div className="mx-auto max-w-3xl">
                  {!hasControl ? (
                    <div className="mb-2 px-1 text-xs text-[var(--app-hint)]">
                      Activating control…
                    </div>
                  ) : null}
                  <div className="flex items-end gap-2 md:gap-3">
                    <textarea
                      className="flex-1 resize-none bg-[var(--app-subtle-bg)] rounded-xl border border-[var(--app-border)] px-3 py-2 md:px-4 md:py-3 text-base text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] min-h-[44px] md:min-h-[48px] max-h-[160px]"
                      value={draft}
                      onChange={(e) => setDraft(e.currentTarget.value)}
                      placeholder={hasControl ? "Message…" : "Activating control…"}
                      rows={1}
                      disabled={!hasControl}
                      onKeyDown={(e) => {
                        if (!hasControl) {
                          return;
                        }
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void handleSend();
                        }
                      }}
                    />
                    {isGenerating && canSendInput && hasControl ? (
                      <div className="relative shrink-0">
                        <div className="pointer-events-none absolute inset-[-6px] rounded-full bg-[var(--app-danger)]/20 animate-ping" />
                        <div className="pointer-events-none absolute inset-[-5px] rounded-full border-[3px] border-dashed border-[var(--app-danger)]/45 animate-[spin_2.5s_linear_infinite]" />
                        <button
                          type="button"
                          onClick={() => void interruptSession(selectedSummary.session.id)}
                          className="relative h-11 w-11 md:h-12 md:w-12 rounded-full bg-[var(--app-danger)] text-white shadow-[0_0_0_4px_color-mix(in_oklab,var(--app-danger)_18%,transparent)] flex items-center justify-center hover:opacity-90 transition-colors"
                        >
                          <Square size={14} />
                        </button>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      disabled={!hasControl || !draft.trim()}
                      onClick={() => void handleSend()}
                      className="shrink-0 h-11 w-11 md:h-12 md:w-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 disabled:opacity-40 transition-colors"
                    >
                      <Send size={18} />
                    </button>
                  </div>

                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <header className="h-14 flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 bg-[var(--app-bg)]/80 backdrop-blur-sm shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors md:hidden"
                  onClick={() => setLeftOpen(true)}
                  aria-label="Open sidebar"
                >
                  <Menu size={18} />
                </button>
                {!sidebarOpen && (
                  <button
                    type="button"
                    className="hidden md:inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                    onClick={() => setSidebarOpen(true)}
                    aria-label="Expand sidebar"
                    title="Expand sidebar"
                  >
                    <Menu size={16} />
                  </button>
                )}
                <div className="min-w-0 md:hidden">
                  <div className="text-sm font-medium text-[var(--app-fg)]">RAH</div>
                  <div className="text-[11px] text-[var(--app-hint)]">
                    Open the sidebar
                  </div>
                </div>
              </div>
            </header>
            <div className="flex-1" />
          </>
        )}
      </main>

      {/* Desktop right inspector */}
      <aside className={`hidden md:flex w-80 flex-col shrink-0 ${selectedSummary ? "bg-[var(--app-subtle-bg)]" : "bg-[var(--app-bg)]"}`}>
        {inspectorContent}
      </aside>

      {/* Mobile right sheet */}
      <Sheet open={rightOpen} onOpenChange={setRightOpen} side="right" title="Inspector">
        {inspectorContent}
      </Sheet>

      {errorDescriptor ? (
        <div className="fixed bottom-4 left-1/2 z-[60] w-[min(92vw,48rem)] -translate-x-1/2">
          <StatusCallout
            tone="warning"
            title={errorDescriptor.title}
            body={errorDescriptor.body}
            {...(errorDescriptor.primaryAction === "refresh"
              ? {
                  primaryLabel: errorDescriptor.primaryLabel ?? "Refresh sessions",
                  onPrimary: () => void refreshWorkbenchState(),
                }
              : errorDescriptor.primaryAction === "claim_control" && selectedSummary
                ? {
                    primaryLabel: errorDescriptor.primaryLabel ?? "Claim control",
                    onPrimary: () => void claimControl(selectedSummary.session.id),
                  }
                : {})}
            secondaryLabel="Dismiss"
            onSecondary={clearError}
          />
        </div>
      ) : null}
      {launchStatus ? (
        <div className="fixed top-4 left-1/2 z-[60] w-[min(92vw,36rem)] -translate-x-1/2">
          <StatusCallout
            tone="info"
            title={`Starting ${providerLabel(launchStatus.provider)} session`}
            body={launchStatus.title ? `${launchStatus.title} · ${launchStatus.cwd}` : launchStatus.cwd}
            icon={<ProviderLogo provider={launchStatus.provider} className="h-5 w-5" />}
          />
        </div>
      ) : null}
    </div>
  );
}
