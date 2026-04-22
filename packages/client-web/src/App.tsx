import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionResponseRequest, StoredSessionRef } from "@rah/runtime-protocol";
import { Archive, LoaderCircle, Menu, PanelRight, History, Home, ArrowUp, Plus, Square, X, Settings, ChevronDown, Folder, FolderPlus } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { InspectorPane } from "./InspectorPane";
import { SessionSidebar } from "./SessionSidebar";
import {
  deriveWorkspaceInfos,
  deriveWorkspaceSections,
  groupLiveSessionsByDirectory,
  sortWorkspaceInfos,
  type WorkspaceSortMode,
} from "./session-browser";
import { providerLabel } from "./types";
import { useSessionStore } from "./useSessionStore";
import { ChatThread } from "./components/chat/ChatThread";
import { FileReferencePicker } from "./components/FileReferencePicker";
import { ProviderLogo } from "./components/ProviderLogo";
import { ProviderSelector, type ProviderChoice } from "./components/ProviderSelector";
import { SettingsPane } from "./components/SettingsPane";
import { SessionHistoryDialog } from "./components/SessionHistoryDialog";
import { Sheet } from "./components/Sheet";
import { StatusCallout } from "./components/StatusCallout";
import { TokenizedTextarea } from "./components/TokenizedTextarea";
import { WorkspacePicker } from "./components/WorkspacePicker";
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

const WORKSPACE_SORT_MODE_KEY = "rah.workspace-sort-mode";
const PINNED_WORKSPACE_SESSION_KEY = "rah.pinned-session-by-workspace";

