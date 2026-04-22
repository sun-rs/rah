import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionResponseRequest } from "@rah/runtime-protocol";
import { InspectorPane } from "./InspectorPane";
import { SessionSidebar } from "./SessionSidebar";
import { providerLabel } from "./types";
import { useSessionStore } from "./useSessionStore";
import { FileReferencePicker } from "./components/FileReferencePicker";
import type { ProviderChoice } from "./components/ProviderSelector";
import {
  ArchiveSessionDialog,
  GlobalWorkbenchCallout,
  SettingsDialog,
  WorkbenchEmptyPane,
  WorkbenchInspectorShell,
  WorkbenchOpeningPane,
  WorkbenchSelectedPane,
  WorkbenchSidebarShell,
} from "./components/workbench";
import { useChatPreferences } from "./hooks/useChatPreferences";
import { initializeTheme } from "./hooks/useTheme";
import {
  canSessionRespondToPermissions,
  isSessionActivelyRunning,
  isReadOnlyReplay,
} from "./session-capabilities";
import { deriveComposerSurface } from "./composer-contract";
import {
  derivePrimaryPaneState,
  deriveWorkbenchSessionCollections,
} from "./workbench-selectors";
import { deriveWorkbenchNoticeState } from "./workbench-notice-contract";
import type { WorkspaceSortMode } from "./session-browser";

const WORKSPACE_SORT_MODE_KEY = "rah.workspace-sort-mode";
const PINNED_WORKSPACE_SESSION_KEY = "rah.pinned-session-by-workspace";

function readWorkspaceSortMode(): WorkspaceSortMode {
  if (typeof window === "undefined") {
    return "created";
  }
  try {
    const value = window.localStorage.getItem(WORKSPACE_SORT_MODE_KEY);
    return value === "updated" ? "updated" : "created";
  } catch {
    return "created";
  }
}

