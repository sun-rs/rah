import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
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
import {
  reconcileSidebarSectionOrder,
  sidebarCouncilOrderKey,
  sidebarPinnedOrderKey,
  type SidebarDropPosition,
} from "./sidebar-section-order";

const sessionWorkspaceBranchCache = new Map<string, string | null>();
const sessionWorkspaceBranchRequests = new Map<string, Promise<string | null>>();
const PINNED_SIDEBAR_DRAG_TYPE = "application/x-rah-sidebar-pinned-order-key";
const COUNCIL_SIDEBAR_DRAG_TYPE = "application/x-rah-sidebar-council-order-key";
const SIDEBAR_POINTER_FOCUS_ATTRIBUTE = "data-sidebar-pointer-focus";

function markSidebarPointerFocus(event: ReactPointerEvent<HTMLDivElement>) {
  event.currentTarget.setAttribute(SIDEBAR_POINTER_FOCUS_ATTRIBUTE, "true");
}

function clearSidebarPointerFocusForKeyboard(
  event: ReactKeyboardEvent<HTMLDivElement>,
) {
  if (event.key === "Tab") {
    event.currentTarget.removeAttribute(SIDEBAR_POINTER_FOCUS_ATTRIBUTE);
  }
}

function clearSidebarPointerFocusAfterBlur(
  event: ReactFocusEvent<HTMLDivElement>,
) {
  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
    event.currentTarget.removeAttribute(SIDEBAR_POINTER_FOCUS_ATTRIBUTE);
  }
}

type SidebarReorderBinding = {
  itemKey: string;
  mimeType: string;
  onMove: (
    sourceKey: string,
    targetKey: string,
    position: SidebarDropPosition,
  ) => void;
};

function transferIncludes(
  event: ReactDragEvent<HTMLDivElement>,
  mimeType: string,
): boolean {
  return Array.from(event.dataTransfer.types).includes(mimeType);
}

function useSidebarReorderDropTarget(binding: SidebarReorderBinding | undefined) {
  const [dropPosition, setDropPosition] = useState<SidebarDropPosition | null>(null);

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!binding || !transferIncludes(event, binding.mimeType)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    setDropPosition(
      event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    );
  };

  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    setDropPosition(null);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!binding || !transferIncludes(event, binding.mimeType)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const sourceKey = event.dataTransfer.getData(binding.mimeType);
    const bounds = event.currentTarget.getBoundingClientRect();
    const position =
      dropPosition ??
      (event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
    setDropPosition(null);
    if (sourceKey) {
      binding.onMove(sourceKey, binding.itemKey, position);
    }
  };

  return {
    clearDropPosition: () => setDropPosition(null),
    dropPosition,
    onDragLeave,
    onDragOver,
    onDrop,
  };
}

