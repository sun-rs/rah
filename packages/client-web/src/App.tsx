import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MessageCircleMore, Plus, UsersRound } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { CouncilSnapshot, PermissionResponseRequest, ProviderModelCatalog, SessionConfigValue, SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import * as api from "./api";
import { SessionSidebar } from "./SessionSidebar";
import { useSessionStore } from "./useSessionStore";
import { FileReferencePicker } from "./components/FileReferencePicker";
import type { ProviderChoice } from "./components/ProviderSelector";
import { ProviderLogo } from "./components/ProviderLogo";
import { SessionHistoryDialog } from "./components/SessionHistoryDialog";
import { GlobalWorkbenchCallout } from "./components/workbench/callouts/GlobalWorkbenchCallout";
import { StopSessionDialog } from "./components/workbench/dialogs/StopSessionDialog";
import { ConfirmDialog } from "./components/workbench/dialogs/ConfirmDialog";
import { RenameSessionDialog } from "./components/workbench/dialogs/RenameSessionDialog";
import { WorkbenchErrorBoundary } from "./components/workbench/WorkbenchErrorBoundary";
import { CanvasNewSessionPane } from "./components/workbench/canvas/CanvasNewSessionPane";
import { CanvasSessionPane } from "./components/workbench/canvas/CanvasSessionPane";
import { CanvasWorkbench, type CanvasLayout } from "./components/workbench/canvas/CanvasWorkbench";
import { CouncilPage } from "./council/CouncilPage";
import { COUNCIL_ACCENT_ICON_CLASSNAME } from "./council/council-theme";
import { defaultRunningCouncilId } from "./council/CouncilsBrowser";
import { mergeCouncilLists, mergeCouncilSnapshot } from "./council/council-message-window";
import { NewCouncilDialog } from "./council/NewCouncilDialog";
import { WorkbenchEmptyPane } from "./components/workbench/panes/WorkbenchEmptyPane";
import { WorkbenchOpeningPane } from "./components/workbench/panes/WorkbenchOpeningPane";
import { WorkbenchSelectedPane } from "./components/workbench/panes/WorkbenchSelectedPane";
import { WorkbenchInspectorShell } from "./components/workbench/shells/WorkbenchInspectorShell";
import { WorkbenchSidebarShell } from "./components/workbench/shells/WorkbenchSidebarShell";
import { useChatPreferences } from "./hooks/useChatPreferences";
import { useNativeTuiDiagnostics } from "./hooks/useNativeTuiDiagnostics";
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
  canSessionStop,
  canSessionRename,
  canSessionSwitchModel,
  canSessionRespondToPermissions,
  canSessionSwitchModes,
  canSessionShowInfo,
  isSessionGenerationActive,
  isReadOnlyReplay,
  shouldPollSessionHistoryTail,
} from "./session-capabilities";
import {
  createDefaultModeDraft,
  resolveSessionModeControlState,
  type SessionModeDraft,
} from "./session-mode-ui";
import { resolveSelectedModelDraft } from "./components/SessionModelControls";
import { deriveComposerSurface } from "./composer-contract";
import {
  setVisibleNotificationTargets,
  type NotificationTarget,
} from "./browser-notifications";
import {
  derivePrimaryPaneState,
  deriveWorkbenchSessionCollections,
  isSessionAttachedToClient,
} from "./workbench-selectors";
import { deriveWorkbenchNoticeState } from "./workbench-notice-contract";
import { buildModelOptionValuesFromReasoning } from "./provider-capabilities";
import { importWithStaleReload } from "./lazy-module-reload";
import {
  createPendingStoredSessionTransition,
  type PendingSessionTransition,
} from "./session-transition-contract";
import {
  applyCanvasPaneTarget,
  CANVAS_PANE_IDS,
  clearCanvasTargetsForStoredSession,
  createCanvasLayoutRatios,
  createDefaultCanvasRightPanelsOpen,
  createEmptyCanvasTargets,
  getCanvasVisiblePaneIds,
  hasAnyCanvasPaneTarget,
  isCanvasStoredTargetClaimPending,
  readRememberedCanvasState,
  rememberCanvasState,
  replaceCanvasSessionTargetWithStoredRef,
  resolveCanvasClaimedSessionId,
  resolveCanvasTargetProjection as resolveCanvasTargetProjectionFromState,
  shouldInitializeCanvasPaneFromSelection,
  type CanvasPaneId,
  type CanvasPaneTarget,
} from "./canvas-state";

const loadSettingsDialog = () =>
  importWithStaleReload(() => import("./components/workbench/dialogs/SettingsDialog"));
const SettingsDialog = lazy(async () => ({
  default: (await loadSettingsDialog()).SettingsDialog,
}));
const loadWorkbenchTerminalDialog = () =>
  importWithStaleReload(() => import("./components/workbench/dialogs/WorkbenchTerminalDialog"));
const WorkbenchTerminalDialog = lazy(async () => ({
  default: (await loadWorkbenchTerminalDialog()).WorkbenchTerminalDialog,
}));
const loadInspectorPane = () => importWithStaleReload(() => import("./InspectorPane"));
const InspectorPane = lazy(async () => ({
  default: (await loadInspectorPane()).InspectorPane,
}));
const loadInspectorFileDetailDialog = () =>
  importWithStaleReload(() => import("./inspector/InspectorFileDetailDialog"));
const InspectorFileDetailDialog = lazy(async () => ({
  default: (await loadInspectorFileDetailDialog()).InspectorFileDetailDialog,
}));

type ModelDraft = {
  modelId?: string | null;
  reasoningId?: string | null;
  optionValues?: Record<string, SessionConfigValue>;
};

type WorkbenchMode = "single" | "canvas" | "council";
type CanvasNewSessionDraft = {
  provider: ProviderChoice;
  modeDrafts: Record<ProviderChoice, SessionModeDraft>;
  modelDrafts: Record<ProviderChoice, ModelDraft>;
};

const MODEL_DRAFT_STORAGE_KEY = "rah.modelDrafts.v2";
const LEGACY_MODEL_DRAFT_STORAGE_KEYS = ["rah.modelDrafts.v1"];
const PROVIDER_CHOICES: ProviderChoice[] = ["codex", "claude", "gemini", "opencode"];

function emptyModelDrafts(): Record<ProviderChoice, ModelDraft> {
  return {
    codex: {},
    claude: {},
    gemini: {},
    opencode: {},
  };
}

function createDefaultModeDrafts(): Record<ProviderChoice, SessionModeDraft> {
  return {
    codex: createDefaultModeDraft("codex"),
    claude: createDefaultModeDraft("claude"),
    gemini: createDefaultModeDraft("gemini"),
    opencode: createDefaultModeDraft("opencode"),
  };
}

function createCanvasNewSessionDraft(provider: ProviderChoice = "codex"): CanvasNewSessionDraft {
  return {
    provider,
    modeDrafts: createDefaultModeDrafts(),
    modelDrafts: readRememberedModelDrafts(),
  };
}

function createEmptyCanvasNewSessionDrafts(): Record<CanvasPaneId, CanvasNewSessionDraft> {
  return {
    "canvas-1": createCanvasNewSessionDraft(),
    "canvas-2": createCanvasNewSessionDraft(),
    "canvas-3": createCanvasNewSessionDraft(),
    "canvas-4": createCanvasNewSessionDraft(),
  };
}

