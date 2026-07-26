import type { ClipboardEventHandler, RefObject } from "react";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import type { ProviderChoice } from "../../ProviderSelector";
import type { SessionModeChoice } from "../../../session-mode-ui";
import type { ComposerAttachmentItem } from "../../../hooks/useComposerAttachments";
import { NewSessionComposer } from "./NewSessionComposer";
import { CouncilLogo } from "../../CouncilLogo";
import { MobileSidebarToggleButton } from "../shells/MobileSidebarToggleButton";

export function WorkbenchEmptyPane(props: {
  sidebarOpen: boolean;
  onOpenLeft: () => void;
  onExpandSidebar: () => void;
  showLeftSidebarControls?: boolean;
  emptyStateComposerRef: RefObject<HTMLTextAreaElement | null>;
  emptyStateDraft: string;
  emptyStateAttachments?: readonly ComposerAttachmentItem[] | undefined;
  emptyStateAttachmentCount?: number | undefined;
  emptyStateAttachmentUploadPending?: boolean | undefined;
  emptyStateAttachmentError?: string | null | undefined;
  onEmptyStateDraftChange: (value: string) => void;
  onEmptyStatePaste?: ClipboardEventHandler<HTMLTextAreaElement> | undefined;
  onUploadEmptyStateFiles?: ((files: readonly File[]) => void | Promise<void>) | undefined;
  onRemoveEmptyStateAttachment?: ((index: number) => void) | undefined;
  onRemoveLastEmptyStateAttachment?: (() => void) | undefined;
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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="pointer-events-none absolute left-2 top-2 z-20 flex items-center">
        <div className="flex min-w-0 items-center">
          {showLeftSidebarControls ? (
            <MobileSidebarToggleButton
              className="pointer-events-auto md:hidden"
              onOpen={props.onOpenLeft}
            />
          ) : null}
          {showLeftSidebarControls && !props.sidebarOpen ? (
            <span className="hidden h-8 w-8 shrink-0 md:block" aria-hidden="true" />
          ) : null}
        </div>
      </div>
      <NewSessionComposer
        composerRef={props.emptyStateComposerRef}
        draft={props.emptyStateDraft}
        draftAttachments={props.emptyStateAttachments}
        draftAttachmentCount={props.emptyStateAttachmentCount}
        attachmentUploadPending={props.emptyStateAttachmentUploadPending}
        attachmentError={props.emptyStateAttachmentError}
        onDraftChange={props.onEmptyStateDraftChange}
        onComposerPaste={props.onEmptyStatePaste}
        onUploadFiles={props.onUploadEmptyStateFiles}
        onRemoveDraftAttachment={props.onRemoveEmptyStateAttachment}
        onRemoveLastDraftAttachment={props.onRemoveLastEmptyStateAttachment}
        onSend={props.onEmptyStateSend}
        canSend={Boolean(
          (props.emptyStateDraft.trim() || (props.emptyStateAttachmentCount ?? 0) > 0) &&
            props.availableWorkspaceDir &&
            !props.emptyStateAttachmentUploadPending,
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
          <div className="flex w-full justify-center">
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
    </div>
  );
}
