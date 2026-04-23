import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type { PermissionResponseRequest } from "@rah/runtime-protocol";
import { SessionSidebar } from "./SessionSidebar";
import { providerLabel } from "./types";
import { useSessionStore } from "./useSessionStore";
import { FileReferencePicker } from "./components/FileReferencePicker";
import type { ProviderChoice } from "./components/ProviderSelector";
import { GlobalWorkbenchCallout } from "./components/workbench/callouts/GlobalWorkbenchCallout";
import { ArchiveSessionDialog } from "./components/workbench/dialogs/ArchiveSessionDialog";
import { WorkbenchEmptyPane } from "./components/workbench/panes/WorkbenchEmptyPane";
import { WorkbenchOpeningPane } from "./components/workbench/panes/WorkbenchOpeningPane";
import { WorkbenchSelectedPane } from "./components/workbench/panes/WorkbenchSelectedPane";
import { WorkbenchInspectorShell } from "./components/workbench/shells/WorkbenchInspectorShell";
import { WorkbenchSidebarShell } from "./components/workbench/shells/WorkbenchSidebarShell";
import { useChatPreferences } from "./hooks/useChatPreferences";
import { useWorkbenchComposerState } from "./hooks/useWorkbenchComposerState";
import { useWorkbenchSelectionState } from "./hooks/useWorkbenchSelectionState";
import { initializeTheme } from "./hooks/useTheme";
import { useWorkbenchChromeState } from "./hooks/useWorkbenchChromeState";
import {
  useWorkbenchSidebarPreferences,
  useWorkspaceSortModeState,
} from "./hooks/useWorkbenchSidebarPreferences";
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

const SettingsDialog = lazy(async () => ({
  default: (await import("./components/workbench/dialogs/SettingsDialog")).SettingsDialog,
}));
const WorkbenchTerminalDialog = lazy(async () => ({
  default: (await import("./components/workbench/dialogs/WorkbenchTerminalDialog"))
    .WorkbenchTerminalDialog,
}));
const InspectorPane = lazy(async () => ({
  default: (await import("./InspectorPane")).InspectorPane,
}));

