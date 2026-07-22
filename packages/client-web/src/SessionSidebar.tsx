import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type { CouncilSnapshot, DebugScenarioDescriptor, StoredSessionRef } from "@rah/runtime-protocol";
import type { WorkspaceSection, WorkspaceSortMode } from "./session-browser";
import {
  Check,
  Archive,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  ListFilter,
  MoreHorizontal,
  Pencil,
  Pin,
  PlusCircle,
  SquarePen,
  X,
} from "lucide-react";
import { readWorkspaceGitStatus } from "./api";
import { ProviderLogo } from "./components/ProviderLogo";
import { CouncilLogo } from "./components/CouncilLogo";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { SIDEBAR_LAYOUT } from "./sidebar-layout-contract";
import {
  deriveSidebarCouncilViewModels,
  deriveSidebarWorkspaceViewModels,
  partitionSidebarPinnedItems,
  type SidebarCouncilViewModel,
  type SidebarActivityStatus,
  type SidebarPinnedItemRef,
  type SidebarWorkspaceViewModel,
} from "./sidebar-view-model";
import { COUNCIL_ACCENT_TITLE_CLASSNAME } from "./council/council-theme";

const sessionWorkspaceBranchCache = new Map<string, string | null>();
const sessionWorkspaceBranchRequests = new Map<string, Promise<string | null>>();

function loadSessionWorkspaceBranch(workspaceDir: string): Promise<string | null> {
  if (sessionWorkspaceBranchCache.has(workspaceDir)) {
    return Promise.resolve(sessionWorkspaceBranchCache.get(workspaceDir) ?? null);
  }
  const existing = sessionWorkspaceBranchRequests.get(workspaceDir);
  if (existing) {
    return existing;
  }
  const request = readWorkspaceGitStatus(workspaceDir)
    .then((status) => status.branch?.trim() || null)
    .catch(() => null)
    .then((branch) => {
      sessionWorkspaceBranchCache.set(workspaceDir, branch);
      sessionWorkspaceBranchRequests.delete(workspaceDir);
      return branch;
    });
  sessionWorkspaceBranchRequests.set(workspaceDir, request);
  return request;
}

function supportsDesktopHover(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function FadingSingleLineText(props: { children: string; className: string }) {
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = titleRef.current;
    if (!element) {
      return;
    }
    const update = () => {
      setOverflowing(element.scrollWidth > element.clientWidth + 1);
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.children]);

  return (
    <span
      ref={titleRef}
      className={`${props.className} ${
        overflowing
          ? "[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]"
          : ""
      }`}
    >
      {props.children}
    </span>
  );
}

function FadingTooltipTitle(props: { children: string }) {
  return (
    <FadingSingleLineText className="block min-w-0 overflow-hidden whitespace-nowrap text-[14px] font-medium text-[var(--app-fg)]">
      {props.children}
    </FadingSingleLineText>
  );
}

function SidebarStatusIndicator(props: { status: SidebarActivityStatus }) {
  const label = props.status === "running"
    ? "Running"
    : props.status === "working"
      ? "Working"
      : props.status === "unread"
        ? "Unread completed turn"
        : props.status === "error"
          ? "Error"
          : "Stopped";
  return (
    <span
      className={SIDEBAR_LAYOUT.sessionStatusSlotClassName}
      aria-label={props.status === "stopped" ? undefined : label}
      title={props.status === "stopped" ? undefined : label}
    >
      {props.status === "working" ? (
        <span className="h-2.5 w-2.5 animate-spin rounded-full border border-current border-r-transparent text-[var(--app-hint)]" />
      ) : props.status === "unread" ? (
        <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
      ) : props.status === "error" ? (
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      ) : props.status === "running" ? (
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      ) : null}
    </span>
  );
}