interface OpeningSessionState {
  mode: "new" | "history";
  provider: StoredSessionRef["provider"];
  title?: string;
  cwd?: string;
}

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
  const [openingSession, setOpeningSession] = useState<OpeningSessionState | null>(null);
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
  const pendingEmptyDraftRef = useRef("");
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

  const sortedWorkspaceInfos = useMemo(
    () => sortWorkspaceInfos(workspaceInfos, workspaceSortMode),
    [workspaceInfos, workspaceSortMode],
  );

  const workspaceSections = useMemo(
    () =>
      deriveWorkspaceSections(
        sortedWorkspaceInfos,
        attachedLiveSessionEntries.map((entry) => entry.summary),
      ),
    [attachedLiveSessionEntries, sortedWorkspaceInfos],
  );

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
  const archiveTargetSummary = archiveConfirmSessionId
    ? projections.get(archiveConfirmSessionId)?.summary ?? null
    : null;
  const activeOpeningSession = launchStatus
    ? {
        mode: "new" as const,
        provider: launchStatus.provider,
        title: launchStatus.title,
        cwd: launchStatus.cwd,
      }
    : openingSession;

  useEffect(() => {
    if (selectedSummary) {
      setOpeningSession(null);
    }
  }, [selectedSummary?.session.id]);

  useEffect(() => {
    if (error) {
      setOpeningSession(null);
    }
  }, [error]);

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
    if (!selectedSummary || !pendingEmptyDraftRef.current) return;
    void sendInput(selectedSummary.session.id, pendingEmptyDraftRef.current);
    pendingEmptyDraftRef.current = "";
  }, [selectedSummary?.session.id, sendInput]);

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
    pendingEmptyDraftRef.current = text;
    setEmptyStateDraft("");
    setOpeningSession({
      mode: "new",
      provider: newSessionProvider as StoredSessionRef["provider"],
      title: text.slice(0, 50),
      cwd: availableWorkspaceDir,
    });
    void startSession({
      provider: newSessionProvider,
      cwd: availableWorkspaceDir,
      title: text.slice(0, 50),
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
    const existingLive = liveSessionByProviderSessionId.get(ref.providerSessionId);
    if (existingLive) {
      setOpeningSession(null);
      setSelectedSessionId(existingLive.session.id);
      return;
    }
    setOpeningSession({
      mode: "history",
      provider: ref.provider,
      title: ref.title ?? ref.preview ?? ref.providerSessionId,
      ...(ref.rootDir ?? ref.cwd ? { cwd: ref.rootDir ?? ref.cwd } : {}),
    });
    void resumeStoredSession(ref, { preferStoredReplay: true }).catch(() => {
      setOpeningSession(null);
    });
  };

  const availableWorkspaceDir = workspaceDirs.length > 0 ? workspaceDir : "";
  const inspectorContent =
    selectedSummary ? (
      <InspectorPane
        sessionId={selectedSummary.session.id}
        events={selectedProjection?.events ?? []}
        onCollapse={() => setRightSidebarOpen(false)}
      />
    ) : (
      <div className="h-full" />
    );

  return (
    <div className="h-screen w-full max-w-full flex overflow-hidden overflow-x-hidden bg-background text-foreground">
      {/* Desktop left sidebar */}
      <aside
        className="hidden md:flex flex-col bg-[var(--app-subtle-bg)] shrink-0 transition-[width] duration-200 overflow-hidden"
        style={{ width: sidebarOpen ? sidebarWidth : 0 }}
      >
        <div className="h-14 px-4 flex items-center justify-between shrink-0">
          {sidebarOpen && (
            <>
              <div className="shrink-0 text-lg font-semibold tracking-tight">RAH</div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
                  onClick={() => setSelectedSessionId(null)}
                  aria-label="Home"
                  title="Home"
                >
                  <Home size={16} />
                </button>
                <SessionHistoryDialog
                  storedSessions={storedSessions}
                  recentSessions={recentSessions}
                  liveSessions={attachedLiveSessionEntries.map((entry) => entry.summary)}
                  onActivate={handleActivateHistorySession}
                  onRemoveSession={(session) => void removeHistorySession(session)}
                  onRemoveWorkspace={(workspaceDir) => void removeHistoryWorkspaceSessions(workspaceDir)}
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
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
              onClick={() => {
                setSelectedSessionId(null);
                setLeftOpen(false);
              }}
              aria-label="Home"
              title="Home"
            >
              <Home size={16} />
            </button>
            <SessionHistoryDialog
              storedSessions={storedSessions}
              recentSessions={recentSessions}
              liveSessions={attachedLiveSessionEntries.map((entry) => entry.summary)}
              onActivate={handleActivateHistorySession}
              onRemoveSession={(session) => void removeHistorySession(session)}
              onRemoveWorkspace={(workspaceDir) => void removeHistoryWorkspaceSessions(workspaceDir)}
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

      <Dialog.Root
        open={archiveConfirmSessionId !== null}
        onOpenChange={(open) => {
          if (!open && archivingSessionId === null) {
            setArchiveConfirmSessionId(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[90vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none z-50 flex flex-col">
            <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
              <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
                Archive session?
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={archivingSessionId !== null}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40 transition-colors"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <div className="px-4 py-4 text-sm text-[var(--app-hint)]">
              {archiveTargetSummary ? (
                <>
                  Archive{" "}
                  <span className="font-medium text-[var(--app-fg)]">
                    {archiveTargetSummary.session.title ?? archiveTargetSummary.session.id}
                  </span>
                  ? You can reopen it from Session History.
                </>
              ) : (
                "Archive this live session? You can reopen it from Session History."
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--app-border)] px-4 py-3">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={archivingSessionId !== null}
                  className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-40 transition-colors"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                disabled={archiveConfirmSessionId === null || archivingSessionId !== null}
                onClick={() => {
                  if (!archiveConfirmSessionId) {
                    return;
                  }
                  setArchivingSessionId(archiveConfirmSessionId);
                  void closeSession(archiveConfirmSessionId)
                    .then(() => setArchiveConfirmSessionId(null))
                    .finally(() => setArchivingSessionId(null));
                }}
                className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 transition-colors"
              >
                {archivingSessionId !== null ? "Archiving…" : "Archive"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

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
                  onClick={() => {
                    if (selectedIsReadOnlyReplay) {
                      void closeSession(selectedSummary.session.id);
                      return;
                    }
                    setArchiveConfirmSessionId(selectedSummary.session.id);
                  }}
                  title={
                    !isAttached
                      ? "This client is not attached"
                      : selectedIsReadOnlyReplay
                        ? "Close this history view"
                        : "Archive this live session"
                  }
                >
                  {selectedIsReadOnlyReplay ? (
                    <>
                      <X size={14} className="mr-1" />
                      <span>Close</span>
                    </>
                  ) : (
                    <>
                      <Archive size={14} className="mr-1" />
                      <span>Archive</span>
                    </>
                  )}
                </button>
                {!rightSidebarOpen && (
                  <button
                    type="button"
                    className="hidden md:inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                    onClick={() => setRightSidebarOpen(true)}
                    aria-label="Expand inspector"
                    title="Expand inspector"
                  >
                    <PanelRight size={16} />
                  </button>
                )}
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
            <div
              className="shrink-0 bg-[var(--app-bg)] px-3 pt-2 md:px-4 md:pt-3"
              style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
            >
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
              ) : !hasControl ? (
                <div className="mx-auto max-w-3xl">
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[var(--app-fg)]">Claim control</div>
                      <div className="text-xs text-[var(--app-hint)]">Claim control to continue here.</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void claimControl(selectedSummary.session.id)}
                      className="shrink-0 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
                    >
                      Claim control
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mx-auto max-w-3xl">
                  <div className="flex items-center gap-2 md:gap-3">
                    <button
                      type="button"
                      onClick={() => setFileReferenceOpen(true)}
                      className="shrink-0 h-11 w-11 md:h-12 md:w-12 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)] flex items-center justify-center hover:text-[var(--app-fg)] transition-colors"
                      title="Insert file or folder reference"
                    >
                      <Plus size={18} />
                    </button>
                    <TokenizedTextarea
                      ref={composerRef}
                      textareaClassName="w-full resize-none bg-[var(--app-subtle-bg)] rounded-xl border border-[var(--app-border)] px-3 py-2 md:px-4 md:py-3 text-base leading-5 focus:outline-none focus:ring-1 focus:ring-[var(--ring)] min-h-[44px] md:min-h-[48px] max-h-[160px]"
                      contentClassName="px-3 py-2 md:px-4 md:py-3 text-base leading-5 min-h-[44px] md:min-h-[48px]"
                      value={draft}
                      onChange={setDraft}
                      placeholder="Message…"
                      rows={1}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void handleSend();
                        }
                      }}
                    />
                    {isGenerating && canSendInput && hasControl ? (
                      <div className="relative shrink-0 h-11 w-11 md:h-12 md:w-12">
                        {/* Keep the animated ring inside a fixed wrapper so it can't change scroll overflow. */}
                        <svg
                          className="pointer-events-none absolute inset-0 h-full w-full animate-[spin_1.2s_linear_infinite]"
                          viewBox="0 0 48 48"
                        >
                          <circle
                            cx="24"
                            cy="24"
                            r="20"
                            fill="none"
                            stroke="color-mix(in oklab, var(--app-danger) 65%, transparent)"
                            strokeWidth="2.5"
                            strokeDasharray="78 30"
                            strokeLinecap="round"
                          />
                        </svg>
                        <button
                          type="button"
                          onClick={() => void interruptSession(selectedSummary.session.id)}
                          className="absolute inset-[2px] rounded-full bg-[var(--app-danger)] text-white flex items-center justify-center transition-all duration-200 hover:opacity-90 hover:scale-105 active:scale-95"
                        >
                          <Square size={14} />
                        </button>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      disabled={!draft.trim()}
                      onClick={() => void handleSend()}
                      className="shrink-0 h-11 w-11 md:h-12 md:w-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 disabled:opacity-40 transition-colors"
                    >
                      <ArrowUp size={18} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : activeOpeningSession ? (
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
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--app-fg)]">
                    {activeOpeningSession.mode === "new" ? "Starting session" : "Opening history session"}
                  </div>
                  <div className="text-[11px] text-[var(--app-hint)]">
                    Preparing content…
                  </div>
                </div>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              <div className="mx-auto flex min-h-full w-full max-w-2xl items-center justify-center px-6 py-8 md:px-10 md:py-12">
                <div className="w-full rounded-3xl border border-[var(--app-border)] bg-[var(--app-bg)] px-6 py-8 text-center shadow-sm md:px-12 md:py-14">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--app-subtle-bg)] md:h-20 md:w-20">
                    <ProviderLogo provider={activeOpeningSession.provider} className="h-8 w-8 md:h-12 md:w-12" />
                  </div>
                  <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-1 text-xs font-medium text-[var(--app-hint)] md:mt-6 md:px-4 md:py-1.5 md:text-sm">
                    <LoaderCircle size={14} className="animate-spin md:h-4 md:w-4" />
                    <span>
                      {activeOpeningSession.mode === "new" ? "Starting…" : "Opening…"}
                    </span>
                  </div>
                  <div className="mt-4 text-lg font-semibold text-[var(--app-fg)] md:mt-8 md:text-3xl md:tracking-tight">
                    {activeOpeningSession.title ??
                      (activeOpeningSession.mode === "new"
                        ? `${providerLabel(activeOpeningSession.provider)} session`
                        : "History session")}
                  </div>
                  <div className="mx-auto mt-2 max-w-md text-sm text-[var(--app-hint)] md:mt-4 md:max-w-lg md:text-base md:leading-7">
                    {activeOpeningSession.mode === "new"
                      ? `Launching ${providerLabel(activeOpeningSession.provider)} and preparing the workspace.`
                      : `Restoring ${providerLabel(activeOpeningSession.provider)} session and rebuilding the timeline.`}
                  </div>
                  {activeOpeningSession.cwd ? (
                    <div className="mx-auto mt-4 max-w-lg rounded-2xl bg-[var(--app-subtle-bg)] px-4 py-3 text-left md:mt-8 md:px-6 md:py-5">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--app-hint)] md:text-xs">
                        Workspace
                      </div>
                      <div className="mt-1 truncate text-sm text-[var(--app-fg)] md:mt-2 md:text-base" title={activeOpeningSession.cwd}>
                        {activeOpeningSession.cwd}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
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
            <div className="flex-1 flex flex-col items-center justify-center px-6 overflow-y-auto custom-scrollbar">
              <div className="w-full max-w-2xl -translate-y-6 space-y-5 md:-translate-y-8 md:space-y-6">
                <div className="text-center">
                  <h1 className="text-2xl font-semibold text-[var(--app-fg)]">
                    What would you like to build?
                  </h1>
                </div>
                <div className="relative">
                  <TokenizedTextarea
                    ref={emptyStateComposerRef}
                    textareaClassName="w-full resize-none bg-[var(--app-subtle-bg)] rounded-2xl border border-[var(--app-border)] px-4 py-3 pr-14 pb-12 text-base focus:outline-none focus:ring-1 focus:ring-[var(--ring)] min-h-[120px]"
                    contentClassName="px-4 py-3 pr-14 pb-12 text-base min-h-[120px]"
                    placeholder="Message…"
                    rows={3}
                    value={emptyStateDraft}
                    onChange={setEmptyStateDraft}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleEmptyStateSend();
                      }
                    }}
                  />
                  {/* Workspace picker — bottom left */}
                  <div ref={workspacePickerRef} className="absolute bottom-3 left-3 z-10 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setFileReferenceOpen(true)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-bg)] transition-colors"
                      title="Insert file or folder reference"
                    >
                      <Plus size={16} />
                    </button>
                    {workspaceDirs.length === 0 ? (
                      <WorkspacePicker
                        currentDir=""
                        triggerLabel="Workspace"
                        triggerIcon={<FolderPlus size={13} />}
                        triggerClassName="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-bg)] transition-colors"
                        onSelect={(dir) => {
                          void addWorkspace(dir);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setWorkspacePickerOpen((v) => !v)}
                        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-bg)] transition-colors"
                      >
                        <Folder size={13} />
                        <span className="max-w-[140px] truncate">
                          {availableWorkspaceDir
                            ? availableWorkspaceDir.split("/").pop()
                            : "Workspace"}
                        </span>
                        <ChevronDown size={12} className={`transition-transform ${workspacePickerOpen ? "rotate-180" : ""}`} />
                      </button>
                    )}
                    {workspaceDirs.length > 0 && workspacePickerOpen && (
                      <div className="absolute bottom-full left-0 mb-1 w-56 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-lg">
                        {workspaceDirs.map((dir) => (
                          <button
                            key={dir}
                            type="button"
                            onClick={() => {
                              setWorkspaceDir(dir);
                              setWorkspacePickerOpen(false);
                            }}
                            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                              dir === availableWorkspaceDir ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]" : "text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                            }`}
                          >
                            <Folder size={13} className="shrink-0 text-[var(--app-hint)]" />
                            <span className="truncate">{dir}</span>
                            {dir === availableWorkspaceDir && <span className="ml-auto text-[10px] text-[var(--app-hint)]">●</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={!emptyStateDraft.trim() || !availableWorkspaceDir}
                    onClick={() => handleEmptyStateSend()}
                    className="absolute bottom-3 right-3 h-10 w-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 disabled:opacity-40 transition-colors"
                  >
                    <ArrowUp size={18} />
                  </button>
                </div>
                <div className="w-full max-w-3xl mx-auto">
                  <ProviderSelector
                    value={newSessionProvider as ProviderChoice}
                    onChange={(v) => setNewSessionProvider(v)}
                    mode="grid"
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {/* Desktop right inspector */}
      {selectedSummary && (
        <>
          {rightSidebarOpen && <div className="hidden md:block resize-handle" />}
          <aside
            className="hidden md:flex flex-col shrink-0 transition-[width] duration-200 overflow-hidden bg-[var(--app-subtle-bg)]"
            style={{ width: rightSidebarOpen ? 320 : 0 }}
          >
            {rightSidebarOpen && inspectorContent}
          </aside>
        </>
      )}

      {/* Mobile right sheet */}
      <Sheet open={rightOpen} onOpenChange={setRightOpen} side="right" title="Inspector">
        {inspectorContent}
      </Sheet>

      {errorDescriptor ? (
        <div
          className="fixed left-1/2 z-[60] w-[min(92vw,48rem)] -translate-x-1/2"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 6rem)" }}
        >
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
      {launchStatus && selectedSummary ? (
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
