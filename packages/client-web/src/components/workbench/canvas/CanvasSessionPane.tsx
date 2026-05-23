import type { ReactNode } from "react";
import type { PermissionResponseRequest, ProviderModelCatalog, SessionConfigValue, SessionSummary } from "@rah/runtime-protocol";
import type { ObjectPaneVariant } from "../../../object-pane-variant";
import { useWorkbenchComposerState } from "../../../hooks/useWorkbenchComposerState";
import { useNativeTuiDiagnostics } from "../../../hooks/useNativeTuiDiagnostics";
import { buildModelOptionValuesFromReasoning } from "../../../provider-capabilities";
import {
  canSessionStop,
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
import { WorkbenchSelectedPane } from "../panes/WorkbenchSelectedPane";
import { ConversationSidePanelShell } from "../shells/ConversationSidePanelShell";

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
  hideGeminiReasoningInChat: boolean;
  showModelInfoInChat: boolean;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "claim_history";
        sessionId: string;
      }
    | null;
  modelCatalog: ProviderModelCatalog | null;
  modelCatalogLoading: boolean;
  onRequestModelCatalogRefresh?: (() => void) | undefined;
  claimModeDraft: SessionModeDraft | undefined;
  claimModelDraft: ModelDraft | undefined;
  modeChangePending: boolean;
  modelChangePending: boolean;
  onClaimModeDraftChange: (sessionId: string, draft: SessionModeDraft) => void;
  onClaimModelDraftChange: (sessionId: string, draft: ModelDraft) => void;
  onRememberModelDraft: (provider: ProviderChoice, draft: ModelDraft) => void;
  onSendInput: (sessionId: string, text: string) => Promise<unknown>;
  onRespondToPermission: (
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ) => Promise<void>;
  onClaimHistory: (
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
  onStop: (sessionId: string) => void;
  onCloseHistory: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
  onSetSessionMode: (sessionId: string, modeId: string) => Promise<unknown>;
  onSetSessionModel: (
    sessionId: string,
    modelId: string,
    reasoningId?: string | null,
    optionValues?: Record<string, SessionConfigValue>,
  ) => Promise<unknown>;
}) {
  const provider = props.summary.session.provider as ProviderChoice;
  const expanded = props.variant === "expanded";
  const sidePanelAvailable = expanded && Boolean(props.inspector);
  const inspectorOpen = expanded && props.sidePanelOpen;
  const selectedIsReadOnlyReplay = isReadOnlyReplay(props.summary);
  const isAttached = isSessionAttachedToClient(props.summary, props.clientId);
  const hasControl = props.summary.controlLease.holderClientId === props.clientId;
  const canRespondToPermission = canSessionRespondToPermissions(props.summary);
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
    draft: props.claimModeDraft ?? null,
    summary: props.summary,
    catalog: props.modelCatalog,
  });
  const claimDraftModelId =
    props.claimModelDraft?.modelId &&
    props.modelCatalog?.models.some((model) => model.id === props.claimModelDraft?.modelId)
      ? props.claimModelDraft.modelId
      : null;
  const modelControl = resolveSelectedModelDraft({
    catalog: props.modelCatalog,
    selectedModelId:
      claimDraftModelId ?? props.summary.session.model?.currentModelId ?? null,
    selectedReasoningId:
      (claimDraftModelId ? props.claimModelDraft?.reasoningId : undefined) ??
      props.summary.session.model?.currentReasoningId ??
      null,
    preserveMissingSelectedModel: claimDraftModelId === null,
  });
  const {
    composerRef,
    draft,
    sendPending,
    setDraft,
    handleSend,
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
      historyNotice={noticeState.historyNotice}
      hideToolCallsInChat={props.hideToolCallsInChat}
      hideOpenCodeReasoningInChat={props.hideOpenCodeReasoningInChat}
      hideGeminiReasoningInChat={props.hideGeminiReasoningInChat}
      showModelInfoInChat={props.showModelInfoInChat}
      canLoadOlderHistory={Boolean(
        props.summary.session.providerSessionId &&
          props.projection?.history.authoritativeApplied &&
          (props.projection.history.nextCursor || props.projection.history.nextBeforeTs),
      )}
      historyLoading={props.projection?.history.phase === "loading"}
      canRespondToPermission={canRespondToPermission}
      onPermissionRespond={(requestId, response) => {
        void props.onRespondToPermission(props.summary.session.id, requestId, response);
      }}
      composerSurface={composerSurface}
      composerRef={composerRef}
      draft={draft}
      sendPending={sendPending}
      onDraftChange={setDraft}
      onSend={() => void handleSend()}
      onClaimHistory={() => {
        const modelDraft = props.claimModelDraft;
        const optionValues =
          (claimDraftModelId ? modelDraft?.optionValues : undefined) ??
          (claimDraftModelId
            ? buildModelOptionValuesFromReasoning({
                catalog: props.modelCatalog,
                modelId: claimDraftModelId,
                reasoningId: modelDraft?.reasoningId ?? null,
              })
            : undefined);
        props.onClaimHistory(props.summary.session.id, {
          ...(modeControl.effectiveModeId ? { modeId: modeControl.effectiveModeId } : {}),
          ...(claimDraftModelId ? { modelId: claimDraftModelId } : {}),
          ...(claimDraftModelId && modelDraft?.reasoningId
            ? { reasoningId: modelDraft.reasoningId }
            : {}),
          ...(optionValues !== undefined ? { optionValues } : {}),
        });
      }}
      claimAccessModes={modeControl.accessModes}
      selectedClaimAccessModeId={modeControl.selectedAccessModeId}
      claimPlanModeAvailable={modeControl.planModeAvailable}
      claimPlanModeEnabled={modeControl.planModeEnabled}
      claimModePending={props.pendingSessionAction?.kind === "claim_history"}
      selectedClaimModelId={modelControl.model?.id ?? null}
      selectedClaimReasoningId={modelControl.reasoning?.id ?? null}
      onClaimAccessModeChange={(modeId) => {
        props.onClaimModeDraftChange(props.summary.session.id, {
          ...(props.claimModeDraft ?? createDefaultModeDraft(provider)),
          accessModeId: modeId,
        });
      }}
      onClaimPlanModeToggle={(enabled) => {
        props.onClaimModeDraftChange(props.summary.session.id, {
          ...(props.claimModeDraft ?? createDefaultModeDraft(provider)),
          planEnabled: enabled,
        });
      }}
      onClaimModelChange={(modelId, defaultReasoningId) => {
        const next = makeModelDraft(modelId || null, defaultReasoningId ?? null);
        props.onRememberModelDraft(provider, next);
        props.onClaimModelDraftChange(props.summary.session.id, next);
      }}
      onClaimReasoningChange={(reasoningId) => {
        const modelId = claimDraftModelId ?? modelControl.model?.id ?? null;
        const next = makeModelDraft(modelId, reasoningId);
        props.onRememberModelDraft(provider, next);
        props.onClaimModelDraftChange(props.summary.session.id, next);
      }}
      onClaimControl={() => {
        const modelDraft = props.claimModelDraft;
        const modelId = claimDraftModelId;
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
      onOpenFileReference={() => undefined}
      fileReferenceDisabled
      onLoadOlderHistory={() => props.onLoadOlderHistory(props.summary.session.id)}
      onOpenLeft={() => undefined}
      onExpandSidebar={() => undefined}
      onOpenRight={() => undefined}
      onExpandInspector={() => undefined}
      onToggleInspector={props.onToggleSidePanel}
      showInspectorToggle={!inspectorOpen}
      inspectorToggleOpen={inspectorOpen}
      inspectorToggleDisabled={props.sidePanelToggleDisabled}
      inspectorToggleTitle={
        props.sidePanelToggleDisabled
          ? "Maximize pane to use inspector"
          : inspectorOpen
            ? "Collapse inspector"
            : "Expand inspector"
      }
      onFloatingAnchorOffsetChange={() => undefined}
      onStopOrClose={() => {
        if (selectedIsReadOnlyReplay) {
          props.onCloseHistory(props.summary.session.id);
          return;
        }
        props.onStop(props.summary.session.id);
      }}
      onDeleteSession={() => props.onDelete(props.summary.session.id)}
      canStopSession={canSessionStop(props.summary)}
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
    />
  );

  if (sidePanelAvailable && props.inspector) {
    return (
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
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {selectedPane}
    </div>
  );
}
