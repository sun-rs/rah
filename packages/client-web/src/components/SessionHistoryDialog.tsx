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
} from "../session-history-grouping";

const DEFAULT_GROUP_ITEM_LIMIT = 10;
const GROUP_ITEM_INCREMENT = 20;

type HistoryTab = "recent" | "all";

function WorkspaceSortMenu(props: {
  value: WorkspaceSortMode;
  onChange: (value: WorkspaceSortMode) => void;
}) {
  const [open, setOpen] = useState(false);

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

  const sortOptions: Array<{ value: WorkspaceSortMode; label: string }> = [
    { value: "created", label: "按创建顺序" },
    { value: "updated", label: "按最近更新" },
  ];

  return (
    <div className="relative" data-history-sort-menu>
      <button
        type="button"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="排序 workspace"
        title="排序 workspace"
        onClick={() => setOpen((current) => !current)}
      >
        <ListFilter size={14} />
      </button>
      {open ? (
        <div className="absolute right-0 top-9 z-10 min-w-44 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg">
          {sortOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
              onClick={() => {
                props.onChange(option.value);
                setOpen(false);
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
                {props.value === option.value ? <Check size={14} /> : null}
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

function SessionRow(props: {
  session: StoredSessionRef;
  liveSummary: SessionSummary | undefined;
  onActivate: (ref: StoredSessionRef) => void;
  onRequestRemove: (ref: StoredSessionRef) => void;
}) {
  const badge = sourceBadge(props.session);
  const live = props.liveSummary !== undefined;
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
  onRemoveSession: (ref: Pick<StoredSessionRef, "provider" | "providerSessionId">) => void;
  onRemoveWorkspace: (workspaceDir: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<HistoryTab>("recent");
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [visibleItemCounts, setVisibleItemCounts] = useState<Map<string, number>>(new Map());
  const [pendingRemoveSession, setPendingRemoveSession] = useState<StoredSessionRef | null>(null);
  const [pendingRemoveWorkspaceDir, setPendingRemoveWorkspaceDir] = useState<string | null>(null);

  const liveByProviderSessionId = useMemo(
    () =>
      new Map(
        props.liveSessions
          .filter((session) => session.session.providerSessionId)
          .map((session) => [session.session.providerSessionId!, session]),
      ),
    [props.liveSessions],
  );

  const groups = useMemo(
    () =>
      groupAllStoredSessionsByDirectory(props.storedSessions, {
        workspaceSortMode: props.workspaceSortMode,
      }),
    [props.storedSessions, props.workspaceSortMode],
  );

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => {
        const groupMatches =
          group.displayName.toLowerCase().includes(q) ||
          group.directory.toLowerCase().includes(q);
        const matchedItems = group.items.filter((session) => matchesQuery(session, q));
        if (groupMatches) return group;
        if (matchedItems.length > 0) return { ...group, items: matchedItems };
        return null;
      })
      .filter((group): group is NonNullable<typeof group> => group !== null);
  }, [groups, query]);

  const recentSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return dedupeStoredSessionsByIdentity(props.recentSessions)
      .filter((session) => matchesQuery(session, q))
      .sort((a, b) => (b.lastUsedAt ?? b.updatedAt ?? "").localeCompare(a.lastUsedAt ?? a.updatedAt ?? ""));
  }, [props.recentSessions, query]);

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
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[90vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none max-md:inset-0 max-md:h-[100dvh] max-md:max-h-[100dvh] max-md:w-screen max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]">
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
            <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
              Session History
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
              <div className="grid flex-1 grid-cols-2 gap-2 rounded-lg bg-[var(--app-subtle-bg)] p-1">
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
              {tab === "all" ? (
                <WorkspaceSortMenu
                  value={props.workspaceSortMode}
                  onChange={props.onWorkspaceSortModeChange}
                />
              ) : null}
            </div>
          </div>

          <div className="px-4 pt-1 pb-2 shrink-0">
            <div className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
              <Search size={14} className="text-[var(--app-hint)] shrink-0" />
              <input
                className="flex-1 bg-transparent text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none"
                placeholder={tab === "recent" ? "Filter recent sessions…" : "Filter workspaces or sessions…"}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
            {tab === "recent" ? (
              recentSessions.length > 0 ? (
                <div className="space-y-1">
                  {recentSessions.map((session) => (
                    <SessionRow
                      key={`recent:${session.provider}:${session.providerSessionId}`}
                      session={session}
                      liveSummary={liveByProviderSessionId.get(session.providerSessionId)}
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
                              liveSummary={liveByProviderSessionId.get(session.providerSessionId)}
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
