import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CirclePause,
  History,
  Info,
  Menu,
  PanelRight,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import type {
  CouncilAgent,
  CouncilRoomSnapshot,
  ProviderModelCatalog,
} from "@rah/runtime-protocol";
import * as api from "../api";
import { ProviderLogo } from "../components/ProviderLogo";
import { MarkdownRenderer } from "../components/chat/MarkdownRenderer";
import type { ProviderChoice } from "../components/ProviderSelector";
import { PROVIDER_OPTIONS } from "../components/ProviderSelector";
import { SessionModelControls } from "../components/SessionModelControls";
import { TokenizedTextarea } from "../components/TokenizedTextarea";
import { WorkspacePicker } from "../components/WorkspacePicker";
import {
  TerminalDialogFrame,
  TerminalPaneStack,
  TerminalTabStrip,
  type TerminalTabDescriptor,
} from "../components/terminal/TerminalSurface";
import { Sheet } from "../components/Sheet";
import { FileReferencePicker } from "../components/FileReferencePicker";
import { COMPOSER_LAYOUT } from "../composer-contract";
import { insertTextAtSelection } from "../composer-text-insertion";
import { resolveSessionModeControlState } from "../session-mode-ui";
import { ConfirmDialog } from "../components/workbench/dialogs/ConfirmDialog";
import {
  HEADER_ACTION_GROUP_CLASS,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_TEXT_BUTTON_CLASS,
  headerRightPaddingClass,
} from "../components/workbench/header-button-styles";
import {
  councilAgentDraftToConfig,
  createDefaultCouncilAgentDrafts,
  normalizeCouncilAgentDraftForCatalog,
  resolveCouncilAgentDraftLabel,
  resolveCouncilAgentModelSelection,
  type CouncilAgentDraft,
} from "./council-ui-state";
import {
  applyCouncilMention,
  buildCouncilMentionOptions,
  filterCouncilMentionOptions,
  findCouncilMentionTrigger,
  type CouncilMentionTrigger,
} from "./council-mentions";
import {
  COUNCIL_TUI_WARM_TTL_MS,
  pruneCouncilTuiCache,
  removeCouncilTuiAgent,
  resetCouncilTuiCache,
  setCouncilTuiDetached,
  touchCouncilTuiCache,
  warmCouncilTuiCache,
  type CouncilTuiCacheState,
} from "../tui-surface-lifecycle";

type CouncilMessage = CouncilRoomSnapshot["messages"][number];
type CouncilDisplayItem =
  | { kind: "message"; message: CouncilMessage }
  | {
    kind: "agent-status";
    key: string;
    actorId: string;
    status: "sent" | "joined" | "listening";
    messageId: number;
  };

const COUNCIL_SYSTEM_NOTICE_CLASS =
  "mx-auto flex w-fit max-w-[92%] items-center gap-2 rounded-full bg-[var(--app-subtle-bg)]/35 px-2.5 py-1 text-[10.5px] leading-relaxed text-[var(--app-hint)] sm:max-w-[78%]";

function isCouncilHistoryRoom(room: CouncilRoomSnapshot): boolean {
  return room.room.status === "stopped" || room.room.status === "failed";
}

function isCouncilAgentTerminalAvailable(agent: CouncilAgent): boolean {
  return (
    agent.status !== "stopped" &&
    agent.status !== "failed" &&
    Boolean(agent.nativeSessionId ?? agent.zellijPaneId)
  );
}

function canOpenCouncilAgentTerminal(room: CouncilRoomSnapshot, agent: CouncilAgent): boolean {
  return room.room.status === "running" && isCouncilAgentTerminalAvailable(agent);
}

type CouncilDialogOutsideEvent = {
  target: EventTarget | null;
  detail?: { originalEvent?: Event };
  preventDefault: () => void;
};

function isInsideSessionModelPanel(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && Boolean(target.closest('[data-session-model-panel="true"]'));
}

function keepModelPanelInsideCouncilDialog(event: CouncilDialogOutsideEvent): void {
  const originalEvent = event.detail?.originalEvent;
  const originalPath = typeof originalEvent?.composedPath === "function"
    ? originalEvent.composedPath()
    : [];
  if (
    isInsideSessionModelPanel(event.target) ||
    isInsideSessionModelPanel(originalEvent?.target) ||
    originalPath.some((entry) => isInsideSessionModelPanel(entry))
  ) {
    event.preventDefault();
  }
}

function councilRoomActivityMs(room: CouncilRoomSnapshot): number {
  const lastMessage = room.messages.at(-1);
  return Date.parse(lastMessage?.createdAt ?? room.room.updatedAt ?? room.room.createdAt) || 0;
}

function formatCouncilCount(value: number, unit: string): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m ${unit}`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k ${unit}`;
  }
  return `${value} ${unit}`;
}

function councilRoomLineLabel(room: CouncilRoomSnapshot): string {
  return formatCouncilCount(room.messages.length, "lines");
}

function councilRoomLineTitle(room: CouncilRoomSnapshot): string {
  return `${room.messages.length.toLocaleString()} room message log lines`;
}

function defaultRunningCouncilRoomId(rooms: CouncilRoomSnapshot[]): string | null {
  return rooms
    .filter((room) => !isCouncilHistoryRoom(room))
    .sort((left, right) => councilRoomActivityMs(right) - councilRoomActivityMs(left))[0]?.room.id ?? null;
}

function actorAgent(room: CouncilRoomSnapshot, actorId: string): CouncilAgent | null {
  return room.agents.find((agent) => agent.id === actorId) ?? null;
}

function actorLabel(room: CouncilRoomSnapshot, actorId: string): string {
  if (actorId === "user") return "You";
  if (actorId === "system") return "System";
  return actorAgent(room, actorId)?.label ?? actorId;
}

function textFromParts(parts: CouncilRoomSnapshot["messages"][number]["parts"]): string {
  return parts
    .map((part) => part.kind === "text" ? part.text : JSON.stringify(part.data))
    .join("\n");
}

function shouldCollapseCouncilReply(text: string): boolean {
  return text.length > 900 || text.split(/\r?\n/).length > 12;
}