function SessionRowTooltip(props: {
  anchor: HTMLDivElement | null;
  id: string;
  open: boolean;
  session: SidebarWorkspaceViewModel["sessions"][number];
  onRequestClose: () => void;
}) {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({});
  const [branch, setBranch] = useState<string | null>(
    () => sessionWorkspaceBranchCache.get(props.session.workspaceDir) ?? null,
  );

  useLayoutEffect(() => {
    if (!props.open || !props.anchor) {
      return;
    }
    const anchorRect = props.anchor.getBoundingClientRect();
    const width = Math.min(320, Math.max(220, window.innerWidth - 16));
    const height = tooltipRef.current?.getBoundingClientRect().height ?? 112;
    const preferredLeft = anchorRect.right + 10;
    const left = preferredLeft + width <= window.innerWidth - 8
      ? preferredLeft
      : Math.max(8, anchorRect.left - width - 10);
    const top = Math.min(
      Math.max(8, anchorRect.top - 8),
      Math.max(8, window.innerHeight - height - 8),
    );
    setStyle({ left, top, width });
  }, [props.anchor, props.open, branch]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    let active = true;
    void loadSessionWorkspaceBranch(props.session.workspaceDir).then((nextBranch) => {
      if (active) {
        setBranch(nextBranch);
      }
    });
    const close = () => props.onRequestClose();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      active = false;
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [props.onRequestClose, props.open, props.session.workspaceDir]);

  if (!props.open) {
    return null;
  }

  return createPortal(
    <div
      ref={tooltipRef}
      id={props.id}
      role="tooltip"
      style={style}
      className="pointer-events-none fixed z-[120] rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-3 text-sm shadow-xl"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
        <FadingTooltipTitle>{props.session.title}</FadingTooltipTitle>
        <span className="shrink-0 text-[12px] tabular-nums text-[var(--app-hint)]">
          {props.session.updatedAtLabel}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[13px] text-[var(--app-fg)]/90">
        <Folder size={15} className="shrink-0 text-[var(--app-hint)]" />
        <span className="min-w-0 truncate">{props.session.workspaceLabel}</span>
      </div>
      {branch ? (
        <div className="mt-2 flex items-center gap-2 text-[13px] text-[var(--app-fg)]/90">
          <GitBranch size={15} className="shrink-0 text-[var(--app-hint)]" />
          <span className="min-w-0 truncate">{branch}</span>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function WorkspaceSortMenu(props: {
  value: WorkspaceSortMode;
  onChange: (value: WorkspaceSortMode) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
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
    { value: "created", label: "Created" },
    { value: "updated", label: "Updated" },
  ];

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        className={SIDEBAR_LAYOUT.toolbarIconButtonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="排序"
        title="排序"
        onClick={() => setOpen((current) => !current)}
      >
        <ListFilter size={14} />
      </button>

      {open ? (
        <div className={SIDEBAR_LAYOUT.sortMenuClassName}>
          {sortOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={SIDEBAR_LAYOUT.sortMenuItemClassName}
              onClick={() => {
                props.onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="flex items-center gap-2">
                {option.value === "created" ? <PlusCircle size={14} className="text-[var(--app-hint)]" /> : <Pencil size={14} className="text-[var(--app-hint)]" />}
                <span>{option.label}</span>
              </span>
              <span className="inline-flex h-4 w-4 items-center justify-center text-[var(--app-hint)]">
                {props.value === option.value ? <Check size={14} /> : null}
              </span>
            </button>
          ))}
          <div className="my-1 h-px bg-[var(--app-border)]" />
          <button
            type="button"
            className={SIDEBAR_LAYOUT.sortMenuActionClassName}
            onClick={() => {
              props.onExpandAll();
              setOpen(false);
            }}
          >
            <ChevronDown size={14} className="text-[var(--app-hint)]" />
            <span>全部展开</span>
          </button>
          <button
            type="button"
            className={SIDEBAR_LAYOUT.sortMenuActionClassName}
            onClick={() => {
              props.onCollapseAll();
              setOpen(false);
            }}
          >
            <ChevronUp size={14} className="text-[var(--app-hint)]" />
            <span>全部折叠</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RunningSessionRow(props: {
  session: SidebarWorkspaceViewModel["sessions"][number];
  draggable: boolean;
  onTogglePin: () => void;
  onArchive: () => void;
  onSelect: () => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const tooltipId = useId();
  const tooltipTimerRef = useRef<number | null>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const titleClassName =
    props.session.originKind === "council"
      ? `${SIDEBAR_LAYOUT.sessionTitleClassName} ${COUNCIL_ACCENT_TITLE_CLASSNAME}`
      : SIDEBAR_LAYOUT.sessionTitleClassName;
  const rowClassName = `${SIDEBAR_LAYOUT.sessionRowBaseClassName} ${
    props.session.selected
      ? SIDEBAR_LAYOUT.sessionRowSelectedClassName
      : SIDEBAR_LAYOUT.sessionRowIdleClassName
  }`;
  const actionCount = Number(props.session.archivable) + 1;
  const selectButtonClassName = `${SIDEBAR_LAYOUT.sessionTitleOnlySelectButtonClassName} ${
    actionCount > 1
      ? SIDEBAR_LAYOUT.sessionDualActionPaddingClassName
      : actionCount === 1
        ? SIDEBAR_LAYOUT.sessionSingleActionPaddingClassName
        : ""
  } ${props.session.pinned ? SIDEBAR_LAYOUT.sessionPinnedActionPaddingClassName : ""}`;

  const clearTooltipTimer = () => {
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
  };
  const openTooltip = (delayed: boolean) => {
    if (!supportsDesktopHover()) {
      return;
    }
    clearTooltipTimer();
    if (!delayed) {
      setTooltipOpen(true);
      return;
    }
    tooltipTimerRef.current = window.setTimeout(() => {
      tooltipTimerRef.current = null;
      setTooltipOpen(true);
    }, 320);
  };
  const closeTooltip = () => {
    clearTooltipTimer();
    setTooltipOpen(false);
  };

  useEffect(() => () => clearTooltipTimer(), []);

  return (
    <div
      ref={rowRef}
      className={rowClassName}
      draggable={props.draggable}
      onMouseEnter={() => openTooltip(true)}
      onMouseLeave={closeTooltip}
      onFocusCapture={() => openTooltip(false)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          closeTooltip();
        }
      }}
      onDragStart={(event) => {
        if (!props.draggable) {
          return;
        }
        event.dataTransfer.setData("application/x-rah-session-id", props.session.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className={SIDEBAR_LAYOUT.sessionInlineRowClassName}>
        <button
          type="button"
          onClick={props.onSelect}
          className={selectButtonClassName}
          aria-describedby={tooltipOpen ? tooltipId : undefined}
        >
          <span className={SIDEBAR_LAYOUT.sessionIconSlotClassName}>
            <ProviderLogo
              provider={props.session.provider}
              className={SIDEBAR_LAYOUT.sessionIconClassName}
              variant="bare"
            />
          </span>
          <SidebarStatusIndicator status={props.session.status} />
          <FadingSingleLineText className={titleClassName}>
            {props.session.title}
          </FadingSingleLineText>
        </button>
        <div className={SIDEBAR_LAYOUT.sessionActionSlotClassName}>
          <button
            type="button"
            onClick={props.onTogglePin}
            className={`${SIDEBAR_LAYOUT.sessionActionButtonClassName} ${
              props.session.pinned
                ? SIDEBAR_LAYOUT.sessionPinActiveClassName
                : SIDEBAR_LAYOUT.sessionPinHiddenClassName
            }`}
            title={props.session.pinned ? "Unpin" : "Pin"}
            aria-label={props.session.pinned ? "Unpin session" : "Pin session"}
          >
            <Pin size={14} className={props.session.pinned ? "fill-current" : ""} />
          </button>
          {props.session.archivable ? (
            <button
              type="button"
              onClick={props.onArchive}
              className={`${SIDEBAR_LAYOUT.sessionActionButtonClassName} ${SIDEBAR_LAYOUT.sessionPinHiddenClassName}`}
              title="Archive"
              aria-label="Archive session"
            >
              <Archive size={14} />
            </button>
          ) : null}
        </div>
      </div>
      <SessionRowTooltip
        anchor={rowRef.current}
        id={tooltipId}
        open={tooltipOpen}
        session={props.session}
        onRequestClose={closeTooltip}
      />
    </div>
  );
}

function CouncilRow(props: {
  council: SidebarCouncilViewModel;
  draggable: boolean;
  onSelect: () => void;
}) {
  const rowClassName = `${SIDEBAR_LAYOUT.sessionRowBaseClassName} ${
    props.council.selected
      ? SIDEBAR_LAYOUT.sessionRowSelectedClassName
      : SIDEBAR_LAYOUT.sessionRowIdleClassName
  }`;
  const selectButtonClassName = SIDEBAR_LAYOUT.sessionTitleOnlySelectButtonClassName;

  return (
    <div
      className={rowClassName}
      draggable={props.draggable}
      onDragStart={(event) => {
        if (!props.draggable) {
          return;
        }
        event.dataTransfer.setData("application/x-rah-council-id", props.council.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className={SIDEBAR_LAYOUT.sessionInlineRowClassName}>
        <button
          type="button"
          onClick={props.onSelect}
          className={selectButtonClassName}
        >
          <span className={SIDEBAR_LAYOUT.sessionIconSlotClassName}>
            <CouncilLogo className={SIDEBAR_LAYOUT.sessionIconClassName} tone="black" variant="bare" />
          </span>
          <SidebarStatusIndicator status={props.council.status} />
          <FadingSingleLineText
            className={`${SIDEBAR_LAYOUT.sessionTitleClassName} ${COUNCIL_ACCENT_TITLE_CLASSNAME}`}
          >
            {props.council.title}
          </FadingSingleLineText>
        </button>
      </div>
    </div>
  );
}

function WorkspaceRow(props: {
  workspace: SidebarWorkspaceViewModel;
  enableSessionDrag: boolean;
  onRemoveWorkspace: () => void;
  onTogglePinSession: (itemKey: string) => void;
  onSelectSession: (session: SidebarWorkspaceViewModel["sessions"][number]) => void;
  onArchiveSession: (session: SidebarWorkspaceViewModel["sessions"][number]) => void;
  onSelectWorkspace: () => void;
  expandAllKey: number;
  expandAllValue: boolean;
}) {
  const [showRemove, setShowRemove] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const itemsId = useId();
  const hasItems = props.workspace.items.length > 0;
  const workspaceRemovalBlocked = props.workspace.hasBlockingRunningSessions;
  const workspaceRemovalLabel = workspaceRemovalBlocked
    ? "Cannot remove a workspace with running sessions"
    : "Remove workspace";
  const toggleExpanded = () => setExpanded((v) => !v);

  useEffect(() => {
    if (!showRemove) {
      return;
    }
    const timeoutId = window.setTimeout(() => setShowRemove(false), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [showRemove]);

  useEffect(() => {
    setExpanded(props.expandAllValue);
  }, [props.expandAllKey]);

  return (
    <div className={SIDEBAR_LAYOUT.workspaceBlockClassName}>
      {/* Workspace header */}
      <div
        className={SIDEBAR_LAYOUT.workspaceHeaderClassName}
      >
        <button
          type="button"
          onClick={toggleExpanded}
          className={SIDEBAR_LAYOUT.workspaceDisclosureButtonClassName}
          title={expanded ? "Collapse workspace" : "Expand workspace"}
          aria-expanded={expanded}
          aria-controls={hasItems ? itemsId : undefined}
          aria-current={props.workspace.selected ? "location" : undefined}
        >
          <span className={SIDEBAR_LAYOUT.workspaceDisclosureIconClassName}>
            {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
          </span>
          <span className={SIDEBAR_LAYOUT.workspaceDisclosureTitleClassName}>
            {props.workspace.displayName}
          </span>
        </button>
        <div
          className={`${SIDEBAR_LAYOUT.workspaceActionSlotClassName} ${
            showRemove ? "opacity-100 pointer-events-auto" : SIDEBAR_LAYOUT.workspaceActionHiddenClassName
          }`}
        >
          {showRemove ? (
            <button
              type="button"
              aria-disabled={workspaceRemovalBlocked}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (workspaceRemovalBlocked) {
                  return;
                }
                props.onRemoveWorkspace();
              }}
              className={`${SIDEBAR_LAYOUT.workspaceActionButtonClassName} ${
                workspaceRemovalBlocked
                  ? SIDEBAR_LAYOUT.workspaceActionDisabledClassName
                  : SIDEBAR_LAYOUT.workspaceActionDangerClassName
              }`}
              aria-label={workspaceRemovalLabel}
              title={workspaceRemovalLabel}
            >
              <X size={12} strokeWidth={2.5} />
            </button>
          ) : (
            <button
              type="button"
              className={SIDEBAR_LAYOUT.workspaceActionButtonClassName}
              onClick={(e) => {
                e.stopPropagation();
                setShowRemove(true);
              }}
              title="More"
            >
              <MoreHorizontal size={14} />
            </button>
          )}
          <button
            type="button"
            className={SIDEBAR_LAYOUT.workspaceActionButtonClassName}
            onClick={(event) => {
              event.stopPropagation();
              props.onSelectWorkspace();
            }}
            aria-label="New task in workspace"
            title="New task in workspace"
          >
            <SquarePen size={14} />
          </button>
        </div>
      </div>

      {/* Running workspace items */}
      {hasItems && expanded ? (
        <div id={itemsId} className={SIDEBAR_LAYOUT.sessionListClassName}>
          {props.workspace.items.map((item) => (
            <RunningSessionRow
              key={item.stableKey}
              session={item}
              draggable={props.enableSessionDrag && item.running}
              onTogglePin={() => props.onTogglePinSession(item.pinItemKey)}
              onArchive={() => props.onArchiveSession(item)}
              onSelect={() => props.onSelectSession(item)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SessionSidebar(props: {
  workspaceSections: WorkspaceSection[];
  storedSessions: readonly StoredSessionRef[];
  workspaceSortMode: WorkspaceSortMode;
  onWorkspaceSortModeChange: (value: WorkspaceSortMode) => void;
  runningSessionActivityAtById?: ReadonlyMap<string, string> | undefined;
  pinnedItems: readonly SidebarPinnedItemRef[];
  onTogglePinSession: (workspaceDir: string, itemKey: string) => void;
  onAddWorkspace: (value: string) => void;
  onRemoveWorkspace: (value: string) => void;
  selectedWorkspaceDir: string;
  selectedSessionId: string | null;
  selectedStoredSessionKey?: string | null;
  selectedCouncilId?: string | null;
  unreadSessionIds: ReadonlySet<string>;
  runtimeStatusBySessionId: ReadonlyMap<
    string,
    "thinking" | "streaming" | "stopping" | "retrying" | undefined
  >;
  erroredSessionIds?: ReadonlySet<string>;
  unreadCouncilIds?: ReadonlySet<string>;
  onSelectSession: (workspaceDir: string, sessionId: string) => void;
  onSelectStoredSession: (workspaceDir: string, session: StoredSessionRef) => void;
  onArchiveRunningSession: (sessionId: string) => void;
  onArchiveStoredSession: (session: StoredSessionRef) => void;
  onSelectCouncil?: (workspaceDir: string, councilId: string) => void;
  onSelectWorkspace: (workspaceDir: string) => void;
  enableSessionDrag?: boolean;
  enableCouncilDrag?: boolean;
  councils?: readonly CouncilSnapshot[];
  debugScenarios: DebugScenarioDescriptor[];
  onStartScenario: (scenario: DebugScenarioDescriptor) => void;
}) {
  const [expandAllKey, setExpandAllKey] = useState(0);
  const [expandAllValue, setExpandAllValue] = useState(true);
  const workspaceViewModels = useMemo(
    () =>
      deriveSidebarWorkspaceViewModels({
        workspaceSections: props.workspaceSections,
        storedSessions: props.storedSessions,
        selectedWorkspaceDir: props.selectedWorkspaceDir,
        selectedSessionId: props.selectedSessionId,
        selectedStoredSessionKey: props.selectedStoredSessionKey ?? null,
        unreadSessionIds: props.unreadSessionIds,
        runtimeStatusBySessionId: props.runtimeStatusBySessionId,
        erroredSessionIds: props.erroredSessionIds,
        pinnedItems: props.pinnedItems,
        runningSessionActivityAtById: props.runningSessionActivityAtById,
        selectedCouncilId: props.selectedCouncilId ?? null,
      }),
    [
      props.pinnedItems,
      props.runtimeStatusBySessionId,
      props.erroredSessionIds,
      props.runningSessionActivityAtById,
      props.selectedCouncilId,
      props.selectedSessionId,
      props.selectedStoredSessionKey,
      props.selectedWorkspaceDir,
      props.unreadSessionIds,
      props.workspaceSections,
      props.storedSessions,
    ],
  );
  const councilItems = useMemo(
    () =>
      deriveSidebarCouncilViewModels({
        councils: props.councils ?? [],
        workspaceSections: props.workspaceSections,
        selectedCouncilId: props.selectedCouncilId ?? null,
        unreadCouncilIds: props.unreadCouncilIds,
      }),
    [
      props.councils,
      props.selectedCouncilId,
      props.unreadCouncilIds,
      props.workspaceSections,
    ],
  );
  const sidebarPartition = useMemo(
    () => partitionSidebarPinnedItems(workspaceViewModels, props.pinnedItems),
    [props.pinnedItems, workspaceViewModels],
  );
  const workspaceCount = sidebarPartition.workspaces.length;
  const sessionCount = workspaceViewModels.reduce(
    (count, workspace) => count + workspace.sessions.length,
    0,
  );
  const runningSessionCount = workspaceViewModels.reduce(
    (count, workspace) => count + workspace.sessions.filter((session) => session.running).length,
    0,
  );
  const expandAll = () => {
    setExpandAllValue(true);
    setExpandAllKey((k) => k + 1);
  };

  const collapseAll = () => {
    setExpandAllValue(false);
    setExpandAllKey((k) => k + 1);
  };

  return (
    <div className={SIDEBAR_LAYOUT.rootClassName}>
      {sidebarPartition.pinnedItems.length > 0 ? (
        <div className={SIDEBAR_LAYOUT.pinnedSectionClassName}>
          <div className={SIDEBAR_LAYOUT.pinnedHeaderClassName}>Pinned</div>
          <div className={SIDEBAR_LAYOUT.pinnedListClassName}>
            {sidebarPartition.pinnedItems.map(({ workspaceDir, item }) => (
              <RunningSessionRow
                key={`${workspaceDir}:${item.stableKey}`}
                session={item}
                draggable={props.enableSessionDrag === true && item.running}
                onTogglePin={() => props.onTogglePinSession(workspaceDir, item.pinItemKey)}
                onArchive={() => {
                  if (item.runtimeSessionId) {
                    props.onArchiveRunningSession(item.runtimeSessionId);
                  } else if (item.storedRef) {
                    props.onArchiveStoredSession(item.storedRef);
                  }
                }}
                onSelect={() => {
                  if (item.runtimeSessionId) {
                    props.onSelectSession(workspaceDir, item.runtimeSessionId);
                  } else if (item.storedRef) {
                    props.onSelectStoredSession(workspaceDir, item.storedRef);
                  }
                }}
              />
            ))}
          </div>
        </div>
      ) : null}

      {councilItems.length > 0 ? (
        <section
          className={SIDEBAR_LAYOUT.councilSectionClassName}
          aria-label="Running Councils"
          data-sidebar-council-section
        >
          <div className={SIDEBAR_LAYOUT.councilHeaderClassName}>
            <span>Councils</span>
            <span
              className={SIDEBAR_LAYOUT.councilCountClassName}
              title={`${councilItems.length} running Councils`}
            >
              {councilItems.length}
            </span>
          </div>
          <div className={SIDEBAR_LAYOUT.councilListClassName}>
            {councilItems.map((item) => (
              <CouncilRow
                key={item.stableKey}
                council={item}
                draggable={props.enableCouncilDrag === true}
                onSelect={() => props.onSelectCouncil?.(item.workspaceDir, item.id)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* Toolbar */}
      <div className={SIDEBAR_LAYOUT.toolbarClassName}>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={SIDEBAR_LAYOUT.toolbarLabelClassName} title="Workspaces">
            <span className={SIDEBAR_LAYOUT.toolbarLabelFullClassName}>Workspaces</span>
            <span className={SIDEBAR_LAYOUT.toolbarLabelShortClassName}>WS</span>
          </span>
          <span
            className={SIDEBAR_LAYOUT.toolbarCountBadgeClassName}
            title={`${workspaceCount} workspaces`}
          >
            {workspaceCount}
          </span>
          <span
            className={SIDEBAR_LAYOUT.toolbarCountBadgeClassName}
            title={`${sessionCount} sessions · ${runningSessionCount} running`}
          >
            {sessionCount}
          </span>
        </div>
        <div className={SIDEBAR_LAYOUT.toolbarActionsClassName}>
          <WorkspaceSortMenu
            value={props.workspaceSortMode}
            onChange={props.onWorkspaceSortModeChange}
            onExpandAll={expandAll}
            onCollapseAll={collapseAll}
          />
          <WorkspacePicker
            currentDir=""
            triggerLabel=""
            triggerIcon={<FolderPlus size={14} />}
            triggerClassName={SIDEBAR_LAYOUT.toolbarIconButtonClassName}
            onSelect={props.onAddWorkspace}
          />
        </div>
      </div>

      {/* Workspace list */}
      <div className={SIDEBAR_LAYOUT.workspaceListClassName}>
        {sidebarPartition.workspaces.map((workspace) => (
          <WorkspaceRow
            key={workspace.directory}
            workspace={workspace}
            enableSessionDrag={props.enableSessionDrag === true}
            onRemoveWorkspace={() => props.onRemoveWorkspace(workspace.directory)}
            onTogglePinSession={(itemKey) =>
              props.onTogglePinSession(workspace.directory, itemKey)
            }
            onSelectSession={(session) => {
              if (session.runtimeSessionId) {
                props.onSelectSession(workspace.directory, session.runtimeSessionId);
              } else if (session.storedRef) {
                props.onSelectStoredSession(workspace.directory, session.storedRef);
              }
            }}
            onArchiveSession={(session) => {
              if (session.runtimeSessionId) {
                props.onArchiveRunningSession(session.runtimeSessionId);
              } else if (session.storedRef) {
                props.onArchiveStoredSession(session.storedRef);
              }
            }}
            onSelectWorkspace={() => props.onSelectWorkspace(workspace.directory)}
            expandAllKey={expandAllKey}
            expandAllValue={expandAllValue}
          />
        ))}
      </div>

      {/* Debug scenarios */}
      {props.debugScenarios.length > 0 ? (
        <div className={SIDEBAR_LAYOUT.labSectionClassName}>
          <div className={SIDEBAR_LAYOUT.labHeaderClassName}>
            <span className={SIDEBAR_LAYOUT.labHeaderLabelClassName}>Lab</span>
          </div>
          <div className={SIDEBAR_LAYOUT.labListClassName}>
            {props.debugScenarios.map((scenario) => (
              <button
                key={scenario.id}
                type="button"
                onClick={() => props.onStartScenario(scenario)}
                className={SIDEBAR_LAYOUT.labButtonClassName}
              >
                <span className={SIDEBAR_LAYOUT.labTitleClassName}>
                  {scenario.label}
                </span>
                <div className={SIDEBAR_LAYOUT.labDescriptionClassName}>
                  {scenario.description}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
