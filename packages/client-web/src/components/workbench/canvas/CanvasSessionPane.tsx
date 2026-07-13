import { useState, type ReactNode } from "react";
import type {
  PermissionResponseRequest,
  ProviderModelCatalog,
  SessionConfigValue,
  ConversationItemDetailKind,
  SessionSummary,
} from "@rah/runtime-protocol";
import type { ObjectPaneVariant } from "../../../object-pane-variant";
import { useWorkbenchComposerState } from "../../../hooks/useWorkbenchComposerState";
import { useNativeTuiDiagnostics } from "../../../hooks/useNativeTuiDiagnostics";
import { buildModelOptionValuesFromReasoning } from "../../../provider-capabilities";
import {
  canSessionStop,
  canSessionArchive,
  canSessionDelete,
  canSessionRename,
  canSessionRespondToPermissions,
  canSessionShowInfo,
  canSessionSwitchModel,
  canSessionSwitchModes,
  isReadOnlyReplay,
  isSessionGenerationActive,
} from "../../../session-capabilities";
import {
  createDefaultModeDraft,
  resolveSessionModeControlState,
  type SessionModeDraft,
} from "../../../session-mode-ui";
import { resolveSelectedModelDraft } from "../../SessionModelControls";
import { deriveComposerSurface } from "../../../composer-contract";
import { deriveWorkbenchNoticeState } from "../../../workbench-notice-contract";
import { isSessionAttachedToClient } from "../../../workbench-selectors";
import type { SessionProjection } from "../../../types";
import type { ProviderChoice } from "../../ProviderSelector";
import { FileReferencePicker } from "../../FileReferencePicker";
import { WorkbenchSelectedPane } from "../panes/WorkbenchSelectedPane";
import { ConversationSidePanelShell } from "../shells/ConversationSidePanelShell";
import {
  SessionSideDock,
  type SessionSideLayout,
} from "../session/SessionSideDock";

type ModelDraft = {
  modelId?: string | null;
  reasoningId?: string | null;
  optionValues?: Record<string, SessionConfigValue>;
};

