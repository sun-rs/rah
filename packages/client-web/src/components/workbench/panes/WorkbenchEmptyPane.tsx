import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import { ArrowUp, ChevronDown, Folder, FolderPlus, Menu, Plus } from "lucide-react";
import { ProviderSelector, type ProviderChoice } from "../../ProviderSelector";
import { SessionControlPopover } from "../../SessionControlPopover";
import { SessionModelControls } from "../../SessionModelControls";
import { SessionModeControls } from "../../SessionModeControls";
import { TokenizedTextarea } from "../../TokenizedTextarea";
import { WorkspacePicker } from "../../WorkspacePicker";
import {
  EMPTY_STATE_COMPOSER_LAYOUT,
  shouldCompactEmptyStateSessionControls,
} from "../../../composer-contract";
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
  modelCatalog: ProviderModelCatalog | null;
  modelCatalogLoading: boolean;
  selectedModelId: string | null;
  selectedReasoningId: string | null;
  onModelChange: (modelId: string, defaultReasoningId?: string | null) => void;
  onReasoningChange: (reasoningId: string) => void;
  accessModes: SessionModeChoice[];
  selectedAccessModeId: string | null;
  planModeAvailable: boolean;
  planModeEnabled: boolean;
  onAccessModeChange: (modeId: string) => void;
  onPlanModeToggle: (enabled: boolean) => void;
}) {
  const controlsRowRef = useRef<HTMLDivElement | null>(null);
  const [controlsRowWidth, setControlsRowWidth] = useState<number | null>(null);
  const workspaceLabel = props.availableWorkspaceDir
    ? props.availableWorkspaceDir.split("/").filter(Boolean).pop() ?? props.availableWorkspaceDir
    : "Workspace";
  const workspaceShouldMarquee = workspaceLabel.length > 6;
  const compactSessionControls = shouldCompactEmptyStateSessionControls(controlsRowWidth);

  useLayoutEffect(() => {
    const node = controlsRowRef.current;
    if (!node) return;
    const updateWidth = () => {
      setControlsRowWidth(Math.floor(node.getBoundingClientRect().width));
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <header className="h-14 flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 bg-[var(--app-bg)]/80 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            className="icon-click-feedback inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] md:hidden"
            onClick={props.onOpenLeft}
            aria-label="Open sidebar"
          >
            <Menu size={18} />
          </button>
          {!props.sidebarOpen && (
            <button
              type="button"
              className="icon-click-feedback hidden md:inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
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
      </header>
      <div className="flex-1 flex flex-col items-center justify-center px-4 md:px-6 overflow-y-auto custom-scrollbar">
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

            {/* Controls anchored to the bottom edge of the textarea card */}
            <div
              ref={controlsRowRef}
              className={EMPTY_STATE_COMPOSER_LAYOUT.controlsRowClassName}
            >
              <div className={EMPTY_STATE_COMPOSER_LAYOUT.leftControlsClassName}>
                <button
                  type="button"
                  onClick={props.onOpenFileReference}
                  className={EMPTY_STATE_COMPOSER_LAYOUT.attachButtonClassName}
                  title="Insert file or folder reference"
                >
                  <Plus size={18} />
                </button>

                {props.workspaceDirs.length === 0 ? (
                  <WorkspacePicker
                    currentDir=""
                    triggerLabel="Workspace"
                    triggerIcon={<FolderPlus size={12} />}
                    triggerClassName={EMPTY_STATE_COMPOSER_LAYOUT.pillClassName}
                    onSelect={props.onAddWorkspace}
                  />
                ) : (
                  <div className="relative" ref={props.workspacePickerRef}>
                    <button
                      type="button"
                      onClick={props.onToggleWorkspacePicker}
                      className={EMPTY_STATE_COMPOSER_LAYOUT.pillClassName}
                      title={props.availableWorkspaceDir || "Workspace"}
                    >
                      <Folder size={12} />
                      <span
                        className="rah-marquee min-w-0 flex-1 text-left"
                        data-marquee={workspaceShouldMarquee ? "true" : "false"}
                      >
                        <span className={workspaceShouldMarquee ? "rah-marquee-track" : "block truncate"}>
                          <span>{workspaceLabel}</span>
                          {workspaceShouldMarquee ? <span aria-hidden="true">{workspaceLabel}</span> : null}
                        </span>
                      </span>
                      <ChevronDown
                        size={11}
                        className={`shrink-0 transition-transform ${props.workspacePickerOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    {props.workspaceDirs.length > 0 && props.workspacePickerOpen ? (
                      <div className="rah-popover-panel absolute bottom-full left-0 z-20 mb-1.5 w-56 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-lg">
                        {props.workspaceDirs.map((dir) => (
                          <button
                            key={dir}
                            type="button"
                            onClick={() => props.onSelectWorkspace(dir)}
                            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                              dir === props.availableWorkspaceDir
                                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                                : "text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                            }`}
                          >
                            <Folder size={13} className="shrink-0 text-[var(--app-hint)]" />
                            <span className="truncate">{dir}</span>
                            {dir === props.availableWorkspaceDir ? (
                              <span className="ml-auto text-[10px] text-[var(--app-hint)]">●</span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}

                <SessionControlPopover
                  accessModes={props.accessModes}
                  selectedAccessModeId={props.selectedAccessModeId}
                  planModeAvailable={props.planModeAvailable}
                  planModeEnabled={props.planModeEnabled}
                  modelCatalog={props.modelCatalog}
                  modelCatalogLoading={props.modelCatalogLoading}
                  selectedModelId={props.selectedModelId}
                  selectedReasoningId={props.selectedReasoningId}
                  allowProviderDefault
                  showModel
                  buttonClassName={`${EMPTY_STATE_COMPOSER_LAYOUT.attachButtonClassName} ${
                    compactSessionControls ? "" : "hidden"
                  }`}
                  onAccessModeChange={props.onAccessModeChange}
                  onPlanModeToggle={props.onPlanModeToggle}
                  onModelChange={props.onModelChange}
                  onReasoningChange={props.onReasoningChange}
                />

                <div
                  className={`items-center gap-2 ${
                    compactSessionControls ? "hidden" : "flex"
                  }`}
                >
                  <SessionModeControls
                    variant="toolbar"
                    accessModes={props.accessModes}
                    selectedAccessModeId={props.selectedAccessModeId}
                    planModeAvailable={props.planModeAvailable}
                    planModeEnabled={props.planModeEnabled}
                    onAccessModeChange={props.onAccessModeChange}
                    onPlanModeToggle={props.onPlanModeToggle}
                  />

                  <SessionModelControls
                    catalog={props.modelCatalog}
                    selectedModelId={props.selectedModelId}
                    selectedReasoningId={props.selectedReasoningId}
                    loading={props.modelCatalogLoading}
                    allowProviderDefault
                    mobileIconOnly
                    onModelChange={props.onModelChange}
                    onReasoningChange={props.onReasoningChange}
                  />
                </div>
              </div>

              <button
                type="button"
                disabled={!props.emptyStateDraft.trim() || !props.availableWorkspaceDir}
                onClick={props.onEmptyStateSend}
                className={EMPTY_STATE_COMPOSER_LAYOUT.sendButtonClassName}
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
