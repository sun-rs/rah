import type { PermissionResponseRequest, ProviderModelCatalog, SessionConfigValue, SessionSummary } from "@rah/runtime-protocol";
import { useWorkbenchComposerState } from "../../../hooks/useWorkbenchComposerState";
import { buildModelOptionValuesFromReasoning } from "../../../provider-capabilities";
import {
  canSessionArchive,
  canSessionDelete,
  canSessionRename,
  canSessionRespondToPermissions,
  canSessionShowInfo,
  canSessionSwitchModel,
  canSessionSwitchModes,
  isReadOnlyReplay,
  isSessionActivelyRunning,
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

type ModelDraft = {
  modelId?: string | null;
  reasoningId?: string | null;
  optionValues?: Record<string, SessionConfigValue>;
};

export function CanvasSessionPane(props: {
  summary: SessionSummary;
  projection: SessionProjection | null;
  clientId: string;
  hideToolCallsInChat: boolean;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "claim_history";
        sessionId: string;
      }
    | null;
  modelCatalog: ProviderModelCatalog | null;
  modelCatalogLoading: boolean;
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
  onArchive: (sessionId: string) => void;
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
  const selectedIsReadOnlyReplay = isReadOnlyReplay(props.summary);
  const isAttached = isSessionAttachedToClient(props.summary, props.clientId);
  const hasControl = props.summary.controlLease.holderClientId === props.clientId;
  const canRespondToPermission = canSessionRespondToPermissions(props.summary);
  const isGenerating = isSessionActivelyRunning(props.summary);
  const composerSurface = deriveComposerSurface({
    selectedSummary: props.summary,
    hasControl,
    isGenerating,
    pendingSessionAction: props.pendingSessionAction,
  });
  const noticeState = deriveWorkbenchNoticeState({
    selectedSummary: props.summary,
    selectedProjection: props.projection,
    error: null,
  });
  const modeControl = resolveSessionModeControlState({
    provider,
    draft: props.claimModeDraft ?? null,
    summary: props.summary,
    catalog: props.modelCatalog,
  });
  const modelControl = resolveSelectedModelDraft({
    catalog: props.modelCatalog,
    selectedModelId:
      props.claimModelDraft?.modelId ?? props.summary.session.model?.currentModelId ?? null,
    selectedReasoningId:
      props.claimModelDraft?.reasoningId ??
      props.summary.session.model?.currentReasoningId ??
      null,
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

  return (
    <div className="flex h-full min-h-0 flex-col">
    <WorkbenchSelectedPane
      selectedSummary={props.summary}
      selectedProjection={props.projection}
      selectedIsReadOnlyReplay={selectedIsReadOnlyReplay}
      compactComposerPrompts="auto"
      compactSessionMeta="auto"
      sidebarOpen
      rightSidebarOpen
      isAttached={isAttached}
      interactionNotice={noticeState.interactionNotice}
      historyNotice={noticeState.historyNotice}
      hideToolCallsInChat={props.hideToolCallsInChat}
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
          modelDraft?.optionValues ??
          (modelDraft?.modelId
            ? buildModelOptionValuesFromReasoning({
                catalog: props.modelCatalog,
                modelId: modelDraft.modelId,
                reasoningId: modelDraft.reasoningId ?? null,
              })
            : undefined);
        props.onClaimHistory(props.summary.session.id, {
          ...(modeControl.effectiveModeId ? { modeId: modeControl.effectiveModeId } : {}),
          ...(modelDraft?.modelId ? { modelId: modelDraft.modelId } : {}),
          ...(modelDraft?.reasoningId ? { reasoningId: modelDraft.reasoningId } : {}),
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
        const modelId = props.claimModelDraft?.modelId ?? modelControl.model?.id ?? null;
        const next = makeModelDraft(modelId, reasoningId);
        props.onRememberModelDraft(provider, next);
        props.onClaimModelDraftChange(props.summary.session.id, next);
      }}
      onClaimControl={() => {
        const modelDraft = props.claimModelDraft;
        const modelId = modelDraft?.modelId ?? null;
        const reasoningId = modelDraft?.reasoningId ?? modelControl.reasoning?.id ?? null;
        const optionValues =
          modelDraft?.optionValues ??
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
      onToggleInspector={() => undefined}
      showInspectorToggle={false}
      onFloatingAnchorOffsetChange={() => undefined}
      onArchiveOrClose={() => {
        if (selectedIsReadOnlyReplay) {
          props.onCloseHistory(props.summary.session.id);
          return;
        }
        props.onArchive(props.summary.session.id);
      }}
      onDeleteSession={() => props.onDelete(props.summary.session.id)}
      canArchiveSession={canSessionArchive(props.summary)}
      canDeleteSession={canSessionDelete(props.summary)}
      canShowSessionInfo={canSessionShowInfo(props.summary)}
      canRenameSession={canSessionRename(props.summary)}
      canSwitchSessionModes={canSessionSwitchModes(props.summary)}
      canSwitchSessionModel={canSessionSwitchModel(props.summary)}
      modeChangePending={props.modeChangePending}
      modelCatalog={props.modelCatalog}
      modelCatalogLoading={props.modelCatalogLoading}
      modelChangePending={props.modelChangePending}
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
    </div>
  );
}