function isSessionConfigValue(value: unknown): value is SessionConfigValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function sanitizeOptionValues(value: unknown): Record<string, SessionConfigValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, SessionConfigValue] =>
    isSessionConfigValue(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sanitizeModelDraft(value: unknown): ModelDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Partial<ModelDraft>;
  if (typeof record.modelId !== "string" || !record.modelId) {
    return {};
  }
  const optionValues = sanitizeOptionValues(record.optionValues);
  return {
    modelId: record.modelId,
    ...(typeof record.reasoningId === "string" && record.reasoningId
      ? { reasoningId: record.reasoningId }
      : {}),
    ...(optionValues ? { optionValues } : {}),
  };
}

function readRememberedModelDrafts(): Record<ProviderChoice, ModelDraft> {
  if (typeof window === "undefined") return emptyModelDrafts();
  try {
    const raw =
      window.localStorage.getItem(MODEL_DRAFT_STORAGE_KEY) ??
      LEGACY_MODEL_DRAFT_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(
        (value): value is string => Boolean(value),
      ) ??
      "{}";
    const parsed = JSON.parse(raw) as Partial<Record<ProviderChoice, unknown>>;
    return PROVIDER_CHOICES.reduce((drafts, provider) => {
      drafts[provider] = sanitizeModelDraft(parsed[provider]);
      return drafts;
    }, emptyModelDrafts());
  } catch {
    return emptyModelDrafts();
  }
}

function writeRememberedModelDrafts(drafts: Record<ProviderChoice, ModelDraft>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_DRAFT_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Ignore storage failures; the in-memory draft still applies for this page.
  }
}

function rememberModelDraft(provider: ProviderChoice, draft: ModelDraft): void {
  if (typeof window === "undefined") return;
  try {
    const current = readRememberedModelDrafts();
    current[provider] = sanitizeModelDraft(draft);
    writeRememberedModelDrafts(current);
  } catch {
    // Ignore storage failures; the in-memory draft still applies for this page.
  }
}

function catalogHasModel(
  catalog: ProviderModelCatalog | null | undefined,
  modelId: string | null | undefined,
): boolean {
  const normalizedModelId = modelId?.trim();
  if (!normalizedModelId || !catalog) {
    return false;
  }
  return catalog.models.some((model) => model.id === normalizedModelId);
}

function pruneModelDraftForCatalog(
  catalog: ProviderModelCatalog | null | undefined,
  draft: ModelDraft | undefined,
): ModelDraft | undefined {
  if (!draft?.modelId) {
    return draft;
  }
  if (!catalog || catalogHasModel(catalog, draft.modelId)) {
    return draft;
  }
  return {};
}

function sameModelDraft(left: ModelDraft | undefined, right: ModelDraft | undefined): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

function draftModelIdForCatalog(
  catalog: ProviderModelCatalog | null | undefined,
  draft: ModelDraft | undefined,
): string | null {
  return catalogHasModel(catalog, draft?.modelId) ? draft!.modelId! : null;
}

function storedRefFromSessionSummary(summary: SessionSummary): StoredSessionRef | null {
  const providerSessionId = summary.session.providerSessionId;
  if (!providerSessionId) {
    return null;
  }
  return {
    provider: summary.session.provider,
    providerSessionId,
    ...(summary.session.cwd ? { cwd: summary.session.cwd } : {}),
    ...(summary.session.rootDir ? { rootDir: summary.session.rootDir } : {}),
    ...(summary.session.title ? { title: summary.session.title } : {}),
    ...(summary.session.preview ? { preview: summary.session.preview } : {}),
    createdAt: summary.session.createdAt,
    updatedAt: summary.session.updatedAt,
    lastUsedAt: summary.session.updatedAt,
    source: "previous_running",
  };
}

function canvasOpeningTransitionForTarget(
  target: CanvasPaneTarget,
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "claim_history";
        sessionId: string;
      }
    | null,
  pendingSessionTransition: PendingSessionTransition | null,
): PendingSessionTransition | null {
  if (!pendingSessionTransition) {
    return null;
  }
  if (
    target.kind === "session" &&
    pendingSessionTransition.kind === "claim_history" &&
    pendingSessionAction?.kind === "claim_history" &&
    pendingSessionAction.sessionId === target.sessionId
  ) {
    return pendingSessionTransition;
  }
  if (
    target.kind === "stored" &&
    pendingSessionTransition.provider === target.ref.provider &&
    pendingSessionTransition.providerSessionId === target.ref.providerSessionId
  ) {
    return pendingSessionTransition;
  }
  return null;
}

