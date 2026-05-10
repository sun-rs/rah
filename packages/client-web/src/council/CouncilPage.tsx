import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  Bot,
  CheckCircle2,
  MessageSquare,
  Plus,
  RefreshCw,
  Square,
  TerminalSquare,
  UsersRound,
  X,
} from "lucide-react";
import type {
  CouncilAgent,
  CouncilAgentTuiResponse,
  CouncilRoomSnapshot,
  ProviderModelCatalog,
} from "@rah/runtime-protocol";
import * as api from "../api";
import { ProviderLogo } from "../components/ProviderLogo";
import type { ProviderChoice } from "../components/ProviderSelector";
import { PROVIDER_OPTIONS } from "../components/ProviderSelector";
import { SessionModelControls } from "../components/SessionModelControls";
import {
  readRahTerminalFontFamily,
  readRahTerminalTheme,
} from "../TerminalPane";
import { resolveSessionModeControlState } from "../session-mode-ui";
import {
  councilAgentDraftToConfig,
  createDefaultCouncilAgentDrafts,
  normalizeCouncilAgentDraftForCatalog,
  resolveCouncilAgentModelSelection,
  type CouncilAgentDraft,
} from "./council-ui-state";

type CouncilPanel = "setup" | "chat" | "agents";

function actorLabel(room: CouncilRoomSnapshot, actorId: string): string {
  if (actorId === "user") return "You";
  if (actorId === "system") return "System";
  return room.agents.find((agent) => agent.id === actorId)?.label ?? actorId;
}

function textFromParts(parts: CouncilRoomSnapshot["messages"][number]["parts"]): string {
  return parts
    .map((part) => part.kind === "text" ? part.text : JSON.stringify(part.data))
    .join("\n");
}

function catalogKey(provider: ProviderChoice, workspace: string): string {
  return `${provider}:${workspace}`;
}

function panelVisibilityClass(panel: CouncilPanel, activePanel: CouncilPanel): string {
  return activePanel === panel ? "flex" : "hidden lg:flex";
}

function agentStatusClass(status: CouncilAgent["status"]): string {
  switch (status) {
    case "idle":
    case "waiting":
      return "bg-emerald-500/10 text-emerald-600";
    case "thinking":
    case "starting":
      return "bg-amber-500/10 text-amber-600";
    case "blocked":
    case "failed":
      return "bg-red-500/10 text-red-600";
    case "stopped":
      return "bg-zinc-500/10 text-zinc-500";
  }
}

