import { useRef, useState } from "react";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import { History, UsersRound } from "lucide-react";
import type { ProviderChoice } from "../../ProviderSelector";
import type { SessionModeChoice } from "../../../session-mode-ui";
import { NewSessionComposer } from "../panes/NewSessionComposer";

export function CanvasNewSessionPane(props: {
  workspaceDirs: string[];
  availableWorkspaceDir: string;
  provider: ProviderChoice;
  modelCatalog: ProviderModelCatalog | null;
  modelCatalogLoading: boolean;
  selectedModelId: string | null;
  selectedReasoningId: string | null;
  onRequestCatalogRefresh: () => void;
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
  onOpenNewCouncil: () => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const workspacePickerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canStart = Boolean(draft.trim() && props.availableWorkspaceDir && !props.startPending);

  return (
    <NewSessionComposer
      className="flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto rah-scroll-panel rah-scroll-panel-y px-4 py-4 md:px-6"
      surfaceClassName="w-full max-w-2xl space-y-5 md:space-y-6"
      composerRef={textareaRef}
      draft={draft}
      onDraftChange={setDraft}
      onSend={() => props.onStart(draft.trim())}
      canSend={canStart}
      sendPending={props.startPending}
      workspacePickerRef={workspacePickerRef}
      workspaceDirs={props.workspaceDirs}
      availableWorkspaceDir={props.availableWorkspaceDir}
      workspacePickerOpen={workspaceOpen}
      onToggleWorkspacePicker={() => setWorkspaceOpen((open) => !open)}
      onSelectWorkspace={(dir) => {
        props.onSelectWorkspace(dir);
        setWorkspaceOpen(false);
      }}
      onAddWorkspace={props.onAddWorkspace}
      provider={props.provider}
      onChangeProvider={props.onProviderChange}
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
          <div className="inline-flex items-center gap-2">
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
            <button
              type="button"
              className="icon-click-feedback inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-transparent px-3 text-xs font-medium text-[var(--app-hint)] transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
              onClick={props.onBack}
              title="Back to choices"
            >
              <History size={14} />
              Back
            </button>
          </div>
        </div>
      }
    />
  );
}