export function App() {
  const {
    init,
    refreshWorkbenchState,
    loadStoredSessionsCatalog,
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
    interruptSession,
    sendInput,
    ensureSessionHistoryLoaded,
    refreshLatestHistory,
    loadOlderHistory,
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
      recentSessions: state.recentSessions,
      workspaceDirs: state.workspaceDirs,
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
      setSelectedSessionId: state.setSelectedSessionId,
      setNewSessionProvider: state.setNewSessionProvider,
      loadProviderModels: state.loadProviderModels,
      startSession: state.startSession,
      startScenario: state.startScenario,
      activateHistorySession: state.activateHistorySession,
      attachSession: state.attachSession,
      closeSession: state.closeSession,
      renameSession: state.renameSession,
      setSessionMode: state.setSessionMode,
      setSessionModel: state.setSessionModel,
      claimHistorySession: state.claimHistorySession,
      removeHistorySession: state.removeHistorySession,
      removeHistoryWorkspaceSessions: state.removeHistoryWorkspaceSessions,
      claimControl: state.claimControl,
      interruptSession: state.interruptSession,
      sendInput: state.sendInput,
      ensureSessionHistoryLoaded: state.ensureSessionHistoryLoaded,
      refreshLatestHistory: state.refreshLatestHistory,
      loadOlderHistory: state.loadOlderHistory,
      respondToPermission: state.respondToPermission,
    })),
  );
  const rememberedCanvasState = useMemo(
    () =>
      typeof window === "undefined"
        ? null
        : readRememberedCanvasState(window.localStorage),
    [],
  );
  const [stopConfirmSessionId, setStopConfirmSessionId] = useState<string | null>(null);
  const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(null);
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [renameDialogSessionId, setRenameDialogSessionId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDialogCouncilId, setRenameDialogCouncilId] = useState<string | null>(null);
  const [renamingCouncilId, setRenamingCouncilId] = useState<string | null>(null);
  const [modeChangeSessionId, setModeChangeSessionId] = useState<string | null>(null);
  const [modelChangeSessionId, setModelChangeSessionId] = useState<string | null>(null);
  const [startModelDrafts, setStartModelDrafts] = useState<Record<ProviderChoice, ModelDraft>>(
    () => readRememberedModelDrafts(),
  );
  const [startModeDrafts, setStartModeDrafts] =
    useState<Record<ProviderChoice, SessionModeDraft>>(() => createDefaultModeDrafts());
  const [claimModeDrafts, setClaimModeDrafts] = useState<Record<string, SessionModeDraft>>({});
  const [claimModelDrafts, setClaimModelDrafts] = useState<Record<string, ModelDraft>>({});
  const [missingWorkspaceConfirmDir, setMissingWorkspaceConfirmDir] = useState<string | null>(null);
  const [floatingAnchorOffsetPx, setFloatingAnchorOffsetPx] = useState(96);
  const [workbenchMode, setWorkbenchMode] = useState<WorkbenchMode>("single");
  const [councils, setCouncils] = useState<CouncilSnapshot[]>([]);
  const [selectedCouncilId, setSelectedCouncilId] = useState<string | null>(null);
  const [homeNewCouncilDialogOpen, setHomeNewCouncilDialogOpen] = useState(false);
  const [canvasLayout, setCanvasLayoutState] = useState<CanvasLayout>(
    () => rememberedCanvasState?.layout ?? "two-horizontal",
  );
  const [canvasMaximizedPaneId, setCanvasMaximizedPaneId] = useState<CanvasPaneId | null>(null);
  const [activeCanvasPaneId, setActiveCanvasPaneId] = useState<CanvasPaneId>(
    () => rememberedCanvasState?.activePaneId ?? "canvas-1",
  );
  const [canvasRatios, setCanvasRatios] = useState<number[]>(() =>
    rememberedCanvasState?.ratios ??
    createCanvasLayoutRatios(rememberedCanvasState?.layout ?? "two-horizontal"),
  );
  const [canvasPaneTargets, setCanvasPaneTargets] =
    useState<Record<CanvasPaneId, CanvasPaneTarget>>(
      () => rememberedCanvasState?.targets ?? createEmptyCanvasTargets(),
    );
  const [canvasPaneRightPanelsOpen, setCanvasPaneRightPanelsOpen] = useState<
    Record<CanvasPaneId, boolean>
  >(() => rememberedCanvasState?.rightPanelsOpen ?? createDefaultCanvasRightPanelsOpen());
  const [canvasPaneOpeningTransitions, setCanvasPaneOpeningTransitions] = useState<
    Partial<Record<CanvasPaneId, PendingSessionTransition>>
  >({});
  const canvasStoredActivationInFlightRef = useRef<Set<string>>(new Set());
  const [canvasNewSessionDrafts, setCanvasNewSessionDrafts] =
    useState<Record<CanvasPaneId, CanvasNewSessionDraft>>(() =>
      createEmptyCanvasNewSessionDrafts(),
    );
  const [linkedFilePreviewPath, setLinkedFilePreviewPath] = useState<string | null>(null);
  const [settingsDialogMounted, setSettingsDialogMounted] = useState(false);
  const [terminalDialogMounted, setTerminalDialogMounted] = useState(false);
  const {
    hideToolCallsInChat,
    hideOpenCodeReasoningInChat,
    hideGeminiReasoningInChat,
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

  useEffect(() => {
    initializeTheme();
    void init();
  }, [init]);

  useEffect(() => {
    rememberCanvasState(
      typeof window === "undefined" ? undefined : window.localStorage,
      {
        layout: canvasLayout,
        activePaneId: activeCanvasPaneId,
        ratios: canvasRatios,
        targets: canvasPaneTargets,
        rightPanelsOpen: canvasPaneRightPanelsOpen,
      },
    );
  }, [
    activeCanvasPaneId,
    canvasLayout,
    canvasPaneRightPanelsOpen,
    canvasPaneTargets,
    canvasRatios,
  ]);

  const refreshCouncils = useCallback(async () => {
    try {
      const response = await api.listCouncils();
      setCouncils((current) => mergeCouncilLists(current, response.councils));
      setSelectedCouncilId((current) => {
        if (!current || response.councils.some((council) => council.id === current)) {
          return current;
        }
        return null;
      });
    } catch {
      // The full Council page owns user-visible council loading errors.
    }
  }, []);

  const removeCouncilFromChats = useCallback(async (councilId: string) => {
    await api.deleteCouncil(councilId);
    await refreshCouncils();
  }, [refreshCouncils]);

  const renameCouncilFromChats = useCallback(async (councilId: string, title: string) => {
    const response = await api.renameCouncil(councilId, { title });
    setCouncils((current) => {
      const existingIndex = current.findIndex((candidate) => candidate.id === response.council.id);
      if (existingIndex >= 0) {
        const next = [...current];
        next[existingIndex] = mergeCouncilSnapshot(next[existingIndex], response.council);
        return next;
      }
      return [response.council, ...current];
    });
  }, []);

  const openCreatedCouncil = useCallback((council: CouncilSnapshot) => {
    setCouncils((current) => {
      const existingIndex = current.findIndex((candidate) => candidate.id === council.id);
      if (existingIndex >= 0) {
        const next = [...current];
        next[existingIndex] = mergeCouncilSnapshot(next[existingIndex], council);
        return next;
      }
      return [council, ...current];
    });
    setSelectedSessionId(null);
    setSelectedWorkspaceOnlyDir(null);
    setWorkspaceDir(council.workspace);
    setSelectedCouncilId(council.id);
    setWorkbenchMode("council");
    setRightSidebarOpen(false);
    setRightOpen(false);
    setLeftOpen(false);
    void refreshCouncils();
  }, [refreshCouncils, setSelectedSessionId, setWorkspaceDir]);

  useEffect(() => {
    void refreshCouncils();
    const timer = window.setInterval(() => {
      void refreshCouncils();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [refreshCouncils]);

  useEffect(() => {
    const preloadSettingsDialog = window.setTimeout(() => {
      void loadSettingsDialog();
    }, 1200);
    return () => window.clearTimeout(preloadSettingsDialog);
  }, []);

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
    runningSessionEntries,
    runningSessionActivityAtById,
    workspaceSections,
  } = sessionCollections;
  const {
    sanitizedPinnedSessionIdByWorkspace,
    togglePinnedSession,
  } = useWorkbenchSidebarPreferences(workspaceSections, councils);

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

  const visibleCanvasPaneIds = getCanvasVisiblePaneIds(canvasLayout, canvasMaximizedPaneId);
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
        if (target.kind === "session") {
          addTarget({ kind: "session", id: target.sessionId });
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
  }, [canvasPaneTargets, selectedCouncilId, selectedSessionId, visibleCanvasPaneKey, workbenchMode]);

  useEffect(() => {
    setVisibleNotificationTargets(visibleNotificationTargets);
    return () => setVisibleNotificationTargets([]);
  }, [visibleNotificationTargets]);

  useEffect(() => {
    if (!canvasMaximizedPaneId) {
      return;
    }
    setCanvasPaneRightPanelsOpen((current) =>
      current[canvasMaximizedPaneId]
        ? current
        : {
            ...current,
            [canvasMaximizedPaneId]: true,
          },
    );
  }, [canvasMaximizedPaneId]);

  const setCanvasPaneRightPanelOpen = useCallback((paneId: CanvasPaneId, open: boolean) => {
    setCanvasPaneRightPanelsOpen((current) => ({
      ...current,
      [paneId]: open,
    }));
  }, []);

  const openLinkedFilePreview = useCallback((path: string) => {
    setLinkedFilePreviewPath(path);
  }, []);

  const toggleCanvasPaneRightPanel = useCallback((paneId: CanvasPaneId) => {
    setCanvasPaneRightPanelsOpen((current) => ({
      ...current,
      [paneId]: !current[paneId],
    }));
  }, []);

  const setCanvasLayout = (layout: CanvasLayout) => {
    setCanvasLayoutState(layout);
    setCanvasMaximizedPaneId(null);
    setCanvasRatios(createCanvasLayoutRatios(layout));
    if (!getCanvasVisiblePaneIds(layout).includes(activeCanvasPaneId)) {
      setActiveCanvasPaneId("canvas-1");
    }
  };

  const setCanvasPaneTarget = (paneId: CanvasPaneId, target: CanvasPaneTarget) => {
    setCanvasPaneTargets((current) =>
      applyCanvasPaneTarget(current, paneId, target, useSessionStore.getState().projections),
    );
    setCanvasPaneRightPanelOpen(paneId, true);
    setActiveCanvasPaneId(paneId);
  };

  const setCanvasPaneSession = (paneId: CanvasPaneId, sessionId: string) => {
    setCanvasPaneTarget(paneId, { kind: "session", sessionId });
    setSelectedSessionId(sessionId);
  };

  const setCanvasPaneStoredRef = (paneId: CanvasPaneId, ref: StoredSessionRef) => {
    setCanvasPaneTarget(paneId, { kind: "stored", ref });
    void activateHistorySession(ref, { confirmCreateMissingWorkspace });
  };

  const setCanvasPaneCouncil = (paneId: CanvasPaneId, councilId: string) => {
    setCanvasPaneTarget(paneId, { kind: "council", councilId });
    setSelectedCouncilId(councilId);
  };

  const clearCanvasPane = (paneId: CanvasPaneId) => {
    const projection = resolveCanvasProjection(paneId);
    const council = resolveCanvasCouncil(paneId);
    const sessionId = projection?.summary.session.id;
    const shouldCloseReadOnlyReplay = projection ? isReadOnlyReplay(projection.summary) : false;
    setCanvasPaneTarget(paneId, { kind: "empty" });
    setCanvasPaneOpeningTransitions((current) => {
      if (current[paneId] === undefined) {
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
    setCanvasPaneOpeningTransitions({});
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

  const stopSessionAndKeepCanvasHistory = async (
    sessionId: string,
    summary: SessionSummary | null,
  ) => {
    const ref = summary ? storedRefFromSessionSummary(summary) : null;
    const affectsCanvasPane = CANVAS_PANE_IDS.some((paneId) => {
      const target = canvasPaneTargets[paneId];
      return target.kind === "session" && target.sessionId === sessionId;
    });
    await closeSession(sessionId);
    if (!affectsCanvasPane) {
      return;
    }
    if (!ref) {
      setCanvasPaneTargets((current) => {
        let changed = false;
        const next = { ...current };
        for (const paneId of CANVAS_PANE_IDS) {
          const target = current[paneId];
          if (target.kind === "session" && target.sessionId === sessionId) {
            next[paneId] = { kind: "empty" };
            changed = true;
          }
        }
        return changed ? next : current;
      });
      return;
    }
    setCanvasPaneTargets((current) =>
      replaceCanvasSessionTargetWithStoredRef(current, sessionId, ref),
    );
    await activateHistorySession(ref, { confirmCreateMissingWorkspace });
  };

  const toggleCanvasPaneMaximize = (paneId: CanvasPaneId) => {
    setActiveCanvasPaneId(paneId);
    setCanvasMaximizedPaneId((current) => (current === paneId ? null : paneId));
  };

  const enterCanvasMode = () => {
    if (
      selectedSessionId &&
      shouldInitializeCanvasPaneFromSelection(canvasPaneTargets[activeCanvasPaneId])
    ) {
      setCanvasPaneTarget(activeCanvasPaneId, { kind: "session", sessionId: selectedSessionId });
    }
    setWorkbenchMode("canvas");
    setRightSidebarOpen(false);
    setRightOpen(false);
  };

  const exitCanvasMode = () => {
    if (activeCanvasSummary) {
      setSelectedSessionId(activeCanvasSummary.session.id);
    }
    if (activeCanvasCouncil) {
      setSelectedCouncilId(activeCanvasCouncil.id);
    }
    setWorkbenchMode("single");
  };

  const hideCouncilMode = () => {
    setSelectedCouncilId(null);
    setWorkbenchMode("single");
    setRightSidebarOpen(false);
    setRightOpen(false);
    setLeftOpen(false);
  };

  const goHome = () => {
    setWorkbenchMode("single");
    setSelectedWorkspaceOnlyDir(null);
    setSelectedSessionId(null);
    setSelectedCouncilId(null);
    setRightSidebarOpen(false);
    setRightOpen(false);
    setLeftOpen(false);
  };

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
  const shouldSyncSelectedHistoryTail = selectedSummary
    ? shouldPollSessionHistoryTail(selectedSummary)
    : false;

  useEffect(() => {
    if (!selectedSessionId || !shouldSyncSelectedHistoryTail) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const syncLatestHistory = () => {
      if (cancelled || inFlight) {
        return;
      }
      inFlight = true;
      void refreshLatestHistory(selectedSessionId)
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    syncLatestHistory();
    const interval = window.setInterval(syncLatestHistory, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshLatestHistory, selectedSessionId, shouldSyncSelectedHistoryTail]);

  const noticeState = deriveWorkbenchNoticeState({
    selectedSummary,
    selectedProjection,
    nativeTuiDiagnostics: selectedNativeTuiDiagnostics,
    error,
  });
  const interactionNotice = noticeState.interactionNotice;
  const historyNotice = noticeState.historyNotice;
  const errorDescriptor = noticeState.errorDescriptor;
  const isGenerating = selectedSummary
    ? isSessionGenerationActive(selectedSummary, selectedProjection?.currentRuntimeStatus)
    : false;
  const composerSurface = deriveComposerSurface({
    selectedSummary,
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
      if (target.kind === "stored" && !projection) {
        const globalOpeningTransition = canvasOpeningTransitionForTarget(
          target,
          pendingSessionAction,
          pendingSessionTransition,
        );
        if (
          isCanvasStoredTargetClaimPending(target, [
            globalOpeningTransition,
            canvasPaneOpeningTransitions[paneId],
          ])
        ) {
          continue;
        }
        const activationKey = `${target.ref.provider}:${target.ref.providerSessionId}`;
        if (!canvasStoredActivationInFlightRef.current.has(activationKey)) {
          canvasStoredActivationInFlightRef.current.add(activationKey);
          void activateHistorySession(target.ref, { confirmCreateMissingWorkspace })
            .catch(() => undefined)
            .finally(() => {
              canvasStoredActivationInFlightRef.current.delete(activationKey);
            });
        }
        continue;
      }
      if (
        projection &&
        projection.summary.session.providerSessionId &&
        !projection.history.authoritativeApplied &&
        projection.history.phase !== "loading"
      ) {
        void ensureSessionHistoryLoaded(projection.summary.session.id).catch(() => undefined);
      }
    }
  }, [
    activateHistorySession,
    canvasPaneOpeningTransitions,
    canvasPaneTargets,
    ensureSessionHistoryLoaded,
    pendingSessionAction,
    pendingSessionTransition,
    projections,
    visibleCanvasPaneKey,
    workbenchMode,
  ]);

  const primaryPaneState = derivePrimaryPaneState({
    selectedSummary,
    pendingSessionTransition,
  });
  const activeOpeningSession = primaryPaneState.openingSession;
  const currentProvider = newSessionProvider as ProviderChoice;
  const currentModelCatalogState = modelCatalogs[currentProvider];
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
    ? modelCatalogs[selectedSummary.session.provider as ProviderChoice]
    : undefined;
  const claimModelDraft = selectedSummary ? claimModelDrafts[selectedSummary.session.id] : undefined;
  const claimDraftModelId = draftModelIdForCatalog(
    selectedModelCatalogState?.catalog,
    claimModelDraft,
  );
  const claimModelControl = selectedSummary
    ? resolveSelectedModelDraft({
        catalog: selectedModelCatalogState?.catalog,
        selectedModelId:
          claimDraftModelId ?? selectedSummary.session.model?.currentModelId ?? null,
        selectedReasoningId:
          (claimDraftModelId ? claimModelDraft?.reasoningId : undefined) ??
          selectedSummary.session.model?.currentReasoningId ??
          null,
        preserveMissingSelectedModel: claimDraftModelId === null,
      })
    : null;
  const claimModeControl = selectedSummary
    ? resolveSessionModeControlState({
        provider: selectedSummary.session.provider,
        draft: claimModeDrafts[selectedSummary.session.id] ?? null,
        summary: selectedSummary,
        catalog: selectedModelCatalogState?.catalog ?? null,
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
    startReasoningId: startModelId ? startReasoningId : null,
    ...(startOptionValues !== undefined ? { startOptionValues } : {}),
    confirmCreateMissingWorkspace,
    sendInput,
    startSession,
  });

  useEffect(() => {
    void loadProviderModels(currentProvider, {
      background: true,
      reason: "new-session-current-provider",
    }).catch(() => undefined);
  }, [currentProvider, loadProviderModels]);

  useEffect(() => {
    if (selectedSummary?.session.provider !== undefined && selectedSummary.session.provider !== "custom") {
      void loadProviderModels(selectedSummary.session.provider as ProviderChoice, {
        background: true,
        reason: "selected-session-provider",
      }).catch(() => undefined);
    }
  }, [loadProviderModels, selectedSummary?.session.provider]);

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
    if (workbenchMode !== "canvas") {
      return;
    }
    const providers = new Set<ProviderChoice>();
    for (const paneId of visibleCanvasPaneIds) {
      if (canvasPaneTargets[paneId].kind === "new") {
        providers.add(canvasNewSessionDrafts[paneId].provider);
      }
      const provider = resolveCanvasProjection(paneId)?.summary.session.provider;
      if (provider && provider !== "custom") {
        providers.add(provider as ProviderChoice);
      }
    }
    for (const provider of providers) {
      void loadProviderModels(provider, {
        background: true,
        reason: "canvas-session-provider",
      }).catch(() => undefined);
    }
  }, [
    canvasNewSessionDrafts,
    canvasPaneTargets,
    canvasLayout,
    canvasMaximizedPaneId,
    loadProviderModels,
    projections,
    workbenchMode,
  ]);

  useEffect(() => {
    const pruneProviderDrafts = (
      drafts: Record<ProviderChoice, ModelDraft>,
    ): Record<ProviderChoice, ModelDraft> => {
      let changed = false;
      const next = { ...drafts };
      for (const provider of PROVIDER_CHOICES) {
        const catalog = modelCatalogs[provider]?.catalog;
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

    setStartModelDrafts((current) => pruneProviderDrafts(current));
    setCanvasNewSessionDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const paneId of CANVAS_PANE_IDS) {
        const prunedModelDrafts = pruneProviderDrafts(current[paneId].modelDrafts);
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
    setClaimModelDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const [sessionId, draft] of Object.entries(current)) {
        const provider = projections.get(sessionId)?.summary.session.provider;
        if (!provider || provider === "custom") {
          continue;
        }
        const catalog = modelCatalogs[provider as ProviderChoice]?.catalog;
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
    const prunedRemembered = pruneProviderDrafts(remembered);
    if (prunedRemembered !== remembered) {
      writeRememberedModelDrafts(prunedRemembered);
    }
  }, [modelCatalogs, projections]);

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

  const availableWorkspaceDir = workspaceDirs.length > 0 ? workspaceDir : "";
  const selectedCouncil =
    selectedCouncilId
      ? councils.find((council) => council.id === selectedCouncilId) ?? null
      : null;
  const selectedInspectorWorkspaceDir = selectedSummary
    ? availableWorkspaceDir ||
      selectedSummary.session.rootDir ||
      selectedSummary.session.cwd ||
      ""
    : selectedCouncil?.workspace ?? selectedWorkspaceOnlyDir ?? availableWorkspaceDir ?? "";
  const terminalCwd = selectedInspectorWorkspaceDir || "~";
  const selectedTerminalSessionId = selectedSummary?.session.id ?? null;
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
      workspaceSortMode={workspaceSortMode}
      onWorkspaceSortModeChange={setWorkspaceSortMode}
      runningSessionActivityAtById={runningSessionActivityAtById}
      pinnedSessionIdByWorkspace={sanitizedPinnedSessionIdByWorkspace}
      onTogglePinSession={togglePinnedSession}
      onTogglePinCouncil={(workspaceDir, councilId) =>
        togglePinnedSession(workspaceDir, `council:${councilId}`)
      }
      onAddWorkspace={(dir) => {
        void addWorkspace(dir);
        setLeftOpen(false);
      }}
      onRemoveWorkspace={(dir) => void removeWorkspace(dir)}
      selectedWorkspaceDir={selectedInspectorWorkspaceDir}
      selectedSessionId={
        workbenchMode === "canvas" ? activeCanvasSummary?.session.id ?? null : selectedSessionId
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
      councils={councils}
      onSelectSession={(workspaceDir, id) => {
        if (workbenchMode !== "single") {
          setWorkbenchMode("single");
        }
        setSelectedWorkspaceOnlyDir(null);
        setWorkspaceDir(workspaceDir);
        setSelectedSessionId(id);
        setLeftOpen(false);
      }}
      onSelectCouncil={(workspaceDir, councilId) => {
        setSelectedWorkspaceOnlyDir(null);
        setWorkspaceDir(workspaceDir);
        setSelectedSessionId(null);
        setSelectedCouncilId(councilId);
        setWorkbenchMode("council");
        setRightSidebarOpen(false);
        setRightOpen(false);
        setLeftOpen(false);
      }}
      onSelectWorkspace={(dir) => {
        if (workbenchMode !== "single") {
          setWorkbenchMode("single");
        }
        setSelectedWorkspaceOnlyDir(dir);
        setWorkspaceDir(dir);
        setSelectedSessionId(null);
        setLeftOpen(false);
      }}
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
    setLeftOpen(false);
    if (workbenchMode !== "single") {
      setWorkbenchMode("single");
    }
    void activateHistorySession(ref, { confirmCreateMissingWorkspace });
  };

  const handleActivateRunningSession = (sessionId: string) => {
    setLeftOpen(false);
    if (workbenchMode !== "single") {
      setWorkbenchMode("single");
    }
    const projection = projections.get(sessionId);
    const summary = projection?.summary;
    if (summary) {
      setSelectedWorkspaceOnlyDir(null);
      setWorkspaceDir(summary.session.rootDir || summary.session.cwd);
    }
    setSelectedSessionId(sessionId);
  };

  const handleActivateCouncil = (councilId: string) => {
    setLeftOpen(false);
    const council = councils.find((candidate) => candidate.id === councilId) ?? null;
    if (council) {
      setSelectedWorkspaceOnlyDir(null);
      setWorkspaceDir(council.workspace);
    }
    setSelectedSessionId(null);
    setSelectedCouncilId(councilId);
    setWorkbenchMode("council");
    setRightSidebarOpen(false);
    setRightOpen(false);
  };

  const inspectorContent = selectedSummary || selectedInspectorWorkspaceDir ? (
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
          events={selectedProjection?.events ?? []}
          onOpenTerminal={() => {
            setTerminalDialogMounted(true);
            setTerminalOpen(true);
          }}
        />
      </Suspense>
    </WorkbenchErrorBoundary>
  ) : (
      <div className="flex h-full flex-col">
      <div className="h-14 px-4 pr-12 flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--app-fg)]">Inspector</div>
          <div className="text-xs text-[var(--app-hint)] truncate">No workspace or session selected</div>
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--app-hint)]">
        Select a workspace or session to inspect files and changes.
      </div>
    </div>
  );

  const rootStyle = {
    "--workbench-keyboard-inset": `${visualViewportBottomInsetPx}px`,
    "--workbench-floating-anchor": `calc(env(safe-area-inset-bottom, 0px) + ${floatingAnchorOffsetPx + visualViewportBottomInsetPx}px)`,
    "--workbench-callout-anchor": `calc(var(--workbench-floating-anchor) + 3.5rem)`,
  } as CSSProperties;
  const mobileCanvasEnabled = viewportWidthPx >= 700;
  const inspectorToggleOpen = rightSidebarOpen || rightOpen;
  const toggleInspectorFromHeader = () => {
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches) {
      setRightSidebarOpen((open) => !open);
      return;
    }
    setRightOpen((open) => !open);
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
        sidebarContent={sidebarContent}
        storedSessions={storedSessions}
        recentSessions={recentSessions}
        runningSessions={runningSessionEntries.map((entry) => entry.summary)}
        runningSessionActivityAtById={runningSessionActivityAtById}
        councils={councils}
        selectedCouncilId={selectedCouncilId}
        workspaceSortMode={historyWorkspaceSortMode}
        onWorkspaceSortModeChange={setHistoryWorkspaceSortMode}
        canvasActive={workbenchMode === "canvas"}
        councilActive={workbenchMode === "council"}
        onOpenCouncil={() => {
          if (workbenchMode === "council") {
            hideCouncilMode();
            return;
          }
          setSelectedCouncilId(defaultRunningCouncilId(councils));
          setWorkbenchMode("council");
          setRightSidebarOpen(false);
          setRightOpen(false);
          setLeftOpen(false);
        }}
        onDesktopToggleCanvas={() => {
          if (workbenchMode === "canvas") {
            exitCanvasMode();
          } else {
            enterCanvasMode();
          }
        }}
        onMobileToggleCanvas={() => {
          if (!mobileCanvasEnabled) {
            return;
          }
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
        onRemoveHistoryWorkspace={(workspaceDir) => void removeHistoryWorkspaceSessions(workspaceDir)}
        onHome={goHome}
        onOpenSettings={() => {
          setSettingsDialogMounted(true);
          setSettingsOpen(true);
        }}
        onCollapseSidebar={() => setSidebarOpen(false)}
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
          void stopSessionAndKeepCanvasHistory(stopConfirmSessionId, stopTargetSummary)
            .then(() => setStopConfirmSessionId(null))
            .finally(() => setStoppingSessionId(null));
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

      {workbenchMode === "single" && (selectedSummary || availableWorkspaceDir) ? (
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

      <NewCouncilDialog
        open={homeNewCouncilDialogOpen}
        onOpenChange={setHomeNewCouncilDialogOpen}
        workspaceDir={availableWorkspaceDir ?? workspaceDir ?? ""}
        workspaceDirs={workspaceDirs}
        councils={councils}
        onAddWorkspace={(dir) => void addWorkspace(dir)}
        onCreated={openCreatedCouncil}
      />

      <WorkbenchErrorBoundary resetKey={`${workbenchMode}:${selectedSessionId ?? primaryPaneState.kind}`}>
        {/* Center chat */}
        <main className="flex-1 flex flex-col min-w-0 overflow-x-hidden overflow-y-hidden">
          {workbenchMode === "council" ? (
            <CouncilPage
              clientId={clientId}
              workspaceDir={availableWorkspaceDir ?? workspaceDir ?? ""}
              workspaceDirs={workspaceDirs}
              selectedCouncilId={selectedCouncilId}
              onSelectedCouncilIdChange={setSelectedCouncilId}
              onCouncilsChange={setCouncils}
              initialCouncils={councils}
              sidebarOpen={sidebarOpen}
              onExpandSidebar={() => setSidebarOpen(true)}
              onOpenLeft={() => setLeftOpen(true)}
              onAddWorkspace={(dir) => void addWorkspace(dir)}
              onHide={hideCouncilMode}
            />
          ) : workbenchMode === "canvas" ? (
            <CanvasWorkbench
              panes={visibleCanvasPaneIds.map((paneId, index) => {
                const target = canvasPaneTargets[paneId];
                return {
                  id: paneId,
                  label: `Pane ${index + 1}`,
                  active: paneId === activeCanvasPaneId,
                  clearable: target.kind !== "empty",
                };
              })}
              layout={canvasLayout}
              maximizedPaneId={canvasMaximizedPaneId}
              ratios={canvasRatios}
              sidebarOpen={sidebarOpen}
              onLayoutChange={setCanvasLayout}
              onResizeRatios={setCanvasRatios}
              onExpandSidebar={() => setSidebarOpen(true)}
              onActivatePane={(paneId) => setActiveCanvasPaneId(paneId as CanvasPaneId)}
              onToggleMaximize={(paneId) => toggleCanvasPaneMaximize(paneId as CanvasPaneId)}
              onClearPane={(paneId) => clearCanvasPane(paneId as CanvasPaneId)}
              onClearAllPanes={clearAllCanvasPanes}
              clearAllPanesDisabled={!hasAnyCanvasPaneTarget(canvasPaneTargets)}
              onExitCanvas={exitCanvasMode}
              onDropSession={(paneId, sessionId) =>
                setCanvasPaneSession(paneId as CanvasPaneId, sessionId)
              }
              onDropCouncil={(paneId, councilId) =>
                setCanvasPaneCouncil(paneId as CanvasPaneId, councilId)
              }
              renderPaneToolbar={(paneId) => {
                const typedPaneId = paneId as CanvasPaneId;
                const projection = resolveCanvasProjection(typedPaneId);
                const council = resolveCanvasCouncil(typedPaneId);
                return (
                  <>
                    {projection ? (
                      <ProviderLogo
                        provider={projection.summary.session.provider}
                        className="h-4 w-4"
                        variant="bare"
                      />
                    ) : null}
                    {council ? (
                      <UsersRound
                        size={15}
                        className={COUNCIL_ACCENT_ICON_CLASSNAME}
                      />
                    ) : null}
                  </>
                );
              }}
              renderPane={(paneId) => {
                const typedPaneId = paneId as CanvasPaneId;
                const target = canvasPaneTargets[typedPaneId];
                const projection = resolveCanvasProjection(typedPaneId);
                const openingTransition = canvasOpeningTransitionForTarget(
                  target,
                  pendingSessionAction,
                  pendingSessionTransition,
                ) ?? canvasPaneOpeningTransitions[typedPaneId] ?? null;
                const paneExpanded = canvasMaximizedPaneId === typedPaneId;
                const paneRightPanelOpen =
                  paneExpanded && canvasPaneRightPanelsOpen[typedPaneId] !== false;
                if (target.kind === "council") {
                  return (
                    <CouncilPage
                      clientId={clientId}
                      workspaceDir={availableWorkspaceDir ?? workspaceDir ?? ""}
                      workspaceDirs={workspaceDirs}
                      initialCouncils={councils}
                      selectedCouncilId={target.councilId}
                      onSelectedCouncilIdChange={(councilId) => {
                        if (councilId) {
                          setCanvasPaneCouncil(typedPaneId, councilId);
                        }
                      }}
                      onCouncilsChange={setCouncils}
                      sidebarOpen
                      onExpandSidebar={() => undefined}
                      onOpenLeft={() => undefined}
                      onAddWorkspace={(dir) => void addWorkspace(dir)}
                      onHide={() => clearCanvasPane(typedPaneId)}
                      agentsPanelMode={paneRightPanelOpen ? "open" : "closed"}
                      onAgentsPanelModeChange={(mode) =>
                        setCanvasPaneRightPanelOpen(typedPaneId, mode === "open")
                      }
                      agentsToggleDisabled={!paneExpanded}
                      showAgentsToggle
                      showLeftSidebarControls={false}
                      showCloseButton={false}
                    />
                  );
                }
                if (!projection) {
                  if (openingTransition) {
                    return (
                      <div className="flex h-full min-h-0 flex-col">
                        <WorkbenchOpeningPane
                          openingSession={openingTransition}
                          sidebarOpen
                          rightSidebarOpen={false}
                          onOpenLeft={() => undefined}
                          onExpandSidebar={() => undefined}
                          onOpenRight={() => undefined}
                          onExpandInspector={() => undefined}
                          onToggleInspector={() => undefined}
                          inspectorToggleOpen={false}
                          showInspectorToggle={false}
                        />
                      </div>
                    );
                  }
                  if (target.kind === "new") {
                    const paneDraft = canvasNewSessionDrafts[typedPaneId];
                    const paneProvider = paneDraft.provider;
                    const paneModelCatalogState = modelCatalogs[paneProvider];
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
                            background: true,
                            reason: "session-control",
                          }).catch(() => undefined);
                        }}
                        accessModes={paneModeControl.accessModes}
                        selectedAccessModeId={paneModeControl.selectedAccessModeId}
                        planModeAvailable={paneModeControl.planModeAvailable}
                        planModeEnabled={paneModeControl.planModeEnabled}
                        startPending={pendingSessionTransition !== null}
                        onAddWorkspace={(dir) => void addWorkspace(dir)}
                        onSelectWorkspace={setWorkspaceDir}
                        onProviderChange={(provider) => {
                          void loadProviderModels(provider, {
                            background: true,
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
                        onStart={(initialInput) => {
                          void startSession({
                            provider: paneProvider,
                            cwd: availableWorkspaceDir,
                            title: initialInput.slice(0, 50),
                            initialInput,
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
                              setCanvasPaneSession(typedPaneId, sessionId);
                            },
                          })
                            .catch(() => undefined);
                        }}
                        onOpenNewCouncil={() => setHomeNewCouncilDialogOpen(true)}
                        onBack={() => setCanvasPaneTarget(typedPaneId, { kind: "empty" })}
                        onCancel={() => setCanvasPaneTarget(typedPaneId, { kind: "empty" })}
                      />
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
                          storedSessions={storedSessions}
                          recentSessions={recentSessions}
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
                          onRemoveWorkspace={(workspaceDir) =>
                            void removeHistoryWorkspaceSessions(workspaceDir)
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
                const modelCatalogState = modelCatalogs[provider];
                return (
                  <CanvasSessionPane
                    variant={paneExpanded ? "expanded" : "compact"}
                    sidePanelOpen={paneRightPanelOpen}
                    sidePanelToggleDisabled={!paneExpanded}
                    onToggleSidePanel={() => toggleCanvasPaneRightPanel(typedPaneId)}
                    {...(paneExpanded
                      ? {
                        inspector: (
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
                                  events={projection.events ?? []}
                                  onOpenTerminal={() => {
                                    setTerminalDialogMounted(true);
                                    setTerminalOpen(true);
                                  }}
                                />
                              </Suspense>
                            </WorkbenchErrorBoundary>
                          ),
                        }
                      : {})}
                    summary={summary}
                    projection={projection}
                    clientId={clientId}
                    hideToolCallsInChat={hideToolCallsInChat}
                    hideOpenCodeReasoningInChat={hideOpenCodeReasoningInChat}
                    hideGeminiReasoningInChat={hideGeminiReasoningInChat}
                    showModelInfoInChat={showModelInfoInChat}
                    pendingSessionAction={
                      pendingSessionAction?.sessionId === summary.session.id
                        ? pendingSessionAction
                        : null
                    }
                    modelCatalog={modelCatalogState?.catalog ?? null}
                    modelCatalogLoading={modelCatalogState?.loading ?? false}
                    onRequestModelCatalogRefresh={() => {
                      const provider = summary.session.provider;
                      if (provider !== "custom") {
                        void loadProviderModels(provider as ProviderChoice, {
                          background: true,
                          reason: "session-control",
                        }).catch(() => undefined);
                      }
                    }}
                    claimModeDraft={claimModeDrafts[summary.session.id]}
                    claimModelDraft={claimModelDrafts[summary.session.id]}
                    modeChangePending={modeChangeSessionId === summary.session.id}
                    modelChangePending={modelChangeSessionId === summary.session.id}
                    onClaimModeDraftChange={(sessionId, nextDraft) => {
                      setClaimModeDrafts((current) => ({
                        ...current,
                        [sessionId]: nextDraft,
                      }));
                    }}
                    onClaimModelDraftChange={(sessionId, nextDraft) => {
                      setClaimModelDrafts((current) => ({
                        ...current,
                        [sessionId]: nextDraft,
                      }));
                    }}
                    onRememberModelDraft={(draftProvider, nextDraft) => {
                      rememberModelDraft(draftProvider, nextDraft);
                      setStartModelDrafts((current) => ({
                        ...current,
                        [draftProvider]: nextDraft.modelId ? nextDraft : {},
                      }));
                    }}
                    onSendInput={(sessionId, text) => sendInput(sessionId, text)}
                    onRespondToPermission={(sessionId, requestId, response) =>
                      respondToPermission(sessionId, requestId, response)
                    }
                    onOpenLocalFile={(_sessionId, path) => openLinkedFilePreview(path)}
                    onClaimHistory={(sessionId, request) => {
                      const ref = storedRefFromSessionSummary(summary);
                      if (ref) {
                        const openingTransition = createPendingStoredSessionTransition(
                          ref,
                          "claim_history",
                        );
                        setCanvasPaneOpeningTransitions((current) => ({
                          ...current,
                          [typedPaneId]: openingTransition,
                        }));
                      }
                      void (async () => {
                        let claimedSessionId: string | null = null;
                        try {
                          claimedSessionId = await claimHistorySession(sessionId, {
                            confirmCreateMissingWorkspace,
                            ...request,
                          });
                          const resolvedSessionId = resolveCanvasClaimedSessionId(
                            useSessionStore.getState().projections,
                            claimedSessionId,
                            ref,
                          );
                          if (resolvedSessionId) {
                            setCanvasPaneSession(typedPaneId, resolvedSessionId);
                          }
                        } catch {
                          const latestProjections = useSessionStore.getState().projections;
                          const resolvedSessionId = resolveCanvasClaimedSessionId(
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
                          }
                        } finally {
                          setCanvasPaneOpeningTransitions((current) => {
                            if (current[typedPaneId] === undefined) {
                              return current;
                            }
                            const next = { ...current };
                            delete next[typedPaneId];
                            return next;
                          });
                        }
                      })();
                    }}
                    onClaimControl={(sessionId) =>
                      claimControl(sessionId).then(() => {
                        setCanvasPaneSession(typedPaneId, sessionId);
                      })
                    }
                    onInterrupt={(sessionId) => void interruptSession(sessionId)}
                    onLoadOlderHistory={(sessionId) => loadOlderHistory(sessionId)}
                    onStop={(sessionId) => setStopConfirmSessionId(sessionId)}
                    onCloseHistory={() => clearCanvasPane(typedPaneId)}
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
          ) : primaryPaneState.kind === "active" && selectedSummary ? (
            <WorkbenchSelectedPane
              selectedSummary={selectedSummary}
              clientId={clientId}
              selectedProjection={selectedProjection}
              selectedIsReadOnlyReplay={selectedIsReadOnlyReplay}
              sidebarOpen={sidebarOpen}
              rightSidebarOpen={rightSidebarOpen}
              isAttached={isAttached}
              interactionNotice={interactionNotice}
              historyNotice={historyNotice}
              hideToolCallsInChat={hideToolCallsInChat}
              hideOpenCodeReasoningInChat={hideOpenCodeReasoningInChat}
              hideGeminiReasoningInChat={hideGeminiReasoningInChat}
              showModelInfoInChat={showModelInfoInChat}
              canLoadOlderHistory={Boolean(
                selectedSummary.session.providerSessionId &&
                  selectedProjection?.history.authoritativeApplied &&
                  (selectedProjection.history.nextCursor ||
                    selectedProjection.history.nextBeforeTs),
              )}
              historyLoading={selectedProjection?.history.phase === "loading"}
              canRespondToPermission={canRespondToPermission}
              onPermissionRespond={handlePermissionResponse}
              onOpenLocalFile={openLinkedFilePreview}
              composerSurface={composerSurface}
              composerRef={composerRef}
              draft={draft}
              sendPending={sendPending}
              onDraftChange={setDraft}
              onSend={() => void handleSend()}
              onClaimHistory={() => {
                const sessionId = selectedSummary.session.id;
                const modelDraft = claimModelDrafts[sessionId];
                const modelDraftId = draftModelIdForCatalog(
                  selectedModelCatalogState?.catalog,
                  modelDraft,
                );
                const optionValues =
                  (modelDraftId ? modelDraft?.optionValues : undefined) ??
                  (modelDraftId
                    ? buildModelOptionValuesFromReasoning({
                        catalog: selectedModelCatalogState?.catalog,
                        modelId: modelDraftId,
                        reasoningId: modelDraft?.reasoningId ?? null,
                      })
                    : undefined);
                void claimHistorySession(sessionId, {
                  confirmCreateMissingWorkspace,
                  ...(claimModeControl?.effectiveModeId
                    ? { modeId: claimModeControl.effectiveModeId }
                    : {}),
                  ...(modelDraftId ? { modelId: modelDraftId } : {}),
                  ...(optionValues !== undefined ? { optionValues } : {}),
                  ...(modelDraftId && modelDraft?.reasoningId
                    ? { reasoningId: modelDraft.reasoningId }
                    : {}),
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
                setClaimModelDrafts((current) => ({
                  ...current,
                  [selectedSummary.session.id]: nextDraft,
                }));
              }}
              onClaimReasoningChange={(reasoningId) => {
                const provider = selectedSummary.session.provider as ProviderChoice;
                const modelId =
                  draftModelIdForCatalog(
                    selectedModelCatalogState?.catalog,
                    claimModelDrafts[selectedSummary.session.id],
                  ) ??
                  claimModelControl?.model?.id ??
                  null;
                const optionValues = modelId
                  ? buildModelOptionValuesFromReasoning({
                      catalog: selectedModelCatalogState?.catalog,
                      modelId,
                      reasoningId,
                    })
                  : undefined;
                const { optionValues: _previousOptionValues, ...previousDraft } =
                  claimModelDrafts[selectedSummary.session.id] ?? {};
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
                setClaimModelDrafts((current) => ({
                  ...current,
                  [selectedSummary.session.id]: nextDraft,
                }));
              }}
              onClaimControl={() => {
                const sessionId = selectedSummary.session.id;
                const modeId = claimModeControl?.effectiveModeId ?? null;
                const modelDraft = claimModelDrafts[sessionId];
                const modelId = draftModelIdForCatalog(
                  selectedModelCatalogState?.catalog,
                  modelDraft,
                );
                const reasoningId =
                  (modelId ? modelDraft?.reasoningId : undefined) ??
                  claimModelControl?.reasoning?.id ??
                  null;
                const optionValues =
                  (modelId ? modelDraft?.optionValues : undefined) ??
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
              onInterrupt={() => void interruptSession(selectedSummary.session.id)}
              onOpenFileReference={() => setFileReferenceOpen(true)}
              onLoadOlderHistory={() => loadOlderHistory(selectedSummary.session.id)}
              onOpenLeft={() => setLeftOpen(true)}
              onExpandSidebar={() => setSidebarOpen(true)}
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
              canStopSession={canSessionStop(selectedSummary)}
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
                    background: true,
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
              showInspectorToggle={!rightOpen && !rightSidebarOpen}
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
              onToggleInspector={toggleInspectorFromHeader}
              inspectorToggleOpen={inspectorToggleOpen}
              showInspectorToggle={!rightOpen && !rightSidebarOpen}
            />
          ) : (
            <WorkbenchEmptyPane
              sidebarOpen={sidebarOpen}
              rightSidebarOpen={rightSidebarOpen}
              onOpenLeft={() => setLeftOpen(true)}
              onExpandSidebar={() => setSidebarOpen(true)}
              onOpenRight={() => setRightOpen(true)}
              onExpandInspector={() => setRightSidebarOpen(true)}
              onToggleInspector={toggleInspectorFromHeader}
              inspectorToggleOpen={inspectorToggleOpen}
              showInspectorToggle={!rightOpen && !rightSidebarOpen}
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
              selectedModelId={startModelId}
              selectedReasoningId={startReasoningId}
              onRequestCatalogRefresh={() => {
                void loadProviderModels(currentProvider, {
                  background: true,
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

        {workbenchMode === "single" ? (
          <WorkbenchInspectorShell
            showDesktop
            desktopOpen={rightSidebarOpen}
            rightOpen={rightOpen}
            onRightOpenChange={setRightOpen}
            onToggle={toggleInspectorFromHeader}
            content={inspectorContent}
          />
        ) : null}
      </WorkbenchErrorBoundary>

      {linkedFilePreviewPath ? (
        <Suspense fallback={null}>
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
        </Suspense>
      ) : null}

      <GlobalWorkbenchCallout
        errorDescriptor={errorDescriptor}
        selectedSummary={workbenchMode === "canvas" ? activeCanvasSummary : selectedSummary}
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
