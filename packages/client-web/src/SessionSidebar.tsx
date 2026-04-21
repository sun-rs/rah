import { useEffect, useMemo, useState } from "react";
import type { DebugScenarioDescriptor, SessionSummary } from "@rah/runtime-protocol";
import type { WorkspaceSection } from "./session-browser";
import { formatRelativeTime } from "./session-browser";
import {
  ChevronRight,
  FolderPlus,
  Plus,
  RefreshCcw,
  X,
} from "lucide-react";
import {
  isSessionActivelyRunning,
  sessionInteractionLabel,
  sessionInteractionMode,
} from "./session-capabilities";
import { providerLabel } from "./types";
import { WorkspacePicker } from "./components/WorkspacePicker";

function LiveSessionRow(props: {
  session: SessionSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const session = props.session.session;
  const interactionMode = sessionInteractionMode(props.session);
  const isRunning = isSessionActivelyRunning(props.session);

  const statusColor =
    interactionMode === "read_only_replay"
      ? "bg-amber-500"
      : interactionMode === "observe_only"
        ? "bg-[var(--app-muted)]"
        : "bg-emerald-500";

  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={`w-full text-left rounded-lg px-3 py-2 transition-colors border ${
        props.selected
          ? "bg-[var(--app-bg)]/70 border-[var(--app-border)] text-[var(--app-fg)]"
          : "border-transparent text-[var(--app-fg)] hover:bg-[var(--app-bg)]/40"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`relative inline-flex h-[7px] w-[7px] rounded-full shrink-0 ${statusColor}`}>
            {isRunning && interactionMode === "interactive" ? (
              <span className="absolute inset-0 rounded-full bg-emerald-500 animate-pulse" />
            ) : null}
          </span>
          <span className="text-sm font-medium truncate">
            {session.title ?? providerLabel(session.provider)}
          </span>
        </div>
        <span className="text-[11px] text-[var(--app-hint)] shrink-0">
          {formatRelativeTime(session.updatedAt) ?? ""}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--app-hint)] pl-[18px]">
        <span className="capitalize">{session.runtimeState}</span>
      </div>
    </button>
  );
}

function WorkspaceGroup(props: {
  section: WorkspaceSection;
  selectedSessionId: string | null;
  expanded: boolean;
  onToggle: () => void;
  onRemoveWorkspace: () => void;
  onSelectSession: (sessionId: string) => void;
}) {
  const hasSessions = props.section.sessions.length > 0;

  return (
    <div className="group/workspace">
      <div
        className="flex items-center gap-1.5 rounded-lg border border-transparent px-2 py-2 transition-colors hover:bg-[var(--app-bg)]/30"
      >
        <button
          type="button"
          onClick={props.onToggle}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
          aria-label={props.expanded ? "Collapse" : "Expand"}
        >
          <ChevronRight
            size={12}
            className={`transition-transform duration-150 ${
              props.expanded ? "rotate-90" : ""
            }`}
          />
        </button>

        <button
          type="button"
          onClick={props.onToggle}
          className="min-w-0 flex-1 text-left"
          title={props.section.workspace.directory}
        >
          <span className="text-sm truncate text-[var(--app-fg)]">
            {props.section.workspace.displayName}
          </span>
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          {hasSessions ? (
            <span className="text-[11px] tabular-nums text-[var(--app-hint)] bg-[var(--app-bg)]/50 px-1.5 py-0.5 rounded-md">
              {props.section.sessions.length}
            </span>
          ) : null}
          <button
            type="button"
            disabled={props.section.workspace.hasBlockingLiveSessions}
            onClick={props.onRemoveWorkspace}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] opacity-0 group-hover/workspace:opacity-100 hover:bg-[var(--app-danger)]/10 hover:text-[var(--app-danger)] disabled:opacity-0 disabled:hover:bg-transparent disabled:hover:text-[var(--app-hint)] transition-all"
            title={
              props.section.workspace.hasBlockingLiveSessions
                ? "Cannot remove a workspace with live sessions in this folder or its descendants"
                : "Remove workspace"
            }
          >
            <X size={11} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {props.expanded ? (
        <div className="pl-7 pr-1 pb-0.5 space-y-0.5">
          {hasSessions ? (
            props.section.sessions.map((session) => (
              <LiveSessionRow
                key={session.session.id}
                session={session}
                selected={session.session.id === props.selectedSessionId}
                onSelect={() => props.onSelectSession(session.session.id)}
              />
            ))
          ) : (
            <div className="px-3 py-2 text-xs text-[var(--app-hint)]">No live sessions.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SessionSidebar(props: {
  workspaceSections: WorkspaceSection[];
  onAddWorkspace: (value: string) => void;
  onRemoveWorkspace: (value: string) => void;
  onOpenNewSession: () => void;
  onRefresh: () => void;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  debugScenarios: DebugScenarioDescriptor[];
  onStartScenario: (scenario: DebugScenarioDescriptor) => void;
}) {
  const [expandedWorkspaceDirs, setExpandedWorkspaceDirs] = useState<string[]>([]);

  const workspaceDirs = useMemo(
    () => props.workspaceSections.map((section) => section.workspace.directory),
    [props.workspaceSections],
  );

  useEffect(() => {
    setExpandedWorkspaceDirs((current) => {
      const next = current.filter((directory) => workspaceDirs.includes(directory));
      for (const section of props.workspaceSections) {
        const shouldDefaultExpand = section.workspace.liveCount > 0;
        if (shouldDefaultExpand && !next.includes(section.workspace.directory)) {
          next.push(section.workspace.directory);
        }
      }
      return next;
    });
  }, [props.workspaceSections, workspaceDirs]);

  return (
    <div className="min-h-full space-y-4 bg-[var(--app-subtle-bg)]">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5">
        <WorkspacePicker
          currentDir=""
          triggerLabel="Add"
          triggerIcon={<FolderPlus size={14} />}
          triggerClassName="h-8 px-3 rounded-lg bg-[var(--app-bg)] text-xs font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors inline-flex items-center justify-center gap-1.5"
          onSelect={props.onAddWorkspace}
        />
        <button
          className="flex-1 h-8 px-3 rounded-lg bg-[var(--app-bg)] text-xs font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors inline-flex items-center justify-center gap-1.5"
          onClick={props.onOpenNewSession}
          title="New session"
        >
          <Plus size={14} />
          New session
        </button>
        <button
          type="button"
          onClick={props.onRefresh}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--app-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
          title="Refresh"
        >
          <RefreshCcw size={14} />
        </button>
      </div>

      {/* Workspaces */}
      <div className="space-y-1">
        <div className="flex items-center justify-between px-1">
          <span className="text-xs font-medium text-[var(--app-hint)]">Workspaces</span>
          <span className="text-[11px] tabular-nums text-[var(--app-hint)]">
            {props.workspaceSections.length}
          </span>
        </div>
        <div className="space-y-0.5">
          {props.workspaceSections.length > 0 ? (
            props.workspaceSections.map((section) => (
              <WorkspaceGroup
                key={section.workspace.directory}
                section={section}
                selectedSessionId={props.selectedSessionId}
                expanded={expandedWorkspaceDirs.includes(section.workspace.directory)}
                onToggle={() =>
                  setExpandedWorkspaceDirs((current) =>
                    current.includes(section.workspace.directory)
                      ? current.filter((directory) => directory !== section.workspace.directory)
                      : [...current, section.workspace.directory],
                  )
                }
                onRemoveWorkspace={() => props.onRemoveWorkspace(section.workspace.directory)}
                onSelectSession={props.onSelectSession}
              />
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--app-border)] px-3 py-3 text-sm text-[var(--app-hint)]">
              No workspaces yet.
            </div>
          )}
        </div>
      </div>

      {/* Debug scenarios */}
      {props.debugScenarios.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-medium text-[var(--app-hint)]">Lab</span>
            <span className="text-[11px] tabular-nums text-[var(--app-hint)]">
              {props.debugScenarios.length}
            </span>
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