export function App() {
  const {
    init,
    refreshWorkbenchState,
    recoverTransport,
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
  const [archiveConfirmSessionId, setArchiveConfirmSessionId] = useState<string | null>(null);
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null);
  const { hideToolCallsInChat } = useChatPreferences();
  const { setWorkspaceSortMode, workspaceSortMode } = useWorkspaceSortModeState();
  const {
    fileReferenceOpen,
    isResizing,
    leftOpen,
    rightOpen,
    rightSidebarOpen,
    settingsOpen,
    sidebarOpen,
    sidebarWidth,
    startSidebarResize,
    terminalOpen,
    setFileReferenceOpen,
    setLeftOpen,
    setRightOpen,
    setRightSidebarOpen,
    setSettingsOpen,
    setSidebarOpen,
    setTerminalOpen,
  } = useWorkbenchChromeState();
  const {
    selectedWorkspaceOnlyDir,
    setSelectedWorkspaceOnlyDir,
    workspacePickerOpen,
    setWorkspacePickerOpen,
    workspacePickerRef,
  } = useWorkbenchSelectionState({
    selectedSessionId,
    workspaceDirs,
  });

  useEffect(() => {
    initializeTheme();
    void init();
  }, [init]);

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
  const {
    sanitizedPinnedSessionIdByWorkspace,
    togglePinnedSession,
  } = useWorkbenchSidebarPreferences(workspaceSections);

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
  const {
    composerRef,
    draft,
    emptyStateComposerRef,
    emptyStateDraft,
    sendPending,
    setDraft,
    setEmptyStateDraft,
    handleSend,
    handleEmptyStateSend,
    insertDraftReference,
    insertEmptyStateReference,
  } = useWorkbenchComposerState({
    selectedSummary,
    availableWorkspaceDir: workspaceDirs.length > 0 ? workspaceDir : "",
    newSessionProvider: newSessionProvider as ProviderChoice,
    sendInput,
    startSession,
  });

  const handlePermissionResponse = async (
    requestId: string,
    response: PermissionResponseRequest,
  ) => {
    if (!selectedSummary) return;
    await respondToPermission(selectedSummary.session.id, requestId, response);
  };

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

  const availableWorkspaceDir = workspaceDirs.length > 0 ? workspaceDir : "";
  const selectedInspectorWorkspaceDir = selectedSummary
    ? availableWorkspaceDir ||
      selectedSummary.session.rootDir ||
      selectedSummary.session.cwd ||
      ""
    : selectedWorkspaceOnlyDir ?? "";
  const sidebarContent = (
    <SessionSidebar
      workspaceSections={workspaceSections}
      workspaceSortMode={workspaceSortMode}
      onWorkspaceSortModeChange={setWorkspaceSortMode}
      pinnedSessionIdByWorkspace={sanitizedPinnedSessionIdByWorkspace}
      onTogglePinSession={togglePinnedSession}
      onAddWorkspace={(dir) => {
        void addWorkspace(dir);
        setLeftOpen(false);
      }}
      onRemoveWorkspace={(dir) => void removeWorkspace(dir)}
      selectedWorkspaceDir={selectedInspectorWorkspaceDir}
      selectedSessionId={selectedSessionId}
      unreadSessionIds={unreadSessionIds}
      runtimeStatusBySessionId={runtimeStatusBySessionId}
      onSelectSession={(workspaceDir, id) => {
        setSelectedWorkspaceOnlyDir(null);
        setWorkspaceDir(workspaceDir);
        setSelectedSessionId(id);
        setLeftOpen(false);
      }}
      onSelectWorkspace={(dir) => {
        setSelectedWorkspaceOnlyDir(dir);
        setWorkspaceDir(dir);
        setSelectedSessionId(null);
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

  const terminalCwd =
    selectedSummary?.session.rootDir ||
    selectedSummary?.session.cwd ||
    availableWorkspaceDir ||
    "~";
  const inspectorContent = selectedSummary || selectedWorkspaceOnlyDir ? (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-xs text-[var(--app-hint)]">
          Loading inspector…
        </div>
      }
    >
      <InspectorPane
        sessionId={selectedSummary?.session.id ?? null}
        workspaceRoot={selectedInspectorWorkspaceDir}
        events={selectedProjection?.events ?? []}
        onCollapse={() => setRightSidebarOpen(false)}
      />
    </Suspense>
  ) : (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--app-hint)]">
      Select a workspace or session to inspect files and changes.
    </div>
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
          startSidebarResize(e);
        }}
        sidebarContent={sidebarContent}
        storedSessions={storedSessions}
        recentSessions={recentSessions}
        liveSessions={liveSessionEntries.map((entry) => entry.summary)}
        onDesktopHome={() => {
          setSelectedWorkspaceOnlyDir(null);
          setSelectedSessionId(null);
          setRightSidebarOpen(false);
          setRightOpen(false);
        }}
        onMobileHome={() => {
          setSelectedWorkspaceOnlyDir(null);
          setSelectedSessionId(null);
          setRightSidebarOpen(false);
          setRightOpen(false);
          setLeftOpen(false);
        }}
        onActivateHistory={handleActivateHistorySession}
        onRemoveHistorySession={(session) => void removeHistorySession(session)}
        onRemoveHistoryWorkspace={(workspaceDir) => void removeHistoryWorkspaceSessions(workspaceDir)}
        onOpenSettings={() => setSettingsOpen(true)}
        onCollapseSidebar={() => setSidebarOpen(false)}
      />

      {settingsOpen ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 text-sm text-white">
              Loading settings…
            </div>
          }
        >
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        </Suspense>
      ) : null}

      {terminalOpen ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 text-sm text-white">
              Loading terminal…
            </div>
          }
        >
          <WorkbenchTerminalDialog
            open={terminalOpen}
            onOpenChange={setTerminalOpen}
            clientId={clientId}
            cwd={terminalCwd}
          />
        </Suspense>
      ) : null}

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
          onPick={selectedSummary ? insertDraftReference : insertEmptyStateReference}
        />
      ) : null}

      {/* Center chat */}
      <main className="flex-1 flex flex-col min-w-0 overflow-x-hidden overflow-y-hidden">
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
            sendPending={sendPending}
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
            onOpenTerminal={() => setTerminalOpen(true)}
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
            rightSidebarOpen={rightSidebarOpen}
            onOpenLeft={() => setLeftOpen(true)}
            onExpandSidebar={() => setSidebarOpen(true)}
            onOpenRight={() => setRightOpen(true)}
            onExpandInspector={() => setRightSidebarOpen(true)}
            onOpenTerminal={() => setTerminalOpen(true)}
          />
        ) : (
          <WorkbenchEmptyPane
            sidebarOpen={sidebarOpen}
            rightSidebarOpen={rightSidebarOpen}
            onOpenLeft={() => setLeftOpen(true)}
            onExpandSidebar={() => setSidebarOpen(true)}
            onOpenRight={() => setRightOpen(true)}
            onExpandInspector={() => setRightSidebarOpen(true)}
            onOpenTerminal={() => setTerminalOpen(true)}
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
        showDesktop={rightSidebarOpen || Boolean(selectedSummary || selectedWorkspaceOnlyDir)}
        desktopOpen={rightSidebarOpen}
        rightOpen={rightOpen}
        onRightOpenChange={setRightOpen}
        content={inspectorContent}
      />

      <GlobalWorkbenchCallout
        errorDescriptor={errorDescriptor}
        selectedSummary={selectedSummary}
        onRefresh={() =>
          void (errorDescriptor?.title === "Connection issue"
            ? recoverTransport()
            : refreshWorkbenchState())
        }
        onClaimControl={(sessionId) => void claimControl(sessionId)}
        onDismiss={clearError}
      />
    </div>
  );
}