function readPinnedWorkspaceSessions(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(PINNED_WORKSPACE_SESSION_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function App() {
  const {
    init,
    refreshWorkbenchState,
    projections,
    unreadSessionIds,
    storedSessions,
    recentSessions,
    workspaceDirs,
    debugScenarios,
    selectedSessionId,
    workspaceDir,
    newSessionProvider,
    pendingSessionTransition,
    pendingSessionAction,
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
    activateHistorySession,
    closeSession,
    claimHistorySession,
    removeHistorySession,
    removeHistoryWorkspaceSessions,
    claimControl,
    releaseControl,
    interruptSession,
    sendInput,
    loadOlderHistory,
    respondToPermission,
  } = useSessionStore();
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [archiveConfirmSessionId, setArchiveConfirmSessionId] = useState<string | null>(null);
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null);
  const [fileReferenceOpen, setFileReferenceOpen] = useState(false);
  const [workspaceSortMode, setWorkspaceSortMode] = useState<WorkspaceSortMode>(() =>
    readWorkspaceSortMode(),
  );
  const [pinnedSessionIdByWorkspace, setPinnedSessionIdByWorkspace] = useState<Record<string, string>>(
    () => readPinnedWorkspaceSessions(),
  );
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem("rah-sidebar-open") !== "false"; } catch { return true; }
  });
  const [rightSidebarOpen, setRightSidebarOpen] = useState(() => {
    try { return localStorage.getItem("rah-right-sidebar-open") !== "false"; } catch { return true; }
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return Math.max(200, Math.min(480, Number(localStorage.getItem("rah-sidebar-width")) || 288)); } catch { return 288; }
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const [isResizing, setIsResizing] = useState(false);
  const [emptyStateDraft, setEmptyStateDraft] = useState("");
  const emptyStateComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const workspacePickerRef = useRef<HTMLDivElement>(null);
  const { hideToolCallsInChat } = useChatPreferences();

  useEffect(() => {
    initializeTheme();
    void init();
  }, [init]);

  useEffect(() => {
    if (!workspacePickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!workspacePickerRef.current?.contains(event.target as Node)) {
        setWorkspacePickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [workspacePickerOpen]);

  const sessionCollections = useMemo(
    () =>
      deriveWorkbenchSessionCollections({
        projections,
        clientId,
        workspaceDirs,
        storedSessions,
        workspaceDir,
        workspaceSortMode,
      }),
    [clientId, projections, storedSessions, workspaceDir, workspaceDirs, workspaceSortMode],
  );
  const {
    sessionEntries,
    liveSessionEntries,
    liveGroups,
    workspaceSections,
  } = sessionCollections;

  const sanitizedPinnedSessionIdByWorkspace = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(pinnedSessionIdByWorkspace).filter(([workspaceDir, sessionId]) =>
          workspaceSections.some(
            (section) =>
              section.workspace.directory === workspaceDir &&
              section.sessions.some((session) => session.session.id === sessionId),
          ),
        ),
      ),
    [pinnedSessionIdByWorkspace, workspaceSections],
  );

  const runtimeStatusBySessionId = useMemo(
    () =>
      new Map(
        [...projections.entries()].map(([sessionId, projection]) => [
          sessionId,
          projection.currentRuntimeStatus === "thinking" ||
          projection.currentRuntimeStatus === "streaming" ||
          projection.currentRuntimeStatus === "retrying"
            ? projection.currentRuntimeStatus
            : undefined,
        ]),
      ),
    [projections],
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
  const selectedIsReadOnlyReplay = selectedSummary ? isReadOnlyReplay(selectedSummary) : false;
  const noticeState = deriveWorkbenchNoticeState({
    selectedSummary,
    selectedProjection,
    error,
  });
  const interactionNotice = noticeState.interactionNotice;
  const historyNotice = noticeState.historyNotice;
  const errorDescriptor = noticeState.errorDescriptor;
  const isGenerating = selectedSummary ? isSessionActivelyRunning(selectedSummary) : false;
  const composerSurface = deriveComposerSurface({
    selectedSummary,
    hasControl: Boolean(hasControl),
    isGenerating,
    pendingSessionAction,
  });
  const archiveTargetSummary = archiveConfirmSessionId
    ? projections.get(archiveConfirmSessionId)?.summary ?? null
    : null;
  const primaryPaneState = derivePrimaryPaneState({
    selectedSummary,
    pendingSessionTransition,
  });
  const activeOpeningSession = primaryPaneState.openingSession;

  const handleSend = async () => {
    if (!selectedSummary || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    await sendInput(selectedSummary.session.id, text);
  };

  const insertFileReference = (reference: string) => {
    setDraft((current) => {
      const textarea = composerRef.current;
      if (!textarea) {
        return current ? `${current} ${reference}` : reference;
      }
      const selectionStart = textarea.selectionStart ?? current.length;
      const selectionEnd = textarea.selectionEnd ?? current.length;
      const prefixNeedsSpace =
        selectionStart > 0 && !/\s/.test(current.slice(Math.max(0, selectionStart - 1), selectionStart));
      const suffixNeedsSpace =
        selectionEnd < current.length && !/\s/.test(current.slice(selectionEnd, selectionEnd + 1));
      const inserted = `${prefixNeedsSpace ? " " : ""}${reference}${suffixNeedsSpace ? " " : ""}`;
      const next = `${current.slice(0, selectionStart)}${inserted}${current.slice(selectionEnd)}`;
      queueMicrotask(() => {
        if (!textarea) return;
        const caret = selectionStart + inserted.length;
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
      return next;
    });
  };

  const insertEmptyStateFileReference = (reference: string) => {
    setEmptyStateDraft((current) => {
      const textarea = emptyStateComposerRef.current;
      if (!textarea) {
        return current ? `${current} ${reference}` : reference;
      }
      const selectionStart = textarea.selectionStart ?? current.length;
      const selectionEnd = textarea.selectionEnd ?? current.length;
      const prefixNeedsSpace =
        selectionStart > 0 && !/\s/.test(current.slice(Math.max(0, selectionStart - 1), selectionStart));
      const suffixNeedsSpace =
        selectionEnd < current.length && !/\s/.test(current.slice(selectionEnd, selectionEnd + 1));
      const inserted = `${prefixNeedsSpace ? " " : ""}${reference}${suffixNeedsSpace ? " " : ""}`;
      const next = `${current.slice(0, selectionStart)}${inserted}${current.slice(selectionEnd)}`;
      queueMicrotask(() => {
        if (!textarea) return;
        const caret = selectionStart + inserted.length;
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
      return next;
    });
  };

  const handleEmptyStateSend = () => {
    const text = emptyStateDraft.trim();
    if (!text || !availableWorkspaceDir) return;
    setEmptyStateDraft("");
    void startSession({
      provider: newSessionProvider,
      cwd: availableWorkspaceDir,
      title: text.slice(0, 50),
      initialInput: text,
    });
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

  useEffect(() => {
    try { localStorage.setItem("rah-right-sidebar-open", String(rightSidebarOpen)); } catch {}
  }, [rightSidebarOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_SORT_MODE_KEY, workspaceSortMode);
    } catch {
      // ignore
    }
  }, [workspaceSortMode]);

  useEffect(() => {
    try {
      localStorage.setItem(
        PINNED_WORKSPACE_SESSION_KEY,
        JSON.stringify(sanitizedPinnedSessionIdByWorkspace),
      );
    } catch {
      // ignore
    }
  }, [sanitizedPinnedSessionIdByWorkspace]);

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
      workspaceSortMode={workspaceSortMode}
      onWorkspaceSortModeChange={setWorkspaceSortMode}
      pinnedSessionIdByWorkspace={sanitizedPinnedSessionIdByWorkspace}
      onTogglePinSession={(workspaceDir, sessionId) => {
        setPinnedSessionIdByWorkspace((current) => {
          if (current[workspaceDir] === sessionId) {
            const next = { ...current };
            delete next[workspaceDir];
            return next;
          }
          return {
            ...current,
            [workspaceDir]: sessionId,
          };
        });
      }}
      onAddWorkspace={(dir) => {
        void addWorkspace(dir);
        setLeftOpen(false);
      }}
      onRemoveWorkspace={(dir) => void removeWorkspace(dir)}
      selectedSessionId={selectedSessionId}
      unreadSessionIds={unreadSessionIds}
      runtimeStatusBySessionId={runtimeStatusBySessionId}
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
    setLeftOpen(false);
    void activateHistorySession(ref);
  };

  const availableWorkspaceDir = workspaceDirs.length > 0 ? workspaceDir : "";
  const inspectorContent =
    selectedSummary ? (
      <InspectorPane
        sessionId={selectedSummary.session.id}
        workspaceRoot={selectedSummary.session.rootDir || selectedSummary.session.cwd || ""}
        events={selectedProjection?.events ?? []}
        onCollapse={() => setRightSidebarOpen(false)}
      />
    ) : (
      <div className="h-full" />
    );

  return (
    <div className="h-screen w-full max-w-full flex overflow-hidden overflow-x-hidden bg-background text-foreground">
      <WorkbenchSidebarShell
        sidebarOpen={sidebarOpen}
        sidebarWidth={sidebarWidth}
        isResizing={isResizing}
        leftOpen={leftOpen}
        onLeftOpenChange={setLeftOpen}
        onResizeStart={(e) => {
          e.preventDefault();
          setIsResizing(true);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        sidebarContent={sidebarContent}
        storedSessions={storedSessions}
        recentSessions={recentSessions}
        liveSessions={liveSessionEntries.map((entry) => entry.summary)}
        onDesktopHome={() => setSelectedSessionId(null)}
        onMobileHome={() => {
          setSelectedSessionId(null);
          setLeftOpen(false);
        }}
        onActivateHistory={handleActivateHistorySession}
        onRemoveHistorySession={(session) => void removeHistorySession(session)}
        onRemoveHistoryWorkspace={(workspaceDir) => void removeHistoryWorkspaceSessions(workspaceDir)}
        onOpenSettings={() => setSettingsOpen(true)}
        onCollapseSidebar={() => setSidebarOpen(false)}
      />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <ArchiveSessionDialog
        open={archiveConfirmSessionId !== null}
        archiving={archivingSessionId !== null}
        targetSummary={archiveTargetSummary}
        onOpenChange={(open) => {
          if (!open && archivingSessionId === null) {
            setArchiveConfirmSessionId(null);
          }
        }}
        onConfirm={() => {
          if (!archiveConfirmSessionId) {
            return;
          }
          setArchivingSessionId(archiveConfirmSessionId);
          void closeSession(archiveConfirmSessionId)
            .then(() => setArchiveConfirmSessionId(null))
            .finally(() => setArchivingSessionId(null));
        }}
      />

      {selectedSummary || availableWorkspaceDir ? (
        <FileReferencePicker
          open={fileReferenceOpen}
          onOpenChange={setFileReferenceOpen}
          rootPath={
            selectedSummary?.session.rootDir ||
            selectedSummary?.session.cwd ||
            availableWorkspaceDir ||
            "/"
          }
          onPick={selectedSummary ? insertFileReference : insertEmptyStateFileReference}
        />
      ) : null}

      {/* Center chat */}
      <main className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
        {primaryPaneState.kind === "active" && selectedSummary ? (
          <WorkbenchSelectedPane
            selectedSummary={selectedSummary}
            selectedProjection={selectedProjection}
            selectedIsReadOnlyReplay={selectedIsReadOnlyReplay}
            sidebarOpen={sidebarOpen}
            rightSidebarOpen={rightSidebarOpen}
            isAttached={isAttached}
            interactionNotice={interactionNotice}
            historyNotice={historyNotice}
            hideToolCallsInChat={hideToolCallsInChat}
            canLoadOlderHistory={Boolean(
              selectedSummary.session.providerSessionId &&
                selectedProjection?.history.authoritativeApplied &&
                (selectedProjection.history.nextCursor ||
                  selectedProjection.history.nextBeforeTs),
            )}
            historyLoading={selectedProjection?.history.phase === "loading"}
            canRespondToPermission={canRespondToPermission}
            onPermissionRespond={handlePermissionResponse}
            composerSurface={composerSurface}
            composerRef={composerRef}
            draft={draft}
            onDraftChange={setDraft}
            onSend={() => void handleSend()}
            onClaimHistory={() => {
              void claimHistorySession(selectedSummary.session.id);
            }}
            onClaimControl={() => void claimControl(selectedSummary.session.id)}
            onInterrupt={() => void interruptSession(selectedSummary.session.id)}
            onOpenFileReference={() => setFileReferenceOpen(true)}
            onLoadOlderHistory={() => {
              void loadOlderHistory(selectedSummary.session.id);
            }}
            onOpenLeft={() => setLeftOpen(true)}
            onExpandSidebar={() => setSidebarOpen(true)}
            onOpenRight={() => setRightOpen(true)}
            onExpandInspector={() => setRightSidebarOpen(true)}
            onArchiveOrClose={() => {
              if (selectedIsReadOnlyReplay) {
                void closeSession(selectedSummary.session.id);
                return;
              }
              setArchiveConfirmSessionId(selectedSummary.session.id);
            }}
          />
        ) : primaryPaneState.kind === "opening" && activeOpeningSession ? (
          <WorkbenchOpeningPane
            openingSession={activeOpeningSession}
            sidebarOpen={sidebarOpen}
            onOpenLeft={() => setLeftOpen(true)}
            onExpandSidebar={() => setSidebarOpen(true)}
          />
        ) : (
          <WorkbenchEmptyPane
            sidebarOpen={sidebarOpen}
            onOpenLeft={() => setLeftOpen(true)}
            onExpandSidebar={() => setSidebarOpen(true)}
            emptyStateComposerRef={emptyStateComposerRef}
            emptyStateDraft={emptyStateDraft}
            onEmptyStateDraftChange={setEmptyStateDraft}
            onEmptyStateSend={handleEmptyStateSend}
            workspacePickerRef={workspacePickerRef}
            onOpenFileReference={() => setFileReferenceOpen(true)}
            workspaceDirs={workspaceDirs}
            availableWorkspaceDir={availableWorkspaceDir}
            workspacePickerOpen={workspacePickerOpen}
            onToggleWorkspacePicker={() => setWorkspacePickerOpen((v) => !v)}
            onSelectWorkspace={(dir) => {
              setWorkspaceDir(dir);
              setWorkspacePickerOpen(false);
            }}
            onAddWorkspace={(dir) => {
              void addWorkspace(dir);
            }}
            newSessionProvider={newSessionProvider as ProviderChoice}
            onChangeProvider={(value) => setNewSessionProvider(value)}
          />
        )}
      </main>

      <WorkbenchInspectorShell
        showDesktop={Boolean(selectedSummary)}
        desktopOpen={rightSidebarOpen}
        rightOpen={rightOpen}
        onRightOpenChange={setRightOpen}
        content={inspectorContent}
      />

      <GlobalWorkbenchCallout
        errorDescriptor={errorDescriptor}
        selectedSummary={selectedSummary}
        onRefresh={() => void refreshWorkbenchState()}
        onClaimControl={(sessionId) => void claimControl(sessionId)}
        onDismiss={clearError}
      />
    </div>
  );
}
