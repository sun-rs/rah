import { useEffect, useMemo, useRef, useState } from "react";
import type { CouncilSnapshot, DebugScenarioDescriptor } from "@rah/runtime-protocol";
import type { WorkspaceSection, WorkspaceSortMode } from "./session-browser";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderOpen,
  FolderPlus,
  ListFilter,
  MoreHorizontal,
  Pencil,
  Pin,
  PlusCircle,
  UsersRound,
  X,
} from "lucide-react";
import { ProviderLogo } from "./components/ProviderLogo";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { SIDEBAR_LAYOUT } from "./sidebar-layout-contract";
import { deriveSidebarWorkspaceViewModels, type SidebarWorkspaceViewModel } from "./sidebar-view-model";
import {
  COUNCIL_ACCENT_ICON_CLASSNAME,
  COUNCIL_ACCENT_TITLE_CLASSNAME,
} from "./council/council-theme";

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
  onSelect: () => void;
}) {
  const statusBadgeClassName = SIDEBAR_LAYOUT.sessionStatusBadgeClassByStatus[props.session.status];
  const titleClassName =
    props.session.originKind === "council"
      ? `${SIDEBAR_LAYOUT.sessionTitleClassName} ${COUNCIL_ACCENT_TITLE_CLASSNAME}`
      : SIDEBAR_LAYOUT.sessionTitleClassName;
  const rowClassName = `${SIDEBAR_LAYOUT.sessionRowBaseClassName} ${
    props.session.selected
      ? SIDEBAR_LAYOUT.sessionRowSelectedClassName
      : SIDEBAR_LAYOUT.sessionRowIdleClassName
  }`;
  const selectButtonClassName = "min-w-0 flex flex-1 items-center gap-1.5 pr-6 text-left";

  return (
    <div
      className={rowClassName}
      draggable={props.draggable}
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
        >
          <div className={SIDEBAR_LAYOUT.sessionHeaderClassName}>
            <span className={SIDEBAR_LAYOUT.sessionIconSlotClassName}>
              <ProviderLogo
                provider={props.session.provider}
                className={SIDEBAR_LAYOUT.sessionIconClassName}
                variant="bare"
              />
            </span>
            <span className={titleClassName}>
              {props.session.title}
            </span>
          </div>
          <div className={SIDEBAR_LAYOUT.sessionMetaRowClassName}>
            <div className={SIDEBAR_LAYOUT.sessionMetaLeftClassName}>
              <span
                className={`${SIDEBAR_LAYOUT.sessionStatusBadgeBaseClassName} ${statusBadgeClassName}`}
              >
                {props.session.statusLabel}
              </span>
            </div>
            <span className={SIDEBAR_LAYOUT.sessionTimeClassName}>
              {props.session.updatedAtLabel}
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={props.onTogglePin}
          className={`${SIDEBAR_LAYOUT.sessionPinButtonClassName} ${
            props.session.pinned
              ? SIDEBAR_LAYOUT.sessionPinActiveClassName
              : SIDEBAR_LAYOUT.sessionPinHiddenClassName
          }`}
          title={props.session.pinned ? "Unpin" : "Pin"}
          aria-label={props.session.pinned ? "Unpin session" : "Pin session"}
        >
          <Pin size={12} className={props.session.pinned ? "fill-current" : ""} />
        </button>
      </div>
    </div>
  );
}