function CouncilMessageContent(props: { role: CouncilMessage["role"]; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const canCollapse = props.role === "agent" && shouldCollapseCouncilReply(props.text);
  const collapsed = canCollapse && !expanded;
  const content = props.role === "agent" ? (
    <MarkdownRenderer
      className="prose-chat max-w-none text-sm leading-relaxed"
      content={props.text}
      fallbackClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-relaxed"
    />
  ) : (
    <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed">
      {props.text}
    </div>
  );

  return (
    <div>
      <div
        className={`relative ${canCollapse ? (expanded ? "cursor-zoom-out" : "cursor-zoom-in") : ""} ${collapsed ? "max-h-56 overflow-hidden" : ""}`}
        onDoubleClick={() => {
          if (canCollapse) {
            setExpanded((value) => !value);
          }
        }}
        title={canCollapse ? (expanded ? "Double-click to collapse" : "Double-click to expand") : undefined}
      >
        {content}
        {collapsed ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent via-white/75 to-white/95 dark:via-zinc-950/70 dark:to-zinc-950/90" />
        ) : null}
      </div>
      {canCollapse ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-2 block w-full rounded-lg px-2 py-1 text-left text-[11px] font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function councilSystemText(room: CouncilRoomSnapshot, text: string): string {
  let cleaned = text.replace(/^\[system]\s*/i, "").trim();
  if (room.room.id) {
    cleaned = cleaned.replace(new RegExp(`\\s+${escapeRegExp(room.room.id)}\\b`, "g"), "");
  }
  return cleaned.trim();
}

function isCouncilSystemNoise(text: string): boolean {
  return /\bwait timed out;\s*no active listener is currently blocking on channel_wait_new\b/i.test(text);
}

function councilAgentSystemStatus(message: CouncilMessage): "sent" | "joined" | "listening" | null {
  if (message.role !== "system" || message.actorId === "system") {
    return null;
  }
  const text = textFromParts(message.parts).trim();
  if (text === `${message.actorId} sent`) {
    return "sent";
  }
  if (text === `${message.actorId} joined`) {
    return "joined";
  }
  if (text === `${message.actorId} listening`) {
    return "listening";
  }
  return null;
}

function councilDisplayItems(room: CouncilRoomSnapshot): CouncilDisplayItem[] {
  const items: CouncilDisplayItem[] = [];
  const statusIndexByActor = new Map<string, number>();
  for (const message of room.messages) {
    if (message.role === "system" && isCouncilSystemNoise(textFromParts(message.parts))) {
      continue;
    }
    const status = councilAgentSystemStatus(message);
    if (!status) {
      items.push({ kind: "message", message });
      continue;
    }
    const previousIndex = statusIndexByActor.get(message.actorId);
    if (previousIndex !== undefined) {
      items.splice(previousIndex, 1);
      for (const [actorId, index] of statusIndexByActor) {
        if (index > previousIndex) {
          statusIndexByActor.set(actorId, index - 1);
        }
      }
    }
    statusIndexByActor.set(message.actorId, items.length);
    items.push({
      kind: "agent-status",
      key: `agent-status:${message.actorId}`,
      actorId: message.actorId,
      status,
      messageId: message.id,
    });
  }
  return items;
}

function catalogKey(provider: ProviderChoice, workspace: string): string {
  return `${provider}:${workspace}`;
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

const COUNCIL_AGENT_THEMES = [
  {
    bubble: "border-blue-300/80 bg-gradient-to-br from-blue-50/95 to-white text-slate-950 shadow-sm dark:border-blue-500/25 dark:from-blue-500/10 dark:to-transparent dark:text-blue-50",
    accent: "bg-blue-400/70",
    card: "border-blue-200/70 bg-blue-50/45 hover:border-blue-300/80 dark:border-blue-500/25 dark:bg-blue-500/10 dark:hover:border-blue-400/45",
  },
  {
    bubble: "border-emerald-300/80 bg-gradient-to-br from-emerald-50/95 to-white text-slate-950 shadow-sm dark:border-emerald-500/25 dark:from-emerald-500/10 dark:to-transparent dark:text-emerald-50",
    accent: "bg-emerald-400/70",
    card: "border-emerald-200/70 bg-emerald-50/45 hover:border-emerald-300/80 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:hover:border-emerald-400/45",
  },
  {
    bubble: "border-amber-300/80 bg-gradient-to-br from-amber-50/95 to-white text-slate-950 shadow-sm dark:border-amber-500/25 dark:from-amber-500/10 dark:to-transparent dark:text-amber-50",
    accent: "bg-amber-400/70",
    card: "border-amber-200/75 bg-amber-50/45 hover:border-amber-300/80 dark:border-amber-500/25 dark:bg-amber-500/10 dark:hover:border-amber-400/45",
  },
  {
    bubble: "border-rose-300/80 bg-gradient-to-br from-rose-50/95 to-white text-slate-950 shadow-sm dark:border-rose-500/25 dark:from-rose-500/10 dark:to-transparent dark:text-rose-50",
    accent: "bg-rose-400/70",
    card: "border-rose-200/70 bg-rose-50/40 hover:border-rose-300/75 dark:border-rose-500/25 dark:bg-rose-500/10 dark:hover:border-rose-400/45",
  },
  {
    bubble: "border-sky-300/80 bg-gradient-to-br from-sky-50/95 to-white text-slate-950 shadow-sm dark:border-sky-500/25 dark:from-sky-500/10 dark:to-transparent dark:text-sky-50",
    accent: "bg-sky-400/70",
    card: "border-sky-200/70 bg-sky-50/45 hover:border-sky-300/80 dark:border-sky-500/25 dark:bg-sky-500/10 dark:hover:border-sky-400/45",
  },
];

function councilAgentTheme(room: CouncilRoomSnapshot, agentId: string) {
  const index = Math.max(0, room.agents.findIndex((agent) => agent.id === agentId));
  return COUNCIL_AGENT_THEMES[index % COUNCIL_AGENT_THEMES.length]!;
}

function councilAgentOptionsLabel(agent: CouncilAgent): string | null {
  const values = new Set<string>();
  if (agent.reasoningId?.trim()) {
    values.add(agent.reasoningId.trim());
  }
  if (agent.optionValues) {
    for (const value of Object.values(agent.optionValues)) {
      if (typeof value === "string" && value.trim()) {
        values.add(value.trim());
      } else if (typeof value === "number" || typeof value === "boolean") {
        values.add(String(value));
      }
    }
  }
  return values.size > 0 ? [...values].join(" / ") : null;
}

function createAdditionalCouncilAgentDraft(): CouncilAgentDraft {
  return {
    id: `opencode-extra-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    provider: "opencode",
    label: "",
    role: "",
    modelId: null,
    reasoningId: null,
    modeId: null,
  };
}

function CouncilAgentDraftEditor(props: {
  drafts: CouncilAgentDraft[];
  workspace: string;
  catalogs: Record<string, ProviderModelCatalog>;
  collapsedDraftIds: Set<string>;
  minAgents?: number;
  onUpdateDraft: (id: string, updater: (draft: CouncilAgentDraft) => CouncilAgentDraft) => void;
  onRemoveDraft: (id: string) => void;
  onToggleDraftCollapsed: (id: string) => void;
}) {
  const minAgents = props.minAgents ?? 1;
  return (
    <div className="space-y-2">
      {props.drafts.map((draft, index) => {
        const catalog = props.catalogs[catalogKey(draft.provider, props.workspace)];
        const modeState = resolveSessionModeControlState({
          provider: draft.provider,
          draft: draft.modeId ? { accessModeId: draft.modeId, planEnabled: false } : null,
          catalog: catalog ?? null,
        });
        const selection = resolveCouncilAgentModelSelection({ draft, catalog: catalog ?? null });
        const displayLabel = resolveCouncilAgentDraftLabel({ draft, catalog: catalog ?? null });
        const removable = props.drafts.length > minAgents;
        const collapsed = props.collapsedDraftIds.has(draft.id);
        const titleText = draft.role.trim() ? `${displayLabel} · ${draft.role.trim()}` : displayLabel;
        return (
          <div key={draft.id} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-2.5">
            <div className={`${collapsed ? "" : "mb-2"} flex items-center justify-between gap-2 text-xs font-semibold text-[var(--app-fg)]`}>
              <button
                type="button"
                onClick={() => props.onToggleDraftCollapsed(draft.id)}
                className="icon-click-feedback flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                title={titleText}
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? "Expand" : "Collapse"} agent ${index + 1}`}
              >
                <ProviderLogo provider={draft.provider} className="h-4 w-4 shrink-0" variant="bare" />
                <span className="min-w-0 truncate">
                  Agent {index + 1}
                  {collapsed ? ` · ${displayLabel}` : ""}
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                {removable ? (
                  <button
                    type="button"
                    onClick={() => props.onRemoveDraft(draft.id)}
                    className="icon-click-feedback inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-danger)]"
                    aria-label={`Remove agent ${index + 1}`}
                    title="Remove agent"
                  >
                    <Trash2 size={13} />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => props.onToggleDraftCollapsed(draft.id)}
                  className="icon-click-feedback inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                  aria-label={`${collapsed ? "Expand" : "Collapse"} agent ${index + 1}`}
                  title={collapsed ? "Expand agent" : "Collapse agent"}
                >
                  {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
              </div>
            </div>
            {!collapsed ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={draft.provider}
                    onChange={(event) => {
                      const provider = event.target.value as ProviderChoice;
                      props.onUpdateDraft(draft.id, (item) => ({
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
                    onChange={(event) => props.onUpdateDraft(draft.id, (item) => ({
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
                <div className="mt-2 grid grid-cols-[minmax(0,3fr)_minmax(0,7fr)] gap-2">
                  <input
                    value={draft.label}
                    onChange={(event) => props.onUpdateDraft(draft.id, (item) => ({
                      ...item,
                      label: event.target.value,
                    }))}
                    className="h-8 min-w-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                    placeholder={displayLabel}
                  />
                  <input
                    value={draft.role}
                    onChange={(event) => props.onUpdateDraft(draft.id, (item) => ({
                      ...item,
                      role: event.target.value,
                    }))}
                    className="h-8 min-w-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                    placeholder="Agent role"
                  />
                </div>
                <div className="mt-2">
                  <SessionModelControls
                    catalog={catalog ?? null}
                    selectedModelId={selection.modelId}
                    selectedReasoningId={selection.reasoningId}
                    loading={!catalog && Boolean(props.workspace)}
                    compact
                    onModelChange={(modelId, defaultReasoningId) => {
                      props.onUpdateDraft(draft.id, (item) => ({
                        ...item,
                        modelId,
                        reasoningId: defaultReasoningId ?? null,
                      }));
                    }}
                    onReasoningChange={(reasoningId) => {
                      props.onUpdateDraft(draft.id, (item) => ({
                        ...item,
                        reasoningId,
                      }));
                    }}
                  />
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function CouncilPage(props: {
  clientId: string;
  workspaceDir: string;
  workspaceDirs: string[];
  sidebarOpen: boolean;
  onExpandSidebar: () => void;
  onOpenLeft: () => void;
  onAddWorkspace: (dir: string) => void;
  onHide: () => void;
}) {
  const [rooms, setRooms] = useState<CouncilRoomSnapshot[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [sendPending, setSendPending] = useState(false);
  const [fileReferenceOpen, setFileReferenceOpen] = useState(false);
  const [mentionTrigger, setMentionTrigger] = useState<CouncilMentionTrigger | null>(null);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [title, setTitle] = useState("");
  const [workspace, setWorkspace] = useState(props.workspaceDir || "");
  const [agentDrafts, setAgentDrafts] = useState<CouncilAgentDraft[]>(() =>
    createDefaultCouncilAgentDrafts(),
  );
  const [catalogs, setCatalogs] = useState<Record<string, ProviderModelCatalog>>({});
  const [selectedTerminalAgentId, setSelectedTerminalAgentId] = useState<string | null>(null);
  const [councilTuiCache, setCouncilTuiCache] = useState<CouncilTuiCacheState>(() =>
    resetCouncilTuiCache(),
  );
  const [collapsedAgentDraftIds, setCollapsedAgentDraftIds] = useState<Set<string>>(new Set());
  const [addAgentDialogOpen, setAddAgentDialogOpen] = useState(false);
  const [addAgentDrafts, setAddAgentDrafts] = useState<CouncilAgentDraft[]>(() => [
    createAdditionalCouncilAgentDraft(),
  ]);
  const [collapsedAddAgentDraftIds, setCollapsedAddAgentDraftIds] = useState<Set<string>>(new Set());
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [infoDialogOpen, setInfoDialogOpen] = useState(false);
  const [newRoomDialogOpen, setNewRoomDialogOpen] = useState(false);
  const [councilSidebarOpen, setCouncilSidebarOpen] = useState(false);
  const [isCouncilWide, setIsCouncilWide] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(min-width: 900px)").matches,
  );
  const [roomStatusCollapsed, setRoomStatusCollapsed] = useState(() =>
    typeof window === "undefined" ? true : !window.matchMedia("(min-width: 900px)").matches,
  );
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [pendingDeleteHistoryRoom, setPendingDeleteHistoryRoom] = useState<CouncilRoomSnapshot | null>(null);
  const [pendingPromptAgentId, setPendingPromptAgentId] = useState<string | null>(null);
  const [pendingPauseAgentId, setPendingPauseAgentId] = useState<string | null>(null);
  const [pendingStopAgentId, setPendingStopAgentId] = useState<string | null>(null);
  const [agentActionUiLocked, setAgentActionUiLocked] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const councilStickToLatestRef = useRef(true);
  const previousCouncilRoomIdRef = useRef<string | null>(null);
  const preserveCouncilSidebarAfterActionRef = useRef(false);
  const preserveTerminalAfterActionRef = useRef<string | null>(null);
  const autoWarmedCouncilRoomIdRef = useRef<string | null>(null);

  const selectedRoom = selectedRoomId ? rooms.find((room) => room.room.id === selectedRoomId) ?? null : null;
  const addAgentWorkspace = selectedRoom?.room.workspace ?? workspace;
  const selectedRoomDisplayItems = useMemo(
    () => selectedRoom ? councilDisplayItems(selectedRoom) : [],
    [selectedRoom],
  );
  const liveTerminalAgents = useMemo(
    () => selectedRoom?.agents.filter(isCouncilAgentTerminalAvailable) ?? [],
    [selectedRoom],
  );
  const liveTerminalAgentIds = useMemo(
    () => liveTerminalAgents.map((agent) => agent.id),
    [liveTerminalAgents],
  );
  const terminalDialogOpen = Boolean(selectedRoom && selectedTerminalAgentId);
  const activeTerminalAgent = selectedRoom?.agents.find((agent) => agent.id === selectedTerminalAgentId) ?? null;
  const visitedLiveTerminalAgents = useMemo(
    () => liveTerminalAgents.filter((agent) => councilTuiCache.visitedAgentIds.has(agent.id)),
    [councilTuiCache.visitedAgentIds, liveTerminalAgents],
  );
  const pendingPromptAgent = selectedRoom?.agents.find((agent) => agent.id === pendingPromptAgentId) ?? null;
  const pendingPauseAgent = selectedRoom?.agents.find((agent) => agent.id === pendingPauseAgentId) ?? null;
  const pendingStopAgent = selectedRoom?.agents.find((agent) => agent.id === pendingStopAgentId) ?? null;
  const agentActionDialogOpen =
    pendingPromptAgent !== null || pendingPauseAgent !== null || pendingStopAgent !== null;
  const blockCouncilParentClose = agentActionDialogOpen || agentActionUiLocked;
  const newRoomBodyRef = useRef<HTMLDivElement | null>(null);
  const mentionOptions = useMemo(() => {
    if (!selectedRoom || !mentionTrigger) {
      return [];
    }
    return filterCouncilMentionOptions(
      buildCouncilMentionOptions(selectedRoom.agents),
      mentionTrigger.query,
    ).slice(0, 8);
  }, [mentionTrigger, selectedRoom]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(min-width: 900px)");
    const handleChange = () => {
      setIsCouncilWide(query.matches);
      setRoomStatusCollapsed(!query.matches);
    };
    handleChange();
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    setMentionTrigger(null);
    setMentionSelectedIndex(0);
  }, [selectedRoomId]);

  useEffect(() => {
    setMentionSelectedIndex((index) =>
      mentionOptions.length === 0 ? 0 : Math.min(index, mentionOptions.length - 1),
    );
  }, [mentionOptions.length]);

  const isCouncilChatNearBottom = (): boolean => {
    const node = chatScrollRef.current;
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 96;
  };

  const updateCouncilScrollHint = () => {
    const nearBottom = isCouncilChatNearBottom();
    councilStickToLatestRef.current = nearBottom;
    setShowScrollToLatest(!nearBottom);
  };

  const scrollCouncilChatToBottom = (behavior: ScrollBehavior = "smooth") => {
    const node = chatScrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    councilStickToLatestRef.current = true;
    setShowScrollToLatest(false);
  };

  useEffect(() => {
    const roomId = selectedRoom?.room.id ?? null;
    const roomChanged = previousCouncilRoomIdRef.current !== roomId;
    previousCouncilRoomIdRef.current = roomId;
    if (!roomId) {
      setShowScrollToLatest(false);
      councilStickToLatestRef.current = true;
      return;
    }
    const shouldStick = roomChanged || councilStickToLatestRef.current;
    window.requestAnimationFrame(() => {
      if (shouldStick) {
        scrollCouncilChatToBottom("auto");
      } else {
        updateCouncilScrollHint();
      }
    });
  }, [selectedRoom?.room.id, selectedRoom?.messages.length]);

  const refreshRooms = async (options?: { silent?: boolean }): Promise<CouncilRoomSnapshot[]> => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const response = await api.listCouncilRooms();
      setRooms(response.rooms);
      setSelectedRoomId((current) => {
        if (current && response.rooms.some((room) => room.room.id === current)) {
          return current;
        }
        return defaultRunningCouncilRoomId(response.rooms);
      });
      return response.rooms;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return [];
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void refreshRooms();
  }, []);

  useEffect(() => {
    if (!selectedTerminalAgentId) {
      return;
    }
    if (
      !selectedRoom ||
      selectedRoom.room.status !== "running" ||
      !liveTerminalAgents.some((agent) => agent.id === selectedTerminalAgentId)
    ) {
      setSelectedTerminalAgentId(null);
    }
  }, [liveTerminalAgents, selectedRoom, selectedTerminalAgentId]);

  useEffect(() => {
    autoWarmedCouncilRoomIdRef.current = null;
    setCouncilTuiCache(resetCouncilTuiCache());
    setSelectedTerminalAgentId(null);
  }, [selectedRoom?.room.id]);

  useEffect(() => {
    setCouncilTuiCache((current) =>
      pruneCouncilTuiCache({
        state: current,
        liveAgentIds: liveTerminalAgentIds,
        now: Date.now(),
        activeAgentId: selectedTerminalAgentId,
      }),
    );
  }, [liveTerminalAgentIds, selectedTerminalAgentId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCouncilTuiCache((current) =>
        pruneCouncilTuiCache({
          state: current,
          liveAgentIds: liveTerminalAgentIds,
          now: Date.now(),
          activeAgentId: selectedTerminalAgentId,
        }),
      );
    }, Math.min(COUNCIL_TUI_WARM_TTL_MS, 60_000));
    return () => window.clearInterval(timer);
  }, [liveTerminalAgentIds, selectedTerminalAgentId]);

  useEffect(() => {
    if (!selectedRoomId) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const refreshAfterSocketLoss = () => {
      void api.listCouncilRooms()
        .then((response) => {
          if (cancelled) return;
          setRooms(response.rooms);
        })
        .catch(() => {
          // The normal 5s polling loop owns user-visible Council refresh errors.
        });
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectSocket();
      }, document.visibilityState === "visible" ? 750 : 3_000);
    };

    const connectSocket = () => {
      if (cancelled) return;
      socket = api.createEventsSocket(
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
        () => {
          refreshAfterSocketLoss();
          if (socket && socket.readyState < WebSocket.CLOSING) {
            socket.close();
          }
        },
        {
          onClose: () => {
            refreshAfterSocketLoss();
            scheduleReconnect();
          },
        },
      );
    };

    const handleForegroundResume = () => {
      if (document.visibilityState !== "visible") return;
      refreshAfterSocketLoss();
      if (!socket || socket.readyState >= WebSocket.CLOSING) {
        clearReconnectTimer();
        connectSocket();
      }
    };

    document.addEventListener("visibilitychange", handleForegroundResume);
    connectSocket();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleForegroundResume);
      clearReconnectTimer();
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
    };
  }, [selectedRoomId]);

  useEffect(() => {
    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void api.listCouncilRooms()
        .then((response) => {
          if (cancelled) return;
          setRooms(response.rooms);
          setError(null);
          setSelectedRoomId((current) => {
            if (current && response.rooms.some((room) => room.room.id === current)) {
              return current;
            }
            return defaultRunningCouncilRoomId(response.rooms);
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
    const draftGroups = [
      { drafts: agentDrafts, cwd: workspace },
      ...(addAgentDialogOpen ? [{ drafts: addAgentDrafts, cwd: addAgentWorkspace }] : []),
    ];
    for (const group of draftGroups) {
      const cwd = group.cwd.trim();
      for (const draft of group.drafts) {
        const key = catalogKey(draft.provider, cwd);
        if (catalogs[key] || requestedKeys.has(key)) continue;
        requestedKeys.add(key);
        void api.listProviderModels(draft.provider, cwd ? { cwd } : {})
          .then((catalog) => {
            setCatalogs((current) => ({ ...current, [key]: catalog }));
          })
          .catch(() => undefined);
      }
    }
  }, [addAgentDialogOpen, addAgentDrafts, addAgentWorkspace, agentDrafts, catalogs, workspace]);

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
    if (!addAgentDialogOpen) {
      return;
    }
    setAddAgentDrafts((current) => {
      let changed = false;
      const next = current.map((draft) => {
        const catalog = catalogs[catalogKey(draft.provider, addAgentWorkspace)];
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
  }, [addAgentDialogOpen, addAgentWorkspace, catalogs]);

  const updateDraft = (id: string, updater: (draft: CouncilAgentDraft) => CouncilAgentDraft) => {
    setAgentDrafts((current) => current.map((draft) => draft.id === id ? updater(draft) : draft));
  };

  const removeDraft = (id: string) => {
    setAgentDrafts((current) => current.filter((draft) => draft.id !== id));
    setCollapsedAgentDraftIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const toggleDraftCollapsed = (id: string) => {
    setCollapsedAgentDraftIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const addNewRoomAgentDraft = () => {
    const draft = createAdditionalCouncilAgentDraft();
    setAgentDrafts((current) => [...current, draft]);
    setCollapsedAgentDraftIds((current) => {
      const next = new Set(current);
      next.delete(draft.id);
      return next;
    });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const node = newRoomBodyRef.current;
        node?.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
      });
    });
  };

  const updateAddAgentDraft = (id: string, updater: (draft: CouncilAgentDraft) => CouncilAgentDraft) => {
    setAddAgentDrafts((current) => current.map((draft) => draft.id === id ? updater(draft) : draft));
  };

  const removeAddAgentDraft = (id: string) => {
    setAddAgentDrafts((current) => current.filter((draft) => draft.id !== id));
    setCollapsedAddAgentDraftIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const toggleAddAgentDraftCollapsed = (id: string) => {
    setCollapsedAddAgentDraftIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const resetAddAgentDrafts = () => {
    setAddAgentDrafts([createAdditionalCouncilAgentDraft()]);
    setCollapsedAddAgentDraftIds(new Set());
  };

  const openAddAgentDialog = () => {
    resetAddAgentDrafts();
    setAddAgentDialogOpen(true);
  };

  const selectWorkspace = (dir: string) => {
    const nextWorkspace = dir.trim();
    setWorkspace(nextWorkspace);
    if (nextWorkspace && !props.workspaceDirs.includes(nextWorkspace)) {
      props.onAddWorkspace(nextWorkspace);
    }
  };

  const startRoom = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.createCouncilRoom({
        ...(title.trim() ? { title: title.trim() } : {}),
        workspace,
        agents: agentDrafts.map((draft) =>
          councilAgentDraftToConfig({
            draft,
            catalog: catalogs[catalogKey(draft.provider, workspace)] ?? null,
          }),
        ),
      });
      setRooms((current) => {
        const existingIndex = current.findIndex((room) => room.room.id === response.room.room.id);
        if (existingIndex >= 0) {
          const next = [...current];
          next[existingIndex] = response.room;
          return next;
        }
        return [response.room, ...current];
      });
      setSelectedRoomId(response.room.room.id);
      setCouncilSidebarOpen(false);
      setNewRoomDialogOpen(false);
      void refreshRooms({ silent: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const sendMessage = async () => {
    if (sendPending || !composer.trim()) return;
    if (!selectedRoom) {
      setError("No council room selected.");
      return;
    }
    if (selectedRoom.room.status === "stopped" || selectedRoom.room.status === "failed") {
      setError(`Council room is ${selectedRoom.room.status} and cannot receive messages.`);
      return;
    }
    const text = composer;
    setComposer("");
    setSendPending(true);
    try {
      const response = await api.postCouncilMessage(selectedRoom.room.id, { text });
      setRooms((current) =>
        current.map((room) => room.room.id === selectedRoom.room.id ? response.room : room),
      );
      setError(null);
    } catch (caught) {
      setComposer((current) => (current.trim() ? current : text));
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSendPending(false);
    }
  };

  const insertCouncilReference = (reference: string) => {
    setComposer((current) => {
      const textarea = composerRef.current;
      if (!textarea) {
        return current ? `${current} ${reference}` : reference;
      }
      const { nextValue, caret } = insertTextAtSelection({
        current,
        selectionStart: textarea.selectionStart ?? current.length,
        selectionEnd: textarea.selectionEnd ?? current.length,
        insertedText: reference,
      });
      queueMicrotask(() => {
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
      return nextValue;
    });
  };

  const updateCouncilMentionTrigger = (value: string) => {
    const textarea = composerRef.current;
    const caret = textarea?.selectionStart ?? value.length;
    const trigger = findCouncilMentionTrigger(value, caret);
    setMentionTrigger(trigger);
    setMentionSelectedIndex(0);
  };

  const insertCouncilMention = (option = mentionOptions[mentionSelectedIndex]) => {
    if (!option || !mentionTrigger) {
      return;
    }
    const { nextValue, caret } = applyCouncilMention(composer, mentionTrigger, option);
    setComposer(nextValue);
    setMentionTrigger(null);
    setMentionSelectedIndex(0);
    queueMicrotask(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(caret, caret);
    });
  };

  const stopRoom = async () => {
    if (!selectedRoom || selectedRoom.room.status === "stopped") return;
    setLoading(true);
    try {
      await api.archiveCouncilRoom(selectedRoom.room.id);
      setStopConfirmOpen(false);
      setSelectedTerminalAgentId(null);
      const nextRooms = await refreshRooms();
      setSelectedRoomId(defaultRunningCouncilRoomId(nextRooms));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const addAgentToRoom = async () => {
    if (!selectedRoom) {
      setError("No council room selected.");
      return;
    }
    if (selectedRoom.room.status !== "running") {
      setError("Agents can only be added to a running council room.");
      return;
    }
    setLoading(true);
    setError(null);
    const successfulDraftIds = new Set<string>();
    try {
      let latestRoom: CouncilRoomSnapshot | null = null;
      for (const draft of addAgentDrafts) {
        const response = await api.addCouncilAgent(selectedRoom.room.id, {
          agent: councilAgentDraftToConfig({
            draft,
            catalog: catalogs[catalogKey(draft.provider, addAgentWorkspace)] ?? null,
          }),
        });
        successfulDraftIds.add(draft.id);
        latestRoom = response.room;
        replaceRoom(response.room);
      }
      if (latestRoom) {
        replaceRoom(latestRoom);
      }
      setAddAgentDialogOpen(false);
      resetAddAgentDrafts();
    } catch (caught) {
      if (successfulDraftIds.size > 0) {
        setAddAgentDrafts((current) => {
          const next = current.filter((draft) => !successfulDraftIds.has(draft.id));
          return next.length > 0 ? next : [createAdditionalCouncilAgentDraft()];
        });
        setCollapsedAddAgentDraftIds((current) => {
          const next = new Set(current);
          for (const id of successfulDraftIds) {
            next.delete(id);
          }
          return next;
        });
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      const prefix = successfulDraftIds.size > 0
        ? `Added ${successfulDraftIds.size} agent${successfulDraftIds.size === 1 ? "" : "s"} before this failure. Remaining drafts were kept. `
        : "";
      setError(`${prefix}${message}`);
    } finally {
      setLoading(false);
    }
  };

  const deleteHistoryRoom = async (roomId: string) => {
    setLoading(true);
    setError(null);
    try {
      await api.deleteCouncilRoom(roomId);
      setPendingDeleteHistoryRoom(null);
      await refreshRooms();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const openRoomInfo = (roomId: string) => {
    setSelectedRoomId(roomId);
    setHistoryDialogOpen(false);
    setInfoDialogOpen(true);
  };

  const selectCouncilTuiAgent = (
    agent: CouncilAgent,
    options?: { attach?: boolean; warmAll?: boolean; validateTerminal?: boolean },
  ) => {
    if (!selectedRoom) {
      return;
    }
    if (!canOpenCouncilAgentTerminal(selectedRoom, agent)) {
      return;
    }
    setError(null);
    const now = Date.now();
    const previousAgentId = selectedTerminalAgentId;
    const roomId = selectedRoom.room.id;
    const shouldWarmAll = Boolean(options?.warmAll) && autoWarmedCouncilRoomIdRef.current !== roomId;
    if (shouldWarmAll) {
      autoWarmedCouncilRoomIdRef.current = roomId;
    }
    setCouncilTuiCache((current) => {
      let next = current;
      if (
        previousAgentId &&
        previousAgentId !== agent.id &&
        liveTerminalAgentIds.includes(previousAgentId)
      ) {
        next = touchCouncilTuiCache({
          state: next,
          agentId: previousAgentId,
          liveAgentIds: liveTerminalAgentIds,
          now,
          activeAgentId: previousAgentId,
          attach: false,
        });
      }
      if (shouldWarmAll) {
        next = warmCouncilTuiCache({
          state: next,
          agentIds: liveTerminalAgentIds,
          liveAgentIds: liveTerminalAgentIds,
          now,
          activeAgentId: agent.id,
          attach: true,
        });
      }
      return touchCouncilTuiCache({
        state: next,
        agentId: agent.id,
        liveAgentIds: liveTerminalAgentIds,
        now,
        activeAgentId: agent.id,
        attach: Boolean(options?.attach),
      });
    });
    setSelectedTerminalAgentId(agent.id);
    if (options?.validateTerminal) {
      void api.getCouncilAgentTui(selectedRoom.room.id, agent.id)
        .then((response) => {
          if (!response.terminalId) {
            setError(response.screen || "This council agent terminal is not live anymore.");
            setSelectedTerminalAgentId((current) => current === agent.id ? null : current);
            void refreshRooms();
          }
        })
        .catch((caught) => {
          setError(caught instanceof Error ? caught.message : String(caught));
        });
    }
  };

  const openTui = (agent: CouncilAgent) => {
    selectCouncilTuiAgent(agent, { attach: true, warmAll: true, validateTerminal: true });
  };

  const selectTerminalTab = (agentId: string) => {
    const agent = liveTerminalAgents.find((item) => item.id === agentId);
    if (!agent) {
      return;
    }
    selectCouncilTuiAgent(agent, { attach: false, warmAll: false, validateTerminal: false });
  };

  const preserveCouncilViewForAgentAction = (options?: { keepTerminal?: boolean }) => {
    preserveCouncilSidebarAfterActionRef.current = councilSidebarOpen && !isCouncilWide;
    preserveTerminalAfterActionRef.current =
      options?.keepTerminal && terminalDialogOpen ? selectedTerminalAgentId : null;
  };

  const restoreCouncilViewAfterAgentAction = (options?: { stoppedAgentId?: string }) => {
    if (preserveCouncilSidebarAfterActionRef.current && !isCouncilWide) {
      setCouncilSidebarOpen(true);
    }
    const terminalAgentId = preserveTerminalAfterActionRef.current;
    if (terminalAgentId && terminalAgentId !== options?.stoppedAgentId) {
      setSelectedTerminalAgentId(terminalAgentId);
    }
    preserveCouncilSidebarAfterActionRef.current = false;
    preserveTerminalAfterActionRef.current = null;
  };

  const handleCouncilSidebarOpenChange = (open: boolean) => {
    if (!open && blockCouncilParentClose) {
      return;
    }
    setCouncilSidebarOpen(open);
  };

  const handleTerminalDialogOpenChange = (open: boolean) => {
    if (!open && blockCouncilParentClose) {
      return;
    }
    if (!open) {
      const agentId = selectedTerminalAgentId;
      if (agentId && liveTerminalAgentIds.includes(agentId)) {
        setCouncilTuiCache((current) =>
          touchCouncilTuiCache({
            state: current,
            agentId,
            liveAgentIds: liveTerminalAgentIds,
            now: Date.now(),
            activeAgentId: agentId,
            attach: false,
          }),
        );
      }
      setSelectedTerminalAgentId(null);
    }
  };

  const replaceRoom = (room: CouncilRoomSnapshot) => {
    setRooms((current) => {
      const index = current.findIndex((item) => item.room.id === room.room.id);
      if (index < 0) return [room, ...current];
      const next = [...current];
      next[index] = room;
      return next;
    });
    setSelectedRoomId(room.room.id);
  };

  const reinjectAgent = async (agentId: string) => {
    if (!selectedRoom) {
      setAgentActionUiLocked(false);
      return;
    }
    setAgentActionUiLocked(true);
    setLoading(true);
    setError(null);
    try {
      const response = await api.reinjectCouncilAgentPrompt(selectedRoom.room.id, agentId);
      replaceRoom(response.room);
      if (response.injectedAgentIds.length === 0) {
        setError(`No live terminal was available for ${agentId}.`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      restoreCouncilViewAfterAgentAction();
      setLoading(false);
      setAgentActionUiLocked(false);
    }
  };

  const pauseAgentCouncilListening = async (agentId: string) => {
    if (!selectedRoom) {
      setAgentActionUiLocked(false);
      return;
    }
    setAgentActionUiLocked(true);
    setLoading(true);
    setError(null);
    try {
      const response = await api.removeCouncilAgent(selectedRoom.room.id, agentId);
      replaceRoom(response.room);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      restoreCouncilViewAfterAgentAction();
      setLoading(false);
      setAgentActionUiLocked(false);
    }
  };

  const stopCouncilAgent = async (agentId: string) => {
    if (!selectedRoom) {
      setAgentActionUiLocked(false);
      return;
    }
    setAgentActionUiLocked(true);
    setLoading(true);
    setError(null);
    try {
      const response = await api.stopCouncilAgent(selectedRoom.room.id, agentId);
      replaceRoom(response.room);
      if (selectedTerminalAgentId === agentId) {
        setSelectedTerminalAgentId(null);
      }
      setCouncilTuiCache((current) => removeCouncilTuiAgent(current, agentId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      restoreCouncilViewAfterAgentAction({ stoppedAgentId: agentId });
      setLoading(false);
      setAgentActionUiLocked(false);
    }
  };

  const requestReinjectAgent = (agentId: string) => {
    preserveCouncilViewForAgentAction({ keepTerminal: true });
    setPendingPromptAgentId(agentId);
  };

  const requestPauseAgentCouncilListening = (agentId: string) => {
    preserveCouncilViewForAgentAction({ keepTerminal: true });
    setPendingPauseAgentId(agentId);
  };

  const requestStopCouncilAgent = (agentId: string) => {
    preserveCouncilViewForAgentAction({ keepTerminal: true });
    setPendingStopAgentId(agentId);
  };

  const activeRooms = useMemo(
    () => rooms
      .filter((room) => !isCouncilHistoryRoom(room))
      .sort((left, right) => councilRoomActivityMs(right) - councilRoomActivityMs(left)),
    [rooms],
  );
  const historyRooms = useMemo(
    () => rooms
      .filter((room) => isCouncilHistoryRoom(room))
      .sort((left, right) => councilRoomActivityMs(right) - councilRoomActivityMs(left)),
    [rooms],
  );
  const nextRoomTitle = useMemo(() => {
    let maxRoomNumber = 0;
    for (const room of rooms) {
      const match = /^Room-(\d+)$/.exec(room.room.title.trim());
      if (!match) continue;
      maxRoomNumber = Math.max(maxRoomNumber, Number.parseInt(match[1]!, 10));
    }
    return `Room-${String(maxRoomNumber + 1).padStart(4, "0")}`;
  }, [rooms]);
  const councilReferenceRoot = selectedRoom?.room.workspace || workspace || props.workspaceDir || "/";
  const roomCanReceiveMessages = Boolean(
    selectedRoom &&
    selectedRoom.room.status !== "stopped" &&
    selectedRoom.room.status !== "failed",
  );
  const sendDisabled = sendPending || !roomCanReceiveMessages || !composer.trim();

  const chatPanelClass = "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-bg)]";
  const councilSidebarClass =
    `${councilSidebarOpen ? "hidden min-[900px]:flex" : "hidden"} min-h-0 w-[clamp(20rem,28vw,28rem)] shrink-0 flex-col overflow-hidden bg-[var(--app-subtle-bg)]`;
  const councilSidebarButtonLabel = councilSidebarOpen ? "Hide agents" : "Show agents";
  const agentsSidebarContent = (
    <div className="flex h-full min-h-0 flex-col bg-[var(--app-subtle-bg)]">
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] pl-4 pr-14">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--app-fg)]">Agents</div>
          <div className="truncate text-xs text-[var(--app-hint)]">
            {selectedRoom
              ? `${selectedRoom.agents.length} agent${selectedRoom.agents.length === 1 ? "" : "s"}`
              : "No running room selected"}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rah-scroll-panel rah-scroll-panel-y p-3">
        {!selectedRoom ? (
          <div className="h-full" />
        ) : (
          <div className="space-y-3">
            {selectedRoom.agents.map((agent) => {
              const terminalEnabled = canOpenCouncilAgentTerminal(selectedRoom, agent);
              const theme = councilAgentTheme(selectedRoom, agent.id);
              const optionsLabel = councilAgentOptionsLabel(agent);
              const agentMeta = [
                agent.modelId ?? "default model",
                optionsLabel,
                agent.lastStatusDetail,
              ].filter(Boolean).join(" · ");
              return (
                <div
                  key={agent.id}
                  className={`group rounded-xl border px-2.5 py-2 transition-colors ${theme.card} ${
                    terminalEnabled ? "" : "opacity-60"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (terminalEnabled) {
                          openTui(agent);
                        }
                      }}
                      disabled={!terminalEnabled}
                      className="icon-click-feedback flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left disabled:cursor-default"
                      title={terminalEnabled ? "Open agent terminal" : "This agent terminal is stopped."}
                    >
                      <span className={`h-8 w-1 shrink-0 rounded-full ${theme.accent}`} />
                      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]/70 shadow-sm">
                        <ProviderLogo provider={agent.provider} className="h-4 w-4" variant="bare" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-semibold leading-5 text-[var(--app-fg)]">{agent.label}</span>
                        </div>
                        <div className="truncate text-[11px] leading-4 text-[var(--app-hint)]">{agentMeta}</div>
                      </div>
                    </button>
                    <span className={`hidden shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold sm:inline-flex ${agentStatusClass(agent.status)}`}>
                      {agent.status}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => requestReinjectAgent(agent.id)}
                        disabled={loading || !terminalEnabled || agent.status === "stopped"}
                        className="icon-click-feedback inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
                        title="Send bootstrap prompt"
                        aria-label={`Send bootstrap prompt to ${agent.label}`}
                      >
                        <Send size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => requestPauseAgentCouncilListening(agent.id)}
                        disabled={loading || !terminalEnabled || agent.status === "stopped"}
                        className="icon-click-feedback inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:border-amber-300/60 hover:bg-amber-500/10 hover:text-amber-600 disabled:opacity-40"
                        title="Pause council listening"
                        aria-label={`Pause council listening for ${agent.label}`}
                      >
                        <CirclePause size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => requestStopCouncilAgent(agent.id)}
                        disabled={loading || !terminalEnabled || agent.status === "stopped"}
                        className="icon-click-feedback inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:border-rose-400/60 hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-40"
                        title="Remove agent from room"
                        aria-label={`Remove ${agent.label} from room`}
                      >
                        <Unplug size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {selectedRoom.room.status === "running" ? (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={openAddAgentDialog}
                  className="icon-click-feedback inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] px-3 text-xs font-semibold text-[var(--app-fg)] transition-colors hover:bg-[var(--app-bg)]"
                >
                  <Plus size={14} />
                  Add agent
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
  const councilTerminalTabs: TerminalTabDescriptor[] = selectedRoom
    ? liveTerminalAgents.map((agent) => {
      const theme = councilAgentTheme(selectedRoom, agent.id);
      return {
        id: agent.id,
        title: agent.label,
        leading: (
          <>
            <span className={`h-2 w-2 shrink-0 rounded-full ${theme.accent}`} />
            <ProviderLogo provider={agent.provider} className="h-3.5 w-3.5 shrink-0" variant="bare" />
          </>
        ),
        label: (
          <span className="max-w-[10rem] truncate text-[11px] font-medium">{agent.label}</span>
        ),
        trailing: (
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${agentStatusClass(agent.status)}`}>
            {agent.status}
          </span>
        ),
      };
    })
    : [];
  const visitedCouncilTerminalTabs = visitedLiveTerminalAgents.flatMap((agent) => {
    const terminalId = agent.nativeSessionId ?? agent.zellijPaneId;
    if (!terminalId) {
      return [];
    }
    return [{ id: agent.id, terminalId, label: agent.label }];
  });

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--app-bg)]">
      <button
        type="button"
        className="workbench-fixed-sidebar-toggle icon-click-feedback fixed right-[max(1rem,env(safe-area-inset-right))] top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-[25] inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]/90 text-[var(--app-hint)] shadow-sm backdrop-blur hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
        onClick={() => setCouncilSidebarOpen((open) => !open)}
        aria-label={councilSidebarButtonLabel}
        title={councilSidebarButtonLabel}
      >
        <PanelRight size={16} />
      </button>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <section className={chatPanelClass}>
          <header className={`relative flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-bg)]/85 pl-4 backdrop-blur-sm ${headerRightPaddingClass(councilSidebarOpen)}`}>
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <button
                type="button"
                className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] md:hidden"
                onClick={props.onOpenLeft}
                aria-label="Open sidebar"
                title="Open sidebar"
              >
                <Menu size={18} />
              </button>
              {!props.sidebarOpen ? (
                <button
                  type="button"
                  className="icon-click-feedback hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] md:inline-flex"
                  onClick={props.onExpandSidebar}
                  aria-label="Expand sidebar"
                  title="Expand sidebar"
                >
                  <Menu size={18} />
                </button>
              ) : null}
              <div className="min-w-0 flex-1 overflow-hidden">
                <div
                  className="truncate text-sm font-semibold text-[var(--app-fg)]"
                  title={selectedRoom?.room.title ?? "Council"}
                >
                  {selectedRoom?.room.title ?? "Council"}
                </div>
                <div
                  className="truncate text-xs text-[var(--app-hint)]"
                  title={selectedRoom ? selectedRoom.room.workspace : "Workspace"}
                >
                  {selectedRoom ? selectedRoom.room.workspace : "Workspace"}
                </div>
              </div>
            </div>
            <div className={HEADER_ACTION_GROUP_CLASS}>
              <button
                type="button"
                onClick={() => setNewRoomDialogOpen(true)}
                className={HEADER_ICON_BUTTON_CLASS}
                title="New council room"
                aria-label="New council room"
              >
                <Plus size={15} />
              </button>
              <button
                type="button"
                onClick={() => setHistoryDialogOpen(true)}
                className={HEADER_ICON_BUTTON_CLASS}
                aria-label="Open council rooms"
                title="Council rooms"
              >
                <History size={14} />
              </button>
              <button
                type="button"
                onClick={props.onHide}
                className={HEADER_TEXT_BUTTON_CLASS}
                title="Close council"
              >
                <X size={14} className="min-[900px]:mr-1" />
                <span className="hidden min-[900px]:inline">Close</span>
              </button>
            </div>
          </header>
          {selectedRoom?.room.status === "running" ? (
            roomStatusCollapsed ? (
              <button
                type="button"
                onClick={() => setRoomStatusCollapsed(false)}
                className="icon-click-feedback mx-3 mt-2 flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/35 px-2 text-[11px] font-semibold text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] sm:mx-4"
                aria-label="Show room status controls"
                title="Show room status controls"
              >
                <ChevronDown size={12} />
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="text-emerald-600">Live</span>
              </button>
            ) : (
              <div className="mx-3 mt-2 flex shrink-0 items-center justify-between gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/25 px-2.5 py-1.5 text-xs sm:mx-4">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setRoomStatusCollapsed(true)}
                    className="icon-click-feedback inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                    aria-label="Collapse room status controls"
                    title="Collapse room status controls"
                  >
                    <ChevronRight size={13} />
                  </button>
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Live
                  </span>
                  <span className="min-w-0 truncate text-[var(--app-hint)]">
                    {selectedRoom.agents.length} agent{selectedRoom.agents.length === 1 ? "" : "s"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setStopConfirmOpen(true)}
                  disabled={loading}
                  className="icon-click-feedback inline-flex h-6 shrink-0 items-center justify-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 text-[11px] font-semibold text-[var(--app-hint)] transition-colors hover:border-rose-400/30 hover:bg-rose-500/5 hover:text-[var(--app-fg)] disabled:opacity-40"
                  title="Stop room and close agent terminals"
                >
                  <Square size={12} className="text-rose-500/65" />
                  Stop
                </button>
              </div>
            )
          ) : null}
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
          <div className="relative min-h-0 flex-1">
            <div
              ref={chatScrollRef}
              onScroll={updateCouncilScrollHint}
              className="h-full space-y-3 overflow-y-auto rah-scroll-main p-3 sm:p-4"
            >
              {!selectedRoom ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[var(--app-hint)]">
                  <span>Start a new room or choose a running room.</span>
                  <button
                    type="button"
                    onClick={() => setNewRoomDialogOpen(true)}
                    className="icon-click-feedback inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] px-3 text-xs font-semibold text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                  >
                    <Plus size={14} />
                    New room
                  </button>
                </div>
              ) : selectedRoomDisplayItems.map((item) => {
                if (item.kind === "agent-status") {
                  const agent = actorAgent(selectedRoom, item.actorId);
                  const label = actorLabel(selectedRoom, item.actorId);
                  const isListening = item.status === "listening";
                  const isJoined = item.status === "joined";
                  return (
                    <div
                      key={`${item.key}:${item.messageId}`}
                      className={COUNCIL_SYSTEM_NOTICE_CLASS}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        isListening ? "bg-emerald-500" : isJoined ? "bg-amber-500" : "bg-zinc-400"
                      }`} />
                      {agent ? <ProviderLogo provider={agent.provider} className="h-3 w-3 shrink-0" variant="bare" /> : null}
                      <span className="min-w-0 truncate">{label}</span>
                      <span className={`shrink-0 ${
                        isListening
                          ? "text-emerald-600 dark:text-emerald-300"
                          : isJoined
                            ? "text-amber-600 dark:text-amber-300"
                            : "text-[var(--app-hint)]"
                      }`}>{isListening ? "ready" : item.status}</span>
                    </div>
                  );
                }
                const message = item.message;
                const agent = actorAgent(selectedRoom, message.actorId);
                if (message.role === "system") {
                  return (
                    <div
                      key={message.id}
                      className={COUNCIL_SYSTEM_NOTICE_CLASS}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-hint)]/50" />
                      <span className="whitespace-pre-wrap">
                        {councilSystemText(selectedRoom, textFromParts(message.parts))}
                      </span>
                    </div>
                  );
                }
                const theme = agent ? councilAgentTheme(selectedRoom, agent.id) : null;
                return (
                  <div
                    key={message.id}
                    className={`w-fit max-w-[92%] rounded-2xl border px-3 py-2 text-sm sm:max-w-[82%] ${
                      message.role === "user"
                        ? "ml-auto border-[var(--app-border)] bg-white text-zinc-950 shadow-sm"
                        : `mr-auto ${theme?.bubble ?? "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"}`
                    }`}
                  >
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold opacity-70">
                      {theme ? <span className={`h-2 w-2 shrink-0 rounded-full ${theme.accent}`} /> : null}
                      {agent ? (
                        <ProviderLogo provider={agent.provider} className="h-3.5 w-3.5 shrink-0" variant="bare" />
                      ) : null}
                      <span className="min-w-0 truncate">{actorLabel(selectedRoom, message.actorId)}</span>
                    </div>
                    <CouncilMessageContent role={message.role} text={textFromParts(message.parts)} />
                  </div>
                );
              })}
            </div>
            {showScrollToLatest ? (
              <button
                type="button"
                onClick={() => scrollCouncilChatToBottom()}
                className="absolute bottom-4 left-1/2 z-[30] flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] shadow-lg transition-all duration-200 hover:scale-110 hover:bg-[var(--app-subtle-bg)] active:scale-95"
                aria-label="Scroll to latest council message"
              >
                <ArrowDown size={16} />
              </button>
            ) : null}
          </div>
          <div className="shrink-0 bg-[var(--app-bg)]" style={COMPOSER_LAYOUT.bottomPaddingStyle}>
            <div className="mx-auto max-w-3xl px-3 pt-2 md:px-4 md:pt-3">
              <div
                className={`grid grid-cols-[auto_1fr_auto] items-end ${COMPOSER_LAYOUT.controlsGapClassName}`}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) {
                    composerRef.current?.focus();
                  }
                }}
              >
                <button
                  type="button"
                  onClick={() => setFileReferenceOpen(true)}
                  disabled={!roomCanReceiveMessages}
                  className={COMPOSER_LAYOUT.attachButtonClassName}
                  title="Insert file or folder reference"
                  aria-label="Insert file or folder reference"
                >
                  <Plus size={18} />
                </button>
                <div className="relative min-w-0">
                  {mentionTrigger && selectedRoom && mentionOptions.length > 0 ? (
                    <div
                      role="listbox"
                      aria-label="Council mentions"
                      className="rah-popover-panel rah-scroll-panel rah-scroll-panel-y absolute bottom-full left-0 z-30 mb-1.5 max-h-64 w-[min(24rem,calc(100vw-5rem))] overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-lg"
                    >
                      {mentionOptions.map((option, index) => {
                        const selected = index === mentionSelectedIndex;
                        const optionTheme = option.agent ? councilAgentTheme(selectedRoom, option.agent.id) : null;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              insertCouncilMention(option);
                            }}
                            onMouseEnter={() => setMentionSelectedIndex(index)}
                            className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors ${
                              selected
                                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)] shadow-sm"
                                : "text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                            }`}
                          >
                            <span
                              className={`h-9 w-1 shrink-0 rounded-full transition-colors ${
                                selected ? optionTheme?.accent ?? "bg-zinc-400/70" : "bg-transparent"
                              }`}
                            />
                            {option.agent ? (
                              <ProviderLogo
                                provider={option.agent.provider}
                                className={`h-4 w-4 shrink-0 transition-opacity ${selected ? "opacity-100" : "opacity-70"}`}
                                variant="bare"
                              />
                            ) : (
                              <Bot
                                size={16}
                                className={`shrink-0 transition-colors ${selected ? "text-[var(--app-fg)]" : "text-[var(--app-hint)]"}`}
                              />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className={`block truncate ${selected ? "font-semibold" : "font-medium"}`}>
                                @{option.label}
                              </span>
                              <span className="block truncate text-[11px] text-[var(--app-hint)]">
                                {option.description}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  <TokenizedTextarea
                    ref={composerRef}
                    textareaClassName={COMPOSER_LAYOUT.textareaClassName}
                    contentClassName={COMPOSER_LAYOUT.textareaContentClassName}
                    value={composer}
                    ariaLabel="Council message composer"
                    disabled={!roomCanReceiveMessages}
                    onChange={(value) => {
                      setComposer(value);
                      updateCouncilMentionTrigger(value);
                    }}
                    rows={1}
                    onKeyDown={(event) => {
                      const nativeEvent = event.nativeEvent as KeyboardEvent;
                      const textarea = composerRef.current;
                      const currentTrigger = findCouncilMentionTrigger(
                        composer,
                        textarea?.selectionStart ?? composer.length,
                      );
                      if (!currentTrigger) {
                        setMentionTrigger(null);
                      }
                      if (currentTrigger && mentionOptions.length > 0) {
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          setMentionSelectedIndex((index) => (index + 1) % mentionOptions.length);
                          return;
                        }
                        if (event.key === "ArrowUp") {
                          event.preventDefault();
                          setMentionSelectedIndex((index) =>
                            (index - 1 + mentionOptions.length) % mentionOptions.length,
                          );
                          return;
                        }
                        if (event.key === "Enter" || event.key === "Tab") {
                          event.preventDefault();
                          insertCouncilMention();
                          return;
                        }
                      }
                      if (mentionTrigger && event.key === "Escape") {
                        event.preventDefault();
                        setMentionTrigger(null);
                        return;
                      }
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !nativeEvent.isComposing &&
                        nativeEvent.keyCode !== 229
                      ) {
                        event.preventDefault();
                        if (!sendDisabled) {
                          void sendMessage();
                        }
                      }
                    }}
                  />
                </div>
                <button
                  type="button"
                  disabled={sendDisabled}
                  onClick={() => void sendMessage()}
                  aria-label="Send message"
                  className={COMPOSER_LAYOUT.sendButtonClassName}
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </div>
          </div>
        </section>

        {councilSidebarOpen ? <div className="inspector-divider hidden min-[900px]:block" /> : null}
        <aside className={councilSidebarClass}>
          {agentsSidebarContent}
        </aside>
      </div>

      <FileReferencePicker
        open={fileReferenceOpen}
        onOpenChange={setFileReferenceOpen}
        rootPath={councilReferenceRoot}
        onPick={insertCouncilReference}
      />

      <Sheet
        open={councilSidebarOpen && !isCouncilWide}
        onOpenChange={handleCouncilSidebarOpenChange}
        side="right"
        title="Agents"
        hideHeader
        modal={false}
        floatingClose="panel"
        floatingCloseLabel="Hide agents"
      >
        {agentsSidebarContent}
      </Sheet>

      <ConfirmDialog
        open={stopConfirmOpen}
        title="Stop council room?"
        description={
          selectedRoom
            ? `Stop "${selectedRoom.room.title}" and close all live agent terminals in this room. The room will remain available in Council History.`
            : "Stop this council room and close all live agent terminals."
        }
        confirmLabel={loading ? "Stopping…" : "Stop room"}
        confirmTone="danger"
        pending={loading}
        onOpenChange={setStopConfirmOpen}
        onConfirm={() => void stopRoom()}
      />

      <ConfirmDialog
        open={pendingDeleteHistoryRoom !== null}
        title="Delete council room?"
        description={
          pendingDeleteHistoryRoom
            ? `Delete "${pendingDeleteHistoryRoom.room.title}" from Council History? This removes the persisted room, agents, and room messages.`
            : "Delete this council room from history?"
        }
        confirmLabel={loading ? "Deleting…" : "Delete"}
        confirmTone="danger"
        pending={loading}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteHistoryRoom(null);
          }
        }}
        onConfirm={() => {
          if (pendingDeleteHistoryRoom) {
            void deleteHistoryRoom(pendingDeleteHistoryRoom.room.id);
          }
        }}
      />

      <ConfirmDialog
        open={pendingPromptAgent !== null}
        title="Send bootstrap prompt?"
        description={
          pendingPromptAgent
            ? `Send the Council bootstrap prompt to "${pendingPromptAgent.label}"? Use this when the agent is not listening or needs recovery.`
            : "Send the Council bootstrap prompt to this agent?"
        }
        confirmLabel={loading ? "Sending…" : "Send prompt"}
        pending={loading}
        modal={false}
        onOpenChange={(open) => {
          if (!open) {
            setPendingPromptAgentId(null);
          }
        }}
        onConfirm={() => {
          const agentId = pendingPromptAgentId;
          setAgentActionUiLocked(true);
          setPendingPromptAgentId(null);
          if (agentId) {
            void reinjectAgent(agentId);
          } else {
            setAgentActionUiLocked(false);
          }
        }}
      />

      <ConfirmDialog
        open={pendingPauseAgent !== null}
        title="Pause council listening?"
        description={
          pendingPauseAgent
            ? `Pause Council listening for "${pendingPauseAgent.label}"? The TUI stays open; only its Council wait loop is interrupted.`
            : "Pause Council listening for this agent?"
        }
        confirmLabel={loading ? "Pausing…" : "Pause"}
        pending={loading}
        modal={false}
        onOpenChange={(open) => {
          if (!open) {
            setPendingPauseAgentId(null);
          }
        }}
        onConfirm={() => {
          const agentId = pendingPauseAgentId;
          setAgentActionUiLocked(true);
          setPendingPauseAgentId(null);
          if (agentId) {
            void pauseAgentCouncilListening(agentId);
          } else {
            setAgentActionUiLocked(false);
          }
        }}
      />

      <ConfirmDialog
        open={pendingStopAgent !== null}
        title="Remove agent from room?"
        description={
          pendingStopAgent
            ? `Remove "${pendingStopAgent.label}" from this room and close only this agent TUI process? Other agents and the room stay running.`
            : "Remove this agent from the room? Other agents and the room stay running."
        }
        confirmLabel={loading ? "Removing…" : "Remove agent"}
        confirmTone="danger"
        pending={loading}
        modal={false}
        onOpenChange={(open) => {
          if (!open) {
            setPendingStopAgentId(null);
          }
        }}
        onConfirm={() => {
          const agentId = pendingStopAgentId;
          setAgentActionUiLocked(true);
          setPendingStopAgentId(null);
          if (agentId) {
            void stopCouncilAgent(agentId);
          } else {
            setAgentActionUiLocked(false);
          }
        }}
      />

      <Dialog.Root open={newRoomDialogOpen} onOpenChange={setNewRoomDialogOpen} modal={false}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35" />
          <Dialog.Content
            className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-[var(--app-bg)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] focus:outline-none min-[900px]:inset-auto min-[900px]:left-1/2 min-[900px]:top-[calc(50%-10px)] min-[900px]:max-h-[min(calc(100dvh-24px),972px)] min-[900px]:w-[min(720px,94vw)] min-[900px]:-translate-x-1/2 min-[900px]:-translate-y-1/2 min-[900px]:rounded-2xl min-[900px]:border min-[900px]:border-[var(--app-border)] min-[900px]:pt-0 min-[900px]:pb-0 min-[900px]:shadow-2xl"
            onPointerDownOutside={keepModelPanelInsideCouncilDialog}
            onInteractOutside={keepModelPanelInsideCouncilDialog}
          >
            <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] px-4">
              <div className="min-w-0">
                <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
                  New room
                </Dialog.Title>
                <div className="truncate text-xs text-[var(--app-hint)]">
                  Configure agents before launching the council.
                </div>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                  aria-label="Close new council room"
                  title="Close"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <div ref={newRoomBodyRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto rah-scroll-panel rah-scroll-panel-y p-4">
              <label className="block text-xs font-medium text-[var(--app-hint)]">
                Title
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="mt-1 h-11 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm text-[var(--app-fg)]"
                  placeholder={nextRoomTitle}
                />
              </label>
              <div className="block text-xs font-medium text-[var(--app-hint)]">
                Workspace
                <WorkspacePicker
                  currentDir={workspace}
                  triggerClassName="mt-1 h-11 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-left text-xs text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                  onSelect={selectWorkspace}
                />
              </div>
              <div className="text-xs font-medium text-[var(--app-hint)]">Agents</div>
              <CouncilAgentDraftEditor
                drafts={agentDrafts}
                workspace={workspace}
                catalogs={catalogs}
                collapsedDraftIds={collapsedAgentDraftIds}
                onUpdateDraft={updateDraft}
                onRemoveDraft={removeDraft}
                onToggleDraftCollapsed={toggleDraftCollapsed}
              />
            </div>
            <div className="grid shrink-0 grid-cols-3 gap-2 p-4">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-click-feedback inline-flex h-11 min-w-0 items-center justify-center rounded-lg border border-[var(--app-border)] text-xs font-semibold text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={addNewRoomAgentDraft}
                className="icon-click-feedback inline-flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] text-xs font-semibold text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
              >
                <Plus size={14} />
                Add agent
              </button>
              <button
                type="button"
                disabled={loading || !workspace.trim()}
                onClick={() => void startRoom()}
                className="icon-click-feedback inline-flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg bg-[var(--app-fg)] px-3 text-xs font-semibold text-[var(--app-bg)] disabled:opacity-40"
              >
                Start
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={addAgentDialogOpen}
        modal={false}
        onOpenChange={(open) => {
          setAddAgentDialogOpen(open);
          if (!open) {
            resetAddAgentDrafts();
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35" />
          <Dialog.Content
            className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-[var(--app-bg)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] focus:outline-none min-[900px]:inset-auto min-[900px]:left-1/2 min-[900px]:top-[calc(50%-10px)] min-[900px]:max-h-[min(calc(100dvh-24px),720px)] min-[900px]:w-[min(720px,94vw)] min-[900px]:-translate-x-1/2 min-[900px]:-translate-y-1/2 min-[900px]:rounded-2xl min-[900px]:border min-[900px]:border-[var(--app-border)] min-[900px]:pt-0 min-[900px]:pb-0 min-[900px]:shadow-2xl"
            onPointerDownOutside={keepModelPanelInsideCouncilDialog}
            onInteractOutside={keepModelPanelInsideCouncilDialog}
          >
            <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] px-4">
              <div className="min-w-0">
                <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
                  Add agents
                </Dialog.Title>
                <div className="truncate text-xs text-[var(--app-hint)]">
                  {selectedRoom ? `Add to ${selectedRoom.room.title}` : "Select a running room first."}
                </div>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                  aria-label="Close add agent"
                  title="Close"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto rah-scroll-panel rah-scroll-panel-y p-4">
              <div className="text-xs font-medium text-[var(--app-hint)]">Agents</div>
              <CouncilAgentDraftEditor
                drafts={addAgentDrafts}
                workspace={addAgentWorkspace}
                catalogs={catalogs}
                collapsedDraftIds={collapsedAddAgentDraftIds}
                onUpdateDraft={updateAddAgentDraft}
                onRemoveDraft={removeAddAgentDraft}
                onToggleDraftCollapsed={toggleAddAgentDraftCollapsed}
              />
            </div>
            <div className="grid shrink-0 grid-cols-3 gap-2 p-4">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-click-feedback inline-flex h-11 min-w-0 items-center justify-center rounded-lg border border-[var(--app-border)] text-xs font-semibold text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={() => setAddAgentDrafts((current) => [...current, createAdditionalCouncilAgentDraft()])}
                className="icon-click-feedback inline-flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] text-xs font-semibold text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
              >
                <Plus size={14} />
                Add agent
              </button>
              <button
                type="button"
                disabled={loading || !selectedRoom || selectedRoom.room.status !== "running" || !addAgentWorkspace.trim() || addAgentDrafts.length === 0}
                onClick={() => void addAgentToRoom()}
                className="icon-click-feedback inline-flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg bg-[var(--app-fg)] px-3 text-xs font-semibold text-[var(--app-bg)] disabled:opacity-40"
              >
                Add {addAgentDrafts.length > 1 ? `${addAgentDrafts.length} agents` : "to room"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={historyDialogOpen}
        onOpenChange={(open) => {
          setHistoryDialogOpen(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35" />
          <Dialog.Content className="fixed inset-x-3 top-[8vh] z-50 max-h-[84vh] overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl focus:outline-none sm:left-1/2 sm:right-auto sm:w-[min(640px,92vw)] sm:-translate-x-1/2">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-3">
              <div className="min-w-0">
                <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
                  Council Rooms
                </Dialog.Title>
                <div className="text-xs text-[var(--app-hint)]">
                  Running rooms are live; stopped rooms are archived chats.
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => void refreshRooms()}
                  disabled={loading}
                  className="icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
                  aria-label="Refresh council rooms"
                  title="Refresh rooms"
                >
                  <RefreshCw size={14} />
                </button>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    aria-label="Close council rooms"
                    title="Close rooms"
                  >
                    <X size={16} />
                  </button>
                </Dialog.Close>
              </div>
            </div>
            <div className="max-h-[calc(84vh-4.5rem)] space-y-4 overflow-y-auto rah-scroll-panel rah-scroll-panel-y p-3">
              <section className="space-y-1.5">
                <div className="flex items-center justify-between px-1">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--app-hint)]">
                    Running
                  </div>
                  <span className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--app-hint)]">
                    {activeRooms.length}
                  </span>
                </div>
                {activeRooms.length > 0 ? activeRooms.map((room) => (
                  <div
                    key={room.room.id}
                    className={`flex min-w-0 w-full items-center gap-2 overflow-hidden rounded-xl border px-2 py-1.5 text-sm transition-colors ${
                      selectedRoom?.room.id === room.room.id
                        ? "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                        : "border-transparent text-[var(--app-hint)] hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedRoomId(room.room.id);
                        setHistoryDialogOpen(false);
                      }}
                      className="min-w-0 flex-1 overflow-hidden rounded-lg px-1 py-0.5 text-left"
                    >
                      <span className="block truncate font-medium" title={room.room.title}>{room.room.title}</span>
                      <span className="block truncate text-xs opacity-75" title={room.room.workspace}>{room.room.workspace}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openRoomInfo(room.room.id)}
                      className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-[var(--app-hint)] transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                      aria-label={`Show info for ${room.room.title}`}
                      title="Room info"
                    >
                      <Info size={14} />
                    </button>
                    <span className="shrink-0 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
                      Live
                    </span>
                  </div>
                )) : (
                  <div className="rounded-xl border border-dashed border-[var(--app-border)] p-4 text-center text-sm text-[var(--app-hint)]">
                    No running rooms.
                  </div>
                )}
              </section>

              <section className="space-y-1.5">
                <div className="flex items-center justify-between px-1">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--app-hint)]">
                    History
                  </div>
                  <span className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--app-hint)]">
                    {historyRooms.length}
                  </span>
                </div>
                {historyRooms.length > 0 ? historyRooms.map((room) => (
                  <div
                    key={room.room.id}
                    className={`flex min-w-0 w-full items-center gap-2 overflow-hidden rounded-xl border px-2 py-1.5 text-sm transition-colors ${
                      selectedRoom?.room.id === room.room.id
                        ? "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                        : "border-transparent text-[var(--app-hint)] hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedRoomId(room.room.id);
                        setHistoryDialogOpen(false);
                      }}
                      className="min-w-0 flex-1 overflow-hidden rounded-lg px-1 py-0.5 text-left"
                    >
                      <span className="block truncate font-medium" title={room.room.title}>{room.room.title}</span>
                      <span className="block truncate text-xs opacity-75" title={room.room.workspace}>{room.room.workspace}</span>
                    </button>
                    <span className="hidden shrink-0 rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--app-hint)] sm:inline-flex">
                      {room.room.status}
                    </span>
                    <span
                      className="inline-flex shrink-0 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--app-hint)]"
                      title={councilRoomLineTitle(room)}
                    >
                      {councilRoomLineLabel(room)}
                    </span>
                    <button
                      type="button"
                      onClick={() => openRoomInfo(room.room.id)}
                      className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-[var(--app-hint)] transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                      aria-label={`Show info for ${room.room.title}`}
                      title="Room info"
                    >
                      <Info size={14} />
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => setPendingDeleteHistoryRoom(room)}
                      className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-[var(--app-hint)] transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-bg)] hover:text-[var(--app-danger)] disabled:opacity-40"
                      aria-label={`Delete ${room.room.title}`}
                      title="Delete room"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )) : (
                  <div className="rounded-xl border border-dashed border-[var(--app-border)] p-4 text-center text-sm text-[var(--app-hint)]">
                    No historical rooms yet.
                  </div>
                )}
              </section>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={infoDialogOpen} onOpenChange={setInfoDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35" />
          <Dialog.Content className="fixed inset-x-3 top-[8vh] z-50 max-h-[84vh] overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl focus:outline-none sm:left-1/2 sm:right-auto sm:w-[min(680px,92vw)] sm:-translate-x-1/2">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-3">
              <div className="min-w-0">
                <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
                  Room Info
                </Dialog.Title>
                <div className="truncate text-xs text-[var(--app-hint)]">
                  Internal identifiers and agent startup configuration.
                </div>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                  aria-label="Close council room info"
                  title="Close info"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            {selectedRoom ? (
              <div className="max-h-[calc(84vh-4.5rem)] space-y-4 overflow-y-auto rah-scroll-panel rah-scroll-panel-y p-4">
                <div className="grid gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/40 p-3 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 font-semibold text-[var(--app-hint)]">Title</span>
                    <span className="min-w-0 break-words text-right text-[var(--app-fg)]">{selectedRoom.room.title}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 font-semibold text-[var(--app-hint)]">Room ID</span>
                    <code className="min-w-0 break-all rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--app-fg)]">
                      {selectedRoom.room.id}
                    </code>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 font-semibold text-[var(--app-hint)]">Workspace</span>
                    <code className="min-w-0 break-all rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--app-fg)]">
                      {selectedRoom.room.workspace}
                    </code>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 font-semibold text-[var(--app-hint)]">Status</span>
                    <span className="text-[var(--app-fg)]">{selectedRoom.room.status}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 font-semibold text-[var(--app-hint)]">Created</span>
                    <span className="text-right text-[var(--app-fg)]">{selectedRoom.room.createdAt}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 font-semibold text-[var(--app-hint)]">Updated</span>
                    <span className="text-right text-[var(--app-fg)]">{selectedRoom.room.updatedAt}</span>
                  </div>
                  {selectedRoom.storage ? (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <span className="shrink-0 font-semibold text-[var(--app-hint)]">Store File</span>
                        <code className="min-w-0 break-all rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--app-fg)]">
                          {selectedRoom.storage.storePath}
                        </code>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <span className="shrink-0 font-semibold text-[var(--app-hint)]">Message Log</span>
                        <code className="min-w-0 break-all rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--app-fg)]">
                          {selectedRoom.storage.messageLogPath}
                        </code>
                      </div>
                    </>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--app-hint)]">
                    Agents
                  </div>
                  {selectedRoom.agents.map((agent) => {
                    const theme = councilAgentTheme(selectedRoom, agent.id);
                    return (
                      <div
                        key={agent.id}
                        className={`rounded-xl border border-l-4 border-[var(--app-border)] bg-[var(--app-subtle-bg)]/30 p-3 text-xs ${theme.card}`}
                      >
                        <div className="mb-2 flex min-w-0 items-center gap-2">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${theme.accent}`} />
                          <ProviderLogo provider={agent.provider} className="h-4 w-4 shrink-0" variant="bare" />
                          <span className="min-w-0 truncate text-sm font-semibold text-[var(--app-fg)]">{agent.label}</span>
                          <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${agentStatusClass(agent.status)}`}>
                            {agent.status}
                          </span>
                        </div>
                        <div className="grid gap-1.5">
                          <div className="flex items-start justify-between gap-3">
                            <span className="shrink-0 font-semibold text-[var(--app-hint)]">Agent ID</span>
                            <code className="min-w-0 break-all rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--app-fg)]">
                              {agent.id}
                            </code>
                          </div>
                          <div className="flex items-start justify-between gap-3">
                            <span className="shrink-0 font-semibold text-[var(--app-hint)]">Provider</span>
                            <span className="text-[var(--app-fg)]">{agent.provider}</span>
                          </div>
                          {agent.role?.trim() ? (
                            <div className="flex items-start justify-between gap-3">
                              <span className="shrink-0 font-semibold text-[var(--app-hint)]">Role</span>
                              <span className="min-w-0 break-words text-right text-[var(--app-fg)]">{agent.role}</span>
                            </div>
                          ) : null}
                          <div className="flex items-start justify-between gap-3">
                            <span className="shrink-0 font-semibold text-[var(--app-hint)]">Model</span>
                            <span className="min-w-0 break-words text-right text-[var(--app-fg)]">{agent.modelId ?? "provider default"}</span>
                          </div>
                          {agent.reasoningId ? (
                            <div className="flex items-start justify-between gap-3">
                              <span className="shrink-0 font-semibold text-[var(--app-hint)]">Options</span>
                              <span className="text-[var(--app-fg)]">{agent.reasoningId}</span>
                            </div>
                          ) : null}
                          {agent.modeId ? (
                            <div className="flex items-start justify-between gap-3">
                              <span className="shrink-0 font-semibold text-[var(--app-hint)]">Mode</span>
                              <span className="min-w-0 break-words text-right text-[var(--app-fg)]">{agent.modeId}</span>
                            </div>
                          ) : null}
                          {agent.optionValues && Object.keys(agent.optionValues).length > 0 ? (
                            <div className="flex items-start justify-between gap-3">
                              <span className="shrink-0 font-semibold text-[var(--app-hint)]">Options</span>
                              <code className="min-w-0 whitespace-pre-wrap break-all rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--app-fg)]">
                                {JSON.stringify(agent.optionValues)}
                              </code>
                            </div>
                          ) : null}
                          {(agent.nativeSessionId ?? agent.zellijPaneId) ? (
                            <div className="flex items-start justify-between gap-3">
                              <span className="shrink-0 font-semibold text-[var(--app-hint)]">Terminal ID</span>
                              <code className="min-w-0 break-all rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--app-fg)]">
                                {agent.nativeSessionId ?? agent.zellijPaneId}
                              </code>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="p-4 text-sm text-[var(--app-hint)]">No council room selected.</div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <TerminalDialogFrame
        open={terminalDialogOpen}
        onOpenChange={handleTerminalDialogOpenChange}
        title={selectedRoom?.room.title ?? "Council terminals"}
        subtitle={activeTerminalAgent?.label ?? "Select an agent"}
        leading={<Bot size={15} className="shrink-0 text-[var(--app-hint)]" />}
        overlayClassName="fixed inset-0 z-[65] bg-black/45"
        contentClassName="fixed inset-0 z-[70] flex h-[100dvh] w-screen flex-col overflow-hidden bg-[var(--app-bg)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] focus:outline-none md:left-1/2 md:top-1/2 md:h-[82vh] md:w-[min(1280px,96vw)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:border-[var(--app-border)] md:pt-0 md:pb-0 md:shadow-2xl"
        closeLabel="Close council terminals"
        closeTitle="Close council terminals"
        closeText="Close"
        forceMount
        headerActions={
          selectedRoom?.room.status === "running" && activeTerminalAgent ? (
            <>
              <button
                type="button"
                onClick={() => requestReinjectAgent(activeTerminalAgent.id)}
                disabled={loading || !isCouncilAgentTerminalAvailable(activeTerminalAgent)}
                className="icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
                title={`Send bootstrap prompt to ${activeTerminalAgent.label}`}
                aria-label={`Send bootstrap prompt to ${activeTerminalAgent.label}`}
              >
                <Send size={14} />
              </button>
              <button
                type="button"
                onClick={() => requestPauseAgentCouncilListening(activeTerminalAgent.id)}
                disabled={loading || !isCouncilAgentTerminalAvailable(activeTerminalAgent)}
                className="icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:border-amber-300/60 hover:bg-amber-500/10 hover:text-amber-600 disabled:opacity-40"
                title={`Pause council listening for ${activeTerminalAgent.label}`}
                aria-label={`Pause council listening for ${activeTerminalAgent.label}`}
              >
                <CirclePause size={14} />
              </button>
              <button
                type="button"
                onClick={() => requestStopCouncilAgent(activeTerminalAgent.id)}
                disabled={loading || !isCouncilAgentTerminalAvailable(activeTerminalAgent)}
                className="icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:border-rose-400/60 hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-40"
                title={`Remove ${activeTerminalAgent.label} from room`}
                aria-label={`Remove ${activeTerminalAgent.label} from room`}
              >
                <Unplug size={14} />
              </button>
            </>
          ) : null
        }
      >
        <TerminalTabStrip
          tabs={councilTerminalTabs}
          activeTabId={selectedTerminalAgentId}
          onTabSelect={selectTerminalTab}
        />
        <TerminalPaneStack
          tabs={visitedCouncilTerminalTabs}
          activeTabId={selectedTerminalAgentId}
          clientId={props.clientId}
          emptyState={
            <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-[var(--app-border)] p-4 text-center text-sm text-[var(--app-hint)]">
              This council agent terminal is not live anymore.
            </div>
          }
          terminalProps={(tab, active) => {
            const tabAgent = selectedRoom?.agents.find((agent) => agent.id === tab.id) ?? null;
            const terminalVisible = terminalDialogOpen && active;
            return {
              hasControl: terminalVisible,
              claimSurface: terminalVisible,
              autoFocus: terminalVisible,
              renderOutput: true,
              tuiClientCloseEnabled: true,
              tuiClientActive: tabAgent
                ? !councilTuiCache.detachedAgentIds.has(tabAgent.id)
                : true,
              onTuiClientActiveChange: (active) => {
                if (!tabAgent) {
                  return;
                }
                const agentId = tabAgent.id;
                setCouncilTuiCache((current) =>
                  setCouncilTuiDetached({
                    state: current,
                    agentId,
                    detached: !active,
                    now: Date.now(),
                  }),
                );
              },
              initialReplay: false,
              maxWriteBatchChars: 128 * 1024,
              scrollback: 180,
            };
          }}
        />
      </TerminalDialogFrame>
    </div>
  );
}
