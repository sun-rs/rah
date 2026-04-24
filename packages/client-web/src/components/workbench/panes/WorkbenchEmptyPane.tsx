import type { RefObject } from "react";
import { ArrowUp, ChevronDown, Folder, FolderPlus, Menu, PanelRight, Plus } from "lucide-react";
import { ProviderSelector, type ProviderChoice } from "../../ProviderSelector";
import { SessionModeControls } from "../../SessionModeControls";
import { TokenizedTextarea } from "../../TokenizedTextarea";
import { WorkspacePicker } from "../../WorkspacePicker";
import { EMPTY_STATE_COMPOSER_LAYOUT } from "../../../composer-contract";
import type { SessionModeChoice } from "../../../session-mode-ui";

export function WorkbenchEmptyPane(props: {
  sidebarOpen: boolean;
  rightSidebarOpen: boolean;
  onOpenLeft: () => void;
  onExpandSidebar: () => void;
  onOpenRight: () => void;
  onExpandInspector: () => void;
  emptyStateComposerRef: RefObject<HTMLTextAreaElement | null>;
  emptyStateDraft: string;
  onEmptyStateDraftChange: (value: string) => void;
  onEmptyStateSend: () => void;
  workspacePickerRef: RefObject<HTMLDivElement | null>;
  onOpenFileReference: () => void;
  workspaceDirs: string[];
  availableWorkspaceDir: string;
  workspacePickerOpen: boolean;
  onToggleWorkspacePicker: () => void;
  onSelectWorkspace: (dir: string) => void;
  onAddWorkspace: (dir: string) => void;
  newSessionProvider: ProviderChoice;
  onChangeProvider: (provider: ProviderChoice) => void;
  accessModes: SessionModeChoice[];
  selectedAccessModeId: string | null;
  planModeAvailable: boolean;
  planModeEnabled: boolean;
  onAccessModeChange: (modeId: string) => void;
  onPlanModeToggle: (enabled: boolean) => void;
}) {
  return (
    <>
      <header className="h-14 flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 bg-[var(--app-bg)]/80 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors md:hidden"
            onClick={props.onOpenLeft}
            aria-label="Open sidebar"
          >
            <Menu size={18} />
          </button>
          {!props.sidebarOpen && (
            <button
              type="button"
              className="hidden md:inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
              onClick={props.onExpandSidebar}
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <Menu size={16} />
            </button>
          )}
          <div className="min-w-0 md:hidden">
            <div className="text-sm font-medium text-[var(--app-fg)]">RAH</div>
            <div className="text-[11px] text-[var(--app-hint)]">
              Open the sidebar
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!props.rightSidebarOpen && (
            <button
              type="button"
              className="hidden md:inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
              onClick={props.onExpandInspector}
              aria-label="Expand inspector"
              title="Expand inspector"
            >
              <PanelRight size={16} />
            </button>
          )}
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors md:hidden"
            onClick={props.onOpenRight}
            aria-label="Open inspector"
          >
            <PanelRight size={18} />
          </button>
        </div>
      </header>
      <div className="flex-1 flex flex-col items-center justify-center px-6 overflow-y-auto custom-scrollbar">
        <div className="w-full max-w-2xl -translate-y-6 space-y-5 md:-translate-y-8 md:space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-[var(--app-fg)]">
              What would you like to build?
            </h1>
          </div>
          <div className="relative">
            <TokenizedTextarea
              ref={props.emptyStateComposerRef}
              textareaClassName={EMPTY_STATE_COMPOSER_LAYOUT.textareaClassName}
              contentClassName={EMPTY_STATE_COMPOSER_LAYOUT.textareaContentClassName}
              placeholder="Message…"
              rows={3}
              value={props.emptyStateDraft}
              onChange={props.onEmptyStateDraftChange}
              onKeyDown={(e) => {
                const nativeEvent = e.nativeEvent as KeyboardEvent;
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !nativeEvent.isComposing &&
                  nativeEvent.keyCode !== 229
                ) {
                  e.preventDefault();
                  props.onEmptyStateSend();
                }
              }}
            />
            <div
              ref={props.workspacePickerRef}
              className={EMPTY_STATE_COMPOSER_LAYOUT.controlsRowClassName}
            >
              <div className={EMPTY_STATE_COMPOSER_LAYOUT.leftControlsClassName}>
                <button
                  type="button"
                  onClick={props.onOpenFileReference}
                  className={EMPTY_STATE_COMPOSER_LAYOUT.roundSecondaryButtonClassName}
                  title="Insert file or folder reference"
                >
                  <Plus size={16} />
                </button>
                {props.workspaceDirs.length === 0 ? (
                  <WorkspacePicker
                    currentDir=""
                    triggerLabel="Workspace"
                    triggerIcon={<FolderPlus size={13} />}
                    triggerClassName={EMPTY_STATE_COMPOSER_LAYOUT.workspaceTriggerClassName}
                    onSelect={props.onAddWorkspace}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={props.onToggleWorkspacePicker}
                    className={EMPTY_STATE_COMPOSER_LAYOUT.workspaceTriggerClassName}
                  >
                    <Folder size={13} />
                    <span className="truncate">
                      {props.availableWorkspaceDir
                        ? props.availableWorkspaceDir.split("/").pop()
                        : "Workspace"}
                    </span>
                    <ChevronDown
                      size={12}
                      className={`shrink-0 transition-transform ${props.workspacePickerOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                )}
                {props.workspaceDirs.length > 0 && props.workspacePickerOpen ? (
                  <div className="absolute bottom-full left-0 mb-1 w-56 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-lg">
                    {props.workspaceDirs.map((dir) => (
                      <button
                        key={dir}
                        type="button"
                        onClick={() => props.onSelectWorkspace(dir)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                          dir === props.availableWorkspaceDir ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]" : "text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                        }`}
                      >
                        <Folder size={13} className="shrink-0 text-[var(--app-hint)]" />
                        <span className="truncate">{dir}</span>
                        {dir === props.availableWorkspaceDir ? <span className="ml-auto text-[10px] text-[var(--app-hint)]">●</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                <SessionModeControls
                  compact
                  accessModes={props.accessModes}
                  selectedAccessModeId={props.selectedAccessModeId}
                  planModeAvailable={props.planModeAvailable}
                  planModeEnabled={props.planModeEnabled}
                  onAccessModeChange={props.onAccessModeChange}
                  onPlanModeToggle={props.onPlanModeToggle}
                />
              </div>
              <button
                type="button"
                disabled={!props.emptyStateDraft.trim() || !props.availableWorkspaceDir}
                onClick={props.onEmptyStateSend}
                className={EMPTY_STATE_COMPOSER_LAYOUT.roundPrimaryButtonClassName}
              >
                <ArrowUp size={18} />
              </button>
            </div>
          </div>
          <div className="w-full max-w-3xl mx-auto">
            <ProviderSelector
              value={props.newSessionProvider}
              onChange={props.onChangeProvider}
              mode="grid"
            />
          </div>
        </div>
      </div>
    </>
  );
}