export function CanvasSessionPane(props: {
  variant: ObjectPaneVariant;
  summary: SessionSummary;
  projection: SessionProjection | null;
  inspector?: ReactNode;
  sidePanelOpen: boolean;
  sidePanelToggleDisabled: boolean;
  onToggleSidePanel: () => void;
  clientId: string;
  hideToolCallsInChat: boolean;
  hideOpenCodeReasoningInChat: boolean;
  showModelInfoInChat: boolean;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "resume_history";
        sessionId: string;
      }
    | null;
  modelCatalog: ProviderModelCatalog | null;
  modelCatalogLoading: boolean;
  onRequestModelCatalogRefresh?: (() => void) | undefined;
  resumeModeDraft: SessionModeDraft | undefined;
  resumeModelDraft: ModelDraft | undefined;
  modeChangePending: boolean;
  modelChangePending: boolean;
  onResumeModeDraftChange: (sessionId: string, draft: SessionModeDraft) => void;
  onResumeModelDraftChange: (sessionId: string, draft: ModelDraft) => void;
  onRememberModelDraft: (provider: ProviderChoice, draft: ModelDraft) => void;
  onSendInput: (sessionId: string, text: string) => Promise<unknown>;
  onRespondToPermission: (
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ) => Promise<void>;
  onOpenLocalFile?: (sessionId: string, path: string) => void;
  onLoadConversationItemDetail?: (
    sessionId: string,
    kind: ConversationItemDetailKind,
    itemId: string,
  ) => Promise<void> | void;
  onLoadConversationTurnDetail?: (sessionId: string, turnId: string) => Promise<void> | void;
  onResumeHistory: (
    sessionId: string,
    request: {
      modeId?: string;
      modelId?: string;
      reasoningId?: string;
      optionValues?: Record<string, SessionConfigValue>;
    },
  ) => void;
  onClaimControl: (sessionId: string) => Promise<void>;
  onInterrupt: (sessionId: string) => void;
  onLoadOlderHistory: (sessionId: string) => void | Promise<void>;
  onEnsureTurnDirectory: (sessionId: string) => void | Promise<void>;
  onLoadTurnHistory: (sessionId: string, turnId: string) => void | Promise<void>;
  onStop: (sessionId: string) => void;
  onCloseHistory: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
  onSetSessionMode: (sessionId: string, modeId: string) => Promise<unknown>;
  onSetSessionModel: (
    sessionId: string,
    modelId: string,
    reasoningId?: string | null,
    optionValues?: Record<string, SessionConfigValue>,
  ) => Promise<unknown>;
  sideProjections?: readonly SessionProjection[];
  sideUnreadSessionIds?: ReadonlySet<string>;
  sideLayout?: SessionSideLayout;
  onSideLayoutChange?: (layout: SessionSideLayout) => void;
  onForkSession?: (sessionId: string, kind: "fork" | "side") => void;
  onRecreateSide?: (parentSessionId: string, sideSessionId: string) => void;
  branchOperationPending?: boolean;
}) {
  const provider = props.summary.session.provider as ProviderChoice;
  const expanded = props.variant === "expanded";
  const sidePanelAvailable = expanded && Boolean(props.inspector);
  const inspectorOpen = expanded && props.sidePanelOpen;
  const selectedIsReadOnlyReplay = isReadOnlyReplay(props.summary);
  const isAttached = isSessionAttachedToClient(props.summary, props.clientId);
  const hasControl = props.summary.controlLease.holderClientId === props.clientId;
  const canRespondToPermission = canSessionRespondToPermissions(props.summary);
  const [fileReferenceOpen, setFileReferenceOpen] = useState(false);
  const isGenerating = isSessionGenerationActive(
    props.summary,
    props.projection?.currentRuntimeStatus,
  );
  const composerSurface = deriveComposerSurface({
    selectedSummary: props.summary,
    hasControl,
    isGenerating,
    pendingSessionAction: props.pendingSessionAction,
  });
  const nativeTuiDiagnostics = useNativeTuiDiagnostics(
    props.summary.session.nativeTui ? props.summary.session.id : null,
  );
  const noticeState = deriveWorkbenchNoticeState({
    selectedSummary: props.summary,
    selectedProjection: props.projection,
    nativeTuiDiagnostics,
    error: null,
  });
  const modeControl = resolveSessionModeControlState({
    provider,
    draft: props.resumeModeDraft ?? null,
    summary: props.summary,
    catalog: props.modelCatalog,
  });
  const resumeDraftModelId =
    props.resumeModelDraft?.modelId &&
    props.modelCatalog?.models.some((model) => model.id === props.resumeModelDraft?.modelId)
      ? props.resumeModelDraft.modelId
      : null;
  const modelControl = resolveSelectedModelDraft({
    catalog: props.modelCatalog,
    selectedModelId:
      resumeDraftModelId ?? props.summary.session.model?.currentModelId ?? null,
    selectedReasoningId:
      (resumeDraftModelId ? props.resumeModelDraft?.reasoningId : undefined) ??
      props.summary.session.model?.currentReasoningId ??
      null,
    preserveMissingSelectedModel: resumeDraftModelId === null,
  });
  const {
    composerRef,
    draft,
    draftImageDataUrls,
    draftImageCount,
    sendPending,
    setDraft,
    handleDraftPaste,
    clearDraftImages,
    removeDraftImage,
    removeLastDraftImage,
    handleSend,
    insertDraftReference,
  } = useWorkbenchComposerState({
    selectedSummary: props.summary,
    availableWorkspaceDir: "",
    newSessionProvider: provider,
    startModeId: null,
    sendInput: props.onSendInput,
    startSession: async () => undefined,
  });

  const makeModelDraft = (modelId: string | null, reasoningId?: string | null): ModelDraft => {
    const optionValues = modelId
      ? buildModelOptionValuesFromReasoning({
          catalog: props.modelCatalog,
          modelId,
          reasoningId: reasoningId ?? null,
        })
      : undefined;
    return {
      modelId,
      reasoningId: modelId ? reasoningId ?? null : null,
      ...(optionValues !== undefined ? { optionValues } : {}),
    };
  };

  const selectedPane = (
    <>
      <WorkbenchSelectedPane
      selectedSummary={props.summary}
      clientId={props.clientId}
      selectedProjection={props.projection}
      selectedIsReadOnlyReplay={selectedIsReadOnlyReplay}
      compactComposerPrompts="auto"
      compactSessionMeta="auto"
      showViewCloseButton={false}
      sidebarOpen
      rightSidebarOpen={inspectorOpen}
      isAttached={isAttached}
      interactionNotice={noticeState.interactionNotice}
      generationActive={isGenerating}
      hideToolCallsInChat={props.hideToolCallsInChat}
      hideOpenCodeReasoningInChat={props.hideOpenCodeReasoningInChat}
      showModelInfoInChat={props.showModelInfoInChat}
      turnDirectory={props.projection?.turnDirectory?.items}
      onEnsureTurnDirectory={() => props.onEnsureTurnDirectory(props.summary.session.id)}
      onLoadTurnHistory={(turnId) =>
        props.onLoadTurnHistory(props.summary.session.id, turnId)
      }
      canRespondToPermission={canRespondToPermission}
      onPermissionRespond={(requestId, response) => {
        void props.onRespondToPermission(props.summary.session.id, requestId, response);
      }}
      onLoadConversationItemDetail={(kind, itemId) =>
        props.onLoadConversationItemDetail?.(props.summary.session.id, kind, itemId)
      }
      onLoadConversationTurnDetail={(turnId) =>
        props.onLoadConversationTurnDetail?.(props.summary.session.id, turnId)
      }
      {...(props.onOpenLocalFile
        ? {
            onOpenLocalFile: (path: string) =>
              props.onOpenLocalFile?.(props.summary.session.id, path),
          }
        : {})}
      composerSurface={composerSurface}
      composerRef={composerRef}
      draft={draft}
      draftImageUrls={draftImageDataUrls}
      draftImageCount={draftImageCount}
      sendPending={sendPending}
      onDraftChange={setDraft}
      onComposerPaste={handleDraftPaste}
      onClearDraftImages={clearDraftImages}
      onRemoveDraftImage={removeDraftImage}
      onRemoveLastDraftImage={removeLastDraftImage}
      onSend={() => void handleSend()}
      onResumeHistory={() => {
        const modelDraft = props.resumeModelDraft;
        const optionValues =
          (resumeDraftModelId ? modelDraft?.optionValues : undefined) ??
          (resumeDraftModelId
            ? buildModelOptionValuesFromReasoning({
                catalog: props.modelCatalog,
                modelId: resumeDraftModelId,
                reasoningId: modelDraft?.reasoningId ?? null,
              })
            : undefined);
        props.onResumeHistory(props.summary.session.id, {
          ...(modeControl.effectiveModeId ? { modeId: modeControl.effectiveModeId } : {}),
          ...(resumeDraftModelId ? { modelId: resumeDraftModelId } : {}),
          ...(resumeDraftModelId && modelDraft?.reasoningId
            ? { reasoningId: modelDraft.reasoningId }
            : {}),
          ...(optionValues !== undefined ? { optionValues } : {}),
        });
      }}
      resumeAccessModes={modeControl.accessModes}
      selectedResumeAccessModeId={modeControl.selectedAccessModeId}
      resumePlanModeAvailable={modeControl.planModeAvailable}
      resumePlanModeEnabled={modeControl.planModeEnabled}
      resumeModePending={props.pendingSessionAction?.kind === "resume_history"}
      selectedResumeModelId={modelControl.model?.id ?? null}
      selectedResumeReasoningId={modelControl.reasoning?.id ?? null}
      onResumeAccessModeChange={(modeId) => {
        props.onResumeModeDraftChange(props.summary.session.id, {
          ...(props.resumeModeDraft ?? createDefaultModeDraft(provider)),
          accessModeId: modeId,
        });
      }}
      onResumePlanModeToggle={(enabled) => {
        props.onResumeModeDraftChange(props.summary.session.id, {
          ...(props.resumeModeDraft ?? createDefaultModeDraft(provider)),
          planEnabled: enabled,
        });
      }}
      onResumeModelChange={(modelId, defaultReasoningId) => {
        const next = makeModelDraft(modelId || null, defaultReasoningId ?? null);
        props.onRememberModelDraft(provider, next);
        props.onResumeModelDraftChange(props.summary.session.id, next);
      }}
      onResumeReasoningChange={(reasoningId) => {
        const modelId = resumeDraftModelId ?? modelControl.model?.id ?? null;
        const next = makeModelDraft(modelId, reasoningId);
        props.onRememberModelDraft(provider, next);
        props.onResumeModelDraftChange(props.summary.session.id, next);
      }}
      onClaimControl={() => {
        const modelDraft = props.resumeModelDraft;
        const modelId = resumeDraftModelId;
        const reasoningId = modelDraft?.reasoningId ?? modelControl.reasoning?.id ?? null;
        const optionValues =
          (modelId ? modelDraft?.optionValues : undefined) ??
          (modelId
            ? buildModelOptionValuesFromReasoning({
                catalog: props.modelCatalog,
                modelId,
                reasoningId,
              })
            : undefined);
        void (async () => {
          try {
            await props.onClaimControl(props.summary.session.id);
            if (modeControl.effectiveModeId) {
              await props.onSetSessionMode(props.summary.session.id, modeControl.effectiveModeId);
            }
            if (modelId) {
              await props.onSetSessionModel(
                props.summary.session.id,
                modelId,
                reasoningId,
                optionValues,
              );
            }
          } catch {
            // Store commands surface failures through the global workbench error.
          }
        })();
      }}
      onInterrupt={() => props.onInterrupt(props.summary.session.id)}
      onOpenFileReference={() => setFileReferenceOpen(true)}
      onLoadOlderHistory={() => props.onLoadOlderHistory(props.summary.session.id)}
      onOpenLeft={() => undefined}
      onExpandSidebar={() => undefined}
      onOpenRight={() => undefined}
      onExpandInspector={() => undefined}
      onToggleInspector={props.onToggleSidePanel}
      showInspectorToggle={!inspectorOpen}
      inspectorToggleClassName={sidePanelAvailable ? "min-[900px]:hidden" : ""}
      inspectorToggleOpen={inspectorOpen}
      inspectorToggleDisabled={props.sidePanelToggleDisabled}
      inspectorToggleTitle={
        props.sidePanelToggleDisabled
          ? "Maximize pane to use inspector"
          : inspectorOpen
            ? "Collapse inspector"
            : "Expand inspector"
      }
      reserveRightPanelToggleSpace={sidePanelAvailable && !inspectorOpen}
      reserveRightPanelBreakpoint="wide"
      onFloatingAnchorOffsetChange={() => undefined}
      onStopOrClose={() => {
        if (selectedIsReadOnlyReplay) {
          props.onCloseHistory(props.summary.session.id);
          return;
        }
        props.onStop(props.summary.session.id);
      }}
      onArchiveSession={() => props.onArchive(props.summary.session.id)}
      onDeleteSession={() => props.onDelete(props.summary.session.id)}
      canStopSession={canSessionStop(props.summary)}
      canArchiveSession={canSessionArchive(props.summary)}
      canForkSession={props.summary.session.capabilities.branching?.sameWorkspace === true}
      canCreateSide={props.summary.session.capabilities.branching?.side === true}
      onForkSession={() => props.onForkSession?.(props.summary.session.id, "fork")}
      onCreateSide={() => props.onForkSession?.(props.summary.session.id, "side")}
      branchOperationPending={props.branchOperationPending ?? false}
      canDeleteSession={canSessionDelete(props.summary)}
      canShowSessionInfo={canSessionShowInfo(props.summary)}
      canRenameSession={canSessionRename(props.summary)}
      canSwitchSessionModes={canSessionSwitchModes(props.summary)}
      canSwitchSessionModel={canSessionSwitchModel(props.summary)}
      modeChangePending={props.modeChangePending}
      modelCatalog={props.modelCatalog}
      modelCatalogLoading={props.modelCatalogLoading}
      modelChangePending={props.modelChangePending}
      onRequestModelCatalogRefresh={props.onRequestModelCatalogRefresh}
      onRenameSession={() => props.onRename(props.summary.session.id)}
      onSetSessionMode={(modeId) => {
        void props.onSetSessionMode(props.summary.session.id, modeId);
      }}
      onSetSessionModel={(modelId, reasoningId) => {
        const optionValues = buildModelOptionValuesFromReasoning({
          catalog: props.modelCatalog,
          modelId,
          reasoningId: reasoningId ?? null,
        });
        const next = {
          modelId,
          reasoningId: reasoningId ?? null,
          ...(optionValues ? { optionValues } : {}),
        };
        props.onRememberModelDraft(provider, next);
        void props.onSetSessionModel(props.summary.session.id, modelId, reasoningId, optionValues);
      }}
      sideTaskCount={expanded ? 0 : props.sideProjections?.length ?? 0}
      />
      <FileReferencePicker
        open={fileReferenceOpen}
        onOpenChange={setFileReferenceOpen}
        rootPath={props.summary.session.rootDir || props.summary.session.cwd || "/"}
        onPick={insertDraftReference}
      />
    </>
  );

  const sessionSurface = sidePanelAvailable && props.inspector ? (
      <div className="flex h-full min-h-0 min-w-0">
        <div className="min-w-0 flex-1">{selectedPane}</div>
        <ConversationSidePanelShell
          desktopOpen={inspectorOpen}
          desktopBreakpoint="wide"
          desktopWidth="clamp(20rem, 28vw, 28rem)"
          toggleLabel={inspectorOpen ? "Collapse inspector" : "Expand inspector"}
          toggleDisabled={props.sidePanelToggleDisabled}
          onToggle={props.onToggleSidePanel}
        >
          {props.inspector}
        </ConversationSidePanelShell>
      </div>
    ) : (
      <div className="flex h-full min-h-0 flex-col">
        {selectedPane}
      </div>
    );

  const sideProjections = props.sideProjections ?? [];
  if (!expanded || sideProjections.length === 0) {
    return sessionSurface;
  }

  const {
    inspector: _inspector,
    sideProjections: _nestedSideProjections,
    sideLayout: _sideLayout,
    onSideLayoutChange: _onSideLayoutChange,
    ...childProps
  } = props;
  void _inspector;
  void _nestedSideProjections;
  void _sideLayout;
  void _onSideLayoutChange;

  return (
    <SessionSideDock
      dockId={props.summary.session.id}
      main={sessionSurface}
      sides={sideProjections.map((sideProjection) => ({
        id: sideProjection.summary.session.id,
        summary: sideProjection.summary,
        unread: props.sideUnreadSessionIds?.has(sideProjection.summary.session.id) ?? false,
        onDiscard: () => props.onStop(sideProjection.summary.session.id),
        ...(props.onRecreateSide
          ? {
              onRecreate: () =>
                props.onRecreateSide?.(
                  props.summary.session.id,
                  sideProjection.summary.session.id,
                ),
            }
          : {}),
        content: (
          <CanvasSessionPane
            {...childProps}
            variant="compact"
            summary={sideProjection.summary}
            projection={sideProjection}
            sidePanelOpen={false}
            sidePanelToggleDisabled
            onToggleSidePanel={() => undefined}
            sideProjections={[]}
          />
        ),
      }))}
      layout={props.sideLayout ?? "columns"}
      onLayoutChange={props.onSideLayoutChange ?? (() => undefined)}
    />
  );
}
