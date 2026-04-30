import { useEffect, useMemo, useState } from "react";
import type { SessionSummary, StoredSessionRef } from "@rah/runtime-protocol";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, ChevronDown, ChevronRight, History, ListFilter, MoreHorizontal, Pencil, PlusCircle, Search, X } from "lucide-react";
import { providerLabel } from "../types";
import { formatRelativeTime, type WorkspaceSortMode } from "../session-browser";
import { ProviderLogo } from "./ProviderLogo";
import {
  dedupeStoredSessionsByIdentity,
  groupAllStoredSessionsByDirectory,
  sessionIdentityKey,
} from "../session-history-grouping";

const DEFAULT_GROUP_ITEM_LIMIT = 10;
const GROUP_ITEM_INCREMENT = 20;
const HISTORY_PROVIDER_OPTIONS = ["codex", "claude", "kimi", "gemini", "opencode"] as const;

type HistoryTab = "live" | "recent" | "all";
type HistoryProviderFilter = (typeof HISTORY_PROVIDER_OPTIONS)[number];

function isHistoryProviderFilter(provider: StoredSessionRef["provider"]): provider is HistoryProviderFilter {
  return (HISTORY_PROVIDER_OPTIONS as readonly string[]).includes(provider);
}

function HistoryFilterMenu(props: {
  sortMode: WorkspaceSortMode;
  onSortModeChange: (value: WorkspaceSortMode) => void;
  selectedProviders: ReadonlySet<HistoryProviderFilter>;
  onToggleProvider: (provider: HistoryProviderFilter) => void;
  onToggleAllProviders: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [disabledHintVisible, setDisabledHintVisible] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-history-sort-menu]")) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!disabledHintVisible) {
      return;
    }
    const timeoutId = window.setTimeout(() => setDisabledHintVisible(false), 1600);
    return () => window.clearTimeout(timeoutId);
  }, [disabledHintVisible]);

  const sortOptions: Array<{ value: WorkspaceSortMode; label: string }> = [
    { value: "created", label: "按创建顺序" },
    { value: "updated", label: "按最近更新" },
  ];
  const allProvidersSelected = props.selectedProviders.size === HISTORY_PROVIDER_OPTIONS.length;

  return (
    <div className="relative" data-history-sort-menu>
      <button
        type="button"
        className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
          props.disabled
            ? "text-[var(--app-hint)] opacity-55 hover:bg-[var(--app-bg)]"
            : "text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={props.disabled}
        aria-label="Filter and sort history"
        title={props.disabled ? "Filters are available in All" : "Filter and sort sessions"}
        onClick={() => {
          if (props.disabled) {
            setOpen(false);
            setDisabledHintVisible(true);
            return;
          }
          setOpen((current) => !current);
        }}
      >
        <ListFilter size={14} />
      </button>
      {disabledHintVisible ? (
        <div className="absolute right-0 top-9 z-20 w-44 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs text-[var(--app-hint)] shadow-lg">
          Switch to All to use filters.
        </div>
      ) : null}
      {open ? (
        <div className="absolute right-0 top-9 z-10 w-56 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg">
          <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--app-hint)]">
            Workspace sort
          </div>
          {sortOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
              onClick={() => {
                props.onSortModeChange(option.value);
              }}
            >
              <span className="flex items-center gap-2">
                {option.value === "created" ? (
                  <PlusCircle size={14} className="text-[var(--app-hint)]" />
                ) : (
                  <Pencil size={14} className="text-[var(--app-hint)]" />
                )}
                <span>{option.label}</span>
              </span>
              <span className="inline-flex h-4 w-4 items-center justify-center text-[var(--app-hint)]">
                {props.sortMode === option.value ? <Check size={14} /> : null}
              </span>
            </button>
          ))}
          <div className="my-1 h-px bg-[var(--app-border)]" />
          <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--app-hint)]">
            Providers
          </div>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
            onClick={props.onToggleAllProviders}
          >
            <span>All providers</span>
            <span className="inline-flex h-4 w-4 items-center justify-center text-[var(--app-hint)]">
              {allProvidersSelected ? <Check size={14} /> : null}
            </span>
          </button>
          {HISTORY_PROVIDER_OPTIONS.map((provider) => (
            <button
              key={provider}
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
              onClick={() => props.onToggleProvider(provider)}
            >
              <span className="flex items-center gap-2">
                <ProviderLogo provider={provider} className="h-4 w-4" />
                <span>{providerLabel(provider)}</span>
              </span>
              <span className="inline-flex h-4 w-4 items-center justify-center text-[var(--app-hint)]">
                {props.selectedProviders.has(provider) ? <Check size={14} /> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function sourceBadge(session: StoredSessionRef) {
  if (session.source === "previous_live") {
    return {
      label: "Prev live",
      className:
        "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    };
  }
  return {
    label: "History",
    className: "border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)]",
  };
}

function sessionTitle(session: StoredSessionRef): string {
  return session.title ?? session.preview ?? session.providerSessionId;
}

function formatCount(value: number, unit: string): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m ${unit}`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k ${unit}`;
  }
  return `${value} ${unit}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function historyMetaLabel(session: StoredSessionRef): string | null {
  const meta = session.historyMeta;
  if (!meta) {
    return null;
  }
  if (typeof meta.lines === "number") {
    return formatCount(meta.lines, "lines");
  }
  if (typeof meta.messages === "number") {
    return formatCount(meta.messages, "msgs");
  }
  if (typeof meta.bytes === "number") {
    return formatBytes(meta.bytes);
  }
  return null;
}

function historyMetaTitle(session: StoredSessionRef): string | undefined {
  const meta = session.historyMeta;
  if (!meta) {
    return undefined;
  }
  return [
    typeof meta.lines === "number" ? formatCount(meta.lines, "lines") : null,
    typeof meta.messages === "number" ? formatCount(meta.messages, "msgs") : null,
    typeof meta.bytes === "number" ? formatBytes(meta.bytes) : null,
  ].filter(Boolean).join(" · ") || undefined;
}

function matchesQuery(session: StoredSessionRef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return (
    sessionTitle(session).toLowerCase().includes(q) ||
    (session.preview ?? "").toLowerCase().includes(q) ||
    session.providerSessionId.toLowerCase().includes(q) ||
    providerLabel(session.provider).toLowerCase().includes(q) ||
    (session.rootDir ?? session.cwd ?? "").toLowerCase().includes(q)
  );
}

function liveSessionTitle(summary: SessionSummary): string {
  return summary.session.title ?? summary.session.preview ?? summary.session.providerSessionId ?? summary.session.id;
}

function liveSessionPath(summary: SessionSummary): string {
  return summary.session.rootDir || summary.session.cwd;
}

function liveMatchesQuery(summary: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return (
    liveSessionTitle(summary).toLowerCase().includes(q) ||
    (summary.session.preview ?? "").toLowerCase().includes(q) ||
    summary.session.id.toLowerCase().includes(q) ||
    (summary.session.providerSessionId ?? "").toLowerCase().includes(q) ||
    providerLabel(summary.session.provider).toLowerCase().includes(q) ||
    liveSessionPath(summary).toLowerCase().includes(q)
  );
}

function LiveSessionRow(props: {
  summary: SessionSummary;
  onActivate: (sessionId: string) => void;
}) {
  const title = liveSessionTitle(props.summary);
  const path = liveSessionPath(props.summary);
  return (
    <button
      type="button"
      onClick={() => props.onActivate(props.summary.session.id)}
      className="w-full rounded-lg border border-transparent px-3 py-2 text-left text-[var(--app-hint)] transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-bg)]"
      data-session-id={props.summary.session.id}
      data-session-source="live"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <ProviderLogo provider={props.summary.session.provider} className="h-5 w-5" />
            <span className="truncate text-sm font-medium text-[var(--app-fg)]">{title}</span>
          </div>
          {props.summary.session.preview && props.summary.session.title ? (
            <div className="mt-1 truncate pl-7 text-xs text-[var(--app-hint)]">
              {props.summary.session.preview}
            </div>
          ) : null}
          {path ? (
            <div className="mt-1 truncate pl-7 text-xs text-[var(--app-hint)]">{path}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          <span className="inline-flex rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            {props.summary.session.runtimeState}
          </span>
          <span className="min-w-[3.5rem] text-right text-xs text-[var(--app-hint)]">
            {formatRelativeTime(props.summary.session.updatedAt) ?? "live"}
          </span>
        </div>
      </div>
    </button>
  );
}

function SessionRow(props: {
  session: StoredSessionRef;
  liveSummary: SessionSummary | undefined;
  onActivate: (ref: StoredSessionRef) => void;
  onRequestRemove: (ref: StoredSessionRef) => void;
}) {
  const badge = sourceBadge(props.session);
  const live = props.liveSummary !== undefined;
  const metaLabel = historyMetaLabel(props.session);
  const metaTitle = historyMetaTitle(props.session);
  const [showRemove, setShowRemove] = useState(false);

  useEffect(() => {
    if (!showRemove) {
      return;
    }
    const timeoutId = window.setTimeout(() => setShowRemove(false), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [showRemove]);

  return (
    <div className="w-full rounded-lg border border-transparent px-3 py-2 transition-colors hover:bg-[var(--app-bg)] hover:border-[var(--app-border)] text-[var(--app-hint)]">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <button
          type="button"
          onClick={() => props.onActivate(props.session)}
          className="min-w-0 flex-1 text-left"
          data-provider-session-id={props.session.providerSessionId}
          data-session-source={props.session.source ?? "provider_history"}
        >
          <div className="flex items-center gap-2 min-w-0">
            <ProviderLogo provider={props.session.provider} className="h-5 w-5" />
            <span className="text-sm font-medium truncate text-[var(--app-fg)]">
              {sessionTitle(props.session)}
            </span>
          </div>
          {props.session.preview && props.session.title ? (
            <div className="mt-1 text-xs text-[var(--app-hint)] truncate pl-7">{props.session.preview}</div>
          ) : null}
          {(props.session.rootDir ?? props.session.cwd) ? (
            <div className="mt-1 text-xs text-[var(--app-hint)] truncate pl-7">
              {props.session.rootDir ?? props.session.cwd}
            </div>
          ) : null}
        </button>
        <div className="flex items-center justify-end gap-2 shrink-0">
          {live ? (
            <span className="inline-flex rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
              Live
            </span>
          ) : (
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.className}`}
            >
              {badge.label}
            </span>
          )}
          {metaLabel ? (
            <span
              className="inline-flex rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--app-hint)]"
              title={metaTitle}
            >
              {metaLabel}
            </span>
          ) : null}
          <span className="text-xs text-[var(--app-hint)] min-w-[3.5rem] text-right">
            {formatRelativeTime(props.session.lastUsedAt ?? props.session.updatedAt) ?? "history"}
          </span>
          {showRemove ? (
            <button
              type="button"
              onClick={() => props.onRequestRemove(props.session)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-danger)] hover:bg-[var(--app-danger-bg)] transition-colors"
              aria-label="Delete session"
              title="Delete session"
            >
              <X size={14} strokeWidth={2.5} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setShowRemove(true)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
              aria-label="More"
              title="More"
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function SessionHistoryDialog(props: {
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  liveSessions: SessionSummary[];
  workspaceSortMode: WorkspaceSortMode;
  onWorkspaceSortModeChange: (value: WorkspaceSortMode) => void;
  onActivate: (ref: StoredSessionRef) => void;
  onActivateLive?: (sessionId: string) => void;
  onRemoveSession: (ref: Pick<StoredSessionRef, "provider" | "providerSessionId">) => void;
  onRemoveWorkspace: (workspaceDir: string) => void;
  defaultTab?: HistoryTab;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<HistoryTab>(props.defaultTab ?? "recent");
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [visibleItemCounts, setVisibleItemCounts] = useState<Map<string, number>>(new Map());
  const [pendingRemoveSession, setPendingRemoveSession] = useState<StoredSessionRef | null>(null);
  const [pendingRemoveWorkspaceDir, setPendingRemoveWorkspaceDir] = useState<string | null>(null);
  const [selectedProviders, setSelectedProviders] = useState<Set<HistoryProviderFilter>>(
    () => new Set(HISTORY_PROVIDER_OPTIONS),
  );

  const liveByProviderSessionId = useMemo(
    () =>
      new Map(
        props.liveSessions
          .filter((session) => session.session.providerSessionId)
          .map((session) => [
            sessionIdentityKey({
              provider: session.session.provider,
              providerSessionId: session.session.providerSessionId!,
            }),
            session,
          ]),
      ),
    [props.liveSessions],
  );

  useEffect(() => {
    if (open) {
      setTab(props.defaultTab ?? "recent");
    }
  }, [open, props.defaultTab]);

  const groups = useMemo(
    () =>
      groupAllStoredSessionsByDirectory(props.storedSessions, {
        workspaceSortMode: props.workspaceSortMode,
      }),
    [props.storedSessions, props.workspaceSortMode],
  );

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matchesProvider = (session: StoredSessionRef) => {
      if (!isHistoryProviderFilter(session.provider)) {
        return selectedProviders.size === HISTORY_PROVIDER_OPTIONS.length;
      }
      return selectedProviders.has(session.provider);
    };
    return groups
      .map((group) => {
        const providerMatchedItems = group.items.filter(matchesProvider);
        if (providerMatchedItems.length === 0) {
          return null;
        }
        if (!q) {
          return { ...group, items: providerMatchedItems };
        }
        const groupMatches =
          group.displayName.toLowerCase().includes(q) ||
          group.directory.toLowerCase().includes(q);
        const matchedItems = providerMatchedItems.filter((session) => matchesQuery(session, q));
        if (groupMatches) return { ...group, items: providerMatchedItems };
        if (matchedItems.length > 0) return { ...group, items: matchedItems };
        return null;
      })
      .filter((group): group is NonNullable<typeof group> => group !== null);
  }, [groups, query, selectedProviders]);

  const recentSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return dedupeStoredSessionsByIdentity(props.recentSessions)
      .filter((session) => matchesQuery(session, q))
      .sort((a, b) => (b.lastUsedAt ?? b.updatedAt ?? "").localeCompare(a.lastUsedAt ?? a.updatedAt ?? ""));
  }, [props.recentSessions, query]);

  const liveSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...props.liveSessions]
      .filter((session) => liveMatchesQuery(session, q))
      .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
  }, [props.liveSessions, query]);

  useEffect(() => {
    if (query.trim()) {
      setExpandedGroups(new Set(filteredGroups.map((group) => group.directory)));
      setVisibleItemCounts(
        new Map(filteredGroups.map((group) => [group.directory, group.items.length] as const)),
      );
    }
  }, [filteredGroups, query]);

  const toggleGroup = (directory: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(directory)) next.delete(directory);
      else next.add(directory);
      return next;
    });
  };

  const showMoreItems = (directory: string, total: number) => {
    setVisibleItemCounts((prev) => {
      const next = new Map(prev);
      const current = next.get(directory) ?? DEFAULT_GROUP_ITEM_LIMIT;
      next.set(directory, Math.min(total, current + GROUP_ITEM_INCREMENT));
      return next;
    });
  };

  const toggleProvider = (provider: HistoryProviderFilter) => {
    setSelectedProviders((current) => {
      const next = new Set(current);
      if (next.has(provider)) {
        next.delete(provider);
      } else {
        next.add(provider);
      }
      return next;
    });
  };

  const toggleAllProviders = () => {
    setSelectedProviders((current) =>
      current.size === HISTORY_PROVIDER_OPTIONS.length
        ? new Set()
        : new Set(HISTORY_PROVIDER_OPTIONS),
    );
  };

  const renderEmpty = (message: string, detail: string) => (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <History size={32} className="text-[var(--app-hint)] mb-3" />
      <div className="text-sm font-medium text-[var(--app-fg)]">{message}</div>
      <div className="text-xs text-[var(--app-hint)] mt-1">{detail}</div>
    </div>
  );

  return (
    <>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>{props.children}</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[90dvh] max-h-[56rem] w-[92vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none max-[699px]:inset-0 max-[699px]:h-[100dvh] max-[699px]:max-h-[100dvh] max-[699px]:w-screen max-[699px]:max-w-none max-[699px]:translate-x-0 max-[699px]:translate-y-0 max-[699px]:rounded-none max-[699px]:border-0 max-[699px]:pt-[env(safe-area-inset-top)] max-[699px]:pb-[env(safe-area-inset-bottom)]">
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
            <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
              Sessions
            </Dialog.Title>
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

          <div className="px-4 pt-3 pb-2 shrink-0">
            <div className="flex items-center gap-2">
              <div className="grid flex-1 grid-cols-3 gap-2 rounded-lg bg-[var(--app-subtle-bg)] p-1">
                <button
                  type="button"
                  onClick={() => setTab("live")}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    tab === "live"
                      ? "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
                      : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                  }`}
                >
                  Live
                </button>
                <button
                  type="button"
                  onClick={() => setTab("recent")}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    tab === "recent"
                      ? "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
                      : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                  }`}
                >
                  Recent
                </button>
                <button
                  type="button"
                  onClick={() => setTab("all")}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    tab === "all"
                      ? "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
                      : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                  }`}
                >
                  All
                </button>
              </div>
              <HistoryFilterMenu
                sortMode={props.workspaceSortMode}
                onSortModeChange={props.onWorkspaceSortModeChange}
                selectedProviders={selectedProviders}
                onToggleProvider={toggleProvider}
                onToggleAllProviders={toggleAllProviders}
                disabled={tab !== "all"}
              />
            </div>
          </div>

          <div className="px-4 pt-1 pb-2 shrink-0">
            <div className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
              <Search size={14} className="text-[var(--app-hint)] shrink-0" />
              <input
                className="flex-1 bg-transparent text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none"
                placeholder={
                  tab === "live"
                    ? "Search live title, id, provider, or path..."
                    : tab === "recent"
                    ? "Search recent title, id, provider, or path…"
                    : "Search title, preview, id, provider, or path…"
                }
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
            {tab === "live" ? (
              liveSessions.length > 0 ? (
                <div className="space-y-1">
                  {liveSessions.map((summary) => (
                    <LiveSessionRow
                      key={summary.session.id}
                      summary={summary}
                      onActivate={(sessionId) => {
                        props.onActivateLive?.(sessionId);
                        setOpen(false);
                      }}
                    />
                  ))}
                </div>
              ) : renderEmpty(
                query.trim() ? "No matching live sessions" : "No live sessions",
                query.trim()
                  ? "Try a different search term."
                  : "Live sessions will appear here while they are open.",
              )
            ) : tab === "recent" ? (
              recentSessions.length > 0 ? (
                <div className="space-y-1">
                  {recentSessions.map((session) => (
                    <SessionRow
                      key={`recent:${session.provider}:${session.providerSessionId}`}
                      session={session}
                      liveSummary={liveByProviderSessionId.get(sessionIdentityKey(session))}
                      onActivate={(ref) => {
                        props.onActivate(ref);
                        setOpen(false);
                      }}
                      onRequestRemove={setPendingRemoveSession}
                    />
                  ))}
                </div>
              ) : renderEmpty(
                query.trim() ? "No matching recent sessions" : "No recent sessions",
                query.trim()
                  ? "Try a different search term."
                  : "Recently used sessions will appear here.",
              )
            ) : filteredGroups.length > 0 ? (
              <div className="space-y-2">
                {filteredGroups.map((group) => {
                  const isExpanded = expandedGroups.has(group.directory);
                  const visibleCount = visibleItemCounts.get(group.directory) ?? DEFAULT_GROUP_ITEM_LIMIT;
                  const visibleItems = group.items.slice(0, visibleCount);
                  const remainingCount = Math.max(0, group.items.length - visibleItems.length);
                  return (
                    <section
                      key={group.directory}
                      className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.directory)}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-[var(--app-bg)] transition-colors"
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          {isExpanded ? (
                            <ChevronDown size={16} className="text-[var(--app-hint)] shrink-0" />
                          ) : (
                            <ChevronRight size={16} className="text-[var(--app-hint)] shrink-0" />
                          )}
                          <span className="text-sm font-medium truncate text-[var(--app-fg)]">
                            {group.displayName}
                          </span>
                        </div>
                        <div className="flex items-center justify-end gap-3 shrink-0 min-w-0">
                          {group.isWorkspaceGroup ? (
                            <span
                              className="text-xs text-[var(--app-hint)] truncate max-w-[160px] text-right"
                              title={group.directory}
                            >
                              {group.directory}
                            </span>
                          ) : (
                            <span className="text-xs text-[var(--app-hint)]">
                              Missing workspace metadata
                            </span>
                          )}
                          <span className="inline-flex items-center justify-center rounded-full bg-[var(--app-bg)] border border-[var(--app-border)] px-2 py-0.5 text-xs font-medium text-[var(--app-fg)] tabular-nums min-w-[1.5rem]">
                            {group.items.length}
                          </span>
                          {group.isWorkspaceGroup ? (
                            <WorkspaceRemoveButton
                              workspaceDir={group.directory}
                              onRequestRemove={setPendingRemoveWorkspaceDir}
                            />
                          ) : null}
                        </div>
                      </button>

                      {isExpanded ? (
                        <div className="border-t border-[var(--app-border)] px-2 pb-2 pt-1 space-y-1">
                          {visibleItems.map((session) => (
                            <SessionRow
                              key={`${session.provider}:${session.providerSessionId}`}
                              session={session}
                              liveSummary={liveByProviderSessionId.get(sessionIdentityKey(session))}
                              onActivate={(ref) => {
                                props.onActivate(ref);
                                setOpen(false);
                              }}
                              onRequestRemove={setPendingRemoveSession}
                            />
                          ))}
                          {group.items.length > DEFAULT_GROUP_ITEM_LIMIT ? (
                            remainingCount > 0 ? (
                              <button
                                type="button"
                                onClick={() => showMoreItems(group.directory, group.items.length)}
                                className="w-full rounded-lg px-3 py-2 text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                              >
                                Show more
                              </button>
                            ) : null
                          ) : null}
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            ) : renderEmpty(
              query.trim() ? "No matching results" : "No session history",
              query.trim()
                ? "Try a different search term."
                : "Previous live sessions and provider history will appear here.",
            )}
          </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={pendingRemoveSession !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setPendingRemoveSession(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 z-[60]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[90vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none z-[70] flex flex-col">
            <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
              <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
                Delete session?
              </Dialog.Title>
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
            <div className="px-4 py-4 text-sm text-[var(--app-hint)]">
              {pendingRemoveSession ? (
                <>
                  Move{" "}
                  <span className="font-medium text-[var(--app-fg)]">
                    {sessionTitle(pendingRemoveSession)}
                  </span>{" "}
                  to the trash?
                </>
              ) : null}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--app-border)] px-4 py-3">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={() => {
                  if (!pendingRemoveSession) {
                    return;
                  }
                  props.onRemoveSession({
                    provider: pendingRemoveSession.provider,
                    providerSessionId: pendingRemoveSession.providerSessionId,
                  });
                  setPendingRemoveSession(null);
                }}
                className="rounded-lg bg-[var(--app-danger)] px-3 py-2 text-xs font-medium text-white hover:opacity-90 transition-colors"
              >
                Delete
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={pendingRemoveWorkspaceDir !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setPendingRemoveWorkspaceDir(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 z-[60]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[90vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none z-[70] flex flex-col">
            <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
              <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
                Delete workspace sessions?
              </Dialog.Title>
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
            <div className="px-4 py-4 text-sm text-[var(--app-hint)]">
              {pendingRemoveWorkspaceDir ? (
                <>
                  Move all session history in{" "}
                  <span className="font-medium text-[var(--app-fg)]">
                    {pendingRemoveWorkspaceDir}
                  </span>{" "}
                  to the trash?
                </>
              ) : null}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--app-border)] px-4 py-3">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={() => {
                  if (!pendingRemoveWorkspaceDir) {
                    return;
                  }
                  props.onRemoveWorkspace(pendingRemoveWorkspaceDir);
                  setPendingRemoveWorkspaceDir(null);
                }}
                className="rounded-lg bg-[var(--app-danger)] px-3 py-2 text-xs font-medium text-white hover:opacity-90 transition-colors"
              >
                Delete
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function WorkspaceRemoveButton(props: {
  workspaceDir: string;
  onRequestRemove: (workspaceDir: string) => void;
}) {
  const [showRemove, setShowRemove] = useState(false);

  useEffect(() => {
    if (!showRemove) {
      return;
    }
    const timeoutId = window.setTimeout(() => setShowRemove(false), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [showRemove]);

  if (showRemove) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          props.onRequestRemove(props.workspaceDir);
        }}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-danger)] hover:bg-[var(--app-danger-bg)] transition-colors"
        aria-label="Delete workspace sessions"
        title="Delete workspace sessions"
      >
        <X size={14} strokeWidth={2.5} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        setShowRemove(true);
      }}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
      aria-label="More"
      title="More"
    >
      <MoreHorizontal size={14} />
    </button>
  );
}
