import { useRef, useState, type ClipboardEventHandler } from "react";
import type { ProviderModelCatalog } from "@rah/runtime-protocol";
import { History } from "lucide-react";
import type { ProviderChoice } from "../../ProviderSelector";
import { CouncilLogo } from "../../CouncilLogo";
import type { SessionModeChoice } from "../../../session-mode-ui";
import { NewSessionComposer } from "../panes/NewSessionComposer";
import {
  appendImageDataUrlsToText,
  imageFilesFromClipboardData,
  readImageDataUrlsFromClipboardData,
} from "../../../composer-image-attachments";
import { insertTextAtSelection } from "../../../composer-text-insertion";

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
  onProviderChange: (provider: ProviderChoice) => void;
  onAccessModeChange: (modeId: string) => void;
  onPlanModeToggle: (enabled: boolean) => void;
  onModelChange: (modelId: string, defaultReasoningId?: string | null) => void;
  onReasoningChange: (reasoningId: string) => void;
  onStart: (initialInput: string, workspaceDir: string) => void;
  onOpenNewCouncil: () => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [imageDataUrls, setImageDataUrls] = useState<string[]>([]);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [selectedWorkspaceDir, setSelectedWorkspaceDir] = useState<string | null>(null);
  const workspacePickerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const outgoingDraft = appendImageDataUrlsToText(draft, imageDataUrls);
  const availableWorkspaceDir = selectedWorkspaceDir ?? props.availableWorkspaceDir;
  const canStart = Boolean(outgoingDraft && availableWorkspaceDir && !props.startPending);
  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (imageFilesFromClipboardData(event.clipboardData).length === 0) {
      return;
    }
    event.preventDefault();
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) {
      const textarea = textareaRef.current ?? event.currentTarget;
      setDraft((current) => {
        const { nextValue, caret } = insertTextAtSelection({
          current,
          selectionStart: textarea.selectionStart ?? current.length,
          selectionEnd: textarea.selectionEnd ?? current.length,
          insertedText: pastedText,
        });
        queueMicrotask(() => {
          textarea.focus();
          textarea.setSelectionRange(caret, caret);
        });
        return nextValue;
      });
    }
    void readImageDataUrlsFromClipboardData(event.clipboardData)
      .then((urls) => {
        if (urls.length > 0) {
          setImageDataUrls((current) => [...current, ...urls]);
        }
      })
      .catch(() => undefined);
  };

  return (
    <NewSessionComposer
      className="flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto rah-scroll-panel rah-scroll-panel-y px-4 py-4 md:px-6"
      surfaceClassName="w-full max-w-2xl space-y-5 md:space-y-6"
      composerRef={textareaRef}
      draft={draft}
      draftImageUrls={imageDataUrls}
      draftImageCount={imageDataUrls.length}
      onDraftChange={setDraft}
      onComposerPaste={handlePaste}
      onClearDraftImages={() => setImageDataUrls([])}
      onRemoveDraftImage={(index) =>
        setImageDataUrls((current) =>
          current.filter((_, candidateIndex) => candidateIndex !== index),
        )
      }
      onRemoveLastDraftImage={() => setImageDataUrls((current) => current.slice(0, -1))}
      onSend={() => {
        props.onStart(outgoingDraft, availableWorkspaceDir);
        setDraft("");
        setImageDataUrls([]);
        setSelectedWorkspaceDir(null);
      }}
      canSend={canStart}
      sendPending={props.startPending}
      workspacePickerRef={workspacePickerRef}
      workspaceDirs={props.workspaceDirs}
      availableWorkspaceDir={availableWorkspaceDir}
      workspacePickerOpen={workspaceOpen}
      onToggleWorkspacePicker={() => setWorkspaceOpen((open) => !open)}
      onSelectWorkspace={(dir) => {
        setSelectedWorkspaceDir(dir);
        setWorkspaceOpen(false);
      }}
      onChooseNewWorkspace={setSelectedWorkspaceDir}
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
              <CouncilLogo className="h-4 w-4" tone="black" variant="bare" />
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
