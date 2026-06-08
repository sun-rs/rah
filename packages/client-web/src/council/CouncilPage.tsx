import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle2,
  CirclePause,
  Info,
  ListTree,
  PencilLine,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Unplug,
  UsersRound,
  X,
} from "lucide-react";
import type {
  CouncilAgent,
  CouncilSnapshot,
  ProviderModelCatalog,
} from "@rah/runtime-protocol";
import * as api from "../api";
import { ProviderLogo } from "../components/ProviderLogo";
import { MarkdownRenderer } from "../components/chat/MarkdownRenderer";
import { TokenizedTextarea } from "../components/TokenizedTextarea";
import {
  TerminalDialogFrame,
  TerminalPaneStack,
  TerminalTabStrip,
  type TerminalTabDescriptor,
} from "../components/terminal/TerminalSurface";
import { FileReferencePicker } from "../components/FileReferencePicker";
import { OverlayScrollArea } from "../components/OverlayScrollArea";
import { ConversationSidePanelShell } from "../components/workbench/shells/ConversationSidePanelShell";
import {
  ConversationHeader,
  ConversationHeaderIconButton,
  ConversationHeaderMoreButton,
  ConversationHeaderPanelToggleButton,
  ConversationHeaderStopButton,
} from "../components/workbench/shells/ConversationHeader";
import { ConversationPageShell } from "../components/workbench/shells/ConversationPageShell";
import { COMPOSER_LAYOUT } from "../composer-contract";
import { insertTextAtSelection } from "../composer-text-insertion";
import { ConfirmDialog } from "../components/workbench/dialogs/ConfirmDialog";
import { RenameSessionDialog } from "../components/workbench/dialogs/RenameSessionDialog";
import {
  HEADER_MENU_DANGER_ITEM_CLASS,
  HEADER_MENU_ITEM_CLASS,
} from "../components/workbench/header-button-styles";
import {
  ConversationHeaderMetaList,
  ConversationMetaBadge,
  CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS,
  ConversationStateMetaBadge,
  type ConversationHeaderMetaItem,
} from "../components/workbench/ConversationMetaBadge";
import {
  resolveConversationHeaderState,
} from "../components/workbench/conversation-header-meta";
import {
  councilAgentDraftToConfig,
  normalizeCouncilAgentDraftForCatalog,
  type CouncilAgentDraft,
} from "./council-ui-state";
import {
  catalogKey,
  councilCatalogFailureLoadedAt,
  CouncilAgentDraftEditor,
  createAdditionalCouncilAgentDraft,
  isCouncilCatalogFresh,
  keepModelPanelInsideCouncilDialog,
  NewCouncilDialog,
} from "./NewCouncilDialog";
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
import {
  CouncilsBrowser,
  defaultRunningCouncilId,
  isCouncilHistory,
  reconcileCouncilSelection,
} from "./CouncilsBrowser";
import { COUNCIL_HEADER_ICON_CLASSNAME } from "./council-theme";
import {
  canLoadOlderCouncilMessages,
  latestKnownCouncilMessageId,
  latestLoadedCouncilMessageId,
  mergeCouncilLatestMessagesPage,
  mergeCouncilLists,
  mergeCouncilSnapshot,
  prependCouncilMessagesPage,
  shouldHydrateLatestCouncilMessages,
} from "./council-message-window";
import { usePwaDisplayMode } from "../hooks/usePwaDisplayMode";

type CouncilMessage = CouncilSnapshot["messages"][number];
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
const COUNCIL_MESSAGE_PAGE_LIMIT = 100;
const COUNCIL_TOP_HISTORY_TRIGGER_PX = 96;

function isCouncilAgentTerminalAvailable(agent: CouncilAgent): boolean {
  return (
    agent.status !== "stopped" &&
    agent.status !== "failed" &&
    Boolean(agent.nativeSessionId ?? agent.terminalId)
  );
}

function canOpenCouncilAgentTerminal(council: CouncilSnapshot, agent: CouncilAgent): boolean {
  return council.status === "running" && isCouncilAgentTerminalAvailable(agent);
}

function actorAgent(council: CouncilSnapshot, actorId: string): CouncilAgent | null {
  return council.agents.find((agent) => agent.id === actorId) ?? null;
}

function actorLabel(council: CouncilSnapshot, actorId: string): string {
  if (actorId === "user") return "You";
  if (actorId === "system") return "System";
  return actorAgent(council, actorId)?.label ?? actorId;
}

