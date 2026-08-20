import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Eraser, MessageCircleMore, Plus, RotateCcw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { CouncilSnapshot, PermissionResponseRequest, SessionQueuedInput, StoredSessionRef } from "@rah/runtime-protocol";
import { SessionSidebar } from "./SessionSidebar";
import { providerModelCatalogKey, useSessionStore } from "./useSessionStore";
import { readErrorMessage } from "./session-store-bootstrap";
import type { ProviderChoice } from "./components/ProviderSelector";
import {
  GlobalWorkbenchNoticeHost,
  type GlobalWorkbenchNotice,
} from "./components/workbench/callouts/GlobalWorkbenchCallout";
import { StopSessionDialog } from "./components/workbench/dialogs/StopSessionDialog";
import { ConfirmDialog } from "./components/workbench/dialogs/ConfirmDialog";
import { RenameSessionDialog } from "./components/workbench/dialogs/RenameSessionDialog";
import { WorkbenchErrorBoundary } from "./components/workbench/WorkbenchErrorBoundary";
import { defaultRunningCouncilId } from "./council/CouncilsBrowser";
import { useCouncilController } from "./council/useCouncilController";
import { WorkbenchEmptyPane } from "./components/workbench/panes/WorkbenchEmptyPane";
import { WorkbenchOpeningPane } from "./components/workbench/panes/WorkbenchOpeningPane";
import {
  SessionSideDock,
} from "./components/workbench/session/SessionSideDock";
import {
  readRememberedSessionSideLayouts,
  rememberSessionSideLayouts,
  type SessionSideLayout,
} from "./components/workbench/session/session-side-state";
import { WorkbenchInspectorShell } from "./components/workbench/shells/WorkbenchInspectorShell";
import { WorkbenchSidebarShell } from "./components/workbench/shells/WorkbenchSidebarShell";
import { useChatPreferences } from "./hooks/useChatPreferences";
import { useNativeTuiDiagnostics } from "./hooks/useNativeTuiDiagnostics";
import { useWorkbenchComposerState } from "./hooks/useWorkbenchComposerState";
import { useWorkbenchSelectionState } from "./hooks/useWorkbenchSelectionState";
import { initializeTheme } from "./hooks/useTheme";
import { initializeAppearancePreferences } from "./hooks/useAppearancePreferences";
import { useWorkbenchChromeState } from "./hooks/useWorkbenchChromeState";
import { useCanvasController } from "./hooks/useCanvasController";
import { useVisibleCanvasSessionPreload } from "./hooks/useVisibleCanvasSessionPreload";
import {
  useForegroundSessionRecovery,
  useForegroundWakeRecovery,
} from "./hooks/useForegroundSessionRecovery";
import { useWorkbenchPageController } from "./hooks/useWorkbenchPageController";
import { useSessionModelDrafts } from "./hooks/useSessionModelDrafts";
import { useRuntimeCompatibilityNotice } from "./hooks/useRuntimeCompatibilityNotice";
import {
  useHistoryWorkspaceSortModeState,
  useWorkbenchSidebarPreferences,
  useWorkspaceSortModeState,
} from "./hooks/useWorkbenchSidebarPreferences";
import { useSidebarSectionOrders } from "./hooks/useSidebarSectionOrders";
import {
  canSessionArchive,
  canSessionDelete,
  canSessionStop,
  canSessionRename,
  canSessionSwitchModel,
  canSessionRespondToPermissions,
  canSessionSwitchModes,
  canSessionShowInfo,
  isSessionGenerationActive,
  isReadOnlyReplay,
} from "./session-capabilities";
import {
  createDefaultModeDraft,
  resolveSessionModeControlState,
  type SessionModeDraft,
} from "./session-mode-ui";
import { resolveSelectedModelDraft } from "./components/SessionModelControls";
import { deriveComposerSurface } from "./composer-contract";
import { type NotificationTarget } from "./browser-notifications";
import {
  derivePrimaryPaneState,
  deriveWorkbenchSessionCollections,
  isSessionAttachedToClient,
  projectionHasLatestTurnError,
} from "./workbench-selectors";
import { deriveWorkbenchNoticeState } from "./workbench-notice-contract";
import { buildModelOptionValuesFromReasoning } from "./provider-capabilities";
import { latestCompletedProviderTurnId } from "./session-branch-boundary";
import {
  resolveResponsiveTier,
  resolveSidePanelOpenForTier,
} from "./responsive-layout";
import { resolveStoredSessionRef } from "./session-store-session-lifecycle";
import { isStoredSessionArchived } from "./session-history-grouping";
import { latestFinalReplyNavigationTarget } from "./session-read-state";
import { TAIL_SESSION_NAVIGATION_TARGET } from "./session-conversation-navigation";
import {
  sameWorkspaceDirectory,
} from "./session-store-workspace";
import { InspectorFileDetailDialog } from "./inspector/InspectorFileDetailDialog";
import type { InspectorOpenFileRequest } from "./inspector/shared";
import { preloadSelectedSessionView } from "./session-view-preload";
import {
  CANVAS_PANE_IDS,
  canvasPaneLabel,
  canvasRestorableTargetKey,
  canvasStoredRefKey,
  canvasOpeningTransitionForTarget,
  clearCanvasCouncilTargets,
  clearCanvasSessionTargets,
  clearCanvasTargetsForStoredSession,
  createCanvasSessionTarget,
  createEmptyCanvasTargets,
  hasAnyCanvasPaneTarget,
  resolveCanvasResumedSessionId,
  resolveCanvasTargetProjection as resolveCanvasTargetProjectionFromState,
  resolveCanvasVisibleSessionId,
  type CanvasPaneId,
} from "./canvas-state";
import {
  CanvasNewSessionPane,
  CanvasSessionPane,
  CanvasWorkbench,
  CouncilPage,
  FileReferencePicker,
  InspectorPane,
  NewCouncilDialog,
  SessionHistoryDialog,
  SettingsDialog,
  WorkbenchSelectedPane,
  WorkbenchTerminalDialog,
} from "./app-lazy-components";
import { FilePreviewDialogErrorBoundary } from "./components/workbench/dialogs/FilePreviewDialogErrorBoundary";
import type { CanvasSessionDragTarget } from "./components/workbench/canvas/canvas-session-drag";
import {
  PROVIDER_CHOICES,
  createDefaultModeDrafts,
  createEmptyCanvasNewSessionDrafts,
  draftModelIdForCatalog,
  pruneModelDraftForCatalog,
  readRememberedModelDrafts,
  rememberModelDraft,
  sameModelDraft,
  writeRememberedModelDrafts,
  type CanvasNewSessionDraft,
  type ModelDraft,
} from "./new-session-drafts";

type BranchOperationKind = "fork" | "side";

type ArchiveConfirmationTarget =
  | {
      kind: "runtime";
      sessionId: string;
      title: string;
      running: boolean;
    }
  | {
      kind: "stored";
      session: Pick<StoredSessionRef, "provider" | "providerSessionId">;
      title: string;
      running: false;
    };

