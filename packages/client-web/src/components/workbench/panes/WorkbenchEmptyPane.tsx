import type { RefObject } from "react";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import { Menu, PanelRight, UsersRound } from "lucide-react";
import type { ProviderChoice } from "../../ProviderSelector";
import type { SessionModeChoice } from "../../../session-mode-ui";
import { NewSessionComposer } from "./NewSessionComposer";

export function WorkbenchEmptyPane(props: {
  sidebarOpen: boolean;
  rightSidebarOpen: boolean;
  onOpenLeft: () => void;
  onExpandSidebar: () => void;
  onOpenRight: () => void;
  onExpandInspector: () => void;
  onToggleInspector: () => void;
  inspectorToggleOpen: boolean;
  showInspectorToggle?: boolean;
  inspectorToggleClassName?: string;
  reserveRightPanelToggleSpace?: boolean;
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
  return (
    <>
      <header
        className={`h-14 flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 bg-[var(--app-bg)]/80 backdrop-blur-sm shrink-0 ${
          props.reserveRightPanelToggleSpace
            ? "md:pr-[calc(max(1rem,env(safe-area-inset-right))+2.75rem)]"
            : ""
        }`}
      >
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
              className="icon-click-feedback hidden h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] md:inline-flex"
              onClick={props.onExpandSidebar}
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <Menu size={18} />
            </button>
          )}
          <div className="min-w-0 md:hidden">
            <div className="text-sm font-medium text-[var(--app-fg)]">RAH</div>
            <div className="text-[11px] text-[var(--app-hint)]">
              Open the sidebar
            </div>
          </div>
        </div>
        {props.showInspectorToggle !== false ? (
          <button
            type="button"
            className={`icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] ${props.inspectorToggleClassName ?? ""}`}
            onClick={props.onToggleInspector}
            aria-label={props.inspectorToggleOpen ? "Collapse inspector" : "Expand inspector"}
            title={props.inspectorToggleOpen ? "Collapse inspector" : "Expand inspector"}
          >
            <PanelRight size={16} />
          </button>
        ) : null}
      </header>
      <NewSessionComposer
        composerRef={props.emptyStateComposerRef}
        draft={props.emptyStateDraft}
        onDraftChange={props.onEmptyStateDraftChange}
        onSend={props.onEmptyStateSend}
        canSend={Boolean(props.emptyStateDraft.trim() && props.availableWorkspaceDir)}
        workspacePickerRef={props.workspacePickerRef}
        onOpenFileReference={props.onOpenFileReference}
        workspaceDirs={props.workspaceDirs}
        availableWorkspaceDir={props.availableWorkspaceDir}
        workspacePickerOpen={props.workspacePickerOpen}
        onToggleWorkspacePicker={props.onToggleWorkspacePicker}
        onSelectWorkspace={props.onSelectWorkspace}
        onAddWorkspace={props.onAddWorkspace}
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
              <UsersRound size={14} />
              New Council
            </button>
          </div>
        }
      />
    </>
  );
}
