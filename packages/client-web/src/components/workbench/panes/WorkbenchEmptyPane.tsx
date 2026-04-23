import type { RefObject } from "react";
import { ArrowUp, ChevronDown, Folder, FolderPlus, Menu, PanelRight, Plus, SquareTerminal } from "lucide-react";
import { ProviderSelector, type ProviderChoice } from "../../ProviderSelector";
import { TokenizedTextarea } from "../../TokenizedTextarea";
import { WorkspacePicker } from "../../WorkspacePicker";

export function WorkbenchEmptyPane(props: {
  sidebarOpen: boolean;
  rightSidebarOpen: boolean;
  onOpenLeft: () => void;
  onExpandSidebar: () => void;
  onOpenRight: () => void;
  onExpandInspector: () => void;
  onOpenTerminal: () => void;
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
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
            onClick={props.onOpenTerminal}
            aria-label="Open terminal"
            title="Open terminal"
          >
            <SquareTerminal size={16} />
          </button>
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
              textareaClassName="w-full resize-none bg-[var(--app-subtle-bg)] rounded-2xl border border-[var(--app-border)] px-4 py-3 pr-14 pb-12 text-base focus:outline-none focus:ring-1 focus:ring-[var(--ring)] min-h-[120px]"
              contentClassName="px-4 py-3 pr-14 pb-12 text-base min-h-[120px]"
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
            <div ref={props.workspacePickerRef} className="absolute bottom-3 left-3 z-10 flex items-center gap-1.5">
              <button
                type="button"
                onClick={props.onOpenFileReference}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-bg)] transition-colors"
                title="Insert file or folder reference"
              >
                <Plus size={16} />
              </button>
              {props.workspaceDirs.length === 0 ? (
                <WorkspacePicker
                  currentDir=""
                  triggerLabel="Workspace"
                  triggerIcon={<FolderPlus size={13} />}
                  triggerClassName="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-bg)] transition-colors"
                  onSelect={props.onAddWorkspace}
                />
              ) : (
                <button
                  type="button"
                  onClick={props.onToggleWorkspacePicker}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-bg)] transition-colors"
                >
                  <Folder size={13} />
                  <span className="max-w-[140px] truncate">
                    {props.availableWorkspaceDir
                      ? props.availableWorkspaceDir.split("/").pop()
                      : "Workspace"}
                  </span>
                  <ChevronDown size={12} className={`transition-transform ${props.workspacePickerOpen ? "rotate-180" : ""}`} />
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
            </div>
            <button
              type="button"
              disabled={!props.emptyStateDraft.trim() || !props.availableWorkspaceDir}
              onClick={props.onEmptyStateSend}
              className="absolute bottom-3 right-3 h-10 w-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 disabled:opacity-40 transition-colors"
            >
              <ArrowUp size={18} />
            </button>
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
