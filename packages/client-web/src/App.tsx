import { Suspense, lazy, useEffect, useMemo, useState, type CSSProperties } from "react";
import { PanelRight } from "lucide-react";
import type { PermissionResponseRequest } from "@rah/runtime-protocol";
import { SessionSidebar } from "./SessionSidebar";
import { providerLabel } from "./types";
import { useSessionStore } from "./useSessionStore";
import { FileReferencePicker } from "./components/FileReferencePicker";
import type { ProviderChoice } from "./components/ProviderSelector";
import { GlobalWorkbenchCallout } from "./components/workbench/callouts/GlobalWorkbenchCallout";
import { ArchiveSessionDialog } from "./components/workbench/dialogs/ArchiveSessionDialog";
import { ConfirmDialog } from "./components/workbench/dialogs/ConfirmDialog";
import { RenameSessionDialog } from "./components/workbench/dialogs/RenameSessionDialog";
import { WorkbenchErrorBoundary } from "./components/workbench/WorkbenchErrorBoundary";
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
  useHistoryWorkspaceSortModeState,
  useWorkbenchSidebarPreferences,
  useWorkspaceSortModeState,
} from "./hooks/useWorkbenchSidebarPreferences";
import {
  canSessionDelete,
  canSessionArchive,
  canSessionRename,
  canSessionSwitchModel,
  canSessionRespondToPermissions,
  canSessionSwitchModes,
  canSessionShowInfo,
  isSessionActivelyRunning,
  isReadOnlyReplay,
} from "./session-capabilities";
import {
  createDefaultModeDraft,
  resolveSessionModeControlState,
  type SessionModeDraft,
} from "./session-mode-ui";
import { resolveSelectedModelDraft } from "./components/SessionModelControls";
import { deriveComposerSurface } from "./composer-contract";
import {
  derivePrimaryPaneState,
  deriveWorkbenchSessionCollections,
  isSessionAttachedToClient,
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
    modelCatalogs,
    selectedSessionId,
    workspaceDir,
    newSessionProvider,
    pendingSessionTransition,
    pendingSessionAction,
    clientId,
    connectionId,
    isInitialLoaded,
    error,
    clearError,
    setWorkspaceDir,
    addWorkspace,
    removeWorkspace,
    setSelectedSessionId,
    setNewSessionProvider,
    loadProviderModels,
    startSession,
    startScenario,
    activateHistorySession,
    attachSession,
    closeSession,
    renameSession,
    setSessionMode,
    setSessionModel,
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
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [renameDialogSessionId, setRenameDialogSessionId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [modeChangeSessionId, setModeChangeSessionId] = useState<string | null>(null);
  const [modelChangeSessionId, setModelChangeSessionId] = useState<string | null>(null);
  const [startModelDrafts, setStartModelDrafts] = useState<
    Record<ProviderChoice, { modelId?: string | null; reasoningId?: string | null }>
  >({
    codex: {},
    claude: {},
    kimi: {},
    gemini: {},
    opencode: {},
  });
  const [startModeDrafts, setStartModeDrafts] = useState<Record<ProviderChoice, SessionModeDraft>>({
    codex: createDefaultModeDraft("codex"),
    claude: createDefaultModeDraft("claude"),
    kimi: createDefaultModeDraft("kimi"),
    gemini: createDefaultModeDraft("gemini"),
    opencode: createDefaultModeDraft("opencode"),
  });
  const [claimModeDrafts, setClaimModeDrafts] = useState<Record<string, SessionModeDraft>>({});
  const [claimModelDrafts, setClaimModelDrafts] = useState<
    Record<string, { modelId?: string | null; reasoningId?: string | null }>
  >({});
  const [missingWorkspaceConfirmDir, setMissingWorkspaceConfirmDir] = useState<string | null>(null);
  const [floatingAnchorOffsetPx, setFloatingAnchorOffsetPx] = useState(96);
  const { hideToolCallsInChat } = useChatPreferences();
  const { setWorkspaceSortMode, workspaceSortMode } = useWorkspaceSortModeState();
  const {
    setWorkspaceSortMode: setHistoryWorkspaceSortMode,
    workspaceSortMode: historyWorkspaceSortMode,
  } = useHistoryWorkspaceSortModeState();
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
    visualViewportBottomInsetPx,
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
  const isAttached = selectedSummary ? isSessionAttachedToClient(selectedSummary, clientId) : false;
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
  const deleteTargetSummary = deleteConfirmSessionId
    ? projections.get(deleteConfirmSessionId)?.summary ?? null
    : null;
  const renameTargetSummary = renameDialogSessionId
    ? projections.get(renameDialogSessionId)?.summary ?? null
    : null;
  const [missingWorkspaceResolver, setMissingWorkspaceResolver] =
    useState<((confirmed: boolean) => void) | null>(null);
  const primaryPaneState = derivePrimaryPaneState({
    selectedSummary,
    pendingSessionTransition,
  });
  const activeOpeningSession = primaryPaneState.openingSession;
  const currentProvider = newSessionProvider as ProviderChoice;
  const startModeControl = resolveSessionModeControlState({
    provider: currentProvider,
    draft: startModeDrafts[currentProvider],
  });
  const currentModelCatalogState = modelCatalogs[currentProvider];
  const startModelDraft = startModelDrafts[currentProvider];
  const startModelControl = resolveSelectedModelDraft({
    catalog: currentModelCatalogState?.catalog,
    selectedModelId: startModelDraft?.modelId,
    selectedReasoningId: startModelDraft?.reasoningId,
    allowProviderDefault: true,
  });
  const startModelId =
    startModelDraft?.modelId ??
    (startModelDraft?.reasoningId ? startModelControl.model?.id ?? null : null);
  const selectedModelCatalogState = selectedSummary
    ? modelCatalogs[selectedSummary.session.provider as ProviderChoice]
    : undefined;
  const claimModelDraft = selectedSummary ? claimModelDrafts[selectedSummary.session.id] : undefined;
  const claimModelControl = selectedSummary
    ? resolveSelectedModelDraft({
        catalog: selectedModelCatalogState?.catalog,
        selectedModelId:
          claimModelDraft?.modelId ?? selectedSummary.session.model?.currentModelId ?? null,
        selectedReasoningId:
          claimModelDraft?.reasoningId ??
          selectedSummary.session.model?.currentReasoningId ??
          null,
      })
    : null;
  const claimModeControl = selectedSummary
    ? resolveSessionModeControlState({
        provider: selectedSummary.session.provider,
        draft: claimModeDrafts[selectedSummary.session.id] ?? null,
        summary: selectedSummary,
      })
    : null;
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
    newSessionProvider: currentProvider,
    startModeId: startModeControl.effectiveModeId,
    startModelId,
    startReasoningId: startModelId ? startModelControl.reasoning?.id ?? null : null,
    sendInput,
    startSession,
  });

  useEffect(() => {
    void loadProviderModels(currentProvider).catch(() => undefined);
  }, [currentProvider, loadProviderModels]);

  useEffect(() => {
    if (selectedSummary?.session.provider !== undefined && selectedSummary.session.provider !== "custom") {
      void loadProviderModels(selectedSummary.session.provider as ProviderChoice).catch(() => undefined);
    }
  }, [loadProviderModels, selectedSummary?.session.provider]);

  const handlePermissionResponse = async (
    requestId: string,
    response: PermissionResponseRequest,
  ) => {
    if (!selectedSummary) return;
    await respondToPermission(selectedSummary.session.id, requestId, response);
  };

  useEffect(() => {
    if (!selectedSummary) {
      return;
    }
    if (selectedSummary.session.launchSource !== "terminal" || isAttached) {
      return;
    }
    void attachSession(selectedSummary);
  }, [attachSession, isAttached, selectedSummary]);

  useEffect(() => {
    const handleForegroundResume = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void recoverTransport();
    };
    const handlePageShow = () => {
      void recoverTransport();
    };
    const handleOnline = () => {
      void recoverTransport();
    };

    document.addEventListener("visibilitychange", handleForegroundResume);
    window.addEventListener("focus", handleForegroundResume);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("online", handleOnline);
    return () => {
      document.removeEventListener("visibilitychange", handleForegroundResume);
      window.removeEventListener("focus", handleForegroundResume);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("online", handleOnline);
    };
  }, [recoverTransport]);

  useEffect(() => {
    if (primaryPaneState.kind !== "active" || !selectedSummary) {
      setFloatingAnchorOffsetPx(96);
    }
  }, [primaryPaneState.kind, selectedSummary]);

  if (!isInitialLoaded) {
    return (
      <div className="h-[100dvh] min-h-[100dvh] flex items-center justify-center bg-background text-foreground">
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

  const confirmCreateMissingWorkspace = (dir: string) =>
    new Promise<boolean>((resolve) => {
      setMissingWorkspaceConfirmDir(dir);
      setMissingWorkspaceResolver(() => resolve);
    });

  const resolveMissingWorkspacePrompt = (confirmed: boolean) => {
    missingWorkspaceResolver?.(confirmed);
    setMissingWorkspaceResolver(null);
    setMissingWorkspaceConfirmDir(null);
  };

  const terminalCwd = selectedInspectorWorkspaceDir || "~";
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
        onOpenTerminal={() => setTerminalOpen(true)}
      />
    </Suspense>
  ) : (
    <div className="flex h-full flex-col">
      <div className="h-14 px-4 flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--app-fg)]">Inspector</div>
          <div className="text-xs text-[var(--app-hint)] truncate">No workspace or session selected</div>
        </div>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
          onClick={() => setRightSidebarOpen(false)}
          aria-label="Collapse inspector"
          title="Collapse inspector"
        >
          <PanelRight size={16} />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--app-hint)]">
        Select a workspace or session to inspect files and changes.
      </div>
    </div>
  );

  const rootStyle = {
    "--workbench-floating-anchor": `calc(env(safe-area-inset-bottom, 0px) + ${floatingAnchorOffsetPx + visualViewportBottomInsetPx}px)`,
    "--workbench-callout-anchor": `calc(var(--workbench-floating-anchor) + 3.5rem)`,
  } as CSSProperties;

  return (
    <div
      className="h-[100dvh] min-h-[100dvh] w-full max-w-full flex overflow-hidden overflow-x-hidden bg-background text-foreground"
      style={rootStyle}
    >
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
        workspaceSortMode={historyWorkspaceSortMode}
        onWorkspaceSortModeChange={setHistoryWorkspaceSortMode}
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
      <ConfirmDialog
        open={deleteConfirmSessionId !== null}
        pending={deletingSessionId !== null}
        confirmTone="danger"
        title="Delete session?"
        description={
          deleteTargetSummary ? (
            <>
              {isReadOnlyReplay(deleteTargetSummary)
                ? "Delete this history session?"
                : "Archive and then delete this live session?"}
              <div className="mt-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2.5 py-2 font-medium text-[var(--app-fg)]">
                {deleteTargetSummary.session.title ?? deleteTargetSummary.session.id}
              </div>
            </>
          ) : (
            "Delete this session?"
          )
        }
        confirmLabel={deletingSessionId ? "Deleting…" : "Delete"}
        onOpenChange={(open) => {
          if (!open && deletingSessionId === null) {
            setDeleteConfirmSessionId(null);
          }
        }}
        onConfirm={() => {
          if (!deleteConfirmSessionId || !deleteTargetSummary) {
            return;
          }
          setDeletingSessionId(deleteConfirmSessionId);
          const storedRef = deleteTargetSummary.session.providerSessionId
            ? {
                provider: deleteTargetSummary.session.provider,
                providerSessionId: deleteTargetSummary.session.providerSessionId,
              }
            : null;
          void closeSession(deleteConfirmSessionId)
            .then(async () => {
              if (storedRef) {
                await removeHistorySession(storedRef);
              }
              setDeleteConfirmSessionId(null);
            })
            .finally(() => setDeletingSessionId(null));
        }}
      />
      <RenameSessionDialog
        open={renameDialogSessionId !== null}
        pending={renamingSessionId !== null}
        initialTitle={renameTargetSummary?.session.title ?? ""}
        onOpenChange={(open) => {
          if (!open && renamingSessionId === null) {
            setRenameDialogSessionId(null);
          }
        }}
        onConfirm={(title) => {
          if (!renameDialogSessionId) {
            return;
          }
          setRenamingSessionId(renameDialogSessionId);
          void renameSession(renameDialogSessionId, title)
            .then(() => setRenameDialogSessionId(null))
            .finally(() => setRenamingSessionId(null));
        }}
      />
      <ConfirmDialog
        open={missingWorkspaceConfirmDir !== null}
        title="Workspace is missing"
        description={
          missingWorkspaceConfirmDir ? (
            <>
              Create this workspace before claiming control?
              <div className="mt-2 break-all rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2.5 py-2 font-mono text-xs text-[var(--app-fg)]">
                {missingWorkspaceConfirmDir}
              </div>
            </>
          ) : null
        }
        confirmLabel="Create workspace"
        onOpenChange={(open) => {
          if (!open) {
            resolveMissingWorkspacePrompt(false);
          }
        }}
        onConfirm={() => resolveMissingWorkspacePrompt(true)}
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

      <WorkbenchErrorBoundary resetKey={selectedSessionId ?? primaryPaneState.kind}>
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
                const sessionId = selectedSummary.session.id;
                const modelDraft = claimModelDrafts[sessionId];
                void claimHistorySession(sessionId, {
                  confirmCreateMissingWorkspace,
                  ...(claimModeControl?.effectiveModeId
                    ? { modeId: claimModeControl.effectiveModeId }
                    : {}),
                  ...(modelDraft?.modelId ? { modelId: modelDraft.modelId } : {}),
                  ...(modelDraft?.reasoningId ? { reasoningId: modelDraft.reasoningId } : {}),
                });
              }}
              claimAccessModes={claimModeControl?.accessModes ?? []}
              selectedClaimAccessModeId={claimModeControl?.selectedAccessModeId ?? null}
              claimPlanModeAvailable={claimModeControl?.planModeAvailable ?? false}
              claimPlanModeEnabled={claimModeControl?.planModeEnabled ?? false}
              claimModePending={pendingSessionAction?.kind === "claim_history"}
              selectedClaimModelId={claimModelControl?.model?.id ?? null}
              selectedClaimReasoningId={claimModelControl?.reasoning?.id ?? null}
              onClaimAccessModeChange={(modeId) => {
                setClaimModeDrafts((current) => ({
                  ...current,
                  [selectedSummary.session.id]: {
                    ...(current[selectedSummary.session.id] ??
                      createDefaultModeDraft(selectedSummary.session.provider as ProviderChoice)),
                    accessModeId: modeId,
                  },
                }));
              }}
              onClaimPlanModeToggle={(enabled) => {
                setClaimModeDrafts((current) => ({
                  ...current,
                  [selectedSummary.session.id]: {
                    ...(current[selectedSummary.session.id] ??
                      createDefaultModeDraft(selectedSummary.session.provider as ProviderChoice)),
                    planEnabled: enabled,
                  },
                }));
              }}
              onClaimModelChange={(modelId, defaultReasoningId) => {
                setClaimModelDrafts((current) => ({
                  ...current,
                  [selectedSummary.session.id]: {
                    modelId: modelId || null,
                    reasoningId: modelId ? defaultReasoningId ?? null : null,
                  },
                }));
              }}
              onClaimReasoningChange={(reasoningId) => {
                setClaimModelDrafts((current) => ({
                  ...current,
                  [selectedSummary.session.id]: {
                    ...(current[selectedSummary.session.id] ?? {}),
                    modelId:
                      current[selectedSummary.session.id]?.modelId ??
                      claimModelControl?.model?.id ??
                      null,
                    reasoningId,
                  },
                }));
              }}
              onClaimControl={() => {
                const sessionId = selectedSummary.session.id;
                const modeId = claimModeControl?.effectiveModeId ?? null;
                const modelDraft = claimModelDrafts[sessionId];
                const modelId = modelDraft?.modelId ?? null;
                const reasoningId =
                  modelDraft?.reasoningId ?? claimModelControl?.reasoning?.id ?? null;
                void (async () => {
                  try {
                    await claimControl(sessionId);
                    if (modeId) {
                      setModeChangeSessionId(sessionId);
                      await setSessionMode(sessionId, modeId).finally(() =>
                        setModeChangeSessionId((current) =>
                          current === sessionId ? null : current,
                        ),
                      );
                    }
                    if (modelId) {
                      setModelChangeSessionId(sessionId);
                      await setSessionModel(sessionId, modelId, reasoningId).finally(() =>
                        setModelChangeSessionId((current) =>
                          current === sessionId ? null : current,
                        ),
                      );
                    }
                  } catch {
                    // Store commands already surface errors through the global workbench error.
                  }
                })();
              }}
              onInterrupt={() => void interruptSession(selectedSummary.session.id)}
              onOpenFileReference={() => setFileReferenceOpen(true)}
              onLoadOlderHistory={() => {
                void loadOlderHistory(selectedSummary.session.id);
              }}
              onOpenLeft={() => setLeftOpen(true)}
              onExpandSidebar={() => setSidebarOpen(true)}
              onOpenRight={() => setRightOpen(true)}
              onExpandInspector={() => setRightSidebarOpen(true)}
              onFloatingAnchorOffsetChange={setFloatingAnchorOffsetPx}
              onArchiveOrClose={() => {
                if (selectedIsReadOnlyReplay) {
                  void closeSession(selectedSummary.session.id);
                  return;
                }
                setArchiveConfirmSessionId(selectedSummary.session.id);
              }}
              onDeleteSession={() => setDeleteConfirmSessionId(selectedSummary.session.id)}
              canArchiveSession={canSessionArchive(selectedSummary)}
              canDeleteSession={canSessionDelete(selectedSummary)}
              canShowSessionInfo={canSessionShowInfo(selectedSummary)}
              canRenameSession={canSessionRename(selectedSummary)}
              canSwitchSessionModes={canSessionSwitchModes(selectedSummary)}
              canSwitchSessionModel={canSessionSwitchModel(selectedSummary)}
              modeChangePending={modeChangeSessionId === selectedSummary.session.id}
              modelCatalog={selectedModelCatalogState?.catalog ?? null}
              modelCatalogLoading={selectedModelCatalogState?.loading ?? false}
              modelChangePending={modelChangeSessionId === selectedSummary.session.id}
              onRenameSession={() => setRenameDialogSessionId(selectedSummary.session.id)}
              onSetSessionMode={(modeId) => {
                setModeChangeSessionId(selectedSummary.session.id);
                void setSessionMode(selectedSummary.session.id, modeId).finally(() =>
                  setModeChangeSessionId((current) =>
                    current === selectedSummary.session.id ? null : current,
                  ),
                );
              }}
              onSetSessionModel={(modelId, reasoningId) => {
                setModelChangeSessionId(selectedSummary.session.id);
                void setSessionModel(selectedSummary.session.id, modelId, reasoningId).finally(() =>
                  setModelChangeSessionId((current) =>
                    current === selectedSummary.session.id ? null : current,
                  ),
                );
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
            />
          ) : (
            <WorkbenchEmptyPane
              sidebarOpen={sidebarOpen}
              rightSidebarOpen={rightSidebarOpen}
              onOpenLeft={() => setLeftOpen(true)}
              onExpandSidebar={() => setSidebarOpen(true)}
              onOpenRight={() => setRightOpen(true)}
              onExpandInspector={() => setRightSidebarOpen(true)}
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
              modelCatalog={currentModelCatalogState?.catalog ?? null}
              modelCatalogLoading={currentModelCatalogState?.loading ?? false}
              selectedModelId={startModelControl.model?.id ?? null}
              selectedReasoningId={startModelControl.reasoning?.id ?? null}
              onModelChange={(modelId, defaultReasoningId) => {
                setStartModelDrafts((current) => ({
                  ...current,
                  [currentProvider]: {
                    modelId: modelId || null,
                    reasoningId: modelId ? defaultReasoningId ?? null : null,
                  },
                }));
              }}
              onReasoningChange={(reasoningId) => {
                setStartModelDrafts((current) => ({
                  ...current,
                  [currentProvider]: {
                    ...(current[currentProvider] ?? {}),
                    modelId:
                      current[currentProvider]?.modelId ??
                      startModelControl.model?.id ??
                      null,
                    reasoningId,
                  },
                }));
              }}
              accessModes={startModeControl.accessModes}
              selectedAccessModeId={startModeControl.selectedAccessModeId}
              planModeAvailable={startModeControl.planModeAvailable}
              planModeEnabled={startModeControl.planModeEnabled}
              onAccessModeChange={(modeId) => {
                setStartModeDrafts((current) => ({
                  ...current,
                  [currentProvider]: {
                    ...(current[currentProvider] ?? createDefaultModeDraft(currentProvider)),
                    accessModeId: modeId,
                  },
                }));
              }}
              onPlanModeToggle={(enabled) => {
                setStartModeDrafts((current) => ({
                  ...current,
                  [currentProvider]: {
                    ...(current[currentProvider] ?? createDefaultModeDraft(currentProvider)),
                    planEnabled: enabled,
                  },
                }));
              }}
            />
          )}
        </main>

        <WorkbenchInspectorShell
          showDesktop
          desktopOpen={rightSidebarOpen}
          rightOpen={rightOpen}
          onRightOpenChange={setRightOpen}
          content={inspectorContent}
        />
      </WorkbenchErrorBoundary>

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
