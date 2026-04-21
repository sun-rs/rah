import { useEffect, useMemo, useState } from "react";
import type { DebugScenarioDescriptor, SessionSummary } from "@rah/runtime-protocol";
import type { WorkspaceSection } from "./session-browser";
import { formatRelativeTime } from "./session-browser";
import {
  ChevronRight,
  Folder,
  FolderPlus,
  Plus,
  RefreshCcw,
  X,
} from "lucide-react";
import { sessionInteractionLabel, sessionInteractionMode } from "./session-capabilities";
import { providerLabel } from "./types";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { ProviderLogo } from "./components/ProviderLogo";

function LiveSessionRow(props: {
  session: SessionSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const session = props.session.session;
  const interactionMode = sessionInteractionMode(props.session);
  const interactionLabel = sessionInteractionLabel(props.session);

  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={`w-full text-left rounded-md px-2 py-1.5 transition-colors ${
        props.selected
          ? "bg-[var(--app-bg)] text-[var(--app-fg)]"
          : "text-[var(--app-hint)] hover:bg-[var(--app-bg)]/60"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ProviderLogo provider={session.provider} className="h-4 w-4" />
          <span className="text-sm truncate">
            {session.title ?? providerLabel(session.provider)}
          </span>
        </div>
        <span className="text-[11px] text-[var(--app-hint)] shrink-0">
          {formatRelativeTime(session.updatedAt) ?? ""}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--app-hint)] pl-6">
        <span>{session.runtimeState}</span>
        <span className="text-[var(--app-border)]">·</span>
        <span
          className={
            interactionMode === "read_only_replay"
              ? "text-amber-600 dark:text-amber-400"
              : interactionMode === "observe_only"
                ? "text-[var(--app-hint)]"
                : "text-emerald-600 dark:text-emerald-400"
          }
        >
          {interactionLabel}
        </span>
      </div>
    </button>
  );
}

function WorkspaceGroup(props: {
  section: WorkspaceSection;
  selectedWorkspaceDir: string;
  selectedSessionId: string | null;
  expanded: boolean;
  onToggle: () => void;
  onSelectWorkspace: () => void;
  onRemoveWorkspace: () => void;
  onSelectSession: (sessionId: string) => void;
}) {
  const selected = props.section.workspace.directory === props.selectedWorkspaceDir;
  const hasSessions = props.section.sessions.length > 0;

  return (
    <div className="group">
      <div
        className={`flex items-center gap-1.5 rounded-lg px-1.5 py-1.5 transition-colors ${
          selected ? "bg-[var(--app-bg)]" : "hover:bg-[var(--app-bg)]/50"
        }`}
      >
        <button
          type="button"
          onClick={props.onToggle}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-bg)] transition-colors"
          aria-label={props.expanded ? "Collapse" : "Expand"}
        >
          <ChevronRight
            size={14}
            className={`transition-transform duration-150 ${
              props.expanded ? "rotate-90" : ""
            }`}
          />
        </button>

        <button
          type="button"
          onClick={props.onSelectWorkspace}
          className="min-w-0 flex-1 text-left"
          title={props.section.workspace.directory}
        >
          <div className="flex items-center gap-2">
            <Folder size={14} className="text-[var(--app-hint)] shrink-0" />
            <span className={`text-sm truncate ${selected ? "font-medium text-[var(--app-fg)]" : "text-[var(--app-fg)]"}`}>
              {props.section.workspace.displayName}
            </span>
          </div>
        </button>

        <div className="flex items-center gap-1 shrink-0">
          {selected ? (
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          ) : null}
          {hasSessions ? (
            <span className="text-[11px] tabular-nums text-[var(--app-hint)] min-w-[1rem] text-right">
              {props.section.sessions.length}
            </span>
          ) : null}
          <button
            type="button"
            disabled={props.section.workspace.hasBlockingLiveSessions}
            onClick={props.onRemoveWorkspace}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)] opacity-40 group-hover:opacity-100 hover:bg-[var(--app-danger)]/10 hover:text-[var(--app-danger)] disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--app-hint)] transition-all"
            title={
              props.section.workspace.hasBlockingLiveSessions
                ? "Cannot remove a workspace with live sessions in this folder or its descendants"
                : "Remove workspace"
            }
          >
            <X size={12} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {props.expanded ? (
        <div className="pl-8 pr-1 pb-0.5 space-y-0.5">
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
            <div className="px-2 py-1.5 text-xs text-[var(--app-hint)]">No live sessions.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SessionSidebar(props: {
  workspaceSections: WorkspaceSection[];
  workspaceDir: string;
  onWorkspaceDirChange: (value: string) => void;
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
        const shouldDefaultExpand =
          section.workspace.directory === props.workspaceDir || section.workspace.liveCount > 0;
        if (shouldDefaultExpand && !next.includes(section.workspace.directory)) {
          next.push(section.workspace.directory);
        }
      }
      return next;
    });
  }, [props.workspaceDir, props.workspaceSections, workspaceDirs]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-1 rounded-lg bg-[var(--app-bg)] p-1">
        <WorkspacePicker
          currentDir=""
          triggerLabel="Workspace"
          triggerIcon={<FolderPlus size={14} />}
          triggerClassName="flex-1 h-8 px-3 rounded-md bg-[var(--app-subtle-bg)] text-xs font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors inline-flex items-center justify-center gap-1.5"
          onSelect={props.onAddWorkspace}
        />
        <button
          className="flex-1 h-8 px-3 rounded-md bg-[var(--app-subtle-bg)] text-xs font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors inline-flex items-center justify-center gap-1.5"
          onClick={props.onOpenNewSession}
          title="New session"
        >
          <Plus size={14} />
          Session
        </button>
        <button
          type="button"
          onClick={props.onRefresh}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
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
                selectedWorkspaceDir={props.workspaceDir}
                selectedSessionId={props.selectedSessionId}
                expanded={expandedWorkspaceDirs.includes(section.workspace.directory)}
                onToggle={() =>
                  setExpandedWorkspaceDirs((current) =>
                    current.includes(section.workspace.directory)
                      ? current.filter((directory) => directory !== section.workspace.directory)
                      : [...current, section.workspace.directory],
                  )
                }
                onSelectWorkspace={() => props.onWorkspaceDirChange(section.workspace.directory)}
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
                className="w-full text-left rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--app-bg)] text-[var(--app-hint)]"
              >
                <div className="flex items-center gap-2">
                  <ProviderLogo provider={scenario.provider} className="h-4 w-4" />
                  <span className="text-sm font-medium truncate text-[var(--app-fg)]">
                    {scenario.label}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--app-hint)] line-clamp-2 pl-6">
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
