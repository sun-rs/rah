import type { ClipboardEventHandler, RefObject } from "react";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import { Menu, PanelRight } from "lucide-react";
import type { ProviderChoice } from "../../ProviderSelector";
import type { SessionModeChoice } from "../../../session-mode-ui";
import { NewSessionComposer } from "./NewSessionComposer";
import { CouncilLogo } from "../../CouncilLogo";
import {
  HEADER_EDGE_TOGGLE_BUTTON_CLASS,
  HEADER_EDGE_TOGGLE_ICON_SIZE,
  HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS,
} from "../header-button-styles";

export function WorkbenchEmptyPane(props: {
  sidebarOpen: boolean;
  rightSidebarOpen: boolean;
  onOpenLeft: () => void;
  onExpandSidebar: () => void;
  showLeftSidebarControls?: boolean;
  onOpenRight: () => void;
  onExpandInspector: () => void;
  onToggleInspector: () => void;
  inspectorToggleOpen: boolean;
  showInspectorToggle?: boolean;
  inspectorToggleClassName?: string;
  reserveRightPanelToggleSpace?: boolean;
  emptyStateComposerRef: RefObject<HTMLTextAreaElement | null>;
  emptyStateDraft: string;
  emptyStateImageUrls?: readonly string[] | undefined;
  emptyStateImageCount?: number | undefined;
  onEmptyStateDraftChange: (value: string) => void;
  onEmptyStatePaste?: ClipboardEventHandler<HTMLTextAreaElement> | undefined;
  onClearEmptyStateImages?: (() => void) | undefined;
  onRemoveEmptyStateImage?: ((index: number) => void) | undefined;
  onRemoveLastEmptyStateImage?: (() => void) | undefined;
  onEmptyStateSend: () => void;
  workspacePickerRef: RefObject<HTMLDivElement | null>;
  onOpenFileReference: () => void;
  workspaceDirs: string[];
  availableWorkspaceDir: string;
  workspacePickerOpen: boolean;
  onToggleWorkspacePicker: () => void;
  onSelectWorkspace: (dir: string) => void;
  onChooseNewWorkspace: (dir: string) => void;
  newSessionProvider: ProviderChoice;
  onChangeProvider: (provider: ProviderChoice) => void;
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
  onOpenNewCouncil: () => void;
}) {
  const showLeftSidebarControls = props.showLeftSidebarControls ?? true;
  return (
    <>
      <header
        className={`h-14 flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-2 bg-[var(--app-bg)]/80 backdrop-blur-sm shrink-0 ${
          props.reserveRightPanelToggleSpace
            ? "md:pr-11"
            : ""
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {showLeftSidebarControls ? (
            <button
              type="button"
              className={`${HEADER_EDGE_TOGGLE_BUTTON_CLASS} md:hidden`}
              onClick={props.onOpenLeft}
              aria-label="Open sidebar"
            >
              <Menu size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
            </button>
          ) : null}
          {showLeftSidebarControls && !props.sidebarOpen ? (
            <button
              type="button"
              className={`${HEADER_EDGE_TOGGLE_BUTTON_CLASS} hidden md:inline-flex`}
              onClick={props.onExpandSidebar}
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <Menu size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
            </button>
          ) : null}
          {showLeftSidebarControls ? (
            <div className="min-w-0 md:hidden">
            <div className="text-sm font-medium text-[var(--app-fg)]">RAH</div>
            <div className="text-[11px] text-[var(--app-hint)]">
              Open the sidebar
            </div>
            </div>
          ) : null}
        </div>
        {props.showInspectorToggle !== false ? (
          <button
            type="button"
            className={`${HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS}${props.inspectorToggleClassName ? ` ${props.inspectorToggleClassName}` : ""}`}
            onClick={props.onToggleInspector}
            aria-label={props.inspectorToggleOpen ? "Collapse inspector" : "Expand inspector"}
            title={props.inspectorToggleOpen ? "Collapse inspector" : "Expand inspector"}
          >
            <PanelRight size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
          </button>
        ) : null}
      </header>
      <NewSessionComposer
        composerRef={props.emptyStateComposerRef}
        draft={props.emptyStateDraft}
        draftImageUrls={props.emptyStateImageUrls}
        draftImageCount={props.emptyStateImageCount}
        onDraftChange={props.onEmptyStateDraftChange}
        onComposerPaste={props.onEmptyStatePaste}
        onClearDraftImages={props.onClearEmptyStateImages}
        onRemoveDraftImage={props.onRemoveEmptyStateImage}
        onRemoveLastDraftImage={props.onRemoveLastEmptyStateImage}
        onSend={props.onEmptyStateSend}
        canSend={Boolean(
          (props.emptyStateDraft.trim() || (props.emptyStateImageCount ?? 0) > 0) &&
            props.availableWorkspaceDir,
        )}
        workspacePickerRef={props.workspacePickerRef}
        onOpenFileReference={props.onOpenFileReference}
        workspaceDirs={props.workspaceDirs}
        availableWorkspaceDir={props.availableWorkspaceDir}
        workspacePickerOpen={props.workspacePickerOpen}
        onToggleWorkspacePicker={props.onToggleWorkspacePicker}
        onSelectWorkspace={props.onSelectWorkspace}
        onChooseNewWorkspace={props.onChooseNewWorkspace}
        provider={props.newSessionProvider}
        onChangeProvider={props.onChangeProvider}
        providerSelectorMode="auto"
        modelCatalog={props.modelCatalog}
        modelCatalogLoading={props.modelCatalogLoading}
        selectedModelId={props.selectedModelId}
        selectedReasoningId={props.selectedReasoningId}
        onRequestCatalogRefresh={props.onRequestCatalogRefresh}
        onModelChange={props.onModelChange}
        onReasoningChange={props.onReasoningChange}
        accessModes={props.accessModes}
        selectedAccessModeId={props.selectedAccessModeId}
        planModeAvailable={props.planModeAvailable}
        planModeEnabled={props.planModeEnabled}
        onAccessModeChange={props.onAccessModeChange}
        onPlanModeToggle={props.onPlanModeToggle}
        footer={
          <div className="flex w-full justify-center pt-1">
            <button
              type="button"
              onClick={props.onOpenNewCouncil}
              className="icon-click-feedback inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-transparent px-3 text-xs font-medium text-[var(--app-hint)] transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
              aria-label="Start a Council"
              title="Start a Council"
            >
              <CouncilLogo className="h-4 w-4" tone="black" variant="bare" />
              New Council
            </button>
          </div>
        }
      />
    </>
  );
}
