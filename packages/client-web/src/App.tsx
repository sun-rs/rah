import { Suspense, lazy, useEffect, useMemo, useState, type CSSProperties } from "react";
import { History, PanelRight, Plus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { PermissionResponseRequest, SessionConfigValue, StoredSessionRef } from "@rah/runtime-protocol";
import { SessionSidebar } from "./SessionSidebar";
import { useSessionStore } from "./useSessionStore";
import { FileReferencePicker } from "./components/FileReferencePicker";
import type { ProviderChoice } from "./components/ProviderSelector";
import { ProviderLogo } from "./components/ProviderLogo";
import { SessionHistoryDialog } from "./components/SessionHistoryDialog";
import { GlobalWorkbenchCallout } from "./components/workbench/callouts/GlobalWorkbenchCallout";
import { ArchiveSessionDialog } from "./components/workbench/dialogs/ArchiveSessionDialog";
import { ConfirmDialog } from "./components/workbench/dialogs/ConfirmDialog";
import { RenameSessionDialog } from "./components/workbench/dialogs/RenameSessionDialog";
import { WorkbenchErrorBoundary } from "./components/workbench/WorkbenchErrorBoundary";
import { CanvasNewSessionPane } from "./components/workbench/canvas/CanvasNewSessionPane";
import { CanvasSessionPane } from "./components/workbench/canvas/CanvasSessionPane";
import { CanvasWorkbench, type CanvasLayout } from "./components/workbench/canvas/CanvasWorkbench";
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
import { buildModelOptionValuesFromReasoning } from "./provider-capabilities";

const loadSettingsDialog = () => import("./components/workbench/dialogs/SettingsDialog");
const SettingsDialog = lazy(async () => ({
  default: (await loadSettingsDialog()).SettingsDialog,
}));
const WorkbenchTerminalDialog = lazy(async () => ({
  default: (await import("./components/workbench/dialogs/WorkbenchTerminalDialog"))
    .WorkbenchTerminalDialog,
}));
const InspectorPane = lazy(async () => ({
  default: (await import("./InspectorPane")).InspectorPane,
}));

type ModelDraft = {
  modelId?: string | null;
  reasoningId?: string | null;
  optionValues?: Record<string, SessionConfigValue>;
};

type WorkbenchMode = "single" | "canvas";
type CanvasPaneId = "canvas-1" | "canvas-2" | "canvas-3" | "canvas-4";
type CanvasPaneTarget =
  | { kind: "empty" }
  | { kind: "new" }
  | { kind: "session"; sessionId: string }
  | { kind: "stored"; ref: StoredSessionRef };
type CanvasNewSessionDraft = {
  provider: ProviderChoice;
  modeDrafts: Record<ProviderChoice, SessionModeDraft>;
  modelDrafts: Record<ProviderChoice, ModelDraft>;
};

const MODEL_DRAFT_STORAGE_KEY = "rah.modelDrafts.v2";
const LEGACY_MODEL_DRAFT_STORAGE_KEYS = ["rah.modelDrafts.v1"];
const PROVIDER_CHOICES: ProviderChoice[] = ["codex", "claude", "kimi", "gemini", "opencode"];
const CANVAS_PANE_IDS: CanvasPaneId[] = ["canvas-1", "canvas-2", "canvas-3", "canvas-4"];
const CANVAS_LAYOUT_PANE_COUNT: Record<CanvasLayout, number> = {
  "two-horizontal": 2,
  "two-vertical": 2,
  "three-horizontal": 3,
  "four-grid": 4,
};

function createEmptyCanvasTargets(): Record<CanvasPaneId, CanvasPaneTarget> {
  return {
    "canvas-1": { kind: "empty" },
    "canvas-2": { kind: "empty" },
    "canvas-3": { kind: "empty" },
    "canvas-4": { kind: "empty" },
  };
}

function createCanvasLayoutRatios(layout: CanvasLayout): number[] {
  return Array.from({ length: CANVAS_LAYOUT_PANE_COUNT[layout] }, () => 1);
}

function emptyModelDrafts(): Record<ProviderChoice, ModelDraft> {
  return {
    codex: {},
    claude: {},
    kimi: {},
    gemini: {},
    opencode: {},
  };
}

function createDefaultModeDrafts(): Record<ProviderChoice, SessionModeDraft> {
  return {
    codex: createDefaultModeDraft("codex"),
    claude: createDefaultModeDraft("claude"),
    kimi: createDefaultModeDraft("kimi"),
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

function rememberModelDraft(provider: ProviderChoice, draft: ModelDraft): void {
  if (typeof window === "undefined") return;
  try {
    const current = readRememberedModelDrafts();
    current[provider] = sanitizeModelDraft(draft);
    window.localStorage.setItem(MODEL_DRAFT_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Ignore storage failures; the in-memory draft still applies for this page.
  }
}

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
    loadOlderHistory,
    respondToPermission,
  } = useSessionStore(
    useShallow((state) => ({
      init: state.init,
      refreshWorkbenchState: state.refreshWorkbenchState,
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
      loadOlderHistory: state.loadOlderHistory,
      respondToPermission: state.respondToPermission,
    })),
  );
  const [archiveConfirmSessionId, setArchiveConfirmSessionId] = useState<string | null>(null);
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null);
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [renameDialogSessionId, setRenameDialogSessionId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
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
  const [canvasLayout, setCanvasLayoutState] = useState<CanvasLayout>("two-horizontal");
  const [canvasMaximizedPaneId, setCanvasMaximizedPaneId] = useState<CanvasPaneId | null>(null);
  const [activeCanvasPaneId, setActiveCanvasPaneId] = useState<CanvasPaneId>("canvas-1");
  const [canvasRatios, setCanvasRatios] = useState<number[]>(() =>
    createCanvasLayoutRatios("two-horizontal"),
  );
  const [canvasPaneTargets, setCanvasPaneTargets] =
    useState<Record<CanvasPaneId, CanvasPaneTarget>>(() => createEmptyCanvasTargets());
  const [canvasNewSessionDrafts, setCanvasNewSessionDrafts] =
    useState<Record<CanvasPaneId, CanvasNewSessionDraft>>(() =>
      createEmptyCanvasNewSessionDrafts(),
    );
  const [settingsDialogMounted, setSettingsDialogMounted] = useState(false);
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
    liveSessionEntries,
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

  const visibleCanvasPaneIds = canvasMaximizedPaneId
    ? [canvasMaximizedPaneId]
    : CANVAS_PANE_IDS.slice(0, CANVAS_LAYOUT_PANE_COUNT[canvasLayout]);
  const resolveCanvasProjection = (paneId: CanvasPaneId) => {
    const target = canvasPaneTargets[paneId];
    return resolveCanvasTargetProjection(target);
  };
  const resolveCanvasTargetProjection = (target: CanvasPaneTarget) => {
    if (target.kind === "session") {
      return projections.get(target.sessionId) ?? null;
    }
    if (target.kind === "stored") {
      for (const projection of projections.values()) {
        if (
          projection.summary.session.provider === target.ref.provider &&
          projection.summary.session.providerSessionId === target.ref.providerSessionId
        ) {
          return projection;
        }
      }
    }
    return null;
  };
  const resolveCanvasLiveUniquenessKey = (target: CanvasPaneTarget): string | null => {
    if (target.kind === "session") {
      const projection = projections.get(target.sessionId);
      return projection && isReadOnlyReplay(projection.summary) ? null : target.sessionId;
    }
    if (target.kind !== "stored") {
      return null;
    }
    const projection = resolveCanvasTargetProjection(target);
    if (!projection || isReadOnlyReplay(projection.summary)) {
      return null;
    }
    return projection.summary.session.id;
  };
  const activeCanvasProjection = resolveCanvasProjection(activeCanvasPaneId);
  const activeCanvasSummary = activeCanvasProjection?.summary ?? null;

  const setCanvasLayout = (layout: CanvasLayout) => {
    setCanvasLayoutState(layout);
    setCanvasMaximizedPaneId(null);
    setCanvasRatios(createCanvasLayoutRatios(layout));
    if (!CANVAS_PANE_IDS.slice(0, CANVAS_LAYOUT_PANE_COUNT[layout]).includes(activeCanvasPaneId)) {
      setActiveCanvasPaneId("canvas-1");
    }
  };

  const setCanvasPaneTarget = (paneId: CanvasPaneId, target: CanvasPaneTarget) => {
    setCanvasPaneTargets((current) => {
      const next = { ...current, [paneId]: target };
      const targetLiveKey = resolveCanvasLiveUniquenessKey(target);
      if (targetLiveKey) {
        for (const id of CANVAS_PANE_IDS) {
          if (id !== paneId && resolveCanvasLiveUniquenessKey(current[id]) === targetLiveKey) {
            next[id] = { kind: "empty" };
          }
        }
      }
      return next;
    });
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

  const clearCanvasPane = (paneId: CanvasPaneId) => {
    const projection = resolveCanvasProjection(paneId);
    setCanvasPaneTarget(paneId, { kind: "empty" });
    if (projection?.summary.session.id && selectedSessionId === projection.summary.session.id) {
      setSelectedSessionId(null);
    }
  };

  const toggleCanvasPaneMaximize = (paneId: CanvasPaneId) => {
    setActiveCanvasPaneId(paneId);
    setCanvasMaximizedPaneId((current) => (current === paneId ? null : paneId));
  };

  const enterCanvasMode = () => {
    if (selectedSessionId) {
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
    setWorkbenchMode("single");
  };

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
  });
  const startModelId = startModelControl.model?.id ?? null;
  const startOptionValues = startModelId
    ? buildModelOptionValuesFromReasoning({
        catalog: currentModelCatalogState?.catalog,
        modelId: startModelId,
        reasoningId: startModelControl.reasoning?.id ?? null,
      })
    : undefined;
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
    startReasoningId: startModelId ? startModelControl.reasoning?.id ?? null : null,
    ...(startOptionValues !== undefined ? { startOptionValues } : {}),
    confirmCreateMissingWorkspace,
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
      void loadProviderModels(provider).catch(() => undefined);
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
      selectedSessionId={
        workbenchMode === "canvas" ? activeCanvasSummary?.session.id ?? null : selectedSessionId
      }
      unreadSessionIds={unreadSessionIds}
      runtimeStatusBySessionId={runtimeStatusBySessionId}
      onSelectSession={(workspaceDir, id) => {
        if (workbenchMode === "canvas") {
          setWorkbenchMode("single");
        }
        setSelectedWorkspaceOnlyDir(null);
        setWorkspaceDir(workspaceDir);
        setSelectedSessionId(id);
        setLeftOpen(false);
      }}
      onSelectWorkspace={(dir) => {
        if (workbenchMode === "canvas") {
          setWorkbenchMode("single");
        }
        setSelectedWorkspaceOnlyDir(dir);
        setWorkspaceDir(dir);
        setSelectedSessionId(null);
        setLeftOpen(false);
      }}
      enableSessionDrag={workbenchMode === "canvas"}
      debugScenarios={debugScenarios}
      onStartScenario={(scenario) => {
        void startScenario(scenario);
        setLeftOpen(false);
      }}
    />
  );

  const handleActivateHistorySession = (ref: typeof storedSessions[number]) => {
    setLeftOpen(false);
    if (workbenchMode === "canvas") {
      setWorkbenchMode("single");
    }
    void activateHistorySession(ref, { confirmCreateMissingWorkspace });
  };

  const handleActivateLiveSession = (sessionId: string) => {
    setLeftOpen(false);
    if (workbenchMode === "canvas") {
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
        onOpenTerminal={() => setTerminalOpen(true)}
      />
    </Suspense>
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
        canvasActive={workbenchMode === "canvas"}
        onDesktopHome={() => {
          setWorkbenchMode("single");
          setSelectedWorkspaceOnlyDir(null);
          setSelectedSessionId(null);
          setRightSidebarOpen(false);
          setRightOpen(false);
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
        onMobileHome={() => {
          setWorkbenchMode("single");
          setSelectedWorkspaceOnlyDir(null);
          setSelectedSessionId(null);
          setRightSidebarOpen(false);
          setRightOpen(false);
          setLeftOpen(false);
        }}
        onActivateHistory={handleActivateHistorySession}
        onActivateLive={handleActivateLiveSession}
        onRemoveHistorySession={(session) => void removeHistorySession(session)}
        onRemoveHistoryWorkspace={(workspaceDir) => void removeHistoryWorkspaceSessions(workspaceDir)}
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

      <WorkbenchErrorBoundary resetKey={`${workbenchMode}:${selectedSessionId ?? primaryPaneState.kind}`}>
        {/* Center chat */}
        <main className="flex-1 flex flex-col min-w-0 overflow-x-hidden overflow-y-hidden">
          {workbenchMode === "canvas" ? (
            <CanvasWorkbench
              panes={visibleCanvasPaneIds.map((paneId, index) => {
                const projection = resolveCanvasProjection(paneId);
                const target = canvasPaneTargets[paneId];
                return {
                  id: paneId,
                  label: projection?.summary.session.title ?? `Pane ${index + 1}`,
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
              onExitCanvas={exitCanvasMode}
              onDropSession={(paneId, sessionId) =>
                setCanvasPaneSession(paneId as CanvasPaneId, sessionId)
              }
              renderPaneToolbar={(paneId) => {
                const typedPaneId = paneId as CanvasPaneId;
                const projection = resolveCanvasProjection(typedPaneId);
                return (
                  <>
                    {projection ? (
                      <ProviderLogo
                        provider={projection.summary.session.provider}
                        className="h-4 w-4"
                        variant="bare"
                      />
                    ) : null}
                  </>
                );
              }}
              renderPane={(paneId) => {
                const typedPaneId = paneId as CanvasPaneId;
                const target = canvasPaneTargets[typedPaneId];
                const projection = resolveCanvasProjection(typedPaneId);
                if (!projection) {
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
                    });
                    const paneStartModelId = paneModelControl.model?.id ?? null;
                    const paneStartOptionValues = paneStartModelId
                      ? buildModelOptionValuesFromReasoning({
                          catalog: paneModelCatalogState?.catalog,
                          modelId: paneStartModelId,
                          reasoningId: paneModelControl.reasoning?.id ?? null,
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
                        selectedReasoningId={paneModelControl.reasoning?.id ?? null}
                        accessModes={paneModeControl.accessModes}
                        selectedAccessModeId={paneModeControl.selectedAccessModeId}
                        planModeAvailable={paneModeControl.planModeAvailable}
                        planModeEnabled={paneModeControl.planModeEnabled}
                        startPending={pendingSessionTransition !== null}
                        onAddWorkspace={(dir) => void addWorkspace(dir)}
                        onSelectWorkspace={setWorkspaceDir}
                        onProviderChange={(provider) => {
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
                                current[typedPaneId].modelDrafts[paneProvider]?.modelId ??
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
                            ...(paneStartModelId && paneModelControl.reasoning?.id
                              ? { reasoningId: paneModelControl.reasoning.id }
                              : {}),
                            confirmCreateMissingWorkspace,
                            onSessionCreated: (sessionId) => {
                              setCanvasPaneSession(typedPaneId, sessionId);
                            },
                          })
                            .catch(() => undefined);
                        }}
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
                          Drop a live session here, choose a session, or create a new one.
                        </div>
                      </div>
                      <div className="grid w-full max-w-[17rem] grid-cols-2 gap-2">
                        <SessionHistoryDialog
                          storedSessions={storedSessions}
                          recentSessions={recentSessions}
                        liveSessions={liveSessionEntries.map((entry) => entry.summary)}
                        workspaceSortMode={historyWorkspaceSortMode}
                        onWorkspaceSortModeChange={setHistoryWorkspaceSortMode}
                        onActivate={(ref) => setCanvasPaneStoredRef(typedPaneId, ref)}
                        onActivateLive={(sessionId) => setCanvasPaneSession(typedPaneId, sessionId)}
                        onRemoveSession={(session) => void removeHistorySession(session)}
                        onRemoveWorkspace={(workspaceDir) =>
                          void removeHistoryWorkspaceSessions(workspaceDir)
                        }
                        defaultTab="live"
                          >
                          <button
                            type="button"
                            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 text-xs font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-bg)]"
                          >
                            <History size={14} />
                            Sessions
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
                    summary={summary}
                    projection={projection}
                    clientId={clientId}
                    hideToolCallsInChat={hideToolCallsInChat}
                    pendingSessionAction={
                      pendingSessionAction?.sessionId === summary.session.id
                        ? pendingSessionAction
                        : null
                    }
                    modelCatalog={modelCatalogState?.catalog ?? null}
                    modelCatalogLoading={modelCatalogState?.loading ?? false}
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
                    onClaimHistory={(sessionId, request) => {
                      void claimHistorySession(sessionId, {
                        confirmCreateMissingWorkspace,
                        ...request,
                      });
                    }}
                    onClaimControl={(sessionId) => claimControl(sessionId)}
                    onInterrupt={(sessionId) => void interruptSession(sessionId)}
                    onLoadOlderHistory={(sessionId) => loadOlderHistory(sessionId)}
                    onArchive={(sessionId) => setArchiveConfirmSessionId(sessionId)}
                    onCloseHistory={(sessionId) => void closeSession(sessionId)}
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
                const optionValues =
                  modelDraft?.optionValues ??
                  (modelDraft?.modelId
                    ? buildModelOptionValuesFromReasoning({
                        catalog: selectedModelCatalogState?.catalog,
                        modelId: modelDraft.modelId,
                        reasoningId: modelDraft.reasoningId ?? null,
                      })
                    : undefined);
                void claimHistorySession(sessionId, {
                  confirmCreateMissingWorkspace,
                  ...(claimModeControl?.effectiveModeId
                    ? { modeId: claimModeControl.effectiveModeId }
                    : {}),
                  ...(modelDraft?.modelId ? { modelId: modelDraft.modelId } : {}),
                  ...(optionValues !== undefined ? { optionValues } : {}),
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
                  claimModelDrafts[selectedSummary.session.id]?.modelId ??
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
                const modelId = modelDraft?.modelId ?? null;
                const reasoningId =
                  modelDraft?.reasoningId ?? claimModelControl?.reasoning?.id ?? null;
                const optionValues =
                  modelDraft?.optionValues ??
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
              onToggleInspector={() => setRightSidebarOpen((open) => !open)}
              showInspectorToggle={false}
              reserveInspectorToggleSpace
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
                      current[currentProvider]?.modelId ??
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
            />
          )}
        </main>

        {workbenchMode === "single" ? (
          <WorkbenchInspectorShell
            showDesktop
            desktopOpen={rightSidebarOpen}
            rightOpen={rightOpen}
            onRightOpenChange={setRightOpen}
            content={inspectorContent}
          />
        ) : null}
      </WorkbenchErrorBoundary>

      {workbenchMode === "single" ? (
        <>
          <button
            type="button"
            className="icon-click-feedback fixed right-[max(1rem,env(safe-area-inset-right))] top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-30 hidden h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]/90 text-[var(--app-hint)] shadow-sm backdrop-blur hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] md:inline-flex"
            onClick={() => setRightSidebarOpen((open) => !open)}
            aria-label={rightSidebarOpen ? "Collapse inspector" : "Expand inspector"}
            title={rightSidebarOpen ? "Collapse inspector" : "Expand inspector"}
          >
            <PanelRight size={16} />
          </button>
          <button
            type="button"
            className="icon-click-feedback fixed right-[max(1rem,env(safe-area-inset-right))] top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-30 inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]/90 text-[var(--app-hint)] shadow-sm backdrop-blur hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] md:hidden"
            onClick={() => setRightOpen(true)}
            aria-label="Open inspector"
            title="Open inspector"
          >
            <PanelRight size={18} />
          </button>
        </>
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