function SidebarDropIndicator(props: { position: SidebarDropPosition | null }) {
  if (!props.position) {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute left-1 right-1 z-[3] flex items-center ${
        props.position === "before" ? "-top-1" : "-bottom-1"
      }`}
    >
      <span className="h-2 w-2 shrink-0 rounded-full border-2 border-[var(--app-focus)] bg-[var(--app-bg)]" />
      <span className="h-0.5 min-w-0 flex-1 rounded-full bg-[var(--app-focus)]" />
    </span>
  );
}

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
      className={`${props.className} ${overflowing ? "rah-sidebar-fade-end" : ""}`}
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
  if (props.status === "stopped") {
    return null;
  }
  const label = props.status === "running"
    ? "Running"
    : props.status === "working"
      ? "Working"
      : props.status === "unread"
        ? "Unread completed turn"
        : "Error";
  return (
    <span
      className={SIDEBAR_LAYOUT.sessionStatusSlotClassName}
      aria-label={label}
      title={label}
    >
      {props.status === "working" ? (
        <span className="h-2.5 w-2.5 animate-spin rounded-full border border-current border-r-transparent text-[var(--app-hint)]" />
      ) : props.status === "unread" ? (
        <span className="h-2 w-2 rounded-full bg-sky-500" />
      ) : props.status === "error" ? (
        <span className="h-2 w-2 rounded-full bg-red-500" />
      ) : props.status === "running" ? (
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
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
  canvasDraggable: boolean;
  reorder?: SidebarReorderBinding;
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
  const selectButtonClassName = SIDEBAR_LAYOUT.sessionTitleOnlySelectButtonClassName;
  const actionGroupClassName = `${SIDEBAR_LAYOUT.sessionActionGroupBaseClassName} ${
    props.session.archivable
      ? SIDEBAR_LAYOUT.sessionDualActionHiddenGroupClassName
      : SIDEBAR_LAYOUT.sessionSingleActionHiddenGroupClassName
  }`;
  const reorderDropTarget = useSidebarReorderDropTarget(props.reorder);
  const draggable = props.canvasDraggable || props.reorder !== undefined;

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
      data-sidebar-session-id={props.session.id}
      data-sidebar-session-provider={props.session.provider}
      draggable={draggable}
      data-sidebar-reorder-key={props.reorder?.itemKey}
      data-sidebar-drop-position={reorderDropTarget.dropPosition ?? undefined}
      onPointerDownCapture={markSidebarPointerFocus}
      onKeyDownCapture={clearSidebarPointerFocusForKeyboard}
      onMouseEnter={() => openTooltip(true)}
      onMouseLeave={closeTooltip}
      onFocusCapture={() => openTooltip(false)}
      onBlurCapture={(event) => {
        clearSidebarPointerFocusAfterBlur(event);
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          closeTooltip();
        }
      }}
      onDragStart={(event) => {
        if (!draggable) {
          return;
        }
        closeTooltip();
        if (props.canvasDraggable) {
          event.dataTransfer.setData("application/x-rah-session-id", props.session.id);
        }
        if (props.reorder) {
          event.dataTransfer.setData(props.reorder.mimeType, props.reorder.itemKey);
        }
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={reorderDropTarget.onDragOver}
      onDragLeave={reorderDropTarget.onDragLeave}
      onDrop={reorderDropTarget.onDrop}
      onDragEnd={reorderDropTarget.clearDropPosition}
    >
      <SidebarDropIndicator position={reorderDropTarget.dropPosition} />
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
          <FadingSingleLineText className={titleClassName}>
            {props.session.title}
          </FadingSingleLineText>
        </button>
        <div className={SIDEBAR_LAYOUT.sessionActionSlotClassName}>
          <SidebarStatusIndicator status={props.session.status} />
          <span className={actionGroupClassName}>
            <span className={SIDEBAR_LAYOUT.sessionActionCellClassName}>
              <button
                type="button"
                onClick={props.onTogglePin}
                className={`${SIDEBAR_LAYOUT.sessionActionButtonClassName} ${SIDEBAR_LAYOUT.sessionActionButtonHiddenClassName} ${
                  props.session.pinned
                    ? SIDEBAR_LAYOUT.sessionPinSelectedToneClassName
                    : ""
                }`}
                title={props.session.pinned ? "Unpin" : "Pin"}
                aria-label={props.session.pinned ? "Unpin session" : "Pin session"}
              >
                <Pin size={14} className={props.session.pinned ? "fill-current" : ""} />
              </button>
            </span>
            {props.session.archivable ? (
              <span className={SIDEBAR_LAYOUT.sessionActionCellClassName}>
                <button
                  type="button"
                  onClick={props.onArchive}
                  className={`${SIDEBAR_LAYOUT.sessionActionButtonClassName} ${SIDEBAR_LAYOUT.sessionActionButtonHiddenClassName}`}
                  title="Archive"
                  aria-label="Archive session"
                >
                  <Archive size={14} />
                </button>
              </span>
            ) : null}
          </span>
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
  canvasDraggable: boolean;
  reorder: SidebarReorderBinding;
  onSelect: () => void;
}) {
  const rowClassName = `${SIDEBAR_LAYOUT.sessionRowBaseClassName} ${
    props.council.selected
      ? SIDEBAR_LAYOUT.sessionRowSelectedClassName
      : SIDEBAR_LAYOUT.sessionRowIdleClassName
  }`;
  const selectButtonClassName = SIDEBAR_LAYOUT.sessionTitleOnlySelectButtonClassName;
  const reorderDropTarget = useSidebarReorderDropTarget(props.reorder);

  return (
    <div
      className={rowClassName}
      draggable
      data-sidebar-reorder-key={props.reorder.itemKey}
      data-sidebar-drop-position={reorderDropTarget.dropPosition ?? undefined}
      onPointerDownCapture={markSidebarPointerFocus}
      onKeyDownCapture={clearSidebarPointerFocusForKeyboard}
      onBlurCapture={clearSidebarPointerFocusAfterBlur}
      onDragStart={(event) => {
        if (props.canvasDraggable) {
          event.dataTransfer.setData("application/x-rah-council-id", props.council.id);
        }
        event.dataTransfer.setData(props.reorder.mimeType, props.reorder.itemKey);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={reorderDropTarget.onDragOver}
      onDragLeave={reorderDropTarget.onDragLeave}
      onDrop={reorderDropTarget.onDrop}
      onDragEnd={reorderDropTarget.clearDropPosition}
    >
      <SidebarDropIndicator position={reorderDropTarget.dropPosition} />
      <div className={SIDEBAR_LAYOUT.sessionInlineRowClassName}>
        <button
          type="button"
          onClick={props.onSelect}
          className={selectButtonClassName}
        >
          <span className={SIDEBAR_LAYOUT.sessionIconSlotClassName}>
            <CouncilLogo className={SIDEBAR_LAYOUT.sessionIconClassName} tone="black" variant="bare" />
          </span>
          <FadingSingleLineText
            className={`${SIDEBAR_LAYOUT.sessionTitleClassName} ${COUNCIL_ACCENT_TITLE_CLASSNAME}`}
          >
            {props.council.title}
          </FadingSingleLineText>
        </button>
        <div className={SIDEBAR_LAYOUT.sessionActionSlotClassName}>
          <SidebarStatusIndicator status={props.council.status} />
        </div>
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
  onNewTaskInWorkspace: () => void;
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
    <div
      className={SIDEBAR_LAYOUT.workspaceBlockClassName}
      data-workspace-dir={props.workspace.directory}
    >
      {/* Workspace header */}
      <div
        className={SIDEBAR_LAYOUT.workspaceHeaderClassName}
        onPointerDownCapture={markSidebarPointerFocus}
        onKeyDownCapture={clearSidebarPointerFocusForKeyboard}
        onBlurCapture={clearSidebarPointerFocusAfterBlur}
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
          <FadingSingleLineText className={SIDEBAR_LAYOUT.workspaceDisclosureTitleClassName}>
            {props.workspace.displayName}
          </FadingSingleLineText>
        </button>
        <div
          className={`${SIDEBAR_LAYOUT.workspaceActionSlotClassName} ${
            showRemove ? "opacity-100 pointer-events-auto" : SIDEBAR_LAYOUT.workspaceActionHiddenClassName
          }`}
        >
          <span className={SIDEBAR_LAYOUT.sessionActionCellClassName}>
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
          </span>
          <span className={SIDEBAR_LAYOUT.sessionActionCellClassName}>
            <button
              type="button"
              className={SIDEBAR_LAYOUT.workspaceActionButtonClassName}
              onClick={(event) => {
                event.stopPropagation();
                props.onNewTaskInWorkspace();
              }}
              aria-label="New task in workspace"
              title="New task in workspace"
            >
              <SquarePen size={14} />
            </button>
          </span>
        </div>
      </div>

      {/* Running workspace items */}
      {hasItems && expanded ? (
        <div id={itemsId} className={SIDEBAR_LAYOUT.sessionListClassName}>
          {props.workspace.items.map((item) => (
            <RunningSessionRow
              key={item.stableKey}
              session={item}
              canvasDraggable={props.enableSessionDrag && item.running}
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
  pinnedOrderKeys: readonly string[];
  councilOrderKeys: readonly string[];
  onMovePinnedItem: (
    sourceKey: string,
    targetKey: string,
    position: SidebarDropPosition,
  ) => void;
  onMoveCouncil: (
    sourceKey: string,
    targetKey: string,
    position: SidebarDropPosition,
  ) => void;
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
  onNewTaskInWorkspace: (workspaceDir: string) => void;
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
  const pinnedAvailableKeys = useMemo(
    () =>
      sidebarPartition.pinnedItems.map(({ workspaceDir, item }) =>
        sidebarPinnedOrderKey(workspaceDir, item.pinItemKey)
      ),
    [sidebarPartition.pinnedItems],
  );
  const councilAvailableKeys = useMemo(
    () => councilItems.map((item) => sidebarCouncilOrderKey(item.id)),
    [councilItems],
  );
  const pinnedSectionOrder = useMemo(
    () => reconcileSidebarSectionOrder(props.pinnedOrderKeys, pinnedAvailableKeys),
    [pinnedAvailableKeys, props.pinnedOrderKeys],
  );
  const councilSectionOrder = useMemo(
    () => reconcileSidebarSectionOrder(props.councilOrderKeys, councilAvailableKeys),
    [councilAvailableKeys, props.councilOrderKeys],
  );
  const orderedPinnedItems = useMemo(() => {
    const itemByKey = new Map(
      sidebarPartition.pinnedItems.map((item) => [
        sidebarPinnedOrderKey(item.workspaceDir, item.item.pinItemKey),
        item,
      ] as const),
    );
    return pinnedSectionOrder.flatMap((key) => {
      const item = itemByKey.get(key);
      return item ? [item] : [];
    });
  }, [pinnedSectionOrder, sidebarPartition.pinnedItems]);
  const orderedCouncilItems = useMemo(() => {
    const itemByKey = new Map(
      councilItems.map((item) => [sidebarCouncilOrderKey(item.id), item] as const),
    );
    return councilSectionOrder.flatMap((key) => {
      const item = itemByKey.get(key);
      return item ? [item] : [];
    });
  }, [councilItems, councilSectionOrder]);
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
      {orderedPinnedItems.length > 0 ? (
        <div className={SIDEBAR_LAYOUT.pinnedSectionClassName}>
          <div className={SIDEBAR_LAYOUT.pinnedHeaderClassName}>Pinned</div>
          <div className={SIDEBAR_LAYOUT.pinnedListClassName}>
            {orderedPinnedItems.map(({ workspaceDir, item }) => {
              const orderKey = sidebarPinnedOrderKey(workspaceDir, item.pinItemKey);
              return (
                <RunningSessionRow
                  key={orderKey}
                  session={item}
                  canvasDraggable={props.enableSessionDrag === true && item.running}
                  reorder={{
                    itemKey: orderKey,
                    mimeType: PINNED_SIDEBAR_DRAG_TYPE,
                    onMove: props.onMovePinnedItem,
                  }}
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
              );
            })}
          </div>
        </div>
      ) : null}

      {orderedCouncilItems.length > 0 ? (
        <section
          className={SIDEBAR_LAYOUT.councilSectionClassName}
          aria-label="Running Councils"
          data-sidebar-council-section
        >
          <div className={SIDEBAR_LAYOUT.councilHeaderClassName}>
            <span>Councils</span>
            <span
              className={SIDEBAR_LAYOUT.councilCountClassName}
              title={`${orderedCouncilItems.length} running Councils`}
            >
              {orderedCouncilItems.length}
            </span>
          </div>
          <div className={SIDEBAR_LAYOUT.councilListClassName}>
            {orderedCouncilItems.map((item) => (
              <CouncilRow
                key={item.stableKey}
                council={item}
                canvasDraggable={props.enableCouncilDrag === true}
                reorder={{
                  itemKey: sidebarCouncilOrderKey(item.id),
                  mimeType: COUNCIL_SIDEBAR_DRAG_TYPE,
                  onMove: props.onMoveCouncil,
                }}
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
          <span className={SIDEBAR_LAYOUT.sessionActionCellClassName}>
            <WorkspaceSortMenu
              value={props.workspaceSortMode}
              onChange={props.onWorkspaceSortModeChange}
              onExpandAll={expandAll}
              onCollapseAll={collapseAll}
            />
          </span>
          <span className={SIDEBAR_LAYOUT.sessionActionCellClassName}>
            <WorkspacePicker
              currentDir=""
              triggerLabel=""
              triggerIcon={<FolderPlus size={14} />}
              triggerClassName={SIDEBAR_LAYOUT.toolbarIconButtonClassName}
              triggerAriaLabel="Add workspace"
              onSelect={props.onAddWorkspace}
            />
          </span>
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
            onNewTaskInWorkspace={() => props.onNewTaskInWorkspace(workspace.directory)}
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
