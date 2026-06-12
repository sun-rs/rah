import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import { ArrowUp, ChevronDown, Folder, FolderPlus, Plus } from "lucide-react";
import { ProviderSelector, type ProviderChoice } from "../../ProviderSelector";
import { SessionControlPopover } from "../../SessionControlPopover";
import { SessionModelControls } from "../../SessionModelControls";
import { SessionModeControls } from "../../SessionModeControls";
import { OverlayScrollArea } from "../../OverlayScrollArea";
import { TokenizedTextarea } from "../../TokenizedTextarea";
import { WorkspacePicker } from "../../WorkspacePicker";
import { ComposerImageAttachmentBadge } from "../../ComposerImageAttachmentBadge";
import {
  EMPTY_STATE_COMPOSER_LAYOUT,
  shouldCompactEmptyStateSessionControls,
  shouldHideEmptyStateSessionControl,
  shouldUseIconOnlyEmptyStateWorkspace,
} from "../../../composer-contract";
import type { SessionModeChoice } from "../../../session-mode-ui";

function MarqueeText(props: { text: string; enabled: boolean }) {
  return (
    <span
      className="rah-marquee min-w-0 flex-1 text-left"
      data-marquee={props.enabled ? "true" : "false"}
    >
      <span className={props.enabled ? "rah-marquee-track" : "block truncate"}>
        <span>{props.text}</span>
        {props.enabled ? <span aria-hidden="true">{props.text}</span> : null}
      </span>
    </span>
  );
}