export function App() {
  const {
    init,
    refreshWorkbenchState,
    loadStoredSessionsCatalog,
    recoverTransport,
    projections,
    unreadSessionIds,
    storedSessions,
    optimisticallyArchivedSessionKeys,
    storedSessionsCatalogLoaded,
    storedSessionsCatalogDirty,
    recentSessions,
    workspaceDirs,
    hiddenWorkspaceDirs,
    pinnedSidebarItems,
    debugScenarios,
    modelCatalogs,
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
    setSidebarItemPinned,
    setSelectedSessionId,
    setNewSessionProvider,
    loadProviderModels,
    startSession,
    forkSession,
    startScenario,
    activateHistorySession,
    closeSession,
    renameSession,
    setSessionMode,
    setSessionModel,
    resumeHistorySession,
    archiveHistorySession,
    restoreHistorySession,
    removeHistorySession,
    setVisibleSessionIds,
    markSessionsRead,
    reconcileUnreadFromLastSeen,
    claimControl,
    interruptSession,
    cancelPendingSessionStartup,
    sendInput,
    updateQueuedInput,
    deleteQueuedInput,
    reorderQueuedInput,
    steerQueuedInput,
    ensureConversationLoaded,
    refreshConversation,
    loadOlderConversation,
    ensureSessionConversationDirectory,
    loadConversationDirectoryTurn,
    loadConversationItemDetail,
    loadConversationTurnDetail,
    respondToPermission,
  } = useSessionStore(
    useShallow((state) => ({
      init: state.init,
      refreshWorkbenchState: state.refreshWorkbenchState,
      loadStoredSessionsCatalog: state.loadStoredSessionsCatalog,
      recoverTransport: state.recoverTransport,
      projections: state.projections,
      unreadSessionIds: state.unreadSessionIds,
      storedSessions: state.storedSessions,
      optimisticallyArchivedSessionKeys: state.optimisticallyArchivedSessionKeys,
      storedSessionsCatalogLoaded: state.storedSessionsCatalogLoaded,
      storedSessionsCatalogDirty: state.storedSessionsCatalogDirty,
      recentSessions: state.recentSessions,
      workspaceDirs: state.workspaceDirs,
      hiddenWorkspaceDirs: state.hiddenWorkspaceDirs,
      pinnedSidebarItems: state.pinnedSidebarItems,
      debugScenarios: state.debugScenarios,
      modelCatalogs: state.modelCatalogs,
      selectedSessionId: state.selectedSessionId,
      workspaceDir: state.workspaceDir,
      newSessionProvider: state.newSessionProvider,
      pendingSessionTransition: state.pendingSessionTransition,
      pendingSessionAction: state.pendingSessionAction,
      clientId: state.clientId,
      isInitialLoaded: state.isInitialLoaded,
      error: state.error,
      clearError: state.clearError,
      setWorkspaceDir: state.setWorkspaceDir,
      addWorkspace: state.addWorkspace,
      removeWorkspace: state.removeWorkspace,
      setSidebarItemPinned: state.setSidebarItemPinned,
      setSelectedSessionId: state.setSelectedSessionId,
      setNewSessionProvider: state.setNewSessionProvider,
      loadProviderModels: state.loadProviderModels,
      startSession: state.startSession,
      forkSession: state.forkSession,
      startScenario: state.startScenario,
      activateHistorySession: state.activateHistorySession,
      closeSession: state.closeSession,
      renameSession: state.renameSession,
      setSessionMode: state.setSessionMode,
      setSessionModel: state.setSessionModel,
      resumeHistorySession: state.resumeHistorySession,
      archiveHistorySession: state.archiveHistorySession,
      restoreHistorySession: state.restoreHistorySession,
      removeHistorySession: state.removeHistorySession,
      setVisibleSessionIds: state.setVisibleSessionIds,
      markSessionsRead: state.markSessionsRead,
      reconcileUnreadFromLastSeen: state.reconcileUnreadFromLastSeen,
      claimControl: state.claimControl,
      interruptSession: state.interruptSession,
      cancelPendingSessionStartup: state.cancelPendingSessionStartup,
      sendInput: state.sendInput,
      updateQueuedInput: state.updateQueuedInput,
      deleteQueuedInput: state.deleteQueuedInput,
      reorderQueuedInput: state.reorderQueuedInput,
      steerQueuedInput: state.steerQueuedInput,
      ensureConversationLoaded: state.ensureConversationLoaded,
      refreshConversation: state.refreshConversation,
      loadOlderConversation: state.loadOlderConversation,
      ensureSessionConversationDirectory: state.ensureSessionConversationDirectory,
      loadConversationDirectoryTurn: state.loadConversationDirectoryTurn,
      loadConversationItemDetail: state.loadConversationItemDetail,
      loadConversationTurnDetail: state.loadConversationTurnDetail,
      respondToPermission: state.respondToPermission,
    })),
  );
  const [stopConfirmSessionId, setStopConfirmSessionId] = useState<string | null>(null);
  const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(null);
  const [archiveConfirmTarget, setArchiveConfirmTarget] =
    useState<ArchiveConfirmationTarget | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [renameDialogSessionId, setRenameDialogSessionId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDialogCouncilId, setRenameDialogCouncilId] = useState<string | null>(null);
  const [renamingCouncilId, setRenamingCouncilId] = useState<string | null>(null);
  const [modeChangeSessionId, setModeChangeSessionId] = useState<string | null>(null);
  const [modelChangeSessionId, setModelChangeSessionId] = useState<string | null>(null);
  const [startModeDrafts, setStartModeDrafts] =
    useState<Record<ProviderChoice, SessionModeDraft>>(() => createDefaultModeDrafts());
  const [resumeModeDrafts, setResumeModeDrafts] = useState<Record<string, SessionModeDraft>>({});
  const [missingWorkspaceConfirmDir, setMissingWorkspaceConfirmDir] = useState<string | null>(null);
  const [floatingAnchorOffsetPx, setFloatingAnchorOffsetPx] = useState(96);
  const [sideLayoutByParentId, setSideLayoutByParentId] = useState<
    Record<string, SessionSideLayout>
  >(() =>
    readRememberedSessionSideLayouts(
      typeof window === "undefined" ? undefined : window.localStorage,
    ),
  );
  useEffect(() => {
    rememberSessionSideLayouts(
      typeof window === "undefined" ? undefined : window.localStorage,
      sideLayoutByParentId,
    );
  }, [sideLayoutByParentId]);

  const {
    startModelDrafts,
    setStartModelDrafts,
    setResumeModelDrafts,
    modelDraftForSession,
    updateResumeModelDraft,
    startSessionWithRememberedModel,
  } = useSessionModelDrafts({ projections, startSession });
  const pendingBranchOperationsRef = useRef(new Map<string, BranchOperationKind>());
  const [pendingBranchOperations, setPendingBranchOperations] = useState<
    Map<string, BranchOperationKind>
  >(
    () => new Map(),
  );
  const {
    councils,
    selectedCouncilId,
    setSelectedCouncilId,
    unreadCouncilIds,
    updateCouncils,
    refreshCouncils,
    upsertCouncil,
    removeCouncil: removeCouncilFromChats,
    renameCouncil: renameCouncilFromChats,
  } = useCouncilController();
  const [homeNewCouncilDialogOpen, setHomeNewCouncilDialogOpen] = useState(false);
  const [pendingNewSessionWorkspaceDir, setPendingNewSessionWorkspaceDir] = useState<string | null>(
    null,
  );
  const [newTaskWorkspaceDir, setNewTaskWorkspaceDir] = useState("");
  const [canvasNewSessionDrafts, setCanvasNewSessionDrafts] =
    useState<Record<CanvasPaneId, CanvasNewSessionDraft>>(() =>
      createEmptyCanvasNewSessionDrafts(),
    );
  const [linkedFilePreviewPath, setLinkedFilePreviewPath] = useState<string | null>(null);
  const [mainInspectorOpenRequest, setMainInspectorOpenRequest] =
    useState<InspectorOpenFileRequest | null>(null);
  const [canvasInspectorOpenRequests, setCanvasInspectorOpenRequests] = useState<
    Partial<Record<CanvasPaneId, InspectorOpenFileRequest>>
  >({});
  const [settingsDialogMounted, setSettingsDialogMounted] = useState(false);
  const [terminalDialogMounted, setTerminalDialogMounted] = useState(false);
  const {
    hideToolCallsInChat,
    hideOpenCodeReasoningInChat,
    showModelInfoInChat,
  } = useChatPreferences();
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
    resetSidebarWidth,
    startSidebarResize,
    terminalOpen,
    visualViewportBottomInsetPx,
    viewportWidthPx,
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
  const pageController = useWorkbenchPageController({
    setSelectedSessionId,
    setSelectedCouncilId,
    setSelectedWorkspaceOnlyDir,
    setLeftOpen,
    setRightOpen,
    setRightSidebarOpen,
  });
  const selectNewTaskWorkspace = useCallback((dir: string) => {
    setPendingNewSessionWorkspaceDir(null);
    setNewTaskWorkspaceDir(dir);
    setWorkspaceDir(dir);
    setWorkspacePickerOpen(false);
  }, [setWorkspaceDir, setWorkspacePickerOpen]);
  const openNewTaskInWorkspace = useCallback((dir: string) => {
    selectNewTaskWorkspace(dir);
    pageController.openWorkspace(dir);
  }, [pageController.openWorkspace, selectNewTaskWorkspace]);
  const workbenchMode = pageController.mode;
  const viewportTier = resolveResponsiveTier(viewportWidthPx);
  const {
    canvasMaximizedPaneId,
    activeCanvasPaneId,
    canvasPaneTargets,
    canvasPaneRightPanelsOpen,
    canvasStoredActivationInFlightRef,
    canvasResumingStoredKeysRef,
    canvasResumingStoredKeys,
    canvasPendingSessionActions,
    canvasRestoreErrors,
    mobileCanvasLayoutOnly,
    effectiveCanvasLayout,
    visibleCanvasPaneIds,
    setActiveCanvasPaneId,
    setMobileCanvasLayout,
    setCanvasPaneTargets,
    setCanvasMaximizedPaneId,
    setCanvasPaneRightPanelOpen,
    toggleCanvasPaneRightPanel,
    markCanvasResumePending,
    clearCanvasResumePending,
    setCanvasLayout,
    splitCanvasPane,
    removeCanvasPane,
    setCanvasPaneTarget,
    reportCanvasRestoreError,
    clearCanvasRestoreError,
    toggleCanvasPaneMaximize,
  } = useCanvasController({
    projections,
    viewportWidthPx,
    workbenchMode,
  });

  useEffect(() => {
    initializeTheme();
    initializeAppearancePreferences();
    void init();
  }, [init]);

  const runtimeCompatibilityNotice = useRuntimeCompatibilityNotice();

  useEffect(() => {
    if (!isInitialLoaded) {
      return;
    }
    void loadStoredSessionsCatalog();
  }, [isInitialLoaded, loadStoredSessionsCatalog]);

  useEffect(() => {
    if (newTaskWorkspaceDir) {
      return;
    }
    const initialWorkspaceDir = workspaceDir.trim() || workspaceDirs[0] || "";
    if (initialWorkspaceDir) {
      setNewTaskWorkspaceDir(initialWorkspaceDir);
    }
  }, [newTaskWorkspaceDir, workspaceDir, workspaceDirs]);

  const openCreatedCouncil = useCallback((council: CouncilSnapshot) => {
    upsertCouncil(council);
    pageController.openCouncil(council.workspace, council.id);
    void refreshCouncils();
  }, [pageController.openCouncil, refreshCouncils, upsertCouncil]);

  const councilProviderSessionKeys = useMemo(
    () => new Set(
      councils.flatMap((council) =>
        council.agents.flatMap((agent) =>
          (agent.providerSessionIds ?? []).map(
            (providerSessionId) => `${agent.provider}:${providerSessionId}`,
          ),
        ),
      ),
    ),
    [councils],
  );
  const visibleStoredSessions = useMemo(
    () => storedSessions.filter(
      (session) => {
        const key = `${session.provider}:${session.providerSessionId}`;
        return (
          !councilProviderSessionKeys.has(key) &&
          !optimisticallyArchivedSessionKeys.has(key)
        );
      },
    ),
    [councilProviderSessionKeys, optimisticallyArchivedSessionKeys, storedSessions],
  );
  const visibleRecentSessions = useMemo(
    () => recentSessions.filter((session) => {
      const key = `${session.provider}:${session.providerSessionId}`;
      return (
        !councilProviderSessionKeys.has(key) &&
        !optimisticallyArchivedSessionKeys.has(key)
      );
    }),
    [councilProviderSessionKeys, optimisticallyArchivedSessionKeys, recentSessions],
  );
  const sessionCollections = useMemo(() => {
    const visibleProjections = new Map(
      [...projections].filter(([, projection]) => {
        if (projection.summary.session.origin?.kind === "council") {
          return false;
        }
        const providerSessionId = projection.summary.session.providerSessionId;
        if (!providerSessionId) {
          return true;
        }
        const key = `${projection.summary.session.provider}:${providerSessionId}`;
        return (
          !councilProviderSessionKeys.has(key) &&
          !optimisticallyArchivedSessionKeys.has(key)
        );
      }),
    );
    return deriveWorkbenchSessionCollections({
        projections: visibleProjections,
        clientId,
        workspaceDirs,
        storedSessions: visibleStoredSessions,
        workspaceDir,
        workspaceSortMode,
        hiddenWorkspaceDirs,
      });
  }, [
    clientId,
    councilProviderSessionKeys,
    hiddenWorkspaceDirs,
    optimisticallyArchivedSessionKeys,
    projections,
    visibleStoredSessions,
    workspaceDir,
    workspaceDirs,
    workspaceSortMode,
  ]);
  const {
    runningSessionEntries,
    runningSessionActivityAtById,
    sideSessionEntries,
    sidebarStoredSessions,
    workspaceSections,
  } = sessionCollections;
  const {
    sanitizedPinnedSidebarItems,
    togglePinnedSidebarItem,
  } = useWorkbenchSidebarPreferences(
    pinnedSidebarItems,
    workspaceSections,
    sidebarStoredSessions,
    {
      sessions: isInitialLoaded,
      storedSessions: storedSessionsCatalogLoaded && !storedSessionsCatalogDirty,
    },
    setSidebarItemPinned,
  );
  const sidebarSectionOrders = useSidebarSectionOrders(
    sanitizedPinnedSidebarItems,
    councils,
  );

  const sideProjectionsByParentId = useMemo(() => {
    const grouped = new Map<string, typeof sideSessionEntries>();
    for (const entry of sideSessionEntries) {
      const parentSessionId = entry.summary.session.relationship?.parentSessionId;
      if (!parentSessionId) {
        continue;
      }
      const siblings = grouped.get(parentSessionId) ?? [];
      siblings.push(entry);
      grouped.set(parentSessionId, siblings);
    }
    return grouped;
  }, [sideSessionEntries]);

  const handleForkSession = useCallback(
    (parentSessionId: string, kind: BranchOperationKind) => {
      if (pendingBranchOperationsRef.current.has(parentSessionId)) {
        return;
      }
      const lastTurnId = latestCompletedProviderTurnId(
        projections.get(parentSessionId)?.conversation?.turns,
      );
      pendingBranchOperationsRef.current.set(parentSessionId, kind);
      setPendingBranchOperations(new Map(pendingBranchOperationsRef.current));
      void forkSession(parentSessionId, {
        kind,
        workspaceMode: "shared",
        ...(lastTurnId ? { lastTurnId } : {}),
      })
        .catch(() => undefined)
        .finally(() => {
          pendingBranchOperationsRef.current.delete(parentSessionId);
          setPendingBranchOperations(new Map(pendingBranchOperationsRef.current));
        });
    },
    [forkSession, projections],
  );

  const handleRecreateSide = useCallback(
    (parentSessionId: string, sideSessionId: string) => {
      void closeSession(sideSessionId)
        .then(() => handleForkSession(parentSessionId, "side"))
        .catch(() => undefined);
    },
    [closeSession, handleForkSession],
  );

  const handleOpenQueuedInputSide = useCallback(
    async (parentSessionId: string, item: SessionQueuedInput) => {
      if (pendingBranchOperationsRef.current.has(parentSessionId)) {
        return;
      }
      const lastTurnId = latestCompletedProviderTurnId(
        projections.get(parentSessionId)?.conversation?.turns,
      );
      pendingBranchOperationsRef.current.set(parentSessionId, "side");
      setPendingBranchOperations(new Map(pendingBranchOperationsRef.current));
      try {
        const sideSessionId = await forkSession(parentSessionId, {
          kind: "side",
          workspaceMode: "shared",
          ...(lastTurnId ? { lastTurnId } : {}),
        });
        await sendInput(
          sideSessionId,
          item.text,
          item.attachments,
          item.annotations?.length ? { annotations: item.annotations } : undefined,
        );
        await deleteQueuedInput(parentSessionId, item.clientMessageId);
      } finally {
        pendingBranchOperationsRef.current.delete(parentSessionId);
        setPendingBranchOperations(new Map(pendingBranchOperationsRef.current));
      }
    },
    [deleteQueuedInput, forkSession, projections, sendInput],
  );

  const runtimeStatusBySessionId = useMemo(
    () =>
      new Map(
        [...projections.entries()].map(([sessionId, projection]) => [
          sessionId,
          projection.currentRuntimeStatus === "thinking" ||
          projection.currentRuntimeStatus === "streaming" ||
          projection.currentRuntimeStatus === "stopping" ||
          projection.currentRuntimeStatus === "retrying"
            ? projection.currentRuntimeStatus
            : undefined,
        ]),
      ),
    [projections],
  );
  const erroredSessionIds = useMemo(
    () =>
      new Set(
        [...projections.entries()]
          .filter(([, projection]) => projectionHasLatestTurnError(projection))
          .map(([sessionId]) => sessionId),
      ),
    [projections],
  );

  const effectiveCanvasMaximizedPaneId = canvasMaximizedPaneId;
  const resolveCanvasProjection = (paneId: CanvasPaneId) => {
    const target = canvasPaneTargets[paneId];
    return resolveCanvasTargetProjectionFromState(target, projections);
  };
  const resolveCanvasCouncil = (paneId: CanvasPaneId) => {
    const target = canvasPaneTargets[paneId];
    if (target.kind !== "council") {
      return null;
    }
    return councils.find((council) => council.id === target.councilId) ?? null;
  };
  const activeCanvasProjection = resolveCanvasProjection(activeCanvasPaneId);
  const activeCanvasSummary = activeCanvasProjection?.summary ?? null;
  const activeCanvasCouncil = resolveCanvasCouncil(activeCanvasPaneId);
  const visibleCanvasPaneKey = visibleCanvasPaneIds.join(":");
  const visibleNotificationTargets = useMemo<NotificationTarget[]>(() => {
    const targets: NotificationTarget[] = [];
    const seen = new Set<string>();
    const addTarget = (target: NotificationTarget) => {
      const key = `${target.kind}:${target.id}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      targets.push(target);
    };

    if (workbenchMode === "canvas") {
      for (const paneId of visibleCanvasPaneIds) {
        const target = canvasPaneTargets[paneId];
        const sessionId = resolveCanvasVisibleSessionId(target, projections);
        if (sessionId) {
          addTarget({ kind: "session", id: sessionId });
        } else if (target.kind === "council") {
          addTarget({ kind: "council", id: target.councilId });
        }
      }
      return targets;
    }

    if (workbenchMode === "council" && selectedCouncilId) {
      addTarget({ kind: "council", id: selectedCouncilId });
      return targets;
    }

    if (selectedSessionId) {
      addTarget({ kind: "session", id: selectedSessionId });
    }
    return targets;
  }, [
    canvasPaneTargets,
    projections,
    selectedCouncilId,
    selectedSessionId,
    visibleCanvasPaneKey,
    workbenchMode,
  ]);
  const foregroundSessionRecovery = useForegroundSessionRecovery({
    visibleNotificationTargets,
    projections,
    isInitialLoaded,
    refreshConversation,
    recoverTransport,
    reconcileUnreadFromLastSeen,
    markSessionsRead,
    setVisibleSessionIds,
  });

  const openLinkedFilePreview = useCallback((path: string) => {
    setLinkedFilePreviewPath(path);
  }, []);

  useEffect(() => {
    setMainInspectorOpenRequest(null);
  }, [selectedSessionId]);

  const setCanvasPaneSession = (paneId: CanvasPaneId, sessionId: string) => {
    setCanvasInspectorOpenRequests((current) => {
      if (!current[paneId]) {
        return current;
      }
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    setCanvasPaneTarget(paneId, createCanvasSessionTarget(sessionId, projections));
    setSelectedSessionId(sessionId);
  };

  const setCanvasPaneStoredRef = (paneId: CanvasPaneId, ref: StoredSessionRef) => {
    setCanvasInspectorOpenRequests((current) => {
      if (!current[paneId]) {
        return current;
      }
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    setCanvasPaneTarget(paneId, { kind: "stored", ref });
  };

  const setCanvasPaneSessionTarget = (
    paneId: CanvasPaneId,
    target: CanvasSessionDragTarget,
  ) => {
    if (target.kind === "runtime") {
      setCanvasPaneSession(paneId, target.sessionId);
      return;
    }
    const ref = storedSessions.find(
      (session) =>
        session.provider === target.provider &&
        session.providerSessionId === target.providerSessionId,
    );
    if (ref) {
      setCanvasPaneStoredRef(paneId, ref);
    }
  };

  const setCanvasPaneCouncil = (paneId: CanvasPaneId, councilId: string) => {
    setCanvasInspectorOpenRequests((current) => {
      if (!current[paneId]) {
        return current;
      }
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    setCanvasPaneTarget(paneId, { kind: "council", councilId });
    setSelectedCouncilId(councilId);
  };

  const clearCanvasPane = (paneId: CanvasPaneId) => {
    const projection = resolveCanvasProjection(paneId);
    const council = resolveCanvasCouncil(paneId);
    const sessionId = projection?.summary.session.id;
    const shouldCloseReadOnlyReplay = projection ? isReadOnlyReplay(projection.summary) : false;
    setCanvasInspectorOpenRequests((current) => {
      if (!current[paneId]) {
        return current;
      }
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    setCanvasPaneTarget(paneId, { kind: "empty" });
    setCanvasPaneRightPanelOpen(paneId, false);
    if (sessionId && selectedSessionId === sessionId) {
      setSelectedSessionId(null);
    }
    if (council?.id && selectedCouncilId === council.id) {
      setSelectedCouncilId(null);
    }
    if (sessionId && shouldCloseReadOnlyReplay) {
      void closeSession(sessionId);
    }
  };

  const removeCanvasPaneAndContent = (paneId: CanvasPaneId) => {
    const projection = resolveCanvasProjection(paneId);
    const council = resolveCanvasCouncil(paneId);
    const sessionId = projection?.summary.session.id;
    const shouldCloseReadOnlyReplay = projection ? isReadOnlyReplay(projection.summary) : false;
    if (!removeCanvasPane(paneId)) {
      return;
    }
    setCanvasInspectorOpenRequests((current) => {
      if (!current[paneId]) {
        return current;
      }
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    if (sessionId && selectedSessionId === sessionId) {
      setSelectedSessionId(null);
    }
    if (council?.id && selectedCouncilId === council.id) {
      setSelectedCouncilId(null);
    }
    if (sessionId && shouldCloseReadOnlyReplay) {
      void closeSession(sessionId);
    }
  };

  const clearAllCanvasPanes = () => {
    const readOnlySessionIds = new Set<string>();
    const clearedSessionIds = new Set<string>();
    const clearedCouncilIds = new Set<string>();
    for (const paneId of CANVAS_PANE_IDS) {
      const projection = resolveCanvasProjection(paneId);
      const council = resolveCanvasCouncil(paneId);
      if (projection) {
        clearedSessionIds.add(projection.summary.session.id);
        if (isReadOnlyReplay(projection.summary)) {
          readOnlySessionIds.add(projection.summary.session.id);
        }
      }
      if (council) {
        clearedCouncilIds.add(council.id);
      }
    }
    setCanvasPaneTargets(createEmptyCanvasTargets());
    setCanvasMaximizedPaneId(null);
    if (selectedSessionId && clearedSessionIds.has(selectedSessionId)) {
      setSelectedSessionId(null);
    }
    if (selectedCouncilId && clearedCouncilIds.has(selectedCouncilId)) {
      setSelectedCouncilId(null);
    }
    for (const sessionId of readOnlySessionIds) {
      void closeSession(sessionId);
    }
  };

  const removeHistorySessionAndClearCanvasTargets = async (
    session: Pick<StoredSessionRef, "provider" | "providerSessionId">,
    options?: { sessionId?: string | null },
  ) => {
    await removeHistorySession(session);
    setCanvasPaneTargets((current) =>
      clearCanvasTargetsForStoredSession(current, session, options),
    );
  };
  const archiveHistorySessionAndClearCanvasTargets = async (
    session: Pick<StoredSessionRef, "provider" | "providerSessionId">,
  ) => {
    const replay = [...useSessionStore.getState().projections.values()].find(
      (entry) =>
        entry.summary.session.provider === session.provider &&
        entry.summary.session.providerSessionId === session.providerSessionId &&
        isReadOnlyReplay(entry.summary),
    );
    await archiveHistorySession(
      session,
      replay ? { runtimeSessionId: replay.summary.session.id } : undefined,
    );
    setCanvasPaneTargets((current) =>
      clearCanvasTargetsForStoredSession(current, session, {
        ...(replay ? { sessionId: replay.summary.session.id } : {}),
      }),
    );
    if (replay && useSessionStore.getState().selectedSessionId === replay.summary.session.id) {
      setSelectedSessionId(null);
    }
  };
  const archiveSessionAndClearCanvasTargets = async (sessionId: string) => {
    const summary = useSessionStore.getState().projections.get(sessionId)?.summary;
    const providerSessionId = summary?.session.providerSessionId;
    if (!summary || !providerSessionId) {
      return;
    }
    const storedRef = {
      provider: summary.session.provider,
      providerSessionId,
    };
    await archiveHistorySession(storedRef, { runtimeSessionId: sessionId });
    setCanvasPaneTargets((current) =>
      clearCanvasTargetsForStoredSession(current, storedRef, { sessionId }),
    );
    if (useSessionStore.getState().selectedSessionId === sessionId) {
      setSelectedSessionId(null);
    }
  };
  const requestArchiveHistorySession = (
    session: Pick<StoredSessionRef, "provider" | "providerSessionId">,
  ) => {
    const current = useSessionStore.getState();
    const stored = [...current.storedSessions, ...current.recentSessions].find(
      (candidate) =>
        candidate.provider === session.provider &&
        candidate.providerSessionId === session.providerSessionId,
    );
    setArchiveConfirmTarget({
      kind: "stored",
      session,
      title: stored?.title ?? stored?.preview ?? session.providerSessionId,
      running: false,
    });
  };
  const requestArchiveRuntimeSession = (sessionId: string) => {
    const summary = useSessionStore.getState().projections.get(sessionId)?.summary;
    if (!summary?.session.providerSessionId) {
      return;
    }
    setArchiveConfirmTarget({
      kind: "runtime",
      sessionId,
      title: summary.session.title ?? summary.session.preview ?? summary.session.id,
      running: summary.session.status === "running" && !isReadOnlyReplay(summary),
    });
  };
  const removeFilteredHistoryWorkspaceSessions = async (
    _workspaceDir: string,
    sessions: readonly StoredSessionRef[],
  ) => {
    if (sessions.length === 0) {
      return;
    }
    for (const session of sessions) {
      await removeHistorySessionAndClearCanvasTargets(session);
    }
  };

  const stopSessionAndClearCanvasPane = async (sessionId: string) => {
    const affectedPaneTargets = new Map(CANVAS_PANE_IDS.flatMap((paneId) => {
      const target = canvasPaneTargets[paneId];
      return target.kind === "session" && target.sessionId === sessionId
        ? [[paneId, target] as const]
        : [];
    }));
    if (affectedPaneTargets.size === 0) {
      await closeSession(sessionId);
      return;
    }

    setCanvasPaneTargets((current) => clearCanvasSessionTargets(current, sessionId));
    try {
      await closeSession(sessionId);
    } catch (caught) {
      setCanvasPaneTargets((current) => {
        let changed = false;
        const next = { ...current };
        for (const [paneId, target] of affectedPaneTargets) {
          if (current[paneId].kind === "empty") {
            next[paneId] = target;
            changed = true;
          }
        }
        return changed ? next : current;
      });
      throw caught;
    }
  };

  const enterCanvasMode = () => {
    pageController.enterCanvas();
  };

  const exitCanvasMode = () => {
    pageController.exitCanvas({
      sessionId: activeCanvasSummary?.session.id ?? null,
      councilId: activeCanvasCouncil?.id ?? null,
    });
  };

  const hideCouncilMode = pageController.hideCouncil;
  const goHome = pageController.goHome;

  const selectedProjection = selectedSessionId ? projections.get(selectedSessionId) ?? null : null;
  const selectedSummary = selectedProjection?.summary ?? null;
  const selectedNativeTuiDiagnostics = useNativeTuiDiagnostics(
    selectedSummary?.session.nativeTui ? selectedSummary.session.id : null,
  );
  const isAttached = selectedSummary ? isSessionAttachedToClient(selectedSummary, clientId) : false;
  const hasControl = selectedSummary?.controlLease.holderClientId === clientId;
  const canRespondToPermission = selectedSummary
    ? canSessionRespondToPermissions(selectedSummary)
    : false;
  const selectedIsReadOnlyReplay = selectedSummary ? isReadOnlyReplay(selectedSummary) : false;
  const selectedStoredRef = selectedSummary
    ? resolveStoredSessionRef(selectedSummary, recentSessions, storedSessions)
    : null;
  const noticeState = deriveWorkbenchNoticeState({
    selectedSummary,
    selectedProjection,
    nativeTuiDiagnostics: selectedNativeTuiDiagnostics,
    error,
  });
  const interactionNotice = noticeState.interactionNotice;
  const errorDescriptor = noticeState.errorDescriptor;
  const globalWorkbenchNotices: GlobalWorkbenchNotice[] = [];
  if (runtimeCompatibilityNotice.descriptor) {
    globalWorkbenchNotices.push({
      id: "runtime-compatibility",
      errorDescriptor: runtimeCompatibilityNotice.descriptor,
      selectedSummary: null,
      onRefresh: () => void runtimeCompatibilityNotice.refresh(),
      onClaimControl: () => undefined,
      dismissLabel: "Mute today",
      onDismiss: runtimeCompatibilityNotice.muteToday,
    });
  }
  if (errorDescriptor) {
    globalWorkbenchNotices.push({
      id: "workbench-error",
      errorDescriptor,
      selectedSummary: workbenchMode === "canvas" ? activeCanvasSummary : selectedSummary,
      onRefresh: () => void refreshWorkbenchState(),
      onClaimControl: (sessionId) => void claimControl(sessionId),
      onDismiss: clearError,
    });
  }
  const isGenerating = selectedSummary
    ? isSessionGenerationActive(selectedSummary, selectedProjection?.currentRuntimeStatus)
    : false;
  const composerSurface = deriveComposerSurface({
    selectedSummary,
    historyArchived: selectedStoredRef ? isStoredSessionArchived(selectedStoredRef) : false,
    hasControl: Boolean(hasControl),
    isGenerating,
    pendingSessionAction,
  });
  const stopTargetSummary = stopConfirmSessionId
    ? projections.get(stopConfirmSessionId)?.summary ?? null
    : null;
  const deleteTargetSummary = deleteConfirmSessionId
    ? projections.get(deleteConfirmSessionId)?.summary ?? null
    : null;
  const deleteTargetRunning =
    deleteTargetSummary !== null &&
    deleteTargetSummary.session.status === "running" &&
    !isReadOnlyReplay(deleteTargetSummary);
  const renameTargetSummary = renameDialogSessionId
    ? projections.get(renameDialogSessionId)?.summary ?? null
    : null;
  const renameTargetCouncil = renameDialogCouncilId
    ? councils.find((council) => council.id === renameDialogCouncilId) ?? null
    : null;
  const [missingWorkspaceResolver, setMissingWorkspaceResolver] =
    useState<((confirmed: boolean) => void) | null>(null);
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

  useEffect(() => {
    if (workbenchMode !== "canvas") {
      return;
    }
    for (const paneId of visibleCanvasPaneIds) {
      const target = canvasPaneTargets[paneId];
      const projection = resolveCanvasProjection(paneId);
      const restorableRef =
        target.kind === "stored"
          ? target.ref
          : target.kind === "session"
            ? target.ref
            : undefined;
      const restoreKey = canvasRestorableTargetKey(target);
      const restoreError = restoreKey ? canvasRestoreErrors[restoreKey] : undefined;
      if (restorableRef && !projection) {
        if (restoreError) {
          continue;
        }
        const globalOpeningTransition = canvasOpeningTransitionForTarget(
          target,
          pendingSessionAction,
          pendingSessionTransition,
          canvasResumingStoredKeys,
        );
        if (globalOpeningTransition?.kind === "resume_history") {
          continue;
        }
        const activationKey = `${restorableRef.provider}:${restorableRef.providerSessionId}`;
        if (!canvasStoredActivationInFlightRef.current.has(activationKey)) {
          canvasStoredActivationInFlightRef.current.add(activationKey);
          void activateHistorySession(restorableRef, {
            confirmCreateMissingWorkspace,
            suppressGlobalError: true,
          })
            .catch((error) => {
              reportCanvasRestoreError(target, readErrorMessage(error));
            })
            .finally(() => {
              canvasStoredActivationInFlightRef.current.delete(activationKey);
            });
        }
        continue;
      }
      if (projection && restoreError) {
        clearCanvasRestoreError(target);
      }
      if (
        target.kind === "session" &&
        !projection &&
        !target.ref &&
        isInitialLoaded
      ) {
        setCanvasPaneTargets((current) => {
          const currentTarget = current[paneId];
          return currentTarget.kind === "session" &&
            currentTarget.sessionId === target.sessionId &&
            !currentTarget.ref
            ? { ...current, [paneId]: { kind: "empty" } }
            : current;
        });
        continue;
      }
      if (
        projection &&
        projection.summary.session.providerSessionId &&
        (!projection.conversation ||
          projection.conversation.phase === "idle" ||
          projection.conversation.phase === "error" ||
          (projection.conversation.phase === "ready" &&
            projection.conversation.loadedScope !== "history"))
      ) {
        void ensureConversationLoaded(projection.summary.session.id).catch(() => undefined);
      }
    }
  }, [
    activateHistorySession,
    canvasResumingStoredKeys,
    canvasPaneTargets,
    canvasRestoreErrors,
    clearCanvasRestoreError,
    ensureConversationLoaded,
    pendingSessionAction,
    pendingSessionTransition,
    projections,
    reportCanvasRestoreError,
    isInitialLoaded,
    visibleCanvasPaneKey,
    workbenchMode,
  ]);

  const primaryPaneState = derivePrimaryPaneState({
    selectedSummary,
    pendingSessionTransition,
  });
  const sessionInspectorAvailable =
    workbenchMode === "single" &&
    primaryPaneState.kind === "active" &&
    selectedSummary !== null;
  useEffect(() => {
    if (sessionInspectorAvailable) {
      return;
    }
    setRightSidebarOpen(false);
    setRightOpen(false);
  }, [sessionInspectorAvailable, setRightOpen, setRightSidebarOpen]);
  const activeOpeningSession = primaryPaneState.openingSession;
  const sidebarWorkspaceDir = workspaceDirs.length > 0
    ? newTaskWorkspaceDir || workspaceDirs[0] || ""
    : "";
  useVisibleCanvasSessionPreload({
    active: workbenchMode === "canvas",
    paneIds: visibleCanvasPaneIds,
    paneKey: visibleCanvasPaneKey,
    paneTargets: canvasPaneTargets,
    projections,
    fallbackWorkspaceRoot: sidebarWorkspaceDir,
    ensureConversationLoaded,
  });
  const emptyStateAvailableWorkspaceDir =
    pendingNewSessionWorkspaceDir ?? sidebarWorkspaceDir;
  const currentProvider = newSessionProvider as ProviderChoice;
  const currentModelCatalogState =
    modelCatalogs[providerModelCatalogKey(currentProvider, emptyStateAvailableWorkspaceDir)];
  useEffect(() => {
    if (
      !isInitialLoaded ||
      workbenchMode !== "single" ||
      primaryPaneState.kind !== "empty"
    ) {
      return;
    }
    void loadProviderModels(currentProvider, {
      ...(emptyStateAvailableWorkspaceDir
        ? { cwd: emptyStateAvailableWorkspaceDir }
        : {}),
      background: true,
      reason: "new-session-visible",
    }).catch(() => undefined);
  }, [
    currentProvider,
    emptyStateAvailableWorkspaceDir,
    isInitialLoaded,
    loadProviderModels,
    primaryPaneState.kind,
    workbenchMode,
  ]);
  const startModeControl = resolveSessionModeControlState({
    provider: currentProvider,
    draft: startModeDrafts[currentProvider],
    catalog: currentModelCatalogState?.catalog ?? null,
  });
  const startModelDraft = startModelDrafts[currentProvider];
  const startModelControl = resolveSelectedModelDraft({
    catalog: currentModelCatalogState?.catalog,
    selectedModelId: startModelDraft?.modelId,
    selectedReasoningId: startModelDraft?.reasoningId,
    allowProviderDefault: true,
    preserveMissingSelectedModel: false,
  });
  const startDraftModelId = draftModelIdForCatalog(
    currentModelCatalogState?.catalog,
    startModelDraft,
  );
  const startModelId = startDraftModelId ?? startModelControl.model?.id ?? null;
  const startReasoningId =
    startDraftModelId === startModelId
      ? startModelDraft.reasoningId ?? startModelControl.reasoning?.id ?? null
      : startModelControl.reasoning?.id ?? null;
  const startOptionValues =
    startDraftModelId === startModelId && startModelDraft.optionValues !== undefined
      ? startModelDraft.optionValues
      : startModelId
        ? buildModelOptionValuesFromReasoning({
            catalog: currentModelCatalogState?.catalog,
            modelId: startModelId,
            reasoningId: startReasoningId,
          })
        : undefined;
  const selectedModelCatalogState = selectedSummary
    ? modelCatalogs[
        providerModelCatalogKey(
          selectedSummary.session.provider as ProviderChoice,
          selectedSummary.session.cwd,
        )
      ]
    : undefined;
  useEffect(() => {
    if (!isInitialLoaded || !selectedSummary) {
      return;
    }
    const provider = selectedSummary.session.provider;
    if (provider === "custom") {
      return;
    }
    void loadProviderModels(provider as ProviderChoice, {
      ...(selectedSummary.session.cwd
        ? { cwd: selectedSummary.session.cwd }
        : {}),
      background: true,
      reason: "session-visible",
    }).catch(() => undefined);
  }, [
    isInitialLoaded,
    loadProviderModels,
    selectedSummary?.session.cwd,
    selectedSummary?.session.id,
    selectedSummary?.session.provider,
  ]);
  const resumeModelDraft = selectedSummary
    ? modelDraftForSession(selectedSummary.session.id)
    : undefined;
  const resumeDraftModelId = draftModelIdForCatalog(
    selectedModelCatalogState?.catalog,
    resumeModelDraft,
  );
  const resumeModelControl = selectedSummary
    ? resolveSelectedModelDraft({
        catalog: selectedModelCatalogState?.catalog,
        selectedModelId:
          resumeDraftModelId ?? selectedSummary.session.model?.currentModelId ?? null,
        selectedReasoningId:
          (resumeDraftModelId ? resumeModelDraft?.reasoningId : undefined) ??
          selectedSummary.session.model?.currentReasoningId ??
          null,
        preserveMissingSelectedModel: resumeDraftModelId === null,
      })
    : null;
  const resumeModeControl = selectedSummary
    ? resolveSessionModeControlState({
        provider: selectedSummary.session.provider,
        draft: resumeModeDrafts[selectedSummary.session.id] ?? null,
        summary: selectedSummary,
        catalog: selectedModelCatalogState?.catalog ?? null,
      })
    : null;
  const effectiveResumeModelId = resumeModelControl?.model?.id ?? null;
  const effectiveResumeReasoningId = resumeModelControl?.reasoning?.id ?? null;
  const selectedHistoryResumeRequest = (() => {
    const draftMatchesEffectiveModel =
      resumeDraftModelId !== null && resumeDraftModelId === effectiveResumeModelId;
    const optionValues =
      (draftMatchesEffectiveModel ? resumeModelDraft?.optionValues : undefined) ??
      (effectiveResumeModelId
        ? buildModelOptionValuesFromReasoning({
            catalog: selectedModelCatalogState?.catalog,
            modelId: effectiveResumeModelId,
            reasoningId: effectiveResumeReasoningId,
          })
        : undefined);
    return {
      confirmCreateMissingWorkspace,
      ...(resumeModeControl?.effectiveModeId
        ? { modeId: resumeModeControl.effectiveModeId }
        : {}),
      ...(effectiveResumeModelId ? { modelId: effectiveResumeModelId } : {}),
      ...(optionValues !== undefined ? { optionValues } : {}),
      ...(effectiveResumeModelId
        ? { reasoningId: effectiveResumeReasoningId }
        : {}),
    };
  })();
  const sendSelectedInput: typeof sendInput = async (
    sessionId,
    text,
    attachments,
    options,
  ) => {
    if (
      !selectedIsReadOnlyReplay ||
      selectedSummary?.session.id !== sessionId
    ) {
      return sendInput(sessionId, text, attachments, options);
    }
    if (selectedStoredRef?.providerState?.archived === true) {
      throw new Error("Archived sessions are read-only.");
    }
    const resumedSessionId = await resumeHistorySession(
      sessionId,
      {
        ...selectedHistoryResumeRequest,
        initialInput: text,
        ...(attachments !== undefined ? { initialAttachments: attachments } : {}),
        ...(options?.annotations?.length
          ? { initialAnnotations: options.annotations }
          : {}),
      },
    );
    if (!resumedSessionId) {
      throw new Error("The session could not be resumed.");
    }
    return;
  };
  const {
    composerRef,
    draft,
    draftAttachments,
    draftAttachmentCount,
    draftAttachmentUploadPending,
    draftAttachmentError,
    draftAnnotations,
    draftAnnotationCount,
    emptyStateComposerRef,
    emptyStateDraft,
    emptyStateAttachments,
    emptyStateAttachmentCount,
    emptyStateAttachmentUploadPending,
    emptyStateAttachmentError,
    emptyStateSendPending,
    sendPending,
    setDraft,
    setEmptyStateDraft,
    handleDraftPaste,
    handleEmptyStatePaste,
    uploadDraftFiles,
    uploadEmptyStateFiles,
    removeDraftAttachment,
    removeEmptyStateAttachment,
    removeLastDraftAttachment,
    removeLastEmptyStateAttachment,
    clearDraftAnnotations,
    handleSend,
    handleEmptyStateSend,
    insertDraftReference,
    insertEmptyStateReference,
    addDraftSelectedText,
    requestDraftSelectedTextDetails,
  } = useWorkbenchComposerState({
    selectedSummary,
    availableWorkspaceDir: emptyStateAvailableWorkspaceDir,
    newSessionProvider: currentProvider,
    startModeId: startModeControl.effectiveModeId,
    startModelId,
    startReasoningId: startModelId ? startReasoningId : null,
    ...(startOptionValues !== undefined ? { startOptionValues } : {}),
    confirmCreateMissingWorkspace,
    sendInput: sendSelectedInput,
    startSession: async (options) => {
      const result = await startSessionWithRememberedModel(options);
      if (result && options?.cwd) {
        setNewTaskWorkspaceDir(options.cwd);
      }
      setPendingNewSessionWorkspaceDir(null);
      return result;
    },
  });

  useEffect(() => {
    if (workbenchMode !== "canvas") {
      return;
    }
    const sessionId = activeCanvasSummary?.session.id;
    if (sessionId && selectedSessionId !== sessionId) {
      setSelectedSessionId(sessionId);
    }
  }, [activeCanvasSummary?.session.id, selectedSessionId, setSelectedSessionId, workbenchMode]);

  useEffect(() => {
    const pruneProviderDrafts = (
      drafts: Record<ProviderChoice, ModelDraft>,
      cwd?: string,
    ): Record<ProviderChoice, ModelDraft> => {
      let changed = false;
      const next = { ...drafts };
      for (const provider of PROVIDER_CHOICES) {
        const catalog = modelCatalogs[providerModelCatalogKey(provider, cwd)]?.catalog;
        if (!catalog) {
          continue;
        }
        const pruned = pruneModelDraftForCatalog(catalog, next[provider]) ?? {};
        if (!sameModelDraft(pruned, next[provider])) {
          next[provider] = pruned;
          changed = true;
        }
      }
      return changed ? next : drafts;
    };

    setStartModelDrafts((current) =>
      pruneProviderDrafts(current, emptyStateAvailableWorkspaceDir || undefined));
    setCanvasNewSessionDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const paneId of CANVAS_PANE_IDS) {
        const prunedModelDrafts = pruneProviderDrafts(
          current[paneId].modelDrafts,
          emptyStateAvailableWorkspaceDir || undefined,
        );
        if (prunedModelDrafts !== current[paneId].modelDrafts) {
          next[paneId] = {
            ...current[paneId],
            modelDrafts: prunedModelDrafts,
          };
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setResumeModelDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const [sessionId, draft] of Object.entries(current)) {
        const session = projections.get(sessionId)?.summary.session;
        const provider = session?.provider;
        if (!provider || provider === "custom") {
          continue;
        }
        const catalog = modelCatalogs[
          providerModelCatalogKey(provider as ProviderChoice, session.cwd)
        ]?.catalog;
        if (!catalog) {
          continue;
        }
        const pruned = pruneModelDraftForCatalog(catalog, draft) ?? {};
        if (!sameModelDraft(pruned, draft)) {
          if (pruned.modelId) {
            next[sessionId] = pruned;
          } else {
            delete next[sessionId];
          }
          changed = true;
        }
      }
      return changed ? next : current;
    });

    const remembered = readRememberedModelDrafts();
    const prunedRemembered = pruneProviderDrafts(
      remembered,
      emptyStateAvailableWorkspaceDir || undefined,
    );
    if (prunedRemembered !== remembered) {
      writeRememberedModelDrafts(prunedRemembered);
    }
  }, [emptyStateAvailableWorkspaceDir, modelCatalogs, projections]);

  const handlePermissionResponse = async (
    requestId: string,
    response: PermissionResponseRequest,
  ) => {
    if (!selectedSummary) return;
    await respondToPermission(selectedSummary.session.id, requestId, response);
  };

  useForegroundWakeRecovery(foregroundSessionRecovery);

  useEffect(() => {
    if (primaryPaneState.kind !== "active" || !selectedSummary) {
      setFloatingAnchorOffsetPx(96);
    }
  }, [primaryPaneState.kind, selectedSummary]);

  const availableWorkspaceDir = sidebarWorkspaceDir;
  const selectedCouncil =
    selectedCouncilId
      ? councils.find((council) => council.id === selectedCouncilId) ?? null
      : null;
  const selectedInspectorWorkspaceDir = selectedSummary
    ? selectedSummary.session.rootDir ||
      selectedSummary.session.cwd ||
      availableWorkspaceDir ||
      ""
    : selectedCouncil?.workspace ?? selectedWorkspaceOnlyDir ?? availableWorkspaceDir ?? "";
  const terminalCwd = selectedInspectorWorkspaceDir || "~";
  const selectedTerminalSessionId = selectedSummary?.session.id ?? null;
  useEffect(() => {
    if (!selectedTerminalSessionId) {
      return;
    }
    const sessionId = selectedTerminalSessionId;
    const controller = new AbortController();
    void preloadSelectedSessionView({
      sessionId,
      workspaceRoot: selectedInspectorWorkspaceDir,
      signal: controller.signal,
      ensureConversationLoaded,
    }).catch(() => {
      // The selected-session surface owns this best-effort preload. Individual
      // Chat and Inspector surfaces retain their normal retry/error controls.
    });
    return () => {
      controller.abort();
    };
  }, [
    ensureConversationLoaded,
    selectedInspectorWorkspaceDir,
    selectedTerminalSessionId,
  ]);
  const terminalOwner = useMemo(() => {
    if (selectedTerminalSessionId) {
      return { kind: "session" as const, id: selectedTerminalSessionId };
    }
    return { kind: "workspace" as const, id: selectedWorkspaceOnlyDir || terminalCwd };
  }, [selectedTerminalSessionId, selectedWorkspaceOnlyDir, terminalCwd]);

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

  const sidebarContent = (
    <SessionSidebar
      workspaceSections={workspaceSections}
      storedSessions={sidebarStoredSessions}
      workspaceSortMode={workspaceSortMode}
      onWorkspaceSortModeChange={setWorkspaceSortMode}
      runningSessionActivityAtById={runningSessionActivityAtById}
      pinnedItems={sanitizedPinnedSidebarItems}
      pinnedOrderKeys={sidebarSectionOrders.pinnedOrderKeys}
      councilOrderKeys={sidebarSectionOrders.councilOrderKeys}
      onMovePinnedItem={sidebarSectionOrders.movePinned}
      onMoveCouncil={sidebarSectionOrders.moveCouncil}
      onTogglePinSession={(workspaceDir, itemKey) =>
        togglePinnedSidebarItem(workspaceDir, itemKey)
      }
      onAddWorkspace={(dir) => {
        void addWorkspace(dir);
        setLeftOpen(false);
      }}
      onRemoveWorkspace={(dir) => {
        const replacementWorkspaceDir =
          workspaceDirs.find((workspace) => !sameWorkspaceDirectory(workspace, dir)) ?? "";
        if (sameWorkspaceDirectory(dir, newTaskWorkspaceDir)) {
          setNewTaskWorkspaceDir(
            replacementWorkspaceDir,
          );
        }
        if (sameWorkspaceDirectory(dir, pendingNewSessionWorkspaceDir ?? undefined)) {
          setPendingNewSessionWorkspaceDir(null);
        }
        void removeWorkspace(dir);
      }}
      selectedWorkspaceDir={selectedInspectorWorkspaceDir}
      selectedSessionId={
        workbenchMode === "canvas" ? activeCanvasSummary?.session.id ?? null : selectedSessionId
      }
      selectedStoredSessionKey={
        selectedStoredRef
          ? `${selectedStoredRef.provider}:${selectedStoredRef.providerSessionId}`
          : null
      }
      selectedCouncilId={
        workbenchMode === "canvas"
          ? activeCanvasCouncil?.id ?? null
          : workbenchMode === "council"
            ? selectedCouncilId
            : null
      }
      unreadSessionIds={unreadSessionIds}
      runtimeStatusBySessionId={runtimeStatusBySessionId}
      erroredSessionIds={erroredSessionIds}
      councils={councils}
      unreadCouncilIds={unreadCouncilIds}
      onSelectSession={(workspaceDir, id, entryIntent) => {
        const projection = projections.get(id);
        const unreadReplyTarget =
          entryIntent === "latest_unread_reply" && projection
            ? latestFinalReplyNavigationTarget(projection)
            : null;
        pageController.openSession(
          workspaceDir,
          id,
          unreadReplyTarget
            ? { kind: "reply_start", ...unreadReplyTarget }
            : TAIL_SESSION_NAVIGATION_TARGET,
        );
      }}
      onSelectStoredSession={(_workspaceDir, session) => {
        pageController.prepareHistorySession();
        void activateHistorySession(session, { confirmCreateMissingWorkspace });
      }}
      onArchiveRunningSession={(sessionId) => {
        void archiveSessionAndClearCanvasTargets(sessionId).catch(() => undefined);
      }}
      onArchiveStoredSession={(session) => {
        void archiveHistorySessionAndClearCanvasTargets(session).catch(() => undefined);
      }}
      onSelectCouncil={(workspaceDir, councilId) => {
        pageController.openCouncil(workspaceDir, councilId);
      }}
      onNewTaskInWorkspace={openNewTaskInWorkspace}
      enableSessionDrag={workbenchMode === "canvas"}
      enableCouncilDrag={workbenchMode === "canvas"}
      debugScenarios={debugScenarios}
      onStartScenario={(scenario) => {
        void startScenario(scenario);
        setLeftOpen(false);
      }}
    />
  );

  const handleActivateHistorySession = (ref: typeof storedSessions[number]) => {
    pageController.prepareHistorySession();
    void activateHistorySession(ref, { confirmCreateMissingWorkspace });
  };

  const handleActivateRunningSession = (sessionId: string) => {
    const projection = projections.get(sessionId);
    const summary = projection?.summary;
    if (summary) {
      pageController.openSession(
        summary.session.rootDir || summary.session.cwd,
        sessionId,
      );
      return;
    }
    pageController.prepareHistorySession();
    setSelectedSessionId(sessionId);
  };

  const handleActivateCouncil = (councilId: string) => {
    const council = councils.find((candidate) => candidate.id === councilId) ?? null;
    if (council) {
      pageController.openCouncil(council.workspace, councilId);
      return;
    }
    pageController.openCouncilLanding(councilId);
  };

  const inspectorContent = selectedSummary ? (
    <WorkbenchErrorBoundary
      resetKey={`inspector:${selectedSummary?.session.id ?? selectedInspectorWorkspaceDir ?? "none"}`}
      title="Inspector crashed"
    >
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
          openFileRequest={mainInspectorOpenRequest}
          onOpenTerminal={() => {
            setTerminalDialogMounted(true);
            setTerminalOpen(true);
          }}
          onClosePanel={() => {
            setRightSidebarOpen(false);
            setRightOpen(false);
          }}
        />
      </Suspense>
    </WorkbenchErrorBoundary>
  ) : null;

  const rootStyle = {
    "--workbench-keyboard-inset": `${visualViewportBottomInsetPx}px`,
    "--workbench-floating-anchor": `calc(env(safe-area-inset-bottom, 0px) + ${floatingAnchorOffsetPx + visualViewportBottomInsetPx}px)`,
  } as CSSProperties;
  const mobileCanvasEnabled = true;
  const inspectorToggleOpen = resolveSidePanelOpenForTier(
    viewportTier,
    rightSidebarOpen,
    rightOpen,
    "wide",
  );
  const showPrimaryLeftSidebarControls = !leftOpen;
  const toggleInspectorFromHeader = () => {
    if (!sessionInspectorAvailable) {
      return;
    }
    if (viewportTier === "wide") {
      setRightSidebarOpen((open) => !open);
      return;
    }
    setRightOpen((open) => !open);
  };

  const renderSideSessionPane = (projection: typeof sideSessionEntries[number]) => {
    const summary = projection.summary;
    const provider = summary.session.provider as ProviderChoice;
    const modelCatalogState =
      modelCatalogs[providerModelCatalogKey(provider, summary.session.cwd)];
    return (
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-xs text-[var(--app-hint)]">
            Loading conversation…
          </div>
        }
      >
        <CanvasSessionPane
        variant="compact"
        summary={summary}
        projection={projection}
        sidePanelOpen={false}
        sidePanelToggleDisabled
        onToggleSidePanel={() => undefined}
        clientId={clientId}
        hideToolCallsInChat={hideToolCallsInChat}
        hideOpenCodeReasoningInChat={hideOpenCodeReasoningInChat}
        showModelInfoInChat={showModelInfoInChat}
        pendingSessionAction={
          pendingSessionAction?.sessionId === summary.session.id
            ? pendingSessionAction
            : null
        }
        modelCatalog={modelCatalogState?.catalog ?? null}
        modelCatalogLoading={modelCatalogState?.loading ?? false}
        onRequestModelCatalogRefresh={() => {
          if (summary.session.provider !== "custom") {
            void loadProviderModels(provider, {
              cwd: summary.session.cwd,
              reason: "side-session-control",
            }).catch(() => undefined);
          }
        }}
        resumeModeDraft={resumeModeDrafts[summary.session.id]}
        resumeModelDraft={modelDraftForSession(summary.session.id)}
        modeChangePending={modeChangeSessionId === summary.session.id}
        modelChangePending={modelChangeSessionId === summary.session.id}
        onResumeModeDraftChange={(sessionId, nextDraft) => {
          setResumeModeDrafts((current) => ({ ...current, [sessionId]: nextDraft }));
        }}
        onResumeModelDraftChange={updateResumeModelDraft}
        onRememberModelDraft={(draftProvider, nextDraft) => {
          rememberModelDraft(draftProvider, nextDraft);
          setStartModelDrafts((current) => ({
            ...current,
            [draftProvider]: nextDraft.modelId ? nextDraft : {},
          }));
        }}
        onSendInput={(sessionId, text, attachments) =>
          sendInput(sessionId, text, attachments)
        }
        onUpdateQueuedInput={(sessionId, clientMessageId, text) =>
          updateQueuedInput(sessionId, clientMessageId, text)
        }
        onDeleteQueuedInput={(sessionId, clientMessageId) =>
          deleteQueuedInput(sessionId, clientMessageId)
        }
        onReorderQueuedInput={(sessionId, clientMessageId, position) =>
          reorderQueuedInput(sessionId, clientMessageId, position)
        }
        onSteerQueuedInput={(sessionId, clientMessageId) =>
          steerQueuedInput(sessionId, clientMessageId)
        }
        onOpenQueuedInputSide={handleOpenQueuedInputSide}
        onRespondToPermission={(sessionId, requestId, response) =>
          respondToPermission(sessionId, requestId, response)
        }
        onOpenLocalFile={(_sessionId, path) => openLinkedFilePreview(path)}
        onLoadConversationItemDetail={(sessionId, kind, itemId) =>
          loadConversationItemDetail(sessionId, kind, itemId)
        }
        onLoadConversationTurnDetail={(sessionId, turnId) =>
          loadConversationTurnDetail(sessionId, turnId)
        }
        onResumeHistory={async () => null}
        onClaimControl={(sessionId) => claimControl(sessionId)}
        onInterrupt={(sessionId) => {
          if (!cancelPendingSessionStartup(sessionId)) void interruptSession(sessionId);
        }}
        onLoadOlderHistory={(sessionId) => loadOlderConversation(sessionId)}
        onEnsureTurnDirectory={(sessionId) =>
          ensureSessionConversationDirectory(sessionId)
        }
        onLoadTurnHistory={(sessionId, turnId) =>
          loadConversationDirectoryTurn(sessionId, turnId)
        }
        onStop={(sessionId) => setStopConfirmSessionId(sessionId)}
        onCloseHistory={(sessionId) => void closeSession(sessionId)}
        onArchive={() => undefined}
        onDelete={() => undefined}
        onRename={() => undefined}
        onSetSessionMode={async (sessionId, modeId) => {
          setModeChangeSessionId(sessionId);
          try {
            return await setSessionMode(sessionId, modeId);
          } finally {
            setModeChangeSessionId((current) => (current === sessionId ? null : current));
          }
        }}
        onSetSessionModel={async (sessionId, modelId, reasoningId, optionValues) => {
          setModelChangeSessionId(sessionId);
          try {
            return await setSessionModel(sessionId, modelId, reasoningId, optionValues);
          } finally {
            setModelChangeSessionId((current) => (current === sessionId ? null : current));
          }
        }}
        sideProjections={[]}
        sideLayout="columns"
        onSideLayoutChange={() => undefined}
        onForkSession={handleForkSession}
        onRecreateSide={handleRecreateSide}
          branchOperationKind={pendingBranchOperations.get(summary.session.id) ?? null}
        />
      </Suspense>
    );
  };

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
        onResizeReset={resetSidebarWidth}
        sidebarContent={sidebarContent}
        storedSessions={visibleStoredSessions}
        recentSessions={visibleRecentSessions}
        runningSessions={runningSessionEntries.map((entry) => entry.summary)}
        runningSessionActivityAtById={runningSessionActivityAtById}
        councils={councils}
        selectedCouncilId={selectedCouncilId}
        workspaceSortMode={historyWorkspaceSortMode}
        onWorkspaceSortModeChange={setHistoryWorkspaceSortMode}
        canvasActive={workbenchMode === "canvas"}
        councilActive={workbenchMode === "council"}
        homeActive={workbenchMode === "single" && selectedSessionId === null}
        onOpenCouncil={() => {
          if (workbenchMode === "council") {
            hideCouncilMode();
            return;
          }
          pageController.openCouncilLanding(defaultRunningCouncilId(councils));
        }}
        onDesktopToggleCanvas={() => {
          if (workbenchMode === "canvas") {
            exitCanvasMode();
          } else {
            enterCanvasMode();
          }
        }}
        onMobileToggleCanvas={() => {
          if (workbenchMode === "canvas") {
            exitCanvasMode();
          } else {
            enterCanvasMode();
          }
          setLeftOpen(false);
        }}
        mobileCanvasEnabled={mobileCanvasEnabled}
        onActivateHistory={handleActivateHistorySession}
        onActivateRunning={handleActivateRunningSession}
        onActivateCouncil={handleActivateCouncil}
        onLoadStoredSessions={loadStoredSessionsCatalog}
        onRefreshCouncils={refreshCouncils}
        onRenameCouncil={(council) => setRenameDialogCouncilId(council.id)}
        onRemoveCouncil={removeCouncilFromChats}
        onRemoveHistorySession={(session) => void removeHistorySessionAndClearCanvasTargets(session)}
        onArchiveHistorySession={requestArchiveHistorySession}
        onRestoreHistorySession={(session) => void restoreHistorySession(session)}
        onRemoveHistoryWorkspace={(workspaceDir, sessions) =>
          void removeFilteredHistoryWorkspaceSessions(workspaceDir, sessions)
        }
        onHome={goHome}
        onOpenSettings={() => {
          setSettingsDialogMounted(true);
          setSettingsOpen(true);
        }}
        onCollapseSidebar={() => setSidebarOpen(false)}
        onExpandSidebar={() => setSidebarOpen(true)}
      />

      {settingsDialogMounted ? (
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

      {terminalDialogMounted ? (
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
            owner={terminalOwner}
          />
        </Suspense>
      ) : null}

      <StopSessionDialog
        open={stopConfirmSessionId !== null}
        stopping={stoppingSessionId !== null}
        targetSummary={stopTargetSummary}
        onOpenChange={(open) => {
          if (!open && stoppingSessionId === null) {
            setStopConfirmSessionId(null);
          }
        }}
        onConfirm={() => {
          if (!stopConfirmSessionId) {
            return;
          }
          setStoppingSessionId(stopConfirmSessionId);
          void stopSessionAndClearCanvasPane(stopConfirmSessionId)
            .then(() => setStopConfirmSessionId(null))
            .finally(() => setStoppingSessionId(null));
        }}
      />
      <ConfirmDialog
        open={archiveConfirmTarget !== null}
        pending={archivePending}
        title="Archive session?"
        description={
          archiveConfirmTarget ? (
            <>
              {archiveConfirmTarget.running
                ? "This session is running. Archiving will stop it and move it out of the workspace sidebar."
                : "Move this session out of the workspace sidebar?"}
              <div className="mt-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2.5 py-2 font-medium text-[var(--app-fg)]">
                {archiveConfirmTarget.title}
              </div>
              <div className="mt-2 text-xs">
                Nothing will be deleted. You can browse or restore it from Chats → Archived.
              </div>
            </>
          ) : null
        }
        confirmLabel={archivePending ? "Archiving…" : "Archive"}
        onOpenChange={(open) => {
          if (!open && !archivePending) {
            setArchiveConfirmTarget(null);
          }
        }}
        onConfirm={() => {
          if (!archiveConfirmTarget || archivePending) {
            return;
          }
          const target = archiveConfirmTarget;
          setArchiveConfirmTarget(null);
          setArchivePending(true);
          const operation = target.kind === "runtime"
            ? archiveSessionAndClearCanvasTargets(target.sessionId)
            : archiveHistorySessionAndClearCanvasTargets(target.session);
          void operation
            .catch(() => undefined)
            .finally(() => setArchivePending(false));
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
                : deleteTargetRunning
                  ? "Stop this session before deleting it."
                  : "Delete this stopped session?"}
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
          if (
            deleteTargetSummary.session.status === "running" &&
            !isReadOnlyReplay(deleteTargetSummary)
          ) {
            setDeleteConfirmSessionId(null);
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
                await removeHistorySessionAndClearCanvasTargets(storedRef, {
                  sessionId: deleteConfirmSessionId,
                });
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
      <RenameSessionDialog
        open={renameDialogCouncilId !== null}
        pending={renamingCouncilId !== null}
        initialTitle={renameTargetCouncil?.title ?? ""}
        title="Rename Council"
        fieldLabel="Council title"
        placeholder="Enter a Council title"
        onOpenChange={(open) => {
          if (!open && renamingCouncilId === null) {
            setRenameDialogCouncilId(null);
          }
        }}
        onConfirm={(title) => {
          if (!renameDialogCouncilId) {
            return;
          }
          setRenamingCouncilId(renameDialogCouncilId);
          void renameCouncilFromChats(renameDialogCouncilId, title)
            .then(() => setRenameDialogCouncilId(null))
            .finally(() => setRenamingCouncilId(null));
        }}
      />
      <ConfirmDialog
        open={missingWorkspaceConfirmDir !== null}
        title="Workspace is missing"
        description={
          missingWorkspaceConfirmDir ? (
            <>
              Create this workspace before starting the session?
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

      {workbenchMode === "single" &&
      fileReferenceOpen &&
      (selectedSummary || emptyStateAvailableWorkspaceDir) ? (
        <Suspense fallback={null}>
          <FileReferencePicker
            open
            onOpenChange={setFileReferenceOpen}
            rootPath={
              selectedSummary?.session.rootDir ||
              selectedSummary?.session.cwd ||
              emptyStateAvailableWorkspaceDir ||
              "/"
            }
            onPick={selectedSummary ? insertDraftReference : insertEmptyStateReference}
          />
        </Suspense>
      ) : null}

      {homeNewCouncilDialogOpen ? (
        <Suspense fallback={null}>
          <NewCouncilDialog
            open
            onOpenChange={setHomeNewCouncilDialogOpen}
            workspaceDir={availableWorkspaceDir ?? workspaceDir ?? ""}
            workspaceDirs={workspaceDirs}
            councils={councils}
            onAddWorkspace={(dir) => void addWorkspace(dir)}
            onCreated={openCreatedCouncil}
          />
        </Suspense>
      ) : null}

      <WorkbenchErrorBoundary resetKey={`${workbenchMode}:${selectedSessionId ?? primaryPaneState.kind}`}>
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Center chat */}
          <main className="flex-1 flex flex-col min-w-0 overflow-x-hidden overflow-y-hidden">
          {workbenchMode === "council" ? (
            <Suspense
              fallback={
                <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-[var(--app-hint)]">
                  Loading Council…
                </div>
              }
            >
              <CouncilPage
                clientId={clientId}
                viewportTier={viewportTier}
                workspaceDir={availableWorkspaceDir ?? workspaceDir ?? ""}
                workspaceDirs={workspaceDirs}
                selectedCouncilId={selectedCouncilId}
                onSelectedCouncilIdChange={setSelectedCouncilId}
                onCouncilsChange={updateCouncils}
                initialCouncils={councils}
                sidebarOpen={sidebarOpen}
                onExpandSidebar={() => setSidebarOpen(true)}
                onOpenLeft={() => setLeftOpen(true)}
                showLeftSidebarControls={showPrimaryLeftSidebarControls}
                onAddWorkspace={(dir) => void addWorkspace(dir)}
                onHide={hideCouncilMode}
              />
            </Suspense>
          ) : workbenchMode === "canvas" ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-xs text-[var(--app-hint)]">
                  Loading canvas…
                </div>
              }
            >
              <CanvasWorkbench
              panes={visibleCanvasPaneIds.map((paneId) => {
                const target = canvasPaneTargets[paneId];
                return {
                  id: paneId,
                  label: canvasPaneLabel(paneId),
                  active: paneId === activeCanvasPaneId,
                  clearable: target.kind !== "empty",
                };
              })}
              layout={effectiveCanvasLayout}
              layoutEditingDisabled={mobileCanvasLayoutOnly}
              maximizedPaneId={effectiveCanvasMaximizedPaneId}
              sidebarOpen={sidebarOpen}
              showLeftSidebarControls={showPrimaryLeftSidebarControls}
              onLayoutChange={mobileCanvasLayoutOnly ? setMobileCanvasLayout : setCanvasLayout}
              onOpenLeft={() => setLeftOpen(true)}
              onExpandSidebar={() => setSidebarOpen(true)}
              onActivatePane={setActiveCanvasPaneId}
              onToggleMaximize={toggleCanvasPaneMaximize}
              onSplitPane={splitCanvasPane}
              onRemovePane={removeCanvasPaneAndContent}
              onClearPane={clearCanvasPane}
              onClearAllPanes={clearAllCanvasPanes}
              clearAllPanesDisabled={!hasAnyCanvasPaneTarget(canvasPaneTargets)}
              onExitCanvas={exitCanvasMode}
              onDropSession={setCanvasPaneSessionTarget}
              onDropCouncil={setCanvasPaneCouncil}
              renderPane={(paneId) => {
                const typedPaneId = paneId;
                const target = canvasPaneTargets[typedPaneId];
                const projection = resolveCanvasProjection(typedPaneId);
                const openingTransition = canvasOpeningTransitionForTarget(
                  target,
                  pendingSessionAction,
                  pendingSessionTransition,
                  canvasResumingStoredKeys,
                );
                const paneExpanded = effectiveCanvasMaximizedPaneId === typedPaneId;
                const paneRightPanelOpen = canvasPaneRightPanelsOpen[typedPaneId] === true;
                if (target.kind === "council") {
                  return (
                    <Suspense
                      fallback={
                        <div className="flex h-full min-h-0 items-center justify-center text-xs text-[var(--app-hint)]">
                          Loading Council…
                        </div>
                      }
                    >
                      <CouncilPage
                        clientId={clientId}
                        viewportTier={viewportTier}
                        workspaceDir={availableWorkspaceDir ?? workspaceDir ?? ""}
                        workspaceDirs={workspaceDirs}
                        initialCouncils={councils}
                        selectedCouncilId={target.councilId}
                        onSelectedCouncilIdChange={(councilId) => {
                          if (councilId) {
                            setCanvasPaneCouncil(typedPaneId, councilId);
                          }
                        }}
                        onCouncilsChange={updateCouncils}
                        sidebarOpen
                        onExpandSidebar={() => undefined}
                        onOpenLeft={() => undefined}
                        onAddWorkspace={(dir) => void addWorkspace(dir)}
                        onHide={() => clearCanvasPane(typedPaneId)}
                        onStopped={(councilId) => {
                          setCanvasPaneTargets((current) =>
                            clearCanvasCouncilTargets(current, councilId),
                          );
                          if (selectedCouncilId === councilId) {
                            setSelectedCouncilId(null);
                          }
                        }}
                        agentsPanelMode={paneRightPanelOpen ? "open" : "closed"}
                        onAgentsPanelModeChange={(mode) =>
                          setCanvasPaneRightPanelOpen(typedPaneId, mode === "open")
                        }
                        showAgentsToggle
                        containedAgentsPanel
                        showLeftSidebarControls={false}
                        showCloseButton={false}
                      />
                    </Suspense>
                  );
                }
                if (!projection) {
                  if (openingTransition) {
                    return (
                      <div className="flex h-full min-h-0 flex-col">
                        <WorkbenchOpeningPane
                          openingSession={openingTransition}
                          sidebarOpen
                          onOpenLeft={() => undefined}
                          onExpandSidebar={() => undefined}
                        />
                      </div>
                    );
                  }
                  if (target.kind === "new") {
                    const paneDraft = canvasNewSessionDrafts[typedPaneId];
                    const paneProvider = paneDraft.provider;
                    const paneWorkspaceDir = emptyStateAvailableWorkspaceDir || undefined;
                    const paneModelCatalogState =
                      modelCatalogs[providerModelCatalogKey(paneProvider, paneWorkspaceDir)];
                    const paneModeControl = resolveSessionModeControlState({
                      provider: paneProvider,
                      draft: paneDraft.modeDrafts[paneProvider],
                      catalog: paneModelCatalogState?.catalog ?? null,
                    });
                    const paneModelDraft = paneDraft.modelDrafts[paneProvider];
                    const paneModelControl = resolveSelectedModelDraft({
                      catalog: paneModelCatalogState?.catalog,
                      selectedModelId: paneModelDraft?.modelId,
                      selectedReasoningId: paneModelDraft?.reasoningId,
                      allowProviderDefault: true,
                      preserveMissingSelectedModel: false,
                    });
                    const paneDraftModelId = draftModelIdForCatalog(
                      paneModelCatalogState?.catalog,
                      paneModelDraft,
                    );
                    const paneStartModelId =
                      paneDraftModelId ?? paneModelControl.model?.id ?? null;
                    const paneStartReasoningId =
                      paneDraftModelId === paneStartModelId
                        ? paneModelDraft.reasoningId ?? paneModelControl.reasoning?.id ?? null
                        : paneModelControl.reasoning?.id ?? null;
                    const paneStartOptionValues =
                      paneDraftModelId === paneStartModelId &&
                        paneModelDraft.optionValues !== undefined
                        ? paneModelDraft.optionValues
                        : paneStartModelId
                          ? buildModelOptionValuesFromReasoning({
                              catalog: paneModelCatalogState?.catalog,
                              modelId: paneStartModelId,
                              reasoningId: paneStartReasoningId,
                            })
                          : undefined;
                    return (
                      <CanvasNewSessionPane
                        workspaceDirs={workspaceDirs}
                        availableWorkspaceDir={availableWorkspaceDir}
                        provider={paneProvider}
                        modelCatalog={paneModelCatalogState?.catalog ?? null}
                        modelCatalogLoading={paneModelCatalogState?.loading ?? false}
                        selectedModelId={paneModelControl.model?.id ?? null}
                        selectedReasoningId={paneStartReasoningId}
                        onRequestCatalogRefresh={() => {
                          void loadProviderModels(paneProvider, {
                            ...(paneWorkspaceDir ? { cwd: paneWorkspaceDir } : {}),
                            reason: "session-control",
                          }).catch(() => undefined);
                        }}
                        accessModes={paneModeControl.accessModes}
                        selectedAccessModeId={paneModeControl.selectedAccessModeId}
                        planModeAvailable={paneModeControl.planModeAvailable}
                        planModeEnabled={paneModeControl.planModeEnabled}
                        startPending={pendingSessionTransition !== null}
                        onProviderChange={(provider) => {
                          void loadProviderModels(provider, {
                            background: true,
                            ...(paneWorkspaceDir ? { cwd: paneWorkspaceDir } : {}),
                            reason: "canvas-provider-change",
                          }).catch(() => undefined);
                          setCanvasNewSessionDrafts((current) => ({
                            ...current,
                            [typedPaneId]: {
                              ...current[typedPaneId],
                              provider,
                            },
                          }));
                        }}
                        onAccessModeChange={(modeId) => {
                          setCanvasNewSessionDrafts((current) => ({
                            ...current,
                            [typedPaneId]: {
                              ...current[typedPaneId],
                              modeDrafts: {
                                ...current[typedPaneId].modeDrafts,
                                [paneProvider]: {
                                  ...(current[typedPaneId].modeDrafts[paneProvider] ??
                                    createDefaultModeDraft(paneProvider)),
                                  accessModeId: modeId,
                                },
                              },
                            },
                          }));
                        }}
                        onPlanModeToggle={(enabled) => {
                          setCanvasNewSessionDrafts((current) => ({
                            ...current,
                            [typedPaneId]: {
                              ...current[typedPaneId],
                              modeDrafts: {
                                ...current[typedPaneId].modeDrafts,
                                [paneProvider]: {
                                  ...(current[typedPaneId].modeDrafts[paneProvider] ??
                                    createDefaultModeDraft(paneProvider)),
                                  planEnabled: enabled,
                                },
                              },
                            },
                          }));
                        }}
                        onModelChange={(modelId, defaultReasoningId) => {
                          const optionValues = modelId
                            ? buildModelOptionValuesFromReasoning({
                                catalog: paneModelCatalogState?.catalog,
                                modelId,
                                reasoningId: defaultReasoningId ?? null,
                              })
                            : undefined;
                          const nextDraft = {
                            modelId: modelId || null,
                            reasoningId: modelId ? defaultReasoningId ?? null : null,
                            ...(optionValues ? { optionValues } : {}),
                          };
                          rememberModelDraft(paneProvider, nextDraft);
                          setCanvasNewSessionDrafts((current) => ({
                            ...current,
                            [typedPaneId]: {
                              ...current[typedPaneId],
                              modelDrafts: {
                                ...current[typedPaneId].modelDrafts,
                                [paneProvider]: nextDraft,
                              },
                            },
                          }));
                        }}
                        onReasoningChange={(reasoningId) => {
                          setCanvasNewSessionDrafts((current) => ({
                            ...current,
                            [typedPaneId]: (() => {
                              const modelId =
                                draftModelIdForCatalog(
                                  paneModelCatalogState?.catalog,
                                  current[typedPaneId].modelDrafts[paneProvider],
                                ) ??
                                paneModelControl.model?.id ??
                                null;
                              const optionValues = modelId
                                ? buildModelOptionValuesFromReasoning({
                                    catalog: paneModelCatalogState?.catalog,
                                    modelId,
                                    reasoningId,
                                  })
                                : undefined;
                              const { optionValues: _previousOptionValues, ...previousDraft } =
                                current[typedPaneId].modelDrafts[paneProvider] ?? {};
                              void _previousOptionValues;
                              const nextDraft = {
                                ...previousDraft,
                                modelId,
                                reasoningId,
                                ...(optionValues !== undefined ? { optionValues } : {}),
                              };
                              rememberModelDraft(paneProvider, nextDraft);
                              return {
                                ...current[typedPaneId],
                                modelDrafts: {
                                  ...current[typedPaneId].modelDrafts,
                                  [paneProvider]: nextDraft,
                                },
                              };
                            })(),
                          }));
                        }}
                        onStart={async (
                          initialInput,
                          selectedWorkspaceDir,
                          initialAttachments,
                        ) => {
                          await startSessionWithRememberedModel({
                            provider: paneProvider,
                            cwd: selectedWorkspaceDir,
                            title: initialInput.slice(0, 50),
                            initialInput,
                            ...(initialAttachments?.length
                              ? { initialAttachments }
                              : {}),
                            ...(paneModeControl.effectiveModeId
                              ? { modeId: paneModeControl.effectiveModeId }
                              : {}),
                            ...(paneStartModelId ? { model: paneStartModelId } : {}),
                            ...(paneStartOptionValues !== undefined
                              ? { optionValues: paneStartOptionValues }
                              : {}),
                            ...(paneStartModelId && paneStartReasoningId
                              ? { reasoningId: paneStartReasoningId }
                              : {}),
                            confirmCreateMissingWorkspace,
                            onSessionCreated: (sessionId) => {
                              setCanvasPaneTargets((current) => {
                                if (current[typedPaneId].kind !== "new") {
                                  return current;
                                }
                                return {
                                  ...current,
                                  [typedPaneId]: createCanvasSessionTarget(
                                    sessionId,
                                    useSessionStore.getState().projections,
                                  ),
                                };
                              });
                            },
                          });
                        }}
                        onOpenNewCouncil={() => setHomeNewCouncilDialogOpen(true)}
                        onBack={() => setCanvasPaneTarget(typedPaneId, { kind: "empty" })}
                        onCancel={() => setCanvasPaneTarget(typedPaneId, { kind: "empty" })}
                      />
                    );
                  }
                  if (target.kind === "stored" || target.kind === "session") {
                    const restoreKey = canvasRestorableTargetKey(target);
                    const restoreError = restoreKey ? canvasRestoreErrors[restoreKey] : undefined;
                    if (restoreError) {
                      return (
                        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
                          <div className="space-y-1">
                            <div className="text-sm font-medium text-[var(--app-fg)]">
                              Session unavailable
                            </div>
                            <div className="max-w-sm text-xs text-[var(--app-hint)]">
                              {restoreError}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-line)] px-2.5 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
                              onClick={() => clearCanvasRestoreError(target)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                              Retry
                            </button>
                            <button
                              type="button"
                              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--app-line)] px-2.5 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
                              onClick={() => clearCanvasPane(typedPaneId)}
                            >
                              <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
                              Clear
                            </button>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1.5 px-6 text-center">
                        <div className="text-sm font-medium text-[var(--app-fg)]">
                          {target.kind === "stored" ? "Opening history…" : "Restoring session…"}
                        </div>
                        <div className="max-w-xs text-xs text-[var(--app-hint)]">
                          The pane binding is preserved while RAH resolves its conversation.
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
                      <div className="space-y-1">
                        <div className="text-sm font-medium text-[var(--app-fg)]">Empty pane</div>
                        <div className="text-xs text-[var(--app-hint)]">
                          Drop a running session or Council here, choose a session, or create a new one.
                        </div>
                      </div>
                      <div className="grid w-full max-w-[17rem] grid-cols-2 gap-2">
                        <SessionHistoryDialog
                          storedSessions={visibleStoredSessions}
                          recentSessions={visibleRecentSessions}
                          runningSessions={runningSessionEntries.map((entry) => entry.summary)}
                          runningSessionActivityAtById={runningSessionActivityAtById}
                          councils={councils}
                          selectedCouncilId={selectedCouncilId}
                          workspaceSortMode={historyWorkspaceSortMode}
                          onWorkspaceSortModeChange={setHistoryWorkspaceSortMode}
                          onActivate={(ref) => setCanvasPaneStoredRef(typedPaneId, ref)}
                          onActivateRunning={(sessionId) => setCanvasPaneSession(typedPaneId, sessionId)}
                          onActivateCouncil={(councilId) => setCanvasPaneCouncil(typedPaneId, councilId)}
                          onLoadStoredSessions={loadStoredSessionsCatalog}
                          onRefreshCouncils={refreshCouncils}
                          onRenameCouncil={(council) => setRenameDialogCouncilId(council.id)}
                          onRemoveCouncil={removeCouncilFromChats}
                          onRemoveSession={(session) =>
                            void removeHistorySessionAndClearCanvasTargets(session)
                          }
                          onArchiveSession={(session) =>
                            requestArchiveHistorySession(session)
                          }
                          onRestoreSession={(session) => void restoreHistorySession(session)}
                          onRemoveWorkspace={(workspaceDir, sessions) =>
                            void removeFilteredHistoryWorkspaceSessions(workspaceDir, sessions)
                          }
                          defaultTab="active"
                        >
                          <button
                            type="button"
                            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 text-xs font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-bg)]"
                          >
                            <MessageCircleMore size={14} />
                            Chats
                          </button>
                        </SessionHistoryDialog>
                        <button
                          type="button"
                          onClick={() => {
                            setCanvasNewSessionDrafts((current) => ({
                              ...current,
                              [typedPaneId]: {
                                ...current[typedPaneId],
                                provider: currentProvider,
                              },
                            }));
                            setCanvasPaneTarget(typedPaneId, { kind: "new" });
                          }}
                          className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 text-xs font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-bg)]"
                        >
                          <Plus size={14} />
                          New
                        </button>
                      </div>
                    </div>
                  );
                }

                const summary = projection.summary;
                const provider = summary.session.provider as ProviderChoice;
                const modelCatalogState =
                  modelCatalogs[providerModelCatalogKey(provider, summary.session.cwd)];
                return (
                  <CanvasSessionPane
                    variant={paneExpanded ? "expanded" : "compact"}
                    sidePanelOpen={paneRightPanelOpen}
                    sidePanelToggleDisabled={false}
                    onToggleSidePanel={() => toggleCanvasPaneRightPanel(typedPaneId)}
                    sideProjections={
                      sideProjectionsByParentId.get(summary.session.id) ?? []
                    }
                    sideUnreadSessionIds={unreadSessionIds}
                    sideLayout={sideLayoutByParentId[summary.session.id] ?? "columns"}
                    onSideLayoutChange={(layout) => {
                      setSideLayoutByParentId((current) => ({
                        ...current,
                        [summary.session.id]: layout,
                      }));
                    }}
                    onForkSession={handleForkSession}
                    onRecreateSide={handleRecreateSide}
                    branchOperationKind={
                      pendingBranchOperations.get(summary.session.id) ?? null
                    }
                    inspector={(
                      <WorkbenchErrorBoundary
                        resetKey={`canvas-inspector:${summary.session.id}`}
                        title="Inspector crashed"
                      >
                        <Suspense
                          fallback={
                            <div className="flex h-full items-center justify-center text-xs text-[var(--app-hint)]">
                              Loading inspector...
                            </div>
                          }
                        >
                          <InspectorPane
                            sessionId={summary.session.id}
                            workspaceRoot={
                              summary.session.rootDir ||
                              summary.session.cwd ||
                              availableWorkspaceDir ||
                              ""
                            }
                            openFileRequest={
                              canvasInspectorOpenRequests[typedPaneId] ?? null
                            }
                            onOpenTerminal={() => {
                              setTerminalDialogMounted(true);
                              setTerminalOpen(true);
                            }}
                            onClosePanel={() =>
                              setCanvasPaneRightPanelOpen(typedPaneId, false)
                            }
                          />
                        </Suspense>
                      </WorkbenchErrorBoundary>
                    )}
                    summary={summary}
                    projection={projection}
                    historyArchived={
                      resolveStoredSessionRef(
                        summary,
                        recentSessions,
                        storedSessions,
                      )?.providerState?.archived === true
                    }
                    clientId={clientId}
                    hideToolCallsInChat={hideToolCallsInChat}
                    hideOpenCodeReasoningInChat={hideOpenCodeReasoningInChat}
                    showModelInfoInChat={showModelInfoInChat}
                    pendingSessionAction={
                      canvasPendingSessionActions[summary.session.id] ??
                      (pendingSessionAction?.sessionId === summary.session.id
                        ? pendingSessionAction
                        : null)
                    }
                    modelCatalog={modelCatalogState?.catalog ?? null}
                    modelCatalogLoading={modelCatalogState?.loading ?? false}
                    onRequestModelCatalogRefresh={() => {
                      const provider = summary.session.provider;
                      if (provider !== "custom") {
                        void loadProviderModels(provider as ProviderChoice, {
                          cwd: summary.session.cwd,
                          reason: "session-control",
                        }).catch(() => undefined);
                      }
                    }}
                    resumeModeDraft={resumeModeDrafts[summary.session.id]}
                    resumeModelDraft={modelDraftForSession(summary.session.id)}
                    modeChangePending={modeChangeSessionId === summary.session.id}
                    modelChangePending={modelChangeSessionId === summary.session.id}
                    onResumeModeDraftChange={(sessionId, nextDraft) => {
                      setResumeModeDrafts((current) => ({
                        ...current,
                        [sessionId]: nextDraft,
                      }));
                    }}
                    onResumeModelDraftChange={updateResumeModelDraft}
                    onRememberModelDraft={(draftProvider, nextDraft) => {
                      rememberModelDraft(draftProvider, nextDraft);
                      setStartModelDrafts((current) => ({
                        ...current,
                        [draftProvider]: nextDraft.modelId ? nextDraft : {},
                      }));
                    }}
                    onSendInput={(sessionId, text, attachments) =>
                      sendInput(sessionId, text, attachments)
                    }
                    onUpdateQueuedInput={(sessionId, clientMessageId, text) =>
                      updateQueuedInput(sessionId, clientMessageId, text)
                    }
                    onDeleteQueuedInput={(sessionId, clientMessageId) =>
                      deleteQueuedInput(sessionId, clientMessageId)
                    }
                    onReorderQueuedInput={(sessionId, clientMessageId, position) =>
                      reorderQueuedInput(sessionId, clientMessageId, position)
                    }
                    onSteerQueuedInput={(sessionId, clientMessageId) =>
                      steerQueuedInput(sessionId, clientMessageId)
                    }
                    onOpenQueuedInputSide={handleOpenQueuedInputSide}
                    onRespondToPermission={(sessionId, requestId, response) =>
                      respondToPermission(sessionId, requestId, response)
                    }
                    onOpenLocalFile={(_sessionId, path) => openLinkedFilePreview(path)}
                    onLoadConversationItemDetail={(sessionId, kind, itemId) =>
                      loadConversationItemDetail(sessionId, kind, itemId)
                    }
                    onLoadConversationTurnDetail={(sessionId, turnId) =>
                      loadConversationTurnDetail(sessionId, turnId)
                    }
                    onResumeHistory={async (sessionId, request) => {
                      const ref = resolveStoredSessionRef(
                        summary,
                        recentSessions,
                        storedSessions,
                      );
                      if (!ref) {
                        return null;
                      }
                      const resumeKey = canvasStoredRefKey(ref);
                      const alreadyPending =
                        canvasResumingStoredKeysRef.current.has(resumeKey);
                      if (!alreadyPending) {
                        markCanvasResumePending(sessionId, ref);
                      }
                      try {
                        const resumedSessionId = await resumeHistorySession(sessionId, {
                          confirmCreateMissingWorkspace,
                          ...request,
                        });
                        const resolvedSessionId = resolveCanvasResumedSessionId(
                          useSessionStore.getState().projections,
                          resumedSessionId,
                          ref,
                        );
                        if (resolvedSessionId) {
                          setCanvasPaneSession(typedPaneId, resolvedSessionId);
                        }
                        return resolvedSessionId;
                      } catch (resumeError) {
                        const latestProjections = useSessionStore.getState().projections;
                        const resolvedSessionId = resolveCanvasResumedSessionId(
                          latestProjections,
                          null,
                          ref,
                        );
                        const resolvedProjection = resolvedSessionId
                          ? latestProjections.get(resolvedSessionId) ?? null
                          : null;
                        if (
                          resolvedSessionId &&
                          resolvedProjection?.summary.controlLease.holderClientId === clientId
                        ) {
                          setCanvasPaneSession(typedPaneId, resolvedSessionId);
                          return resolvedSessionId;
                        }
                        throw resumeError;
                      } finally {
                        if (!alreadyPending) {
                          clearCanvasResumePending(sessionId, ref);
                        }
                      }
                    }}
                    onClaimControl={(sessionId) =>
                      claimControl(sessionId).then(() => {
                        setCanvasPaneSession(typedPaneId, sessionId);
                      })
                    }
                    onInterrupt={(sessionId) => {
                      if (!cancelPendingSessionStartup(sessionId)) void interruptSession(sessionId);
                    }}
                    onLoadOlderHistory={(sessionId) => loadOlderConversation(sessionId)}
                    onEnsureTurnDirectory={(sessionId) =>
                      ensureSessionConversationDirectory(sessionId)
                    }
                    onLoadTurnHistory={(sessionId, turnId) =>
                      loadConversationDirectoryTurn(sessionId, turnId)
                    }
                    onStop={(sessionId) => setStopConfirmSessionId(sessionId)}
                    onCloseHistory={() => clearCanvasPane(typedPaneId)}
                    onArchive={requestArchiveRuntimeSession}
                    onDelete={(sessionId) => setDeleteConfirmSessionId(sessionId)}
                    onRename={(sessionId) => setRenameDialogSessionId(sessionId)}
                    onSetSessionMode={async (sessionId, modeId) => {
                      setModeChangeSessionId(sessionId);
                      try {
                        return await setSessionMode(sessionId, modeId);
                      } finally {
                        setModeChangeSessionId((current) =>
                          current === sessionId ? null : current,
                        );
                      }
                    }}
                    onSetSessionModel={async (sessionId, modelId, reasoningId, optionValues) => {
                      setModelChangeSessionId(sessionId);
                      try {
                        return await setSessionModel(sessionId, modelId, reasoningId, optionValues);
                      } finally {
                        setModelChangeSessionId((current) =>
                          current === sessionId ? null : current,
                        );
                      }
                    }}
                  />
                );
              }}
              />
            </Suspense>
          ) : primaryPaneState.kind === "active" && selectedSummary ? (
            <SessionSideDock
              dockId={selectedSummary.session.id}
              main={(
                <div className="conversation-panel-surface relative flex h-full min-h-0 min-w-0">
                  <div className="min-w-0 flex-1">
                    <Suspense
                      fallback={
                        <div className="flex h-full items-center justify-center text-xs text-[var(--app-hint)]">
                          Loading conversation…
                        </div>
                      }
                    >
                      <WorkbenchSelectedPane
              selectedSummary={selectedSummary}
              clientId={clientId}
              selectedProjection={selectedProjection}
              conversationNavigationRevision={pageController.sessionNavigationRevision}
              conversationNavigationRequest={pageController.sessionNavigationRequest}
              onConversationNavigationConsumed={pageController.acknowledgeSessionNavigation}
              selectedIsReadOnlyReplay={selectedIsReadOnlyReplay}
              sidebarOpen={sidebarOpen}
              rightSidebarOpen={rightSidebarOpen}
              isAttached={isAttached}
              interactionNotice={interactionNotice}
              generationActive={isGenerating}
              hideToolCallsInChat={hideToolCallsInChat}
              hideOpenCodeReasoningInChat={hideOpenCodeReasoningInChat}
              showModelInfoInChat={showModelInfoInChat}
              turnDirectory={selectedProjection?.turnDirectory?.items}
              onEnsureTurnDirectory={() =>
                ensureSessionConversationDirectory(selectedSummary.session.id)
              }
              onLoadTurnHistory={(turnId) =>
                loadConversationDirectoryTurn(selectedSummary.session.id, turnId)
              }
              canRespondToPermission={canRespondToPermission}
              onPermissionRespond={handlePermissionResponse}
              onOpenLocalFile={openLinkedFilePreview}
              onLoadConversationItemDetail={(kind, itemId) =>
                loadConversationItemDetail(selectedSummary.session.id, kind, itemId)
              }
              onLoadConversationTurnDetail={(turnId) =>
                loadConversationTurnDetail(selectedSummary.session.id, turnId)
              }
              composerSurface={composerSurface}
              composerRef={composerRef}
              draft={draft}
              draftAttachments={draftAttachments}
              draftAttachmentCount={draftAttachmentCount}
              attachmentUploadPending={draftAttachmentUploadPending}
              attachmentError={draftAttachmentError}
              draftAnnotations={draftAnnotations}
              draftAnnotationCount={draftAnnotationCount}
              sendPending={sendPending}
              onDraftChange={setDraft}
              onComposerPaste={handleDraftPaste}
              onUploadFiles={uploadDraftFiles}
              onRemoveDraftAttachment={removeDraftAttachment}
              onRemoveLastDraftAttachment={removeLastDraftAttachment}
              onClearDraftAnnotations={clearDraftAnnotations}
              onAddSelectedText={addDraftSelectedText}
              onSelectedTextMoreDetails={requestDraftSelectedTextDetails}
              onSend={() => void handleSend()}
              onUpdateQueuedInput={(clientMessageId, text) =>
                updateQueuedInput(selectedSummary.session.id, clientMessageId, text)
              }
              onDeleteQueuedInput={(clientMessageId) =>
                deleteQueuedInput(selectedSummary.session.id, clientMessageId)
              }
              onReorderQueuedInput={(clientMessageId, position) =>
                reorderQueuedInput(selectedSummary.session.id, clientMessageId, position)
              }
              onSteerQueuedInput={(clientMessageId) =>
                steerQueuedInput(selectedSummary.session.id, clientMessageId)
              }
              onOpenQueuedInputSide={(item) =>
                handleOpenQueuedInputSide(selectedSummary.session.id, item)
              }
              resumeAccessModes={resumeModeControl?.accessModes ?? []}
              selectedResumeAccessModeId={resumeModeControl?.selectedAccessModeId ?? null}
              resumePlanModeAvailable={resumeModeControl?.planModeAvailable ?? false}
              resumePlanModeEnabled={resumeModeControl?.planModeEnabled ?? false}
              resumeModePending={
                pendingSessionAction?.kind === "resume_history" &&
                pendingSessionAction.sessionId === selectedSummary.session.id
              }
              selectedResumeModelId={resumeModelControl?.model?.id ?? null}
              selectedResumeReasoningId={resumeModelControl?.reasoning?.id ?? null}
              onResumeAccessModeChange={(modeId) => {
                setResumeModeDrafts((current) => ({
                  ...current,
                  [selectedSummary.session.id]: {
                    ...(current[selectedSummary.session.id] ??
                      createDefaultModeDraft(selectedSummary.session.provider as ProviderChoice)),
                    accessModeId: modeId,
                  },
                }));
              }}
              onResumePlanModeToggle={(enabled) => {
                setResumeModeDrafts((current) => ({
                  ...current,
                  [selectedSummary.session.id]: {
                    ...(current[selectedSummary.session.id] ??
                      createDefaultModeDraft(selectedSummary.session.provider as ProviderChoice)),
                    planEnabled: enabled,
                  },
                }));
              }}
              onResumeModelChange={(modelId, defaultReasoningId) => {
                const provider = selectedSummary.session.provider as ProviderChoice;
                const optionValues = modelId
                  ? buildModelOptionValuesFromReasoning({
                      catalog: selectedModelCatalogState?.catalog,
                      modelId,
                      reasoningId: defaultReasoningId ?? null,
                    })
                  : undefined;
                const nextDraft = {
                  modelId: modelId || null,
                  reasoningId: modelId ? defaultReasoningId ?? null : null,
                  ...(optionValues ? { optionValues } : {}),
                };
                rememberModelDraft(provider, nextDraft);
                setStartModelDrafts((current) => ({
                  ...current,
                  [provider]: modelId ? nextDraft : {},
                }));
                updateResumeModelDraft(selectedSummary.session.id, nextDraft);
              }}
              onResumeReasoningChange={(reasoningId) => {
                const provider = selectedSummary.session.provider as ProviderChoice;
                const modelId =
                  draftModelIdForCatalog(
                    selectedModelCatalogState?.catalog,
                    resumeModelDraft,
                  ) ??
                  resumeModelControl?.model?.id ??
                  null;
                const optionValues = modelId
                  ? buildModelOptionValuesFromReasoning({
                      catalog: selectedModelCatalogState?.catalog,
                      modelId,
                      reasoningId,
                    })
                  : undefined;
                const { optionValues: _previousOptionValues, ...previousDraft } =
                  resumeModelDraft ?? {};
                void _previousOptionValues;
                const nextDraft = {
                  ...previousDraft,
                  modelId,
                  reasoningId,
                  ...(optionValues !== undefined ? { optionValues } : {}),
                };
                rememberModelDraft(provider, nextDraft);
                setStartModelDrafts((current) => ({
                  ...current,
                  [provider]: nextDraft.modelId ? nextDraft : {},
                }));
                updateResumeModelDraft(selectedSummary.session.id, nextDraft);
              }}
              onClaimControl={() => {
                const sessionId = selectedSummary.session.id;
                const modeId = resumeModeControl?.effectiveModeId ?? null;
                const modelDraft = modelDraftForSession(sessionId);
                const draftModelId = draftModelIdForCatalog(
                  selectedModelCatalogState?.catalog,
                  modelDraft,
                );
                const modelId = resumeModelControl?.model?.id ?? draftModelId;
                const reasoningId =
                  (draftModelId === modelId ? modelDraft?.reasoningId : undefined) ??
                  resumeModelControl?.reasoning?.id ??
                  null;
                const optionValues =
                  (draftModelId === modelId ? modelDraft?.optionValues : undefined) ??
                  (modelId
                    ? buildModelOptionValuesFromReasoning({
                        catalog: selectedModelCatalogState?.catalog,
                        modelId,
                        reasoningId,
                      })
                    : undefined);
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
                      await setSessionModel(
                        sessionId,
                        modelId,
                        reasoningId,
                        optionValues,
                      ).finally(() =>
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
              onInterrupt={() => {
                if (!cancelPendingSessionStartup(selectedSummary.session.id)) {
                  void interruptSession(selectedSummary.session.id);
                }
              }}
              onOpenFileReference={() => setFileReferenceOpen(true)}
              onLoadOlderHistory={() => loadOlderConversation(selectedSummary.session.id)}
              onOpenLeft={() => setLeftOpen(true)}
              onExpandSidebar={() => setSidebarOpen(true)}
              showLeftSidebarControls={
                showPrimaryLeftSidebarControls &&
                (sideProjectionsByParentId.get(selectedSummary.session.id)?.length ?? 0) === 0
              }
              onOpenRight={() => setRightOpen(true)}
              onExpandInspector={() => setRightSidebarOpen(true)}
              onToggleInspector={toggleInspectorFromHeader}
              inspectorToggleOpen={inspectorToggleOpen}
              onFloatingAnchorOffsetChange={setFloatingAnchorOffsetPx}
              {...(!selectedIsReadOnlyReplay
                ? {
                    onHideSession: () => {
                      setSelectedWorkspaceOnlyDir(null);
                      setSelectedSessionId(null);
                      setRightSidebarOpen(false);
                      setRightOpen(false);
                    },
                  }
                : {})}
              onStopOrClose={() => {
                if (selectedIsReadOnlyReplay) {
                  void closeSession(selectedSummary.session.id);
                  return;
                }
                setStopConfirmSessionId(selectedSummary.session.id);
              }}
              onDeleteSession={() => setDeleteConfirmSessionId(selectedSummary.session.id)}
              onArchiveSession={() => {
                requestArchiveRuntimeSession(selectedSummary.session.id);
              }}
              canStopSession={canSessionStop(selectedSummary)}
              canArchiveSession={canSessionArchive(selectedSummary)}
              canForkSession={
                selectedSummary.session.capabilities.branching?.sameWorkspace === true
              }
              canCreateSide={
                selectedSummary.session.capabilities.branching?.side === true
              }
              onForkSession={() => handleForkSession(selectedSummary.session.id, "fork")}
              onCreateSide={() => handleForkSession(selectedSummary.session.id, "side")}
              branchOperationKind={
                pendingBranchOperations.get(selectedSummary.session.id) ?? null
              }
              canDeleteSession={canSessionDelete(selectedSummary)}
              canShowSessionInfo={canSessionShowInfo(selectedSummary)}
              canRenameSession={canSessionRename(selectedSummary)}
              canSwitchSessionModes={canSessionSwitchModes(selectedSummary)}
              canSwitchSessionModel={canSessionSwitchModel(selectedSummary)}
              modeChangePending={modeChangeSessionId === selectedSummary.session.id}
              modelCatalog={selectedModelCatalogState?.catalog ?? null}
              modelCatalogLoading={selectedModelCatalogState?.loading ?? false}
              modelChangePending={modelChangeSessionId === selectedSummary.session.id}
              onRequestModelCatalogRefresh={() => {
                const provider = selectedSummary.session.provider;
                if (provider !== "custom") {
                  void loadProviderModels(provider as ProviderChoice, {
                    cwd: selectedSummary.session.cwd,
                    reason: "session-control",
                  }).catch(() => undefined);
                }
              }}
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
                const provider = selectedSummary.session.provider as ProviderChoice;
                const optionValues = buildModelOptionValuesFromReasoning({
                  catalog: selectedModelCatalogState?.catalog,
                  modelId,
                  reasoningId: reasoningId ?? null,
                });
                const nextDraft = {
                  modelId,
                  reasoningId: reasoningId ?? null,
                  ...(optionValues ? { optionValues } : {}),
                };
                rememberModelDraft(provider, nextDraft);
                setStartModelDrafts((current) => ({
                  ...current,
                  [provider]: modelId ? nextDraft : {},
                }));
                updateResumeModelDraft(selectedSummary.session.id, nextDraft);
                setModelChangeSessionId(selectedSummary.session.id);
                void setSessionModel(
                  selectedSummary.session.id,
                  modelId,
                  reasoningId,
                  optionValues,
                ).finally(() =>
                  setModelChangeSessionId((current) =>
                    current === selectedSummary.session.id ? null : current,
                  ),
                );
              }}
              sideTaskCount={
                sideProjectionsByParentId.get(selectedSummary.session.id)?.length ?? 0
              }
              sideTaskLayout={
                sideLayoutByParentId[selectedSummary.session.id] ?? "columns"
              }
              onSideTaskLayoutChange={(layout) => {
                setSideLayoutByParentId((current) => ({
                  ...current,
                  [selectedSummary.session.id]: layout,
                }));
              }}
                        showInspectorToggle={sessionInspectorAvailable && !inspectorToggleOpen}
                      />
                    </Suspense>
                  </div>
                  {inspectorContent ? (
                    <WorkbenchInspectorShell
                      showDesktop={viewportTier === "wide"}
                      desktopOpen={inspectorToggleOpen}
                      rightOpen={rightOpen}
                      onRightOpenChange={setRightOpen}
                      content={inspectorContent}
                      contained
                    />
                  ) : null}
                </div>
              )}
              sides={(sideProjectionsByParentId.get(selectedSummary.session.id) ?? []).map(
                (sideProjection) => ({
                  id: sideProjection.summary.session.id,
                  summary: sideProjection.summary,
                  unread: unreadSessionIds.has(sideProjection.summary.session.id),
                  onDiscard: () =>
                    setStopConfirmSessionId(sideProjection.summary.session.id),
                  content: renderSideSessionPane(sideProjection),
                }),
              )}
              showMobileSidebarControl={showPrimaryLeftSidebarControls}
              onOpenMobileSidebar={() => setLeftOpen(true)}
              layout={sideLayoutByParentId[selectedSummary.session.id] ?? "columns"}
            />
          ) : primaryPaneState.kind === "opening" && activeOpeningSession ? (
            <WorkbenchOpeningPane
              openingSession={activeOpeningSession}
              sidebarOpen={sidebarOpen}
              onOpenLeft={() => setLeftOpen(true)}
              onExpandSidebar={() => setSidebarOpen(true)}
              showLeftSidebarControls={showPrimaryLeftSidebarControls}
            />
          ) : (
            <WorkbenchEmptyPane
              sidebarOpen={sidebarOpen}
              onOpenLeft={() => setLeftOpen(true)}
              onExpandSidebar={() => setSidebarOpen(true)}
              showLeftSidebarControls={showPrimaryLeftSidebarControls}
              emptyStateComposerRef={emptyStateComposerRef}
              emptyStateDraft={emptyStateDraft}
              emptyStateAttachments={emptyStateAttachments}
              emptyStateAttachmentCount={emptyStateAttachmentCount}
              emptyStateAttachmentUploadPending={emptyStateAttachmentUploadPending}
              emptyStateAttachmentError={emptyStateAttachmentError}
              emptyStateSendPending={emptyStateSendPending}
              onEmptyStateDraftChange={setEmptyStateDraft}
              onEmptyStatePaste={handleEmptyStatePaste}
              onUploadEmptyStateFiles={uploadEmptyStateFiles}
              onRemoveEmptyStateAttachment={removeEmptyStateAttachment}
              onRemoveLastEmptyStateAttachment={removeLastEmptyStateAttachment}
              onEmptyStateSend={handleEmptyStateSend}
              workspacePickerRef={workspacePickerRef}
              onOpenFileReference={() => setFileReferenceOpen(true)}
              workspaceDirs={workspaceDirs}
              availableWorkspaceDir={emptyStateAvailableWorkspaceDir}
              workspacePickerOpen={workspacePickerOpen}
              onToggleWorkspacePicker={() => setWorkspacePickerOpen((v) => !v)}
              onSelectWorkspace={selectNewTaskWorkspace}
              onChooseNewWorkspace={setPendingNewSessionWorkspaceDir}
              newSessionProvider={newSessionProvider as ProviderChoice}
              onChangeProvider={(value) => setNewSessionProvider(value)}
              modelCatalog={currentModelCatalogState?.catalog ?? null}
              modelCatalogLoading={currentModelCatalogState?.loading ?? false}
              selectedModelId={startModelId}
              selectedReasoningId={startReasoningId}
              onRequestCatalogRefresh={() => {
                void loadProviderModels(currentProvider, {
                  ...(emptyStateAvailableWorkspaceDir
                    ? { cwd: emptyStateAvailableWorkspaceDir }
                    : {}),
                  reason: "session-control",
                }).catch(() => undefined);
              }}
              onModelChange={(modelId, defaultReasoningId) => {
                const optionValues = modelId
                  ? buildModelOptionValuesFromReasoning({
                      catalog: currentModelCatalogState?.catalog,
                      modelId,
                      reasoningId: defaultReasoningId ?? null,
                    })
                  : undefined;
                const nextDraft = {
                  modelId: modelId || null,
                  reasoningId: modelId ? defaultReasoningId ?? null : null,
                  ...(optionValues ? { optionValues } : {}),
                };
                rememberModelDraft(currentProvider, nextDraft);
                setStartModelDrafts((current) => ({
                  ...current,
                  [currentProvider]: nextDraft,
                }));
              }}
              onReasoningChange={(reasoningId) => {
                setStartModelDrafts((current) => ({
                  ...current,
                  [currentProvider]: (() => {
                    const modelId =
                      draftModelIdForCatalog(
                        currentModelCatalogState?.catalog,
                        current[currentProvider],
                      ) ??
                      startModelControl.model?.id ??
                      null;
                    const optionValues = modelId
                      ? buildModelOptionValuesFromReasoning({
                          catalog: currentModelCatalogState?.catalog,
                          modelId,
                          reasoningId,
                        })
                      : undefined;
                    const { optionValues: _previousOptionValues, ...previousDraft } =
                      current[currentProvider] ?? {};
                    void _previousOptionValues;
                    const nextDraft = {
                      ...previousDraft,
                      modelId,
                      reasoningId,
                      ...(optionValues !== undefined ? { optionValues } : {}),
                    };
                    rememberModelDraft(currentProvider, nextDraft);
                    return nextDraft;
                  })(),
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
              onOpenNewCouncil={() => setHomeNewCouncilDialogOpen(true)}
            />
          )}
          </main>

        </div>
      </WorkbenchErrorBoundary>

      {linkedFilePreviewPath ? (
        <FilePreviewDialogErrorBoundary
          resetKey={linkedFilePreviewPath}
          onClose={() => setLinkedFilePreviewPath(null)}
        >
          <InspectorFileDetailDialog
            sessionId={selectedSummary?.session.id ?? null}
            workspaceRoot={selectedInspectorWorkspaceDir}
            selection={{
              path: linkedFilePreviewPath,
              source: "local",
            }}
            onRefreshChanges={() => undefined}
            onClose={() => setLinkedFilePreviewPath(null)}
          />
        </FilePreviewDialogErrorBoundary>
      ) : null}

      <GlobalWorkbenchNoticeHost
        notices={globalWorkbenchNotices}
        viewportTier={viewportTier}
      />
    </div>
  );
}