function textFromParts(parts: CouncilSnapshot["messages"][number]["parts"]): string {
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

function councilSystemText(council: CouncilSnapshot, text: string): string {
  let cleaned = text.replace(/^\[system]\s*/i, "").trim();
  if (council.id) {
    cleaned = cleaned.replace(new RegExp(`\\s+${escapeRegExp(council.id)}\\b`, "g"), "");
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

function councilDisplayItems(council: CouncilSnapshot): CouncilDisplayItem[] {
  const items: CouncilDisplayItem[] = [];
  const statusIndexByActor = new Map<string, number>();
  for (const message of council.messages) {
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

function councilAgentTheme(council: CouncilSnapshot, agentId: string) {
  const index = Math.max(0, council.agents.findIndex((agent) => agent.id === agentId));
  return COUNCIL_AGENT_THEMES[index % COUNCIL_AGENT_THEMES.length]!;
}

function councilAgentOptionsLabel(agent: CouncilAgent): string | null {
  const values = new Set<string>();
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

function formatCouncilOptionName(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCouncilOptionValue(value: unknown): string {
  if (value === null) {
    return "Default";
  }
  if (typeof value === "boolean") {
    return value ? "On" : "Off";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value) ?? String(value);
}

function CouncilAgentOptionValues(props: {
  values: NonNullable<CouncilAgent["optionValues"]>;
}) {
  const entries = Object.entries(props.values);
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="min-w-0 flex-1 space-y-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5">
          <span className="text-[11px] text-[var(--app-hint)]">{formatCouncilOptionName(key)}</span>
          <span className="max-w-full break-words rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] font-medium text-[var(--app-fg)]">
            {formatCouncilOptionValue(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function CouncilPage(props: {
  clientId: string;
  workspaceDir: string;
  workspaceDirs: string[];
  initialCouncils?: readonly CouncilSnapshot[];
  selectedCouncilId?: string | null;
  onSelectedCouncilIdChange?: (councilId: string | null) => void;
  onCouncilsChange?: (councils: CouncilSnapshot[]) => void;
  sidebarOpen: boolean;
  onExpandSidebar: () => void;
  onOpenLeft: () => void;
  onAddWorkspace: (dir: string) => void;
  onHide: () => void;
  agentsPanelMode?: "open" | "closed";
  onAgentsPanelModeChange?: (mode: "open" | "closed") => void;
  agentsToggleDisabled?: boolean;
  showAgentsToggle?: boolean;
  showLeftSidebarControls?: boolean;
  showCloseButton?: boolean;
}) {
  const [councils, setCouncils] = useState<CouncilSnapshot[]>(() => [
    ...(props.initialCouncils ?? []),
  ]);
  const councilsRef = useRef<CouncilSnapshot[]>([...(props.initialCouncils ?? [])]);
  const [selectedCouncilIdState, setSelectedCouncilIdState] = useState<string | null>(
    props.selectedCouncilId ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [councilsRefreshing, setCouncilsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [sendPending, setSendPending] = useState(false);
  const [fileReferenceOpen, setFileReferenceOpen] = useState(false);
  const [mentionTrigger, setMentionTrigger] = useState<CouncilMentionTrigger | null>(null);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [workspace, setWorkspace] = useState(props.workspaceDir || "");
  const [catalogs, setCatalogs] = useState<Record<string, ProviderModelCatalog>>({});
  const catalogLoadedAtRef = useRef<Record<string, number>>({});
  const catalogRequestsRef = useRef<Set<string>>(new Set());
  const [selectedTerminalAgentId, setSelectedTerminalAgentId] = useState<string | null>(null);
  const [councilTuiCache, setCouncilTuiCache] = useState<CouncilTuiCacheState>(() =>
    resetCouncilTuiCache(),
  );
  const [addAgentDialogOpen, setAddAgentDialogOpen] = useState(false);
  const [addAgentDrafts, setAddAgentDrafts] = useState<CouncilAgentDraft[]>(() => [
    createAdditionalCouncilAgentDraft(),
  ]);
  const [collapsedAddAgentDraftIds, setCollapsedAddAgentDraftIds] = useState<Set<string>>(new Set());
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [loadingOlderCouncilMessages, setLoadingOlderCouncilMessages] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [infoDialogOpen, setInfoDialogOpen] = useState(false);
  const [councilMenuOpen, setCouncilMenuOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renamePending, setRenamePending] = useState(false);
  const [newCouncilDialogOpen, setNewCouncilDialogOpen] = useState(false);
  const [localCouncilSidebarOpen, setLocalCouncilSidebarOpen] = useState(
    () => props.agentsPanelMode === "open",
  );
  const [isCouncilWide, setIsCouncilWide] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(min-width: 768px)").matches,
  );
  const [isCouncilHeaderCompact, setIsCouncilHeaderCompact] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 520px)").matches,
  );
  const isPwaDisplayMode = usePwaDisplayMode();
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [pendingDeleteHistoryCouncil, setPendingDeleteHistoryCouncil] = useState<CouncilSnapshot | null>(null);
  const [pendingPromptAgentId, setPendingPromptAgentId] = useState<string | null>(null);
  const [pendingPauseAgentId, setPendingPauseAgentId] = useState<string | null>(null);
  const [pendingStopAgentId, setPendingStopAgentId] = useState<string | null>(null);
  const [agentActionUiLocked, setAgentActionUiLocked] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const councilMenuRef = useRef<HTMLDivElement | null>(null);
  const councilStickToLatestRef = useRef(true);
  const loadingOlderCouncilMessagesRef = useRef(false);
  const latestCouncilMessageLoadsRef = useRef<Set<string>>(new Set());
  const councilPrependAnchorRef = useRef<{
    councilId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const previousCouncilIdRef = useRef<string | null>(null);
  const preserveCouncilSidebarAfterActionRef = useRef(false);
  const preserveTerminalAfterActionRef = useRef<string | null>(null);
  const autoWarmedCouncilIdRef = useRef<string | null>(null);
  const selectedCouncilIdRef = useRef<string | null>(props.selectedCouncilId ?? null);
  const selectedCouncilId =
    props.selectedCouncilId !== undefined ? props.selectedCouncilId : selectedCouncilIdState;
  const setSelectedCouncilId = useCallback(
    (next: string | null | ((current: string | null) => string | null)) => {
      const current = selectedCouncilIdRef.current;
      const resolved = typeof next === "function" ? next(current) : next;
      selectedCouncilIdRef.current = resolved;
      setSelectedCouncilIdState(resolved);
      props.onSelectedCouncilIdChange?.(resolved);
    },
    [props.onSelectedCouncilIdChange],
  );

  useEffect(() => {
    if (props.selectedCouncilId !== undefined) {
      selectedCouncilIdRef.current = props.selectedCouncilId;
      setSelectedCouncilIdState(props.selectedCouncilId);
    }
  }, [props.selectedCouncilId]);

  useEffect(() => {
    councilsRef.current = councils;
    props.onCouncilsChange?.(councils);
  }, [props.onCouncilsChange, councils]);

  useEffect(() => {
    if (props.agentsPanelMode === undefined) {
      return;
    }
    setLocalCouncilSidebarOpen(props.agentsPanelMode === "open");
  }, [props.agentsPanelMode]);

  const councilSidebarOpen =
    props.agentsPanelMode !== undefined
      ? props.agentsPanelMode === "open"
      : localCouncilSidebarOpen;
  const setCouncilSidebarOpen = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      const resolved = typeof next === "function" ? next(councilSidebarOpen) : next;
      if (props.agentsPanelMode !== undefined) {
        props.onAgentsPanelModeChange?.(resolved ? "open" : "closed");
        return;
      }
      setLocalCouncilSidebarOpen(resolved);
    },
    [councilSidebarOpen, props.agentsPanelMode, props.onAgentsPanelModeChange],
  );

  const selectedCouncil = selectedCouncilId ? councils.find((council) => council.id === selectedCouncilId) ?? null : null;
  const addAgentWorkspace = selectedCouncil?.workspace ?? workspace;

  useEffect(() => {
    if (!selectedCouncil) {
      return;
    }
    if (!shouldHydrateLatestCouncilMessages(selectedCouncil)) {
      return;
    }
    if (latestCouncilMessageLoadsRef.current.has(selectedCouncil.id)) {
      return;
    }

    let cancelled = false;
    const councilId = selectedCouncil.id;
    latestCouncilMessageLoadsRef.current.add(councilId);
    void api.readCouncilMessages(selectedCouncil.id, { limit: COUNCIL_MESSAGE_PAGE_LIMIT })
      .then((page) => {
        if (cancelled) {
          return;
        }
        setCouncils((current) =>
          current.map((candidate) =>
            candidate.id === councilId ? mergeCouncilLatestMessagesPage(candidate, page) : candidate,
          ),
        );
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        latestCouncilMessageLoadsRef.current.delete(councilId);
      });

    return () => {
      cancelled = true;
    };
  }, [
    selectedCouncil?.id,
    selectedCouncil ? latestKnownCouncilMessageId(selectedCouncil) : undefined,
    selectedCouncil ? latestLoadedCouncilMessageId(selectedCouncil) : undefined,
  ]);

  useEffect(() => {
    if (!councilMenuOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && councilMenuRef.current?.contains(target)) {
        return;
      }
      setCouncilMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCouncilMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [councilMenuOpen]);

  useEffect(() => {
    if (!selectedCouncil) {
      setCouncilMenuOpen(false);
      setRenameDialogOpen(false);
    }
  }, [selectedCouncil]);

  const selectedCouncilDisplayItems = useMemo(
    () => selectedCouncil ? councilDisplayItems(selectedCouncil) : [],
    [selectedCouncil],
  );
  const liveTerminalAgents = useMemo(
    () => selectedCouncil?.agents.filter(isCouncilAgentTerminalAvailable) ?? [],
    [selectedCouncil],
  );
  const liveTerminalAgentIds = useMemo(
    () => liveTerminalAgents.map((agent) => agent.id),
    [liveTerminalAgents],
  );
  const terminalDialogOpen = Boolean(selectedCouncil && selectedTerminalAgentId);
  const activeTerminalAgent = selectedCouncil?.agents.find((agent) => agent.id === selectedTerminalAgentId) ?? null;
  const visitedRunningTerminalAgents = useMemo(
    () => liveTerminalAgents.filter((agent) => councilTuiCache.visitedAgentIds.has(agent.id)),
    [councilTuiCache.visitedAgentIds, liveTerminalAgents],
  );
  const pendingPromptAgent = selectedCouncil?.agents.find((agent) => agent.id === pendingPromptAgentId) ?? null;
  const pendingPauseAgent = selectedCouncil?.agents.find((agent) => agent.id === pendingPauseAgentId) ?? null;
  const pendingStopAgent = selectedCouncil?.agents.find((agent) => agent.id === pendingStopAgentId) ?? null;
  const agentActionDialogOpen =
    pendingPromptAgent !== null || pendingPauseAgent !== null || pendingStopAgent !== null;
  const blockCouncilParentClose = agentActionDialogOpen || agentActionUiLocked;
  const mentionOptions = useMemo(() => {
    if (!selectedCouncil || !mentionTrigger) {
      return [];
    }
    return filterCouncilMentionOptions(
      buildCouncilMentionOptions(selectedCouncil.agents),
      mentionTrigger.query,
    ).slice(0, 8);
  }, [mentionTrigger, selectedCouncil]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(min-width: 768px)");
    const handleChange = () => {
      setIsCouncilWide(query.matches);
    };
    handleChange();
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(max-width: 520px)");
    const handleChange = () => {
      setIsCouncilHeaderCompact(query.matches);
    };
    handleChange();
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    setMentionTrigger(null);
    setMentionSelectedIndex(0);
  }, [selectedCouncilId]);

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

  const loadOlderCouncilMessages = async () => {
    const council = selectedCouncil;
    if (
      !council ||
      !canLoadOlderCouncilMessages(council) ||
      loadingOlderCouncilMessagesRef.current
    ) {
      return;
    }
    const node = chatScrollRef.current;
    if (node) {
      councilPrependAnchorRef.current = {
        councilId: council.id,
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
    }
    loadingOlderCouncilMessagesRef.current = true;
    setLoadingOlderCouncilMessages(true);
    setError(null);
    try {
      const page = await api.readCouncilMessages(council.id, {
        ...(council.messageWindow?.nextBeforeMessageId !== undefined
          ? { beforeMessageId: council.messageWindow.nextBeforeMessageId }
          : {}),
        limit: COUNCIL_MESSAGE_PAGE_LIMIT,
      });
      setCouncils((current) =>
        current.map((candidate) =>
          candidate.id === council.id ? prependCouncilMessagesPage(candidate, page) : candidate,
        ),
      );
    } catch (caught) {
      councilPrependAnchorRef.current = null;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      loadingOlderCouncilMessagesRef.current = false;
      setLoadingOlderCouncilMessages(false);
    }
  };

  const handleCouncilChatScroll = () => {
    updateCouncilScrollHint();
    const node = chatScrollRef.current;
    if (
      node &&
      node.scrollTop <= COUNCIL_TOP_HISTORY_TRIGGER_PX &&
      canLoadOlderCouncilMessages(selectedCouncil) &&
      !loadingOlderCouncilMessagesRef.current
    ) {
      void loadOlderCouncilMessages();
    }
  };

  const scrollCouncilChatToBottom = (behavior: ScrollBehavior = "smooth") => {
    const node = chatScrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    councilStickToLatestRef.current = true;
    setShowScrollToLatest(false);
  };

  useEffect(() => {
    const councilId = selectedCouncil?.id ?? null;
    const councilChanged = previousCouncilIdRef.current !== councilId;
    previousCouncilIdRef.current = councilId;
    if (!councilId) {
      setShowScrollToLatest(false);
      councilStickToLatestRef.current = true;
      return;
    }
    const shouldStick = councilChanged || councilStickToLatestRef.current;
    window.requestAnimationFrame(() => {
      if (shouldStick) {
        scrollCouncilChatToBottom("auto");
      } else {
        updateCouncilScrollHint();
      }
    });
  }, [selectedCouncil?.id, selectedCouncil?.messages.length]);

  useLayoutEffect(() => {
    const anchor = councilPrependAnchorRef.current;
    const node = chatScrollRef.current;
    if (!anchor || !node || anchor.councilId !== selectedCouncil?.id) {
      return;
    }
    node.scrollTop = anchor.scrollTop + (node.scrollHeight - anchor.scrollHeight);
    councilPrependAnchorRef.current = null;
  }, [selectedCouncil?.id, selectedCouncil?.messages.length]);

  const refreshCouncils = async (
    options?: {
      silent?: boolean;
      allowRunningDefault?: boolean;
      scope?: "active" | "all";
      preserveMissing?: boolean;
    },
  ): Promise<CouncilSnapshot[]> => {
    const scope = options?.scope ?? "active";
    if (!options?.silent) {
      setCouncilsRefreshing(true);
    }
    setError(null);
    try {
      const response = await api.listCouncils({ scope });
      const nextCouncils = mergeCouncilLists(councilsRef.current, response.councils, {
        preserveMissing: options?.preserveMissing ?? scope === "active",
      });
      councilsRef.current = nextCouncils;
      setCouncils(nextCouncils);
      setSelectedCouncilId((current) => {
        return reconcileCouncilSelection(current, nextCouncils, {
          allowRunningDefault: options?.allowRunningDefault,
        });
      });
      return nextCouncils;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return [];
    } finally {
      if (!options?.silent) {
        setCouncilsRefreshing(false);
      }
    }
  };

  useEffect(() => {
    void refreshCouncils({ allowRunningDefault: true });
  }, []);

  useEffect(() => {
    if (historyDialogOpen) {
      void refreshCouncils({ scope: "all" });
    }
  }, [historyDialogOpen]);

  useEffect(() => {
    if (!selectedTerminalAgentId) {
      return;
    }
    if (
      !selectedCouncil ||
      selectedCouncil.status !== "running" ||
      !liveTerminalAgents.some((agent) => agent.id === selectedTerminalAgentId)
    ) {
      setSelectedTerminalAgentId(null);
    }
  }, [liveTerminalAgents, selectedCouncil, selectedTerminalAgentId]);

  useEffect(() => {
    autoWarmedCouncilIdRef.current = null;
    setCouncilTuiCache(resetCouncilTuiCache());
    setSelectedTerminalAgentId(null);
  }, [selectedCouncil?.id]);

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
    if (!selectedCouncilId) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const refreshAfterSocketLoss = () => {
      void api.listCouncils({ scope: "active" })
        .then((response) => {
          if (cancelled) return;
          const nextCouncils = mergeCouncilLists(councilsRef.current, response.councils, {
            preserveMissing: true,
          });
          councilsRef.current = nextCouncils;
          setCouncils(nextCouncils);
        })
        .catch(() => {
          // The normal 5s polling loop owns user-visible Council refresh errors.
        });
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) return;
      const baseDelay = document.visibilityState === "visible" ? 750 : 3_000;
      const delay = Math.min(30_000, baseDelay * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectSocket();
      }, delay);
    };

    const connectSocket = () => {
      if (cancelled) return;
      socket = api.createEventsSocket(
        {
          sessionIds: [selectedCouncilId],
          eventTypes: ["council.message.created"],
        },
        (batch) => {
          const latest = batch.events
            .filter((event) => event.type === "council.message.created")
            .at(-1);
          if (!latest) return;
          setCouncils((current) => {
            const nextCouncil = latest.payload.council;
            const index = current.findIndex((council) => council.id === nextCouncil.id);
            if (index < 0) {
              return [nextCouncil, ...current];
            }
            const next = [...current];
            next[index] = mergeCouncilSnapshot(next[index], nextCouncil);
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
          onOpen: () => {
            reconnectAttempt = 0;
          },
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
  }, [selectedCouncilId]);

  useEffect(() => {
    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void api.listCouncils({ scope: "active" })
        .then((response) => {
          if (cancelled) return;
          const nextCouncils = mergeCouncilLists(councilsRef.current, response.councils, {
            preserveMissing: true,
          });
          councilsRef.current = nextCouncils;
          setCouncils(nextCouncils);
          setError(null);
          setSelectedCouncilId((current) => {
            return reconcileCouncilSelection(current, nextCouncils);
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
    const draftGroups = addAgentDialogOpen
      ? [{ drafts: addAgentDrafts, cwd: addAgentWorkspace }]
      : [];
    for (const group of draftGroups) {
      const cwd = group.cwd.trim();
      for (const draft of group.drafts) {
        const key = catalogKey(draft.provider, cwd);
        if (
          requestedKeys.has(key) ||
          catalogRequestsRef.current.has(key) ||
          isCouncilCatalogFresh(catalogLoadedAtRef.current[key])
        ) {
          continue;
        }
        requestedKeys.add(key);
        catalogRequestsRef.current.add(key);
        void api.listProviderModels(draft.provider, cwd ? { cwd } : {})
          .then((catalog) => {
            catalogLoadedAtRef.current[key] = Date.now();
            setCatalogs((current) => ({ ...current, [key]: catalog }));
          })
          .catch(() => {
            catalogLoadedAtRef.current[key] = councilCatalogFailureLoadedAt();
          })
          .finally(() => {
            catalogRequestsRef.current.delete(key);
          });
      }
    }
  }, [addAgentDialogOpen, addAgentDrafts, addAgentWorkspace, catalogs]);

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

  const handleNewCouncilCreated = (council: CouncilSnapshot) => {
    setCouncils((current) => {
      const existingIndex = current.findIndex((candidate) => candidate.id === council.id);
      if (existingIndex >= 0) {
        const next = [...current];
        next[existingIndex] = mergeCouncilSnapshot(next[existingIndex], council);
        return next;
      }
      return [council, ...current];
    });
    setSelectedCouncilId(council.id);
    setCouncilSidebarOpen(false);
    void refreshCouncils({ silent: true, scope: "active" });
  };

  const sendMessage = async () => {
    if (sendPending || !composer.trim()) return;
    if (!selectedCouncil) {
      setError("No Council selected.");
      return;
    }
    if (selectedCouncil.status === "stopped") {
      setError("Council is stopped and cannot receive messages.");
      return;
    }
    const text = composer;
    setComposer("");
    setSendPending(true);
    try {
      const response = await api.postCouncilMessage(selectedCouncil.id, { text });
      setCouncils((current) =>
        current.map((council) =>
          council.id === selectedCouncil.id ? mergeCouncilSnapshot(council, response.council) : council,
        ),
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

  const stopCouncil = async () => {
    if (!selectedCouncil || selectedCouncil.status === "stopped") return;
    setLoading(true);
    try {
      await api.stopCouncil(selectedCouncil.id);
      setStopConfirmOpen(false);
      setSelectedTerminalAgentId(null);
      const nextCouncils = await refreshCouncils({ scope: "active", preserveMissing: false });
      setSelectedCouncilId(defaultRunningCouncilId(nextCouncils));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const addAgentToCouncil = async () => {
    if (!selectedCouncil) {
      setError("No Council selected.");
      return;
    }
    if (selectedCouncil.status !== "running") {
      setError("Agents can only be added to a running Council.");
      return;
    }
    setLoading(true);
    setError(null);
    const successfulDraftIds = new Set<string>();
    try {
      let latestCouncil: CouncilSnapshot | null = null;
      for (const draft of addAgentDrafts) {
        const response = await api.addCouncilAgent(selectedCouncil.id, {
          agent: councilAgentDraftToConfig({
            draft,
            catalog: catalogs[catalogKey(draft.provider, addAgentWorkspace)] ?? null,
          }),
        });
        successfulDraftIds.add(draft.id);
        latestCouncil = response.council;
        replaceCouncil(response.council);
      }
      if (latestCouncil) {
        replaceCouncil(latestCouncil);
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

  const deleteHistoryCouncil = async (councilId: string) => {
    setLoading(true);
    setError(null);
    try {
      await api.deleteCouncil(councilId);
      setPendingDeleteHistoryCouncil(null);
      await refreshCouncils({ scope: "all" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const openCouncilInfo = (councilId: string) => {
    setSelectedCouncilId(councilId);
    setHistoryDialogOpen(false);
    setInfoDialogOpen(true);
  };

  const openCouncilRename = (council: CouncilSnapshot) => {
    setSelectedCouncilId(council.id);
    setHistoryDialogOpen(false);
    setRenameDialogOpen(true);
  };

  const selectCouncilTuiAgent = (
    agent: CouncilAgent,
    options?: { attach?: boolean; warmAll?: boolean; validateTerminal?: boolean },
  ) => {
    if (!selectedCouncil) {
      return;
    }
    if (!canOpenCouncilAgentTerminal(selectedCouncil, agent)) {
      return;
    }
    setError(null);
    const now = Date.now();
    const previousAgentId = selectedTerminalAgentId;
    const councilId = selectedCouncil.id;
    const shouldWarmAll = Boolean(options?.warmAll) && autoWarmedCouncilIdRef.current !== councilId;
    if (shouldWarmAll) {
      autoWarmedCouncilIdRef.current = councilId;
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
      void api.getCouncilAgentTui(selectedCouncil.id, agent.id)
        .then((response) => {
          if (!response.terminalId) {
            setError(response.screen || "This council agent terminal is not running anymore.");
            setSelectedTerminalAgentId((current) => current === agent.id ? null : current);
            void refreshCouncils({ scope: "active" });
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

  const replaceCouncil = (council: CouncilSnapshot) => {
    setCouncils((current) => {
      const index = current.findIndex((item) => item.id === council.id);
      if (index < 0) return [council, ...current];
      const next = [...current];
      next[index] = mergeCouncilSnapshot(next[index], council);
      return next;
    });
    setSelectedCouncilId(council.id);
  };

  const renameCouncil = async (councilId: string, title: string) => {
    setRenamePending(true);
    setError(null);
    try {
      const response = await api.renameCouncil(councilId, { title });
      replaceCouncil(response.council);
      setRenameDialogOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRenamePending(false);
    }
  };

  const reinjectAgent = async (agentId: string) => {
    if (!selectedCouncil) {
      setAgentActionUiLocked(false);
      return;
    }
    setAgentActionUiLocked(true);
    setLoading(true);
    setError(null);
    try {
      const response = await api.reinjectCouncilAgentPrompt(selectedCouncil.id, agentId);
      replaceCouncil(response.council);
      if (response.injectedAgentIds.length === 0) {
        setError(`No running terminal was available for ${agentId}.`);
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
    if (!selectedCouncil) {
      setAgentActionUiLocked(false);
      return;
    }
    setAgentActionUiLocked(true);
    setLoading(true);
    setError(null);
    try {
      const response = await api.removeCouncilAgent(selectedCouncil.id, agentId);
      replaceCouncil(response.council);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      restoreCouncilViewAfterAgentAction();
      setLoading(false);
      setAgentActionUiLocked(false);
    }
  };

  const stopCouncilAgent = async (agentId: string) => {
    if (!selectedCouncil) {
      setAgentActionUiLocked(false);
      return;
    }
    setAgentActionUiLocked(true);
    setLoading(true);
    setError(null);
    try {
      const response = await api.stopCouncilAgent(selectedCouncil.id, agentId);
      replaceCouncil(response.council);
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

  const councilReferenceRoot = selectedCouncil?.workspace || workspace || props.workspaceDir || "/";
  const councilCanReceiveMessages = Boolean(
    selectedCouncil &&
    selectedCouncil.status === "running",
  );
  const sendDisabled = sendPending || !councilCanReceiveMessages || !composer.trim();
  const showAgentsToggle = props.showAgentsToggle ?? true;
  const agentsToggleDisabled = props.agentsToggleDisabled ?? false;
  const showLeftSidebarControls = props.showLeftSidebarControls ?? true;
  const showCloseButton = props.showCloseButton ?? true;

  const chatPanelClass = "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-bg)]";
  const councilSidebarButtonLabel = councilSidebarOpen ? "Hide agents" : "Show agents";
  const councilSidebarButtonTitle = agentsToggleDisabled
    ? "Maximize pane to use agents"
    : councilSidebarButtonLabel;
  const agentsSidebarContent = (
    <div className="flex h-full min-h-0 flex-col bg-[var(--app-subtle-bg)]">
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] pl-4 pr-14">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--app-fg)]">Agents</div>
          <div className="truncate text-xs text-[var(--app-hint)]">
            {selectedCouncil
              ? `${selectedCouncil.agents.length} agent${selectedCouncil.agents.length === 1 ? "" : "s"}`
              : "No running Council selected"}
          </div>
        </div>
      </div>
      <OverlayScrollArea
        className="min-h-0 flex-1"
        viewportClassName="h-full p-3"
        scrollAriaLabel="Council agents"
      >
        {!selectedCouncil ? (
          <div className="h-full" />
        ) : (
          <div className="space-y-3">
            {selectedCouncil.agents.map((agent) => {
              const terminalEnabled = canOpenCouncilAgentTerminal(selectedCouncil, agent);
              const theme = councilAgentTheme(selectedCouncil, agent.id);
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
                        title="Remove agent from Council"
                        aria-label={`Remove ${agent.label} from Council`}
                      >
                        <Unplug size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {selectedCouncil.status === "running" ? (
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
      </OverlayScrollArea>
    </div>
  );
  const councilTerminalTabs: TerminalTabDescriptor[] = selectedCouncil
    ? liveTerminalAgents.map((agent) => {
      const theme = councilAgentTheme(selectedCouncil, agent.id);
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
  const visitedCouncilTerminalTabs = visitedRunningTerminalAgents.flatMap((agent) => {
    const terminalId = agent.nativeSessionId ?? agent.terminalId;
    if (!terminalId) {
      return [];
    }
    return [{ id: agent.id, terminalId, label: agent.label }];
  });
  const selectedCouncilHeaderState = selectedCouncil
    ? resolveConversationHeaderState({
        status: selectedCouncil.status,
        phase: selectedCouncil.phase,
      })
    : null;
  const selectedCouncilAgentCountLabel = selectedCouncil
    ? `${selectedCouncil.agents.length} agent${selectedCouncil.agents.length === 1 ? "" : "s"}`
    : null;
  const compactCouncilMeta = isPwaDisplayMode || !isCouncilWide;
  const selectedCouncilHeaderMetaItems: ConversationHeaderMetaItem[] =
    selectedCouncil && selectedCouncilHeaderState && selectedCouncilAgentCountLabel
      ? [
          {
            slot: "status",
            node: (
              <ConversationStateMetaBadge
                state={selectedCouncilHeaderState}
              />
            ),
          },
          {
            slot: "count",
            node: (
              <ConversationMetaBadge
                tone="council"
                title={selectedCouncilAgentCountLabel}
                ariaLabel={selectedCouncilAgentCountLabel}
                icon={<UsersRound size={10} />}
                label={compactCouncilMeta ? selectedCouncil.agents.length : selectedCouncilAgentCountLabel}
                paddingClassName={CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS}
              />
            ),
          },
        ]
      : [];
  const selectedCouncilDeleteDisabled =
    !selectedCouncil || selectedCouncil.status === "running" || loading;
  const selectedCouncilDeleteTitle =
    selectedCouncil?.status === "running"
      ? "Running Councils cannot be deleted"
      : loading
        ? "Action in progress"
        : "Delete Council";
  const showCouncilOverflowMenu = selectedCouncil !== null || isCouncilHeaderCompact;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--app-bg)]">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <ConversationPageShell as="section" className={chatPanelClass}>
          <ConversationHeader
            sidebarOpen={props.sidebarOpen}
            showLeftSidebarControls={showLeftSidebarControls}
            onOpenLeft={props.onOpenLeft}
            onExpandSidebar={props.onExpandSidebar}
            compactCloseAction={isPwaDisplayMode}
            backgroundClassName="bg-[var(--app-bg)]/85"
            identity={<UsersRound className={COUNCIL_HEADER_ICON_CLASSNAME} />}
            title={selectedCouncil?.title ?? "Council"}
            titleText={selectedCouncil?.title ?? "Council"}
            meta={<ConversationHeaderMetaList items={selectedCouncilHeaderMetaItems} />}
            actions={
              <>
              <ConversationHeaderIconButton
                onClick={() => setHistoryDialogOpen(true)}
                className="max-[520px]:hidden"
                aria-label="Chats"
                title="Chats"
              >
                <ListTree size={14} />
              </ConversationHeaderIconButton>
              <ConversationHeaderIconButton
                onClick={() => setNewCouncilDialogOpen(true)}
                className="max-[520px]:hidden"
                title="New Council"
                aria-label="New Council"
              >
                <Plus size={15} />
              </ConversationHeaderIconButton>
              {selectedCouncil?.status === "running" ? (
                <ConversationHeaderStopButton
                  onClick={() => setStopConfirmOpen(true)}
                  disabled={loading}
                  ariaLabel="Stop Council"
                  title="Stop Council and close agent terminals"
                />
              ) : null}
              {showCouncilOverflowMenu ? (
                <div ref={councilMenuRef} className="relative">
                  <ConversationHeaderMoreButton
                    onClick={() => setCouncilMenuOpen((open) => !open)}
                    open={councilMenuOpen}
                    ariaLabel="Council actions"
                    title="Council actions"
                  />
                  {councilMenuOpen ? (
                    <div className="absolute right-0 top-[calc(100%+0.375rem)] z-[120] min-w-[10rem] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-xl">
                      {isCouncilHeaderCompact ? (
                        <>
                          <button
                            type="button"
                            className={HEADER_MENU_ITEM_CLASS}
                            onClick={() => {
                              setCouncilMenuOpen(false);
                              setHistoryDialogOpen(true);
                            }}
                          >
                            <ListTree size={14} />
                            <span>Chats</span>
                          </button>
                          <button
                            type="button"
                            className={HEADER_MENU_ITEM_CLASS}
                            onClick={() => {
                              setCouncilMenuOpen(false);
                              setNewCouncilDialogOpen(true);
                            }}
                          >
                            <Plus size={14} />
                            <span>New Council</span>
                          </button>
                        </>
                      ) : null}
                      {selectedCouncil ? (
                        <>
                          <button
                            type="button"
                            className={HEADER_MENU_ITEM_CLASS}
                            onClick={() => {
                              setCouncilMenuOpen(false);
                              openCouncilInfo(selectedCouncil.id);
                            }}
                          >
                            <Info size={14} />
                            <span>Info</span>
                          </button>
                          <button
                            type="button"
                            className={HEADER_MENU_ITEM_CLASS}
                            onClick={() => {
                              setCouncilMenuOpen(false);
                              setRenameDialogOpen(true);
                            }}
                          >
                            <PencilLine size={14} />
                            <span>Rename</span>
                          </button>
                          <button
                            type="button"
                            className={
                              selectedCouncilDeleteDisabled
                                ? HEADER_MENU_ITEM_CLASS
                                : HEADER_MENU_DANGER_ITEM_CLASS
                            }
                            disabled={selectedCouncilDeleteDisabled}
                            title={selectedCouncilDeleteTitle}
                            aria-label={selectedCouncilDeleteTitle}
                            onClick={() => {
                              if (selectedCouncilDeleteDisabled) {
                                return;
                              }
                              setCouncilMenuOpen(false);
                              setPendingDeleteHistoryCouncil(selectedCouncil);
                            }}
                          >
                            <Trash2 size={14} />
                            <span>Delete</span>
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              </>
            }
            closeAction={
              showCloseButton
                ? {
                    ariaLabel: "Close Council view",
                    title: "Close Council view",
                    onClick: props.onHide,
                  }
                : null
            }
            trailingActions={
              showAgentsToggle && (!isCouncilWide || !councilSidebarOpen) ? (
                <ConversationHeaderPanelToggleButton
                  onClick={() => setCouncilSidebarOpen((open) => !open)}
                  disabled={agentsToggleDisabled}
                  ariaLabel={councilSidebarButtonLabel}
                  open={councilSidebarOpen}
                  title={councilSidebarButtonTitle}
                />
              ) : null
            }
          />
          {error ? (
            <div className="mx-4 mt-3 rounded-lg border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10 px-3 py-2 text-xs text-[var(--app-danger)]">
              {error}
            </div>
          ) : null}
          {selectedCouncil?.error ? (
            <div className="mx-4 mt-3 rounded-lg border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10 px-3 py-2 text-xs text-[var(--app-danger)]">
              {selectedCouncil.error}
            </div>
          ) : null}
          <div className="relative min-h-0 flex-1">
            <div
              ref={chatScrollRef}
              onScroll={handleCouncilChatScroll}
              className="h-full space-y-3 overflow-y-auto rah-scroll-main p-3 sm:p-4"
            >
              {!selectedCouncil ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[var(--app-hint)]">
                  <span>Start a new Council or choose a running Council.</span>
                  <button
                    type="button"
                    onClick={() => setNewCouncilDialogOpen(true)}
                    className="icon-click-feedback inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] px-3 text-xs font-semibold text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                  >
                    <Plus size={14} />
                    New Council
                  </button>
                </div>
              ) : (
                <>
                  {loadingOlderCouncilMessages && canLoadOlderCouncilMessages(selectedCouncil) ? (
                    <div className="flex justify-center">
                      <div className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--app-hint)]">
                        Loading older history
                      </div>
                    </div>
                  ) : null}
                  {selectedCouncilDisplayItems.map((item) => {
                if (item.kind === "agent-status") {
                  const agent = actorAgent(selectedCouncil, item.actorId);
                  const label = actorLabel(selectedCouncil, item.actorId);
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
                const agent = actorAgent(selectedCouncil, message.actorId);
                if (message.role === "system") {
                  return (
                    <div
                      key={message.id}
                      className={COUNCIL_SYSTEM_NOTICE_CLASS}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-hint)]/50" />
                      <span className="whitespace-pre-wrap">
                        {councilSystemText(selectedCouncil, textFromParts(message.parts))}
                      </span>
                    </div>
                  );
                }
                const theme = agent ? councilAgentTheme(selectedCouncil, agent.id) : null;
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
                      <span className="min-w-0 truncate">{actorLabel(selectedCouncil, message.actorId)}</span>
                    </div>
                    <CouncilMessageContent role={message.role} text={textFromParts(message.parts)} />
                  </div>
                );
                  })}
                </>
              )}
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
                  disabled={!councilCanReceiveMessages}
                  className={COMPOSER_LAYOUT.attachButtonClassName}
                  title="Insert file or folder reference"
                  aria-label="Insert file or folder reference"
                >
                  <Plus size={18} />
                </button>
                <div className="relative min-w-0">
                  {mentionTrigger && selectedCouncil && mentionOptions.length > 0 ? (
                    <div
                      role="listbox"
                      aria-label="Council mentions"
                      className="rah-popover-panel absolute bottom-full left-0 z-30 mb-1.5 max-h-64 w-[min(24rem,calc(100vw-5rem))] overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg"
                    >
                      <OverlayScrollArea
                        className="max-h-64"
                        viewportClassName="max-h-64"
                        contentClassName="p-1.5"
                        scrollAriaLabel="Council mentions"
                      >
                        {mentionOptions.map((option, index) => {
                          const selected = index === mentionSelectedIndex;
                          const optionTheme = option.agent ? councilAgentTheme(selectedCouncil, option.agent.id) : null;
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
                      </OverlayScrollArea>
                    </div>
                  ) : null}
                  <TokenizedTextarea
                    ref={composerRef}
                    textareaClassName={COMPOSER_LAYOUT.textareaClassName}
                    contentClassName={COMPOSER_LAYOUT.textareaContentClassName}
                    value={composer}
                    ariaLabel="Council message composer"
                    disabled={!councilCanReceiveMessages}
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
        </ConversationPageShell>

        <ConversationSidePanelShell
          desktopOpen={councilSidebarOpen}
          desktopBreakpoint="md"
          mobileOpen={councilSidebarOpen && !isCouncilWide}
          onMobileOpenChange={handleCouncilSidebarOpenChange}
          mobileTitle="Agents"
          mobileModal={false}
          mobileFloatingCloseLabel="Hide agents"
          toggleLabel={councilSidebarButtonTitle}
          toggleDisabled={agentsToggleDisabled}
          onToggle={() => setCouncilSidebarOpen((open) => !open)}
        >
          {agentsSidebarContent}
        </ConversationSidePanelShell>
      </div>

      <FileReferencePicker
        open={fileReferenceOpen}
        onOpenChange={setFileReferenceOpen}
        rootPath={councilReferenceRoot}
        onPick={insertCouncilReference}
      />

      <RenameSessionDialog
        open={renameDialogOpen}
        initialTitle={selectedCouncil?.title ?? ""}
        pending={renamePending}
        title="Rename Council"
        fieldLabel="Council title"
        placeholder="Enter a Council title"
        onOpenChange={(open) => {
          if (!open && renamePending) {
            return;
          }
          setRenameDialogOpen(open);
        }}
        onConfirm={(title) => {
          if (selectedCouncil) {
            void renameCouncil(selectedCouncil.id, title);
          }
        }}
      />

      <ConfirmDialog
        open={stopConfirmOpen}
        title="Stop Council?"
        description={
          selectedCouncil
            ? `Stop "${selectedCouncil.title}" and close all running agent terminals in this Council. It will remain available in stopped Councils.`
            : "Stop this Council and close all running agent terminals."
        }
        confirmLabel={loading ? "Stopping…" : "Stop Council"}
        confirmTone="danger"
        pending={loading}
        onOpenChange={setStopConfirmOpen}
        onConfirm={() => void stopCouncil()}
      />

      <ConfirmDialog
        open={pendingDeleteHistoryCouncil !== null}
        title="Delete Council?"
        description={
          pendingDeleteHistoryCouncil
            ? `Delete "${pendingDeleteHistoryCouncil.title}" from Council history? This removes the saved Council, agents, and messages.`
            : "Delete this Council from history?"
        }
        confirmLabel={loading ? "Deleting…" : "Delete"}
        confirmTone="danger"
        pending={loading}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteHistoryCouncil(null);
          }
        }}
        onConfirm={() => {
          if (pendingDeleteHistoryCouncil) {
            void deleteHistoryCouncil(pendingDeleteHistoryCouncil.id);
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
        title="Remove agent from Council?"
        description={
          pendingStopAgent
            ? `Remove "${pendingStopAgent.label}" from this Council and close only this agent TUI process? Other agents and the Council stay running.`
            : "Remove this agent from the Council? Other agents and the Council stay running."
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

      <NewCouncilDialog
        open={newCouncilDialogOpen}
        onOpenChange={setNewCouncilDialogOpen}
        workspaceDir={workspace || props.workspaceDir || ""}
        workspaceDirs={props.workspaceDirs}
        councils={councils}
        onAddWorkspace={props.onAddWorkspace}
        onCreated={handleNewCouncilCreated}
      />

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
                  {selectedCouncil ? `Add to ${selectedCouncil.title}` : "Select a running Council first."}
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
            <OverlayScrollArea
              className="min-h-0 flex-1 min-[900px]:flex-none"
              viewportClassName="h-full p-4 min-[900px]:h-auto min-[900px]:max-h-[calc(min(calc(100dvh-24px),720px)-8.25rem)]"
              contentClassName="space-y-3"
              scrollAriaLabel="Add agents"
            >
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
            </OverlayScrollArea>
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
                disabled={loading || !selectedCouncil || selectedCouncil.status !== "running" || !addAgentWorkspace.trim() || addAgentDrafts.length === 0}
                onClick={() => void addAgentToCouncil()}
                className="icon-click-feedback inline-flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg bg-[var(--app-fg)] px-3 text-xs font-semibold text-[var(--app-bg)] disabled:opacity-40"
              >
                Add {addAgentDrafts.length > 1 ? `${addAgentDrafts.length} agents` : "to chat"}
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
                  Council Chats
                </Dialog.Title>
                <div className="text-xs text-[var(--app-hint)]">
                  Running Councils can receive messages; stopped Councils are read-only transcripts.
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => void refreshCouncils({ scope: "all" })}
                  disabled={councilsRefreshing}
                  className="icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40"
                  aria-label="Refresh Councils"
                  title="Refresh Councils"
                >
                  <RefreshCw size={14} />
                </button>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    aria-label="Close Councils"
                    title="Close Councils"
                  >
                    <X size={16} />
                  </button>
                </Dialog.Close>
              </div>
            </div>
            <OverlayScrollArea
              className="max-h-[calc(84vh-4.5rem)]"
              viewportClassName="max-h-[calc(84vh-4.5rem)] p-3"
              scrollAriaLabel="Councils"
            >
              <CouncilsBrowser
                councils={councils}
                selectedCouncilId={selectedCouncil?.id ?? null}
                loading={loading}
                onOpenCouncil={(council) => {
                  setSelectedCouncilId(council.id);
                  setHistoryDialogOpen(false);
                }}
                onShowCouncilInfo={(council) => openCouncilInfo(council.id)}
                onRenameCouncil={openCouncilRename}
                onRequestDeleteCouncil={setPendingDeleteHistoryCouncil}
              />
            </OverlayScrollArea>
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
                  Council Chat Info
                </Dialog.Title>
                <div className="truncate text-xs text-[var(--app-hint)]">
                  Internal identifiers and agent startup configuration.
                </div>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                  aria-label="Close Council info"
                  title="Close info"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            {selectedCouncil ? (
              <OverlayScrollArea
                className="max-h-[calc(84vh-4.5rem)]"
                viewportClassName="max-h-[calc(84vh-4.5rem)] p-4"
                contentClassName="space-y-4"
              >
                <div className="grid gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/40 p-3 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 font-semibold text-[var(--app-hint)]">Title</span>
                    <span className="min-w-0 break-words text-right text-[var(--app-fg)]">{selectedCouncil.title}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 font-semibold text-[var(--app-hint)]">Council ID</span>
                    <code className="min-w-0 break-all rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--app-fg)]">
                      {selectedCouncil.id}
                    </code>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 font-semibold text-[var(--app-hint)]">Workspace</span>
                    <code className="min-w-0 break-all rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--app-fg)]">
                      {selectedCouncil.workspace}
                    </code>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 font-semibold text-[var(--app-hint)]">Status</span>
                    <span className="text-[var(--app-fg)]">
                      {selectedCouncil.status} · {selectedCouncil.phase}
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 font-semibold text-[var(--app-hint)]">Created</span>
                    <span className="text-right text-[var(--app-fg)]">{selectedCouncil.createdAt}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 font-semibold text-[var(--app-hint)]">Updated</span>
                    <span className="text-right text-[var(--app-fg)]">{selectedCouncil.updatedAt}</span>
                  </div>
                  {selectedCouncil.storage ? (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <span className="shrink-0 font-semibold text-[var(--app-hint)]">Store File</span>
                        <code className="min-w-0 break-all rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--app-fg)]">
                          {selectedCouncil.storage.storePath}
                        </code>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <span className="shrink-0 font-semibold text-[var(--app-hint)]">Message Log</span>
                        <code className="min-w-0 break-all rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--app-fg)]">
                          {selectedCouncil.storage.messageLogPath}
                        </code>
                      </div>
                    </>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--app-hint)]">
                    Agents
                  </div>
                  {selectedCouncil.agents.map((agent) => {
                    const theme = councilAgentTheme(selectedCouncil, agent.id);
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
                          {agent.modeId ? (
                            <div className="flex items-start justify-between gap-3">
                              <span className="shrink-0 font-semibold text-[var(--app-hint)]">Mode</span>
                              <span className="min-w-0 break-words text-right text-[var(--app-fg)]">{agent.modeId}</span>
                            </div>
                          ) : null}
                          {agent.optionValues && Object.keys(agent.optionValues).length > 0 ? (
                            <div className="flex items-start justify-between gap-3">
                              <span className="shrink-0 font-semibold text-[var(--app-hint)]">Options</span>
                              <CouncilAgentOptionValues values={agent.optionValues} />
                            </div>
                          ) : null}
                          {(agent.nativeSessionId ?? agent.terminalId) ? (
                            <div className="flex items-start justify-between gap-3">
                              <span className="shrink-0 font-semibold text-[var(--app-hint)]">Terminal ID</span>
                              <code className="min-w-0 break-all rounded bg-[var(--app-bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--app-fg)]">
                                {agent.nativeSessionId ?? agent.terminalId}
                              </code>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </OverlayScrollArea>
            ) : (
              <div className="p-4 text-sm text-[var(--app-hint)]">No Council selected.</div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <TerminalDialogFrame
        open={terminalDialogOpen}
        onOpenChange={handleTerminalDialogOpenChange}
        title={selectedCouncil?.title ?? "Council terminals"}
        subtitle={activeTerminalAgent?.label ?? "Select an agent"}
        leading={<Bot size={15} className="shrink-0 text-[var(--app-hint)]" />}
        overlayClassName="fixed inset-0 z-[65] bg-black/45"
        contentClassName="fixed inset-0 z-[70] flex h-[100dvh] w-screen flex-col overflow-hidden bg-[var(--app-bg)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] focus:outline-none md:left-1/2 md:top-1/2 md:h-[82vh] md:w-[min(1280px,96vw)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:border-[var(--app-border)] md:pt-0 md:pb-0 md:shadow-2xl"
        closeLabel="Close council terminals"
        closeTitle="Close council terminals"
        closeText="Close"
        forceMount
        headerActions={
          selectedCouncil?.status === "running" && activeTerminalAgent ? (
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
                title={`Remove ${activeTerminalAgent.label} from council`}
                aria-label={`Remove ${activeTerminalAgent.label} from council`}
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
              This council agent terminal is not running anymore.
            </div>
          }
          terminalProps={(tab, active) => {
            const tabAgent = selectedCouncil?.agents.find((agent) => agent.id === tab.id) ?? null;
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
              initialReplay: true,
              replayTailBytes: 512 * 1024,
              maxWriteBatchChars: 128 * 1024,
              scrollback: 180,
            };
          }}
        />
      </TerminalDialogFrame>
    </div>
  );
}