function CouncilRow(props: {
  council: SidebarWorkspaceViewModel["councils"][number];
  draggable: boolean;
  onTogglePin: () => void;
  onSelect: () => void;
}) {
  const statusBadgeClassName =
    props.council.status === "starting"
      ? "text-sky-600/90 dark:text-sky-400/90"
      : props.council.status === "working"
        ? "text-sky-600/90 dark:text-sky-400/90"
        : props.council.status === "waiting_permission"
          ? "text-orange-700/90 dark:text-orange-400/90"
          : "text-[var(--app-hint)]";
  const rowClassName = `${SIDEBAR_LAYOUT.sessionRowBaseClassName} ${
    props.council.selected
      ? SIDEBAR_LAYOUT.sessionRowSelectedClassName
      : SIDEBAR_LAYOUT.sessionRowIdleClassName
  }`;
  const selectButtonClassName = "min-w-0 flex flex-1 items-center gap-1.5 pr-6 text-left";

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
          <div className={SIDEBAR_LAYOUT.sessionHeaderClassName}>
            <span className={SIDEBAR_LAYOUT.sessionIconSlotClassName}>
              <UsersRound
                size={16}
                className={COUNCIL_ACCENT_ICON_CLASSNAME}
              />
            </span>
            <span className={`${SIDEBAR_LAYOUT.sessionTitleClassName} ${COUNCIL_ACCENT_TITLE_CLASSNAME}`}>
              {props.council.title}
            </span>
          </div>
          <div className={SIDEBAR_LAYOUT.sessionMetaRowClassName}>
            <div className={SIDEBAR_LAYOUT.sessionMetaLeftClassName}>
              <span className={`${SIDEBAR_LAYOUT.sessionStatusBadgeBaseClassName} ${statusBadgeClassName}`}>
                {props.council.statusLabel}
              </span>
            </div>
            <span className={SIDEBAR_LAYOUT.sessionTimeClassName}>
              {props.council.updatedAtLabel}
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={props.onTogglePin}
          className={`${SIDEBAR_LAYOUT.sessionPinButtonClassName} ${
            props.council.pinned
              ? SIDEBAR_LAYOUT.sessionPinActiveClassName
              : SIDEBAR_LAYOUT.sessionPinHiddenClassName
          }`}
          title={props.council.pinned ? "Unpin" : "Pin"}
          aria-label={props.council.pinned ? "Unpin Council" : "Pin Council"}
        >
          <Pin size={12} className={props.council.pinned ? "fill-current" : ""} />
        </button>
      </div>
    </div>
  );
}

