import { useEffect, useMemo, useState } from "react";
import { Archive, Bot, MessageSquare, Plus, RefreshCw, TerminalSquare, UsersRound } from "lucide-react";
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
import { resolveSessionModeControlState } from "../session-mode-ui";
import {
  councilAgentDraftToConfig,
  createDefaultCouncilAgentDrafts,
  type CouncilAgentDraft,
} from "./council-ui-state";

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
  const [selectedTui, setSelectedTui] = useState<CouncilAgentTuiResponse | null>(null);

  const selectedRoom = rooms.find((room) => room.room.id === selectedRoomId) ?? rooms[0] ?? null;

  const refreshRooms = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listCouncilRooms();
      setRooms(response.rooms);
      if (!selectedRoomId && response.rooms[0]) {
        setSelectedRoomId(response.rooms[0].room.id);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
          if (!selectedRoomId && response.rooms[0]) {
            setSelectedRoomId(response.rooms[0].room.id);
          }
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
  }, [selectedRoomId]);

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

  const archiveRoom = async () => {
    if (!selectedRoom) return;
    setLoading(true);
    try {
      await api.archiveCouncilRoom(selectedRoom.room.id);
      await refreshRooms();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const openTui = async (agent: CouncilAgent) => {
    try {
      setSelectedTui(await api.getCouncilAgentTui(agent.roomId, agent.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const roomStats = useMemo(() => {
    return `${rooms.length} room${rooms.length === 1 ? "" : "s"}`;
  }, [rooms.length]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--app-border)] px-4">
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
            <div className="truncate text-xs text-[var(--app-hint)]">{roomStats} · plugin-style multi-agent room</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refreshRooms()}
          className="icon-click-feedback inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--app-border)] px-3 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[20rem_minmax(0,1fr)_18rem] gap-3 p-3 max-[980px]:grid-cols-1">
        <aside className="flex min-h-0 flex-col rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/40">
          <div className="border-b border-[var(--app-border)] px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--app-hint)]">
            Start Room
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
                const model = catalog?.models.find((entry) => entry.id === draft.modelId) ?? catalog?.models[0];
                const reasoningOptions = model?.reasoningOptions ?? [];
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
                          setAgentDrafts((current) => current.map((item) =>
                            item.id === draft.id
                              ? { ...item, provider, modelId: null, reasoningId: null, modeId: null }
                              : item,
                          ));
                        }}
                        className="h-8 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                      >
                        {PROVIDER_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                      <select
                        value={draft.modeId ?? modeState.selectedAccessModeId ?? ""}
                        onChange={(event) => setAgentDrafts((current) => current.map((item) =>
                          item.id === draft.id ? { ...item, modeId: event.target.value || null } : item,
                        ))}
                        className="h-8 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                      >
                        {modeState.accessModes.map((mode) => (
                          <option key={mode.id} value={mode.id}>{mode.label}</option>
                        ))}
                      </select>
                    </div>
                    <input
                      value={draft.label}
                      onChange={(event) => setAgentDrafts((current) => current.map((item) =>
                        item.id === draft.id ? { ...item, label: event.target.value } : item,
                      ))}
                      className="mt-2 h-8 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                    />
                    <input
                      value={draft.role}
                      onChange={(event) => setAgentDrafts((current) => current.map((item) =>
                        item.id === draft.id ? { ...item, role: event.target.value } : item,
                      ))}
                      className="mt-2 h-8 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                    />
                    <select
                      value={draft.modelId ?? catalog?.models[0]?.id ?? ""}
                      onChange={(event) => {
                        const selected = catalog?.models.find((entry) => entry.id === event.target.value);
                        setAgentDrafts((current) => current.map((item) =>
                          item.id === draft.id
                            ? {
                                ...item,
                                modelId: event.target.value || null,
                                reasoningId: selected?.reasoningOptions?.at(-1)?.id ?? null,
                              }
                            : item,
                        ));
                      }}
                      className="mt-2 h-8 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                    >
                      {(catalog?.models ?? []).map((entry) => (
                        <option key={entry.id} value={entry.id}>{entry.label}</option>
                      ))}
                    </select>
                    {reasoningOptions.length > 0 ? (
                      <select
                        value={draft.reasoningId ?? reasoningOptions.at(-1)?.id ?? ""}
                        onChange={(event) => setAgentDrafts((current) => current.map((item) =>
                          item.id === draft.id ? { ...item, reasoningId: event.target.value || null } : item,
                        ))}
                        className="mt-2 h-8 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                      >
                        {reasoningOptions.map((entry) => (
                          <option key={entry.id} value={entry.id}>{entry.label}</option>
                        ))}
                      </select>
                    ) : null}
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
                Add agent
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
          </div>
        </aside>

        <section className="flex min-h-0 flex-col rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)]">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--app-border)] px-4">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[var(--app-fg)]">
                {selectedRoom?.room.title ?? "No council room"}
              </div>
              <div className="truncate text-xs text-[var(--app-hint)]">
                {selectedRoom ? `${selectedRoom.room.status} · ${selectedRoom.room.workspace}` : "Start a room to begin."}
              </div>
            </div>
            {selectedRoom ? (
              <button
                type="button"
                onClick={() => void archiveRoom()}
                className="icon-click-feedback inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--app-border)] px-3 text-xs text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
              >
                <Archive size={14} />
                Archive
              </button>
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
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {selectedRoom?.messages.map((message) => (
              <div
                key={message.id}
                className={`max-w-[82%] rounded-2xl border px-3 py-2 text-sm ${
                  message.role === "user"
                    ? "ml-auto border-[var(--app-border)] bg-[var(--app-fg)] text-[var(--app-bg)]"
                    : message.role === "system"
                      ? "mx-auto border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                      : "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                }`}
              >
                <div className="mb-1 text-[11px] font-semibold opacity-70">
                  {actorLabel(selectedRoom, message.actorId)}
                </div>
                <div className="whitespace-pre-wrap leading-relaxed">{textFromParts(message.parts)}</div>
              </div>
            ))}
          </div>
          <div className="flex shrink-0 items-end gap-2 border-t border-[var(--app-border)] p-3">
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              disabled={!selectedRoom}
              className="min-h-10 flex-1 resize-none rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none"
              placeholder="Post to the council room…"
              rows={2}
            />
            <button
              type="button"
              disabled={!selectedRoom || !composer.trim()}
              onClick={() => void sendMessage()}
              className="icon-click-feedback inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--app-fg)] px-4 text-sm font-semibold text-[var(--app-bg)] disabled:opacity-40"
            >
              <MessageSquare size={15} />
              Send
            </button>
          </div>
        </section>

        <aside className="flex min-h-0 flex-col rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/40">
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
                  <div className="truncate text-xs text-[var(--app-hint)]">{agent.status} · {agent.modelId ?? "provider default"}</div>
                </div>
                <TerminalSquare size={15} className="text-[var(--app-hint)]" />
              </button>
            ))}
          </div>
          {selectedTui ? (
            <div className="border-t border-[var(--app-border)] p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--app-fg)]">
                <Bot size={14} />
                {selectedTui.agentId}
              </div>
              <pre className="max-h-52 overflow-auto rounded-xl bg-black p-3 text-[11px] leading-relaxed text-white">
                {selectedTui.screen || "No TUI snapshot available yet."}
              </pre>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