export function NewSessionComposer(props: {
  className?: string;
  surfaceClassName?: string;
  titleClassName?: string;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  draftImageUrls?: readonly string[] | undefined;
  draftImageCount?: number | undefined;
  onDraftChange: (value: string) => void;
  onComposerPaste?: ClipboardEventHandler<HTMLTextAreaElement> | undefined;
  onClearDraftImages?: (() => void) | undefined;
  onRemoveDraftImage?: ((index: number) => void) | undefined;
  onRemoveLastDraftImage?: (() => void) | undefined;
  onSend: () => void;
  canSend: boolean;
  sendPending?: boolean;
  workspacePickerRef?: RefObject<HTMLDivElement | null>;
  onOpenFileReference?: (() => void) | undefined;
  workspaceDirs: string[];
  availableWorkspaceDir: string;
  workspacePickerOpen: boolean;
  onToggleWorkspacePicker: () => void;
  onSelectWorkspace: (dir: string) => void;
  onAddWorkspace: (dir: string) => void;
  provider: ProviderChoice;
  onChangeProvider: (provider: ProviderChoice) => void;
  providerSelectorMode?: "grid" | "icons" | "auto";
  modelCatalog: ProviderModelCatalog | null;
  modelCatalogLoading: boolean;
  selectedModelId: string | null;
  selectedReasoningId: string | null;
  onRequestCatalogRefresh: () => void;
  onModelChange: (modelId: string, defaultReasoningId?: string | null) => void;
  onReasoningChange: (reasoningId: string) => void;
  accessModes: SessionModeChoice[];
  selectedAccessModeId: string | null;
  planModeAvailable: boolean;
  planModeEnabled: boolean;
  onAccessModeChange: (modeId: string) => void;
  onPlanModeToggle: (enabled: boolean) => void;
  footer?: ReactNode;
}) {
  const controlsRowRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [controlsRowWidth, setControlsRowWidth] = useState<number | null>(null);
  const [surfaceWidth, setSurfaceWidth] = useState<number | null>(null);
  const workspaceLabel = props.availableWorkspaceDir
    ? props.availableWorkspaceDir.split("/").filter(Boolean).pop() ?? props.availableWorkspaceDir
    : "Workspace";
  const workspaceShouldMarquee = workspaceLabel.length > 6;
  const compactSessionControls = shouldCompactEmptyStateSessionControls(controlsRowWidth);
  const iconOnlyWorkspace = shouldUseIconOnlyEmptyStateWorkspace(controlsRowWidth);
  const hideSessionControl = shouldHideEmptyStateSessionControl(controlsRowWidth);
  const providerSelectorMode =
    props.providerSelectorMode === "auto"
      ? surfaceWidth !== null && surfaceWidth < 560
        ? "icons"
        : "grid"
      : props.providerSelectorMode ?? "grid";
  const draftImageUrls = props.draftImageUrls ?? [];
  const textareaHasImages = draftImageUrls.length > 0;

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
    if (!props.canSend) return;
    props.onSend();
  };

  return (
    <div
      className={
        props.className ??
        "flex-1 flex flex-col items-center justify-center px-4 md:px-6 overflow-y-auto rah-scroll-panel rah-scroll-panel-y"
      }
    >
      <div
        ref={surfaceRef}
        className={
          props.surfaceClassName ??
          "w-full min-w-0 max-w-[min(42rem,100%)] -translate-y-6 space-y-5 md:-translate-y-8 md:space-y-6"
        }
      >
        <div className="text-center">
          <h1 className={props.titleClassName ?? "text-2xl font-semibold text-[var(--app-fg)]"}>
            What would you like to build?
          </h1>
        </div>

        <div className="relative">
          <ComposerImageAttachmentBadge
            imageUrls={draftImageUrls}
            onRemove={props.onRemoveDraftImage}
            className="pointer-events-auto absolute left-4 top-3 z-20 md:left-5 md:top-4"
          />
          <TokenizedTextarea
            ref={props.composerRef}
            wrapperClassName={EMPTY_STATE_COMPOSER_LAYOUT.textareaWrapperClassName}
            textareaClassName={`${EMPTY_STATE_COMPOSER_LAYOUT.textareaClassName} ${
              textareaHasImages ? "pt-16 md:pt-[4.5rem]" : ""
            }`}
            contentClassName={EMPTY_STATE_COMPOSER_LAYOUT.textareaContentClassName}
            placeholder="Message…"
            rows={3}
            value={props.draft}
            onChange={props.onDraftChange}
            onPaste={props.onComposerPaste}
            onKeyDown={(event) => {
              const nativeEvent = event.nativeEvent as KeyboardEvent;
              if (
                event.key === "Backspace" &&
                props.draft.length === 0 &&
                draftImageUrls.length > 0
              ) {
                event.preventDefault();
                props.onRemoveLastDraftImage?.();
                return;
              }
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

          <div ref={controlsRowRef} className={EMPTY_STATE_COMPOSER_LAYOUT.controlsRowClassName}>
            <div className={EMPTY_STATE_COMPOSER_LAYOUT.leftControlsClassName}>
              {props.onOpenFileReference ? (
                <button
                  type="button"
                  onClick={props.onOpenFileReference}
                  className={EMPTY_STATE_COMPOSER_LAYOUT.attachButtonClassName}
                  title="Insert file or folder reference"
                >
                  <Plus size={18} />
                </button>
              ) : null}

              {props.workspaceDirs.length === 0 ? (
                <WorkspacePicker
                  currentDir=""
                  triggerLabel={iconOnlyWorkspace ? "" : "Workspace"}
                  triggerIcon={<FolderPlus size={iconOnlyWorkspace ? 18 : 12} />}
                  triggerAriaLabel="Select workspace"
                  triggerClassName={
                    iconOnlyWorkspace
                      ? EMPTY_STATE_COMPOSER_LAYOUT.attachButtonClassName
                      : EMPTY_STATE_COMPOSER_LAYOUT.pillClassName
                  }
                  onSelect={props.onAddWorkspace}
                />
              ) : (
                <div className="relative shrink-0" ref={props.workspacePickerRef}>
                  <button
                    type="button"
                    onClick={props.onToggleWorkspacePicker}
                    aria-label="Select workspace"
                    className={
                      iconOnlyWorkspace
                        ? EMPTY_STATE_COMPOSER_LAYOUT.attachButtonClassName
                        : EMPTY_STATE_COMPOSER_LAYOUT.pillClassName
                    }
                    title={props.availableWorkspaceDir || "Workspace"}
                  >
                    <Folder size={iconOnlyWorkspace ? 18 : 12} />
                    {iconOnlyWorkspace ? null : (
                      <>
                        <MarqueeText text={workspaceLabel} enabled={workspaceShouldMarquee} />
                        <ChevronDown
                          size={11}
                          className={`shrink-0 transition-transform ${props.workspacePickerOpen ? "rotate-180" : ""}`}
                        />
                      </>
                    )}
                  </button>
                  {props.workspaceDirs.length > 0 && props.workspacePickerOpen ? (
                    <div className="rah-popover-panel absolute bottom-full left-0 z-50 mb-1.5 max-h-[min(18rem,calc(100dvh-12rem))] w-[min(34rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg">
                      <OverlayScrollArea
                        className="max-h-[min(18rem,calc(100dvh-12rem))]"
                        viewportClassName="max-h-[min(18rem,calc(100dvh-12rem))]"
                        contentClassName="p-1.5"
                        scrollAriaLabel="Workspaces"
                      >
                        {props.workspaceDirs.map((dir) => (
                          <button
                            key={dir}
                            type="button"
                            onClick={() => props.onSelectWorkspace(dir)}
                            title={dir}
                            className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                              dir === props.availableWorkspaceDir
                                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                                : "text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                            }`}
                          >
                            <Folder size={13} className="shrink-0 text-[var(--app-hint)]" />
                            <MarqueeText text={dir} enabled={dir.length > 34} />
                            {dir === props.availableWorkspaceDir ? (
                              <span className="shrink-0 text-[10px] text-[var(--app-hint)]">●</span>
                            ) : null}
                          </button>
                        ))}
                      </OverlayScrollArea>
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
                  compactSessionControls && !hideSessionControl ? "" : "hidden"
                }`}
                onOpen={props.onRequestCatalogRefresh}
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
                  onOpen={props.onRequestCatalogRefresh}
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
                  onOpen={props.onRequestCatalogRefresh}
                  onModelChange={props.onModelChange}
                  onReasoningChange={props.onReasoningChange}
                />
              </div>
            </div>

            <button
              type="button"
              disabled={!props.canSend}
              onClick={submit}
              aria-label="Start session"
              title={props.sendPending ? "Starting..." : "Start session"}
              className={EMPTY_STATE_COMPOSER_LAYOUT.sendButtonClassName}
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>

        <div className="w-full max-w-3xl mx-auto">
          <ProviderSelector
            value={props.provider}
            onChange={props.onChangeProvider}
            mode={providerSelectorMode}
          />
        </div>

        {props.footer}
      </div>
    </div>
  );
}
