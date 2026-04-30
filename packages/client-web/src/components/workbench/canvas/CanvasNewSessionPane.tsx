import { useLayoutEffect, useRef, useState } from "react";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import { ArrowUp, ChevronDown, Folder, FolderPlus, History } from "lucide-react";
import type { ProviderChoice } from "../../ProviderSelector";
import { ProviderSelector } from "../../ProviderSelector";
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

export function CanvasNewSessionPane(props: {
  workspaceDirs: string[];
  availableWorkspaceDir: string;
  provider: ProviderChoice;
  modelCatalog: ProviderModelCatalog | null;
  modelCatalogLoading: boolean;
  selectedModelId: string | null;
  selectedReasoningId: string | null;
  accessModes: SessionModeChoice[];
  selectedAccessModeId: string | null;
  planModeAvailable: boolean;
  planModeEnabled: boolean;
  startPending: boolean;
  onAddWorkspace: (dir: string) => void;
  onSelectWorkspace: (dir: string) => void;
  onProviderChange: (provider: ProviderChoice) => void;
  onAccessModeChange: (modeId: string) => void;
  onPlanModeToggle: (enabled: boolean) => void;
  onModelChange: (modelId: string, defaultReasoningId?: string | null) => void;
  onReasoningChange: (reasoningId: string) => void;
  onStart: (initialInput: string) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [controlsRowWidth, setControlsRowWidth] = useState<number | null>(null);
  const [surfaceWidth, setSurfaceWidth] = useState<number | null>(null);
  const controlsRowRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const workspacePickerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const workspaceLabel = props.availableWorkspaceDir
    ? props.availableWorkspaceDir.split("/").filter(Boolean).pop() ?? props.availableWorkspaceDir
    : "Workspace";
  const canStart = Boolean(draft.trim() && props.availableWorkspaceDir && !props.startPending);
  const compactSessionControls = shouldCompactEmptyStateSessionControls(controlsRowWidth);
  const providerSelectorMode: "grid" | "icons" =
    surfaceWidth !== null && surfaceWidth < 560 ? "icons" : "grid";

  useLayoutEffect(() => {
    const nodes = [
      { node: controlsRowRef.current, setWidth: setControlsRowWidth },
      { node: surfaceRef.current, setWidth: setSurfaceWidth },
    ];
    const observers: ResizeObserver[] = [];
    const cleanupListeners: Array<() => void> = [];

    for (const { node, setWidth } of nodes) {
      if (!node) continue;
      const updateWidth = () => {
        setWidth(Math.floor(node.getBoundingClientRect().width));
      };
      updateWidth();
      if (typeof ResizeObserver === "undefined") {
        window.addEventListener("resize", updateWidth);
        cleanupListeners.push(() => window.removeEventListener("resize", updateWidth));
      } else {
        const observer = new ResizeObserver(updateWidth);
        observer.observe(node);
        observers.push(observer);
      }
    }

    return () => {
      for (const observer of observers) {
        observer.disconnect();
      }
      for (const cleanup of cleanupListeners) {
        cleanup();
      }
    };
  }, []);

  const submit = () => {
    if (!canStart) return;
    props.onStart(draft.trim());
  };

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto custom-scrollbar px-4 py-4 md:px-6">
      <div ref={surfaceRef} className="w-full max-w-2xl space-y-5 md:space-y-6">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-[var(--app-fg)] md:text-2xl">
            What would you like to build?
          </h1>
        </div>

        <div className="relative">
          <TokenizedTextarea
            ref={textareaRef}
            textareaClassName={EMPTY_STATE_COMPOSER_LAYOUT.textareaClassName}
            contentClassName={EMPTY_STATE_COMPOSER_LAYOUT.textareaContentClassName}
            placeholder="Message…"
            rows={3}
            value={draft}
            onChange={setDraft}
            onKeyDown={(event) => {
              const nativeEvent = event.nativeEvent as KeyboardEvent;
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !nativeEvent.isComposing &&
                nativeEvent.keyCode !== 229
              ) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div
            ref={controlsRowRef}
            className={EMPTY_STATE_COMPOSER_LAYOUT.controlsRowClassName}
          >
            <div className={EMPTY_STATE_COMPOSER_LAYOUT.leftControlsClassName}>
              {props.workspaceDirs.length === 0 ? (
                <WorkspacePicker
                  currentDir=""
                  triggerLabel="Workspace"
                  triggerIcon={<FolderPlus size={12} />}
                  triggerClassName={EMPTY_STATE_COMPOSER_LAYOUT.pillClassName}
                  onSelect={props.onAddWorkspace}
                />
              ) : (
                <div ref={workspacePickerRef} className="relative">
                  <button
                    type="button"
                    className={EMPTY_STATE_COMPOSER_LAYOUT.pillClassName}
                    title={props.availableWorkspaceDir || "Workspace"}
                    onClick={() => setWorkspaceOpen((open) => !open)}
                  >
                    <Folder size={12} />
                    <span className="truncate">{workspaceLabel}</span>
                    <ChevronDown
                      size={11}
                      className={`shrink-0 transition-transform ${workspaceOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  {workspaceOpen ? (
                    <div className="rah-popover-panel absolute bottom-full left-0 z-50 mb-1.5 max-h-64 w-64 overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-xl">
                      {props.workspaceDirs.map((dir) => (
                        <button
                          key={dir}
                          type="button"
                          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                            dir === props.availableWorkspaceDir
                              ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                              : "text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                          }`}
                          onClick={() => {
                            props.onSelectWorkspace(dir);
                            setWorkspaceOpen(false);
                          }}
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

              <div className={`items-center gap-2 ${compactSessionControls ? "hidden" : "flex"}`}>
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
              disabled={!canStart}
              className={EMPTY_STATE_COMPOSER_LAYOUT.sendButtonClassName}
              onClick={submit}
              aria-label="Start session"
              title={props.startPending ? "Starting..." : "Start session"}
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl">
          <ProviderSelector
            value={props.provider}
            onChange={props.onProviderChange}
            mode={providerSelectorMode}
          />
        </div>

        <div className="flex w-full justify-center">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--app-border)] px-3 text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            onClick={props.onBack}
          >
            <History size={14} />
            Back to choices
          </button>
        </div>
      </div>
    </div>
  );
}