function CouncilTuiSnapshot(props: { screen: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let disposed = false;
    const terminal = new Terminal({
      convertEol: false,
      disableStdin: true,
      fontFamily: readRahTerminalFontFamily(),
      fontSize: 12,
      letterSpacing: 0,
      lineHeight: 1.08,
      theme: readRahTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    const fit = () => {
      if (disposed) {
        return;
      }
      try {
        fitAddon.fit();
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
      } catch {
        // The next resize/snapshot render can recover the static TUI view.
      }
    };
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(container);
    terminal.write(props.screen || "\r\nNo TUI snapshot available yet.\r\n", fit);
    window.requestAnimationFrame(fit);
    const settleTimer = window.setTimeout(fit, 120);
    return () => {
      disposed = true;
      window.clearTimeout(settleTimer);
      resizeObserver.disconnect();
      terminal.dispose();
    };
  }, [props.screen]);

  return (
    <div
      ref={containerRef}
      className="terminal-canvas h-full min-h-0 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--terminal-bg,var(--app-code-bg))] p-2"
    />
  );
}

export function CouncilPage(props: {
  workspaceDir: string;
  onOpenSidebar: () => void;
}) {
  const [rooms, setRooms] = useState<CouncilRoomSnapshot[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [title, setTitle] = useState("Council");
  const [workspace, setWorkspace] = useState(props.workspaceDir || "");
  const [agentDrafts, setAgentDrafts] = useState<CouncilAgentDraft[]>(() =>
    createDefaultCouncilAgentDrafts(),
  );
  const [catalogs, setCatalogs] = useState<Record<string, ProviderModelCatalog>>({});
  const [activePanel, setActivePanel] = useState<CouncilPanel>("chat");
  const [selectedTui, setSelectedTui] = useState<CouncilAgentTuiResponse | null>(null);
  const [selectedTuiLoading, setSelectedTuiLoading] = useState(false);

  const selectedRoom = rooms.find((room) => room.room.id === selectedRoomId) ?? rooms[0] ?? null;

  const refreshRooms = async (): Promise<CouncilRoomSnapshot[]> => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listCouncilRooms();
      setRooms(response.rooms);
      setSelectedRoomId((current) => {
        if (current && response.rooms.some((room) => room.room.id === current)) {
          return current;
        }
        return response.rooms[0]?.room.id ?? null;
      });
      return response.rooms;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return [];
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshRooms();
  }, []);

  useEffect(() => {
    if (!selectedRoomId) return;
    const socket = api.createEventsSocket(
      {
        sessionIds: [selectedRoomId],
        eventTypes: ["council.message.created"],
      },
      (batch) => {
        const latest = batch.events
          .filter((event) => event.type === "council.message.created")
          .at(-1);
        if (!latest) return;
        setRooms((current) => {
          const nextRoom = latest.payload.room;
          const index = current.findIndex((room) => room.room.id === nextRoom.room.id);
          if (index < 0) {
            return [nextRoom, ...current];
          }
          const next = [...current];
          next[index] = nextRoom;
          return next;
        });
      },
      (caught) => setError(caught.message),
    );
    return () => socket.close();
  }, [selectedRoomId]);

  useEffect(() => {
    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void api.listCouncilRooms()
        .then((response) => {
          if (cancelled) return;
          setRooms(response.rooms);
          setSelectedRoomId((current) => {
            if (current && response.rooms.some((room) => room.room.id === current)) {
              return current;
            }
            return response.rooms[0]?.room.id ?? null;
          });
        })
        .catch((caught) => {
          if (!cancelled) {
            setError(caught instanceof Error ? caught.message : String(caught));
          }
        });
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    setWorkspace((current) => current || props.workspaceDir || "");
  }, [props.workspaceDir]);

  useEffect(() => {
    const requestedKeys = new Set<string>();
    for (const draft of agentDrafts) {
      const key = catalogKey(draft.provider, workspace);
      if (!workspace || catalogs[key] || requestedKeys.has(key)) continue;
      requestedKeys.add(key);
      void api.listProviderModels(draft.provider, { cwd: workspace })
        .then((catalog) => {
          setCatalogs((current) => ({ ...current, [key]: catalog }));
        })
        .catch(() => undefined);
    }
  }, [agentDrafts, catalogs, workspace]);

  useEffect(() => {
    setAgentDrafts((current) => {
      let changed = false;
      const next = current.map((draft) => {
        const catalog = catalogs[catalogKey(draft.provider, workspace)];
        if (!catalog) {
          return draft;
        }
        const normalized = normalizeCouncilAgentDraftForCatalog({ draft, catalog });
        if (normalized !== draft) {
          changed = true;
        }
        return normalized;
      });
      return changed ? next : current;
    });
  }, [catalogs, workspace]);

  useEffect(() => {
    if (!selectedTui) {
      return;
    }
    let cancelled = false;
    const refreshTui = async () => {
      try {
        const response = await api.getCouncilAgentTui(selectedTui.roomId, selectedTui.agentId);
        if (!cancelled) {
          setSelectedTui(response);
        }
      } catch {
        // Keep the last good snapshot; the room poll will surface failures.
      }
    };
    const intervalId = window.setInterval(() => void refreshTui(), 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedTui?.roomId, selectedTui?.agentId]);

  const updateDraft = (id: string, updater: (draft: CouncilAgentDraft) => CouncilAgentDraft) => {
    setAgentDrafts((current) => current.map((draft) => draft.id === id ? updater(draft) : draft));
  };

  const startRoom = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.createCouncilRoom({
        title,
        workspace,
        agents: agentDrafts.map((draft) =>
          councilAgentDraftToConfig({
            draft,
            catalog: catalogs[catalogKey(draft.provider, workspace)] ?? null,
          }),
        ),
      });
      await refreshRooms();
      setSelectedRoomId(response.room.room.id);
      setActivePanel("chat");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!selectedRoom || !composer.trim()) return;
    const text = composer;
    setComposer("");
    try {
      const response = await api.postCouncilMessage(selectedRoom.room.id, { text });
      setRooms((current) =>
        current.map((room) => room.room.id === selectedRoom.room.id ? response.room : room),
      );
    } catch (caught) {
      setComposer(text);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const stopRoom = async () => {
    if (!selectedRoom || selectedRoom.room.status === "stopped") return;
    setLoading(true);
    try {
      await api.archiveCouncilRoom(selectedRoom.room.id);
      setSelectedTui(null);
      await refreshRooms();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const openTui = async (agent: CouncilAgent) => {
    setSelectedTuiLoading(true);
    setError(null);
    try {
      setSelectedTui(await api.getCouncilAgentTui(agent.roomId, agent.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSelectedTuiLoading(false);
    }
  };

  const roomStats = useMemo(() => {
    return `${rooms.length} room${rooms.length === 1 ? "" : "s"}`;
  }, [rooms.length]);

  const setupPanelClass =
    `${panelVisibilityClass("setup", activePanel)} min-h-0 flex-col rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/40`;
  const chatPanelClass =
    `${panelVisibilityClass("chat", activePanel)} min-h-0 flex-col rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)]`;
  const agentsPanelClass =
    `${panelVisibilityClass("agents", activePanel)} min-h-0 flex-col rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/40`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--app-border)] px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            className="icon-click-feedback inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
            onClick={props.onOpenSidebar}
            title="Open sidebar"
          >
            <UsersRound size={16} />
          </button>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--app-fg)]">Council</div>
            <div className="truncate text-xs text-[var(--app-hint)]">{roomStats} · multi-agent room</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selectedRoom ? (
            <button
              type="button"
              onClick={() => void stopRoom()}
              disabled={loading || selectedRoom.room.status === "stopped"}
              className="icon-click-feedback inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--app-border)] px-2.5 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-40 sm:px-3"
              title="Stop room and its zellij session"
            >
              <Square size={13} />
              <span className="hidden sm:inline">Stop</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void refreshRooms()}
            className="icon-click-feedback inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--app-border)] px-2.5 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] sm:px-3"
          >
            <RefreshCw size={14} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </header>

      <nav className="grid h-11 shrink-0 grid-cols-3 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-1 lg:hidden">
        {([
          ["setup", "Setup"],
          ["chat", "Chat"],
          ["agents", "Agents"],
        ] as const).map(([panel, label]) => (
          <button
            key={panel}
            type="button"
            onClick={() => setActivePanel(panel)}
            className={`rounded-lg text-xs font-semibold transition-colors ${
              activePanel === panel
                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                : "text-[var(--app-hint)]"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-2 sm:p-3 lg:grid-cols-[19rem_minmax(0,1fr)_17rem]">
        <aside className={setupPanelClass}>
          <div className="border-b border-[var(--app-border)] px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--app-hint)]">
            Setup
          </div>
          <div className="space-y-3 overflow-y-auto p-3">
            <label className="block text-xs font-medium text-[var(--app-hint)]">
              Title
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="mt-1 h-9 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-sm text-[var(--app-fg)]"
              />
            </label>
            <label className="block text-xs font-medium text-[var(--app-hint)]">
              Workspace
              <input
                value={workspace}
                onChange={(event) => setWorkspace(event.target.value)}
                className="mt-1 h-9 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
              />
            </label>
            <div className="space-y-2">
              {agentDrafts.map((draft, index) => {
                const catalog = catalogs[catalogKey(draft.provider, workspace)];
                const modeState = resolveSessionModeControlState({
                  provider: draft.provider,
                  draft: draft.modeId ? { accessModeId: draft.modeId, planEnabled: false } : null,
                  catalog: catalog ?? null,
                });
                const selection = resolveCouncilAgentModelSelection({ draft, catalog: catalog ?? null });
                return (
                  <div key={draft.id} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-2.5">
                    <div className="mb-2 flex items-center justify-between text-xs font-semibold text-[var(--app-fg)]">
                      <span>Agent {index + 1}</span>
                      <ProviderLogo provider={draft.provider} className="h-4 w-4" variant="bare" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={draft.provider}
                        onChange={(event) => {
                          const provider = event.target.value as ProviderChoice;
                          updateDraft(draft.id, (item) => ({
                            ...item,
                            provider,
                            modelId: null,
                            reasoningId: null,
                            modeId: null,
                          }));
                        }}
                        className="h-8 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                      >
                        {PROVIDER_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                      <select
                        value={draft.modeId ?? modeState.selectedAccessModeId ?? ""}
                        onChange={(event) => updateDraft(draft.id, (item) => ({
                          ...item,
                          modeId: event.target.value || null,
                        }))}
                        className="h-8 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                      >
                        {modeState.accessModes.map((mode) => (
                          <option key={mode.id} value={mode.id}>{mode.label}</option>
                        ))}
                      </select>
                    </div>
                    <input
                      value={draft.label}
                      onChange={(event) => updateDraft(draft.id, (item) => ({
                        ...item,
                        label: event.target.value,
                      }))}
                      className="mt-2 h-8 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                      placeholder="Agent label"
                    />
                    <input
                      value={draft.role}
                      onChange={(event) => updateDraft(draft.id, (item) => ({
                        ...item,
                        role: event.target.value,
                      }))}
                      className="mt-2 h-8 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                      placeholder="Agent role"
                    />
                    <div className="mt-2">
                      <SessionModelControls
                        catalog={catalog ?? null}
                        selectedModelId={selection.modelId}
                        selectedReasoningId={selection.reasoningId}
                        loading={!catalog && Boolean(workspace)}
                        compact
                        onModelChange={(modelId, defaultReasoningId) => {
                          updateDraft(draft.id, (item) => ({
                            ...item,
                            modelId,
                            reasoningId: defaultReasoningId ?? null,
                          }));
                        }}
                        onReasoningChange={(reasoningId) => {
                          updateDraft(draft.id, (item) => ({
                            ...item,
                            reasoningId,
                          }));
                        }}
                      />
                      {catalog && selection.model && selection.reasoningOptions.length === 0 ? (
                        <div className="mt-1 truncate text-[11px] text-[var(--app-hint)]">
                          {selection.model.label} has no startup parameter options.
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAgentDrafts((current) => [
                  ...current,
                  {
                    id: `opencode-${current.length + 1}`,
                    provider: "opencode",
                    label: `OpenCode ${current.length + 1}`,
                    role: "Specialist",
                    modelId: null,
                    reasoningId: null,
                    modeId: null,
                  },
                ])}
                className="icon-click-feedback inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-bg)]"
              >
                <Plus size={14} />
                Add
              </button>
              <button
                type="button"
                disabled={loading || !workspace.trim()}
                onClick={() => void startRoom()}
                className="icon-click-feedback inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--app-fg)] px-3 text-xs font-semibold text-[var(--app-bg)] disabled:opacity-40"
              >
                Start
              </button>
            </div>
            {rooms.length > 0 ? (
              <div className="space-y-1 border-t border-[var(--app-border)] pt-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--app-hint)]">
                  Rooms
                </div>
                {rooms.slice(0, 8).map((room) => (
                  <button
                    key={room.room.id}
                    type="button"
                    onClick={() => {
                      setSelectedRoomId(room.room.id);
                      setActivePanel("chat");
                    }}
                    className={`flex h-9 w-full items-center justify-between rounded-lg px-2 text-left text-xs ${
                      selectedRoom?.room.id === room.room.id
                        ? "bg-[var(--app-bg)] text-[var(--app-fg)]"
                        : "text-[var(--app-hint)] hover:bg-[var(--app-bg)]"
                    }`}
                  >
                    <span className="truncate">{room.room.title}</span>
                    <span className="ml-2 shrink-0">{room.room.status}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </aside>

        <section className={chatPanelClass}>
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--app-border)] px-4">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[var(--app-fg)]">
                {selectedRoom?.room.title ?? "No council room"}
              </div>
              <div className="truncate text-xs text-[var(--app-hint)]">
                {selectedRoom ? `${selectedRoom.room.status} · ${selectedRoom.room.workspace}` : "Start a room to begin."}
              </div>
            </div>
            {selectedRoom?.room.status === "running" ? (
              <span className="inline-flex h-7 items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 text-[11px] font-semibold text-emerald-600">
                <CheckCircle2 size={13} />
                Live
              </span>
            ) : null}
          </div>
          {error ? (
            <div className="mx-4 mt-3 rounded-lg border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10 px-3 py-2 text-xs text-[var(--app-danger)]">
              {error}
            </div>
          ) : null}
          {selectedRoom?.room.error ? (
            <div className="mx-4 mt-3 rounded-lg border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10 px-3 py-2 text-xs text-[var(--app-danger)]">
              {selectedRoom.room.error}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
            {selectedRoom?.messages.map((message) => (
              <div
                key={message.id}
                className={`max-w-[92%] rounded-2xl border px-3 py-2 text-sm sm:max-w-[82%] ${
                  message.role === "user"
                    ? "ml-auto border-[var(--app-border)] bg-[var(--app-fg)] text-[var(--app-bg)]"
                    : message.role === "system"
                      ? "mx-auto border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                      : "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                }`}
              >
                <div className="mb-1 text-[11px] font-semibold opacity-70">
                  {selectedRoom ? actorLabel(selectedRoom, message.actorId) : message.actorId}
                </div>
                <div className="whitespace-pre-wrap leading-relaxed">{textFromParts(message.parts)}</div>
              </div>
            ))}
          </div>
          <div className="flex shrink-0 items-end gap-2 border-t border-[var(--app-border)] p-2 sm:p-3">
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              disabled={!selectedRoom || selectedRoom.room.status === "stopped"}
              className="min-h-10 flex-1 resize-none rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none"
              placeholder="Post to the council room..."
              rows={2}
            />
            <button
              type="button"
              disabled={!selectedRoom || !composer.trim() || selectedRoom.room.status === "stopped"}
              onClick={() => void sendMessage()}
              className="icon-click-feedback inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--app-fg)] px-3 text-sm font-semibold text-[var(--app-bg)] disabled:opacity-40 sm:px-4"
            >
              <MessageSquare size={15} />
              <span className="hidden sm:inline">Send</span>
            </button>
          </div>
        </section>

        <aside className={agentsPanelClass}>
          <div className="border-b border-[var(--app-border)] px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--app-hint)]">
            Agents
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {selectedRoom?.agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => void openTui(agent)}
                className="icon-click-feedback flex w-full items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-left hover:bg-[var(--app-subtle-bg)]"
              >
                <ProviderLogo provider={agent.provider} className="h-5 w-5" variant="bare" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-[var(--app-fg)]">{agent.label}</div>
                  <div className="truncate text-xs text-[var(--app-hint)]">{agent.modelId ?? "provider default"}</div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${agentStatusClass(agent.status)}`}>
                  {agent.status}
                </span>
                <TerminalSquare size={15} className="text-[var(--app-hint)]" />
              </button>
            ))}
            {!selectedRoom ? (
              <div className="rounded-xl border border-dashed border-[var(--app-border)] p-4 text-center text-xs text-[var(--app-hint)]">
                Start or select a room to see agents.
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      {selectedTui ? (
        <div className="fixed inset-2 z-[70] flex flex-col rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl sm:inset-5">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--app-border)] px-3 sm:px-4">
            <div className="flex min-w-0 items-center gap-2">
              <Bot size={15} className="text-[var(--app-hint)]" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[var(--app-fg)]">
                  {selectedRoom?.agents.find((agent) => agent.id === selectedTui.agentId)?.label ?? selectedTui.agentId}
                </div>
                <div className="truncate text-[11px] text-[var(--app-hint)]">
                  {selectedTui.zellijSessionName ?? "zellij"} · {selectedTui.paneId ?? "pane pending"}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => selectedTui && void openTui({
                  id: selectedTui.agentId,
                  roomId: selectedTui.roomId,
                  provider: "codex",
                  label: selectedTui.agentId,
                  status: "idle",
                  updatedAt: "",
                } as CouncilAgent)}
                disabled={selectedTuiLoading}
                className="icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                title="Refresh TUI snapshot"
              >
                <RefreshCw size={14} />
              </button>
              <button
                type="button"
                onClick={() => setSelectedTui(null)}
                className="icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                title="Close TUI snapshot"
              >
                <X size={15} />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 p-2 sm:p-3">
            <CouncilTuiSnapshot screen={selectedTui.screen} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
