import { useEffect, useRef, useState } from "react";
import type { DebugScenarioDescriptor, SessionSummary } from "@rah/runtime-protocol";
import type { WorkspaceSection, WorkspaceSortMode } from "./session-browser";
import { formatRelativeTime } from "./session-browser";
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
  PlusCircle,
  Terminal,
  X,
} from "lucide-react";
import { providerLabel } from "./types";
import { WorkspacePicker } from "./components/WorkspacePicker";

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

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const sortOptions: Array<{ value: WorkspaceSortMode; label: string }> = [
    { value: "created", label: "已创建" },
    { value: "updated", label: "已更新" },
  ];

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        className="h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-bg)] transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Sort"
        onClick={() => setOpen((current) => !current)}
      >
        <ListFilter size={14} />
      </button>

      {open ? (
        <div className="absolute right-0 top-9 z-20 w-44 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-lg">
          {sortOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
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
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
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
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
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

function LiveSessionRow(props: {
  session: SessionSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const session = props.session.session;

  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={`group/session w-full text-left rounded-lg px-3 py-2 transition-colors ${
        props.selected
          ? "bg-[var(--app-bg)]/60 text-[var(--app-fg)]"
          : "text-[var(--app-fg)] hover:bg-[var(--app-bg)]/30"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Terminal size={13} className="shrink-0 text-[var(--app-hint)]" />
          <span className="text-sm truncate">
            {session.title ?? providerLabel(session.provider)}
          </span>
        </div>
        <span className="text-[11px] text-[var(--app-hint)] shrink-0">
          {formatRelativeTime(session.updatedAt) ?? ""}
        </span>
      </div>
    </button>
  );
}

function WorkspaceRow(props: {
  section: WorkspaceSection;
  selectedSessionId: string | null;
  onRemoveWorkspace: () => void;
  onSelectSession: (sessionId: string) => void;
  expandAllKey: number;
  expandAllValue: boolean;
}) {
  const [showRemove, setShowRemove] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const hasSessions = props.section.sessions.length > 0;
  const toggleExpanded = () => setExpanded((v) => !v);

  useEffect(() => {
    setExpanded(props.expandAllValue);
  }, [props.expandAllKey]);

  return (
    <div className="space-y-0.5">
      {/* Workspace header */}
      <div className="group/workspace flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--app-bg)]/30">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded();
          }}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors shrink-0"
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        </button>
        <button
          type="button"
          onClick={toggleExpanded}
          className="text-sm text-[var(--app-fg)] truncate flex-1 text-left"
        >
          {props.section.workspace.displayName}
        </button>
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/workspace:opacity-100 transition-opacity">
          {showRemove ? (
            <button
              type="button"
              disabled={props.section.workspace.hasBlockingLiveSessions}
              onClick={(e) => {
                e.stopPropagation();
                props.onRemoveWorkspace();
              }}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-danger)]/10 hover:text-[var(--app-danger)] disabled:opacity-30 transition-colors"
              title={
                props.section.workspace.hasBlockingLiveSessions
                  ? "Cannot remove a workspace with live sessions"
                  : "Remove workspace"
              }
            >
              <X size={12} strokeWidth={2.5} />
            </button>
          ) : (
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
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

      {/* Sessions */}
      {hasSessions && expanded ? (
        <div className="pl-2 pr-1 space-y-0.5">
          {props.section.sessions.map((session) => (
            <LiveSessionRow
              key={session.session.id}
              session={session}
              selected={session.session.id === props.selectedSessionId}
              onSelect={() => props.onSelectSession(session.session.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SessionSidebar(props: {
  workspaceSections: WorkspaceSection[];
  workspaceSortMode: WorkspaceSortMode;
  onWorkspaceSortModeChange: (value: WorkspaceSortMode) => void;
  onAddWorkspace: (value: string) => void;
  onRemoveWorkspace: (value: string) => void;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  debugScenarios: DebugScenarioDescriptor[];
  onStartScenario: (scenario: DebugScenarioDescriptor) => void;
}) {
  const [expandAllKey, setExpandAllKey] = useState(0);
  const [expandAllValue, setExpandAllValue] = useState(true);

  const expandAll = () => {
    setExpandAllValue(true);
    setExpandAllKey((k) => k + 1);
  };

  const collapseAll = () => {
    setExpandAllValue(false);
    setExpandAllKey((k) => k + 1);
  };

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-[var(--app-hint)]">Workspaces</span>
        <div className="flex items-center gap-0.5">
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
            triggerClassName="h-7 w-7 rounded-md text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-bg)] transition-colors inline-flex items-center justify-center"
            onSelect={props.onAddWorkspace}
          />
        </div>
      </div>

      {/* Workspace list */}
      <div className="space-y-4">
        {props.workspaceSections.map((section) => (
          <WorkspaceRow
            key={section.workspace.directory}
            section={section}
            selectedSessionId={props.selectedSessionId}
            onRemoveWorkspace={() => props.onRemoveWorkspace(section.workspace.directory)}
            onSelectSession={props.onSelectSession}
            expandAllKey={expandAllKey}
            expandAllValue={expandAllValue}
          />
        ))}
      </div>

      {/* Debug scenarios */}
      {props.debugScenarios.length > 0 ? (
        <div className="space-y-2">
          <div className="px-1">
            <span className="text-xs font-medium text-[var(--app-hint)]">Lab</span>
          </div>
          <div className="space-y-0.5">
            {props.debugScenarios.map((scenario) => (
              <button
                key={scenario.id}
                type="button"
                onClick={() => props.onStartScenario(scenario)}
                className="w-full text-left rounded-lg px-3 py-2 transition-colors hover:bg-[var(--app-bg)]/60"
              >
                <span className="text-sm font-medium truncate text-[var(--app-fg)]">
                  {scenario.label}
                </span>
                <div className="mt-0.5 text-[11px] text-[var(--app-hint)] line-clamp-2">
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