function WorkspaceRow(props: {
  workspace: SidebarWorkspaceViewModel;
  enableSessionDrag: boolean;
  enableCouncilDrag: boolean;
  onRemoveWorkspace: () => void;
  onTogglePinSession: (sessionId: string) => void;
  onTogglePinCouncil: (councilId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSelectCouncil: (councilId: string) => void;
  onSelectWorkspace: () => void;
  expandAllKey: number;
  expandAllValue: boolean;
}) {
  const [showRemove, setShowRemove] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const hasItems = props.workspace.items.length > 0;
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
        className={`${SIDEBAR_LAYOUT.workspaceHeaderClassName} ${
          props.workspace.selected ? SIDEBAR_LAYOUT.workspaceHeaderSelectedClassName : ""
        }`}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded();
          }}
          className={SIDEBAR_LAYOUT.workspaceToggleButtonClassName}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        </button>
        <button
          type="button"
          onClick={props.onSelectWorkspace}
          className={`${SIDEBAR_LAYOUT.workspaceTitleButtonClassName} ${
            props.workspace.selected ? SIDEBAR_LAYOUT.workspaceTitleSelectedClassName : ""
          }`}
        >
          {props.workspace.displayName}
        </button>
        <div
          className={`${SIDEBAR_LAYOUT.workspaceActionSlotClassName} ${
            showRemove ? "opacity-100 pointer-events-auto" : SIDEBAR_LAYOUT.workspaceActionHiddenClassName
          }`}
        >
          {showRemove ? (
            <button
              type="button"
              disabled={props.workspace.hasBlockingRunningSessions}
              onClick={(e) => {
                e.stopPropagation();
                props.onRemoveWorkspace();
              }}
              className={`${SIDEBAR_LAYOUT.workspaceActionButtonClassName} ${SIDEBAR_LAYOUT.workspaceActionDangerClassName}`}
              title={
                props.workspace.hasBlockingRunningSessions
                  ? "Cannot remove a workspace with running sessions"
                  : "Remove workspace"
              }
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
        </div>
      </div>

      {/* Running workspace items */}
      {hasItems && expanded ? (
        <div className={SIDEBAR_LAYOUT.sessionListClassName}>
          {props.workspace.items.map((item) =>
            item.kind === "session" ? (
              <RunningSessionRow
                key={`session:${item.id}`}
                session={item}
                draggable={props.enableSessionDrag}
                onTogglePin={() => props.onTogglePinSession(item.id)}
                onSelect={() => props.onSelectSession(item.id)}
              />
            ) : (
              <CouncilRow
                key={`council:${item.id}`}
                council={item}
                draggable={props.enableCouncilDrag}
                onTogglePin={() => props.onTogglePinCouncil(item.id)}
                onSelect={() => props.onSelectCouncil(item.id)}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SessionSidebar(props: {
  workspaceSections: WorkspaceSection[];
  workspaceSortMode: WorkspaceSortMode;
  onWorkspaceSortModeChange: (value: WorkspaceSortMode) => void;
  runningSessionActivityAtById?: ReadonlyMap<string, string> | undefined;
  pinnedSessionIdByWorkspace: Readonly<Record<string, string>>;
  onTogglePinSession: (workspaceDir: string, sessionId: string) => void;
  onTogglePinCouncil: (workspaceDir: string, councilId: string) => void;
  onAddWorkspace: (value: string) => void;
  onRemoveWorkspace: (value: string) => void;
  selectedWorkspaceDir: string;
  selectedSessionId: string | null;
  selectedCouncilId?: string | null;
  unreadSessionIds: ReadonlySet<string>;
  runtimeStatusBySessionId: ReadonlyMap<
    string,
    "thinking" | "streaming" | "stopping" | "retrying" | undefined
  >;
  onSelectSession: (workspaceDir: string, sessionId: string) => void;
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
        selectedWorkspaceDir: props.selectedWorkspaceDir,
        selectedSessionId: props.selectedSessionId,
        unreadSessionIds: props.unreadSessionIds,
        runtimeStatusBySessionId: props.runtimeStatusBySessionId,
        pinnedSessionIdByWorkspace: props.pinnedSessionIdByWorkspace,
        runningSessionActivityAtById: props.runningSessionActivityAtById,
        ...(props.councils !== undefined ? { councils: props.councils } : {}),
        selectedCouncilId: props.selectedCouncilId ?? null,
      }),
    [
      props.councils,
      props.pinnedSessionIdByWorkspace,
      props.runtimeStatusBySessionId,
      props.runningSessionActivityAtById,
      props.selectedCouncilId,
      props.selectedSessionId,
      props.selectedWorkspaceDir,
      props.unreadSessionIds,
      props.workspaceSections,
    ],
  );
  const workspaceCount = workspaceViewModels.length;
  const runningSessionCount = workspaceViewModels.reduce(
    (count, workspace) => count + workspace.sessions.length,
    0,
  );
  const runningCouncilCount = workspaceViewModels.reduce(
    (count, workspace) => count + workspace.councils.length,
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
      {/* Toolbar */}
      <div className={SIDEBAR_LAYOUT.toolbarClassName}>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={SIDEBAR_LAYOUT.toolbarLabelClassName}>Workspaces</span>
          <span
            className={SIDEBAR_LAYOUT.toolbarCountBadgeClassName}
            title={`${workspaceCount} workspaces`}
          >
            {workspaceCount}
          </span>
          <span
            className={SIDEBAR_LAYOUT.toolbarCountBadgeClassName}
            title={`${runningSessionCount + runningCouncilCount} running workspace items`}
          >
            {runningSessionCount + runningCouncilCount}
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
        {workspaceViewModels.map((workspace) => (
          <WorkspaceRow
            key={workspace.directory}
            workspace={workspace}
            enableSessionDrag={props.enableSessionDrag === true}
            enableCouncilDrag={props.enableCouncilDrag === true}
            onRemoveWorkspace={() => props.onRemoveWorkspace(workspace.directory)}
            onTogglePinSession={(sessionId) =>
              props.onTogglePinSession(workspace.directory, sessionId)
            }
            onTogglePinCouncil={(councilId) =>
              props.onTogglePinCouncil(workspace.directory, councilId)
            }
            onSelectSession={(sessionId) => props.onSelectSession(workspace.directory, sessionId)}
            onSelectCouncil={(councilId) => props.onSelectCouncil?.(workspace.directory, councilId)}
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
