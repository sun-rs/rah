import type {
  CloseSessionRequest,
  DeleteQueuedInputRequest,
  ForkSessionRequest,
  ForkSessionResponse,
  InterruptSessionRequest,
  PermissionResponseRequest,
  ProviderModelCatalog,
  ReorderQueuedInputRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetInputQueuePolicyRequest,
  SetSessionModelRequest,
  SessionInputRequest,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
  SteerQueuedInputRequest,
  UpdateQueuedInputRequest,
} from "@rah/runtime-protocol";
import { randomUUID } from "node:crypto";
import type { ProviderAdapter, RuntimeServices } from "../provider-adapter";
import {
  forkCodexLiveSession,
  loadCodexPlanCollaborationMode,
  pauseActiveCodexThreadGoal,
  respondToCodexLivePermission,
  resumeCodexLiveSession,
  startCodexLiveSession,
  type LiveCodexSession,
} from "./codex-live-client";
import { createCodexAppServerClient } from "../codex-app-server-client";
import { CodexJsonRpcResponseError } from "../codex-live-rpc";
import {
  bindCodexSubmittedUserMessageToTurn,
  codexSubmittedUserMessageActivity,
  discardCodexSubmittedUserMessageFromTurn,
  discardPendingCodexSubmittedUserMessage,
  recordCodexSubmittedUserMessage,
  recordCodexSubmittedUserMessageForTurn,
} from "../codex-app-server-activity";
import {
  CodexModelCatalogCache,
  resolveCodexRuntimeCapabilityState,
} from "../codex-model-catalog";
import {
  findCodexStoredSessionRecord,
  patchCodexStoredSessionTitle,
  resumeCodexStoredSession,
} from "../codex-stored-sessions";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
  reuseExistingProviderSessionForResume,
} from "../provider-resume";
import { codexLaunchSpec, probeProviderDiagnostic } from "../provider-diagnostics";
import { toSessionSummary } from "../session-store";
import {
  buildCodexModeState,
  codexPlanAccessModeId,
  parseCodexModeId,
} from "../session-mode-utils";
import { optionValueAsString, resolveModelOptionValues } from "../session-model-options";
import { applyProviderActivity } from "../provider-activity";
import { timelineRuntimeModel } from "../timeline-runtime-model";
import { mergeManualProviderModels } from "../manual-provider-models";
import { publishSessionStateChanged } from "../runtime-session-events";
import { setSessionSideLifecycleState } from "../session-side-lifecycle";
import {
  deleteRuntimeQueuedInput,
  markRuntimeQueuedInputQueued,
  markRuntimeQueuedInputSubmitting,
  publishSessionInputAccepted,
  publishSessionInputQueue,
  publishSessionInputQueuePolicy,
  reorderRuntimeQueuedInput,
  restoreRuntimeQueuedInput,
  runtimeQueuedInput,
  SessionInputQueueConflictError,
  type RuntimeQueuedInput,
  updateRuntimeQueuedInput,
  withdrawRuntimeQueuedInput,
} from "../session-input-queue";
import { codexTurnInput } from "../session-input-attachments";

const CODEX_EVENT_SOURCE = {
  provider: "codex" as const,
  channel: "structured_live" as const,
  authority: "derived" as const,
};
const CODEX_INTERRUPT_FALLBACK_MS = 1_500;
const CODEX_SHUTDOWN_CONTROL_TIMEOUT_MS = 2_000;
const CODEX_NO_ACTIVE_TURN_ERROR = "no active turn to interrupt";

function isCodexNoActiveTurnError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.trim().toLowerCase().replace(/[.!]+$/, "");
  return (
    message === CODEX_NO_ACTIVE_TURN_ERROR ||
    message.endsWith(`: ${CODEX_NO_ACTIVE_TURN_ERROR}`)
  );
}

function isCodexTurnSteerRaceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.trim().toLowerCase();
  return (
    message.includes("no active turn") ||
    message.includes("turn is not active") ||
    message.includes("turn is no longer active") ||
    message.includes("turn already completed") ||
    message.includes("turn has ended") ||
    (message.includes("expected turn") && message.includes("current turn"))
  );
}

type CodexTurnCollaborationMode = {
  mode: "default" | "plan";
  settings: {
    model: string;
    reasoning_effort: string | null;
    developer_instructions: string | null;
  };
};

function codexSandboxPolicyForTurn(args: {
  sandboxMode: string;
  cwd: string;
}) {
  switch (args.sandboxMode) {
    case "read-only":
      return {
        type: "readOnly" as const,
        networkAccess: false,
      };
    case "workspace-write":
      return {
        type: "workspaceWrite" as const,
        writableRoots: [args.cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case "danger-full-access":
    default:
      return {
        type: "dangerFullAccess" as const,
      };
  }
}

function codexCollaborationModeForTurn(live: LiveCodexSession): CodexTurnCollaborationMode | null {
  const model = live.modelId ?? live.planCollaborationMode?.settings.model ?? null;
  if (!model) {
    return null;
  }
  if (live.activeModeId !== "plan" || !live.planCollaborationMode) {
    // Codex preserves the previous collaboration mode when this field is omitted.
    // Send default explicitly so toggling Plan off actually exits plan mode.
    return {
      mode: "default",
      settings: {
        model,
        reasoning_effort: live.reasoningId,
        developer_instructions: null,
      },
    };
  }
  return {
    mode: "plan",
    settings: {
      ...live.planCollaborationMode.settings,
      model,
      reasoning_effort:
        live.reasoningId ?? live.planCollaborationMode.settings.reasoning_effort,
    },
  };
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex";
  readonly providers: Array<"codex"> = ["codex"];

  private readonly services: RuntimeServices;
  private readonly liveSessions = new Map<string, LiveCodexSession>();
  private readonly rehydratedSessionIds = new Set<string>();
  private readonly modelCatalog = new CodexModelCatalogCache();

  constructor(services: RuntimeServices) {
    this.services = services;
  }

  private reportAsyncLiveError(sessionId: string, detail: string): void {
    const state = this.services.sessionStore.getSession(sessionId);
    if (state) {
      this.services.sessionStore.patchManagedSession(sessionId, {
        runtimeDiagnostics: {
          ...(state.session.runtimeDiagnostics ?? {}),
          lastError: detail,
        },
      });
    }
    this.services.eventBus.publish({
      sessionId,
      type: "runtime.status",
      source: CODEX_EVENT_SOURCE,
      payload: {
        status: "error",
        detail,
      },
    });
    this.services.sessionStore.setRuntimeState(sessionId, "failed");
  }

  private isEphemeralSideSession(sessionId: string): boolean {
    const relationship =
      this.services.sessionStore.getSession(sessionId)?.session.relationship;
    return relationship?.kind === "side" && relationship.persistence === "ephemeral";
  }

  private isEphemeralLiveSession(liveSession: LiveCodexSession): boolean {
    return liveSession.ephemeral === true || this.isEphemeralSideSession(liveSession.sessionId);
  }

  private registerLiveSession(liveSession: LiveCodexSession): void {
    if (this.isEphemeralSideSession(liveSession.sessionId)) {
      liveSession.ephemeral = true;
    }
    liveSession.inputQueuePolicy = "queue";
    liveSession.drainQueuedInput = () => this.drainQueuedInput(liveSession);
    liveSession.client.setCloseHandler((error) => {
      this.handleLiveClientClosed(liveSession, error);
    });
    this.liveSessions.set(liveSession.sessionId, liveSession);
    publishSessionInputQueue(this.services, liveSession.sessionId, liveSession.queuedInputs);
    publishSessionInputQueuePolicy(
      this.services,
      liveSession.sessionId,
      liveSession.inputQueuePolicy,
    );
  }

  private enqueueInput(live: LiveCodexSession, request: SessionInputRequest): void {
    if (
      request.clientMessageId &&
      live.queuedInputs.some(
        (item) => item.clientMessageId === request.clientMessageId,
      )
    ) {
      return;
    }
    live.queuedInputs.push(runtimeQueuedInput(request));
    publishSessionInputQueue(this.services, live.sessionId, live.queuedInputs);
  }

  private waitForQueuedInputAcceptance(
    live: LiveCodexSession,
    clientMessageId: string,
    timeoutMs = 90_000,
  ): Promise<void> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (this.liveSessions.get(live.sessionId) !== live || live.ephemeralExpired) {
          reject(new Error("Codex Session closed before the initial question was accepted."));
          return;
        }
        const queued = live.queuedInputs.find(
          (item) => item.clientMessageId === clientMessageId,
        );
        if (!queued) {
          resolve();
          return;
        }
        if (
          live.queuedInputDrainPaused === true &&
          live.uncertainQueuedInputClientMessageId === clientMessageId
        ) {
          reject(new Error("Codex did not accept the initial question; it remains queued in RAH."));
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error("Timed out waiting for Codex to accept the initial question."));
          return;
        }
        const timer = setTimeout(poll, 10);
        timer.unref?.();
      };
      poll();
    });
  }

  private async steerLiveTurn(
    live: LiveCodexSession,
    request: SessionInputRequest,
    queuedInput?: RuntimeQueuedInput,
  ): Promise<void> {
    const turnId = live.currentTurnId;
    if (!live.threadId || !turnId || live.turnStartInFlight) {
      throw new SessionInputQueueConflictError(
        "The active turn ended before this message could be guided.",
      );
    }
    if (
      queuedInput &&
      !markRuntimeQueuedInputSubmitting(live.queuedInputs, queuedInput.clientMessageId)
    ) {
      throw new SessionInputQueueConflictError(
        "Queued message is no longer waiting and cannot be guided.",
      );
    }
    if (queuedInput) {
      publishSessionInputQueue(this.services, live.sessionId, live.queuedInputs);
    }
    const submittedMessage = {
      text: request.text,
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
      ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
      ...(request.clientTurnId ? { clientTurnId: request.clientTurnId } : {}),
    };
    recordCodexSubmittedUserMessageForTurn(
      live.translationState,
      turnId,
      submittedMessage,
    );
    try {
      await live.client.request(
        "turn/steer",
        {
          threadId: live.threadId,
          expectedTurnId: turnId,
          input: codexTurnInput(request),
          ...(request.clientMessageId
            ? { clientUserMessageId: request.clientMessageId }
            : {}),
        },
        90_000,
      );
      const submittedActivity = codexSubmittedUserMessageActivity(
        live.translationState,
        {
          turnId,
          providerSessionId: live.threadId,
          message: submittedMessage,
        },
      );
      if (submittedActivity) {
        applyProviderActivity(
          this.services,
          live.sessionId,
          CODEX_EVENT_SOURCE,
          submittedActivity,
        );
      }
      if (queuedInput) {
        deleteRuntimeQueuedInput(live.queuedInputs, queuedInput.clientMessageId);
        publishSessionInputAccepted(this.services, live.sessionId, queuedInput);
        publishSessionInputQueue(this.services, live.sessionId, live.queuedInputs);
      }
    } catch (error) {
      discardCodexSubmittedUserMessageFromTurn(
        live.translationState,
        turnId,
        request.clientMessageId,
      );
      if (queuedInput) {
        markRuntimeQueuedInputQueued(live.queuedInputs, queuedInput.clientMessageId);
        publishSessionInputQueue(this.services, live.sessionId, live.queuedInputs);
      }
      const activeTurnMoved =
        live.currentTurnId !== turnId || live.finishedTurnIds.has(turnId);
      if (queuedInput && (activeTurnMoved || isCodexTurnSteerRaceError(error))) {
        if (isCodexTurnSteerRaceError(error) && live.currentTurnId === turnId) {
          live.finishedTurnIds.add(turnId);
          live.currentTurnId = null;
        }
        // The provider closed the guidance window while the request was in
        // flight. The canonical queue still owns the message, so let it start
        // the next turn instead of surfacing a false destructive failure.
        this.drainQueuedInput(live);
        return;
      }
      throw error;
    }
  }

  private clearQueuedInputs(live: LiveCodexSession): void {
    const changed =
      live.queuedInputs.length > 0 ||
      live.queuedInputDrainPaused === true ||
      live.uncertainQueuedInputClientMessageId !== undefined;
    live.queuedInputs.length = 0;
    delete live.queuedInputSubmission;
    delete live.queuedInputDrainPaused;
    delete live.uncertainQueuedInputClientMessageId;
    if (changed) {
      publishSessionInputQueue(this.services, live.sessionId, live.queuedInputs);
    }
  }

  private handleLiveClientClosed(liveSession: LiveCodexSession, error: Error): void {
    if (this.liveSessions.get(liveSession.sessionId) !== liveSession) {
      return;
    }
    this.liveSessions.delete(liveSession.sessionId);
    this.clearInterruptFallback(liveSession);
    // Each live Codex session owns its app-server process. A transport close
    // is terminal for an ephemeral, pathless Side, and the process must not be
    // left behind after its RPC channel disappears.
    void (async () => {
      try {
        await liveSession.flushNotifications?.();
      } finally {
        await liveSession.client.dispose();
      }
    })().catch((disposeError) => {
      console.warn("[rah] failed to dispose Codex app-server after transport close", {
        sessionId: liveSession.sessionId,
        error: disposeError,
      });
    });
    const state = this.services.sessionStore.getSession(liveSession.sessionId);
    if (!state) {
      return;
    }
    const detail = error.message || "Codex app-server closed";
    if (this.isEphemeralLiveSession(liveSession) && !liveSession.disposalInFlight) {
      liveSession.ephemeralExpired = true;
      this.clearQueuedInputs(liveSession);
      liveSession.currentTurnId = null;
      this.services.sessionStore.patchManagedSession(liveSession.sessionId, {
        ...(state.session.nativeTui
          ? {
              nativeTui: {
                ...state.session.nativeTui,
                viewAvailable: false,
              },
            }
          : {}),
        runtimeDiagnostics: {
          ...(state.session.runtimeDiagnostics ?? {}),
          attachState: "failed",
          lastError: detail,
        },
      });
      this.services.sessionStore.setRuntimeState(liveSession.sessionId, "stopped");
      setSessionSideLifecycleState(
        this.services,
        liveSession.sessionId,
        "expired",
        "Codex unloaded this ephemeral Side task. Start a new Side to continue.",
      );
      publishSessionStateChanged(this.services, liveSession.sessionId, "stopped");
      return;
    }
    this.services.sessionStore.patchManagedSession(liveSession.sessionId, {
      ...(state.session.nativeTui
        ? {
            nativeTui: {
              ...state.session.nativeTui,
              viewAvailable: false,
            },
          }
        : {}),
      runtimeDiagnostics: {
        ...(state.session.runtimeDiagnostics ?? {}),
        attachState: "failed",
        lastError: detail,
      },
    });
    this.services.eventBus.publish({
      sessionId: liveSession.sessionId,
      type: "runtime.status",
      source: CODEX_EVENT_SOURCE,
      payload: {
        status: "error",
        detail,
      },
    });
    this.services.sessionStore.setRuntimeState(liveSession.sessionId, "failed");
    publishSessionStateChanged(this.services, liveSession.sessionId, "failed");
  }

  private drainQueuedInput(live: LiveCodexSession): void {
    if (
      !live.threadId ||
      live.currentTurnId ||
      live.turnStartInFlight ||
      live.queuedInputDrainPaused
    ) {
      return;
    }
    const next = live.queuedInputs[0];
    if (!next || next.state !== "queued") {
      return;
    }
    if (!markRuntimeQueuedInputSubmitting(live.queuedInputs, next.clientMessageId)) {
      return;
    }
    if (live.uncertainQueuedInputClientMessageId === next.clientMessageId) {
      delete live.uncertainQueuedInputClientMessageId;
    }
    publishSessionInputQueue(this.services, live.sessionId, live.queuedInputs);
    this.startLiveTurn(live, next, { queuedInput: next });
  }

  private clearInterruptFallback(live: LiveCodexSession): void {
    if (live.interruptFallbackTimer) {
      clearTimeout(live.interruptFallbackTimer);
      delete live.interruptFallbackTimer;
    }
    delete live.interruptFallbackTurnId;
  }

  private scheduleInterruptFallback(live: LiveCodexSession, turnId: string): void {
    this.clearInterruptFallback(live);
    live.interruptFallbackTurnId = turnId;
    live.interruptFallbackTimer = setTimeout(() => {
      delete live.interruptFallbackTimer;
      delete live.interruptFallbackTurnId;
      if (
        this.liveSessions.get(live.sessionId) !== live ||
        live.currentTurnId !== turnId ||
        !live.interruptingTurnIds.has(turnId)
      ) {
        return;
      }
      live.finishedTurnIds.add(turnId);
      live.interruptingTurnIds.delete(turnId);
      live.currentTurnId = null;
      live.interruptWhenTurnStarts = false;
      applyProviderActivity(this.services, live.sessionId, CODEX_EVENT_SOURCE, {
        type: "turn_canceled",
        turnId,
        reason: "Interrupted",
      });
      live.drainQueuedInput?.();
    }, CODEX_INTERRUPT_FALLBACK_MS);
    live.interruptFallbackTimer.unref?.();
  }

  private async interruptLiveTurnBeforeDisposal(live: LiveCodexSession): Promise<void> {
    this.clearQueuedInputs(live);
    if (!live.threadId) {
      return;
    }
    const turnId = live.currentTurnId;
    if (!turnId) {
      if (live.turnStartInFlight) {
        live.interruptWhenTurnStarts = true;
      }
      return;
    }
    if (live.interruptingTurnIds.has(turnId)) {
      return;
    }
    live.interruptingTurnIds.add(turnId);
    try {
      await live.client.request(
        "turn/interrupt",
        {
          threadId: live.threadId,
          turnId,
        },
        CODEX_SHUTDOWN_CONTROL_TIMEOUT_MS,
      );
    } catch (error) {
      live.interruptingTurnIds.delete(turnId);
      if (isCodexNoActiveTurnError(error)) {
        live.finishedTurnIds.add(turnId);
        if (live.currentTurnId === turnId) {
          live.currentTurnId = null;
        }
        live.interruptWhenTurnStarts = false;
        return;
      }
      console.warn("[rah] failed to interrupt Codex turn before session disposal", {
        sessionId: live.sessionId,
        threadId: live.threadId,
        turnId,
        error,
      });
      throw error;
    }
  }

  private async pauseLiveGoalBeforeDisposal(live: LiveCodexSession): Promise<void> {
    if (!live.threadId) {
      return;
    }
    await pauseActiveCodexThreadGoal(
      live.client,
      live.threadId,
      CODEX_SHUTDOWN_CONTROL_TIMEOUT_MS,
    );
  }

  private async prepareLiveSessionForDisposal(live: LiveCodexSession): Promise<void> {
    live.disposalInFlight = true;
    try {
      if (!live.ephemeralExpired) {
        await this.interruptLiveTurnBeforeDisposal(live);
        if (this.isEphemeralLiveSession(live) && live.threadId) {
          await live.client.request(
            "thread/unsubscribe",
            { threadId: live.threadId },
            CODEX_SHUTDOWN_CONTROL_TIMEOUT_MS,
          );
        } else {
          await this.pauseLiveGoalBeforeDisposal(live);
        }
      }
    } catch (error) {
      live.disposalInFlight = false;
      throw error;
    }
  }

  private async disposeDetachedEphemeralSide(sessionId: string): Promise<void> {
    const state = this.services.sessionStore.getSession(sessionId);
    const relationship = state?.session.relationship;
    if (
      relationship?.kind !== "side" ||
      relationship.persistence !== "ephemeral" ||
      relationship.sideState === "expired"
    ) {
      return;
    }
    const threadId = state?.session.providerSessionId;
    if (!threadId) {
      throw new Error(`Side session ${sessionId} does not have a provider thread id.`);
    }

    const client = await createCodexAppServerClient();
    try {
      await client.request(
        "thread/unsubscribe",
        { threadId },
        CODEX_SHUTDOWN_CONTROL_TIMEOUT_MS,
      );
    } finally {
      await client.dispose();
    }
  }

  private startLiveTurn(
    live: LiveCodexSession,
    request: SessionInputRequest,
    options?: { queuedInput?: RuntimeQueuedInput },
  ): void {
    if (live.ephemeralExpired) {
      return;
    }
    if (this.isEphemeralLiveSession(live)) {
      setSessionSideLifecycleState(this.services, live.sessionId, "active");
    }
    if (!live.threadId) {
      if (options?.queuedInput) {
        restoreRuntimeQueuedInput(live.queuedInputs, options.queuedInput);
        publishSessionInputQueue(this.services, live.sessionId, live.queuedInputs);
      } else {
        this.enqueueInput(live, request);
      }
      return;
    }
    const collaborationMode = codexCollaborationModeForTurn(live);
    const requestRuntimeModel = timelineRuntimeModel({
      modelId: live.modelId,
      optionId: live.reasoningId,
      optionKind: "reasoning_effort",
      source: "request",
    });
    if (requestRuntimeModel) {
      live.translationState.pendingRuntimeModel = requestRuntimeModel;
    } else {
      delete live.translationState.pendingRuntimeModel;
    }
    recordCodexSubmittedUserMessage(live.translationState, {
      text: request.text,
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
      ...(request.clientMessageId !== undefined
        ? { clientMessageId: request.clientMessageId }
        : {}),
      ...(request.clientTurnId !== undefined
        ? { clientTurnId: request.clientTurnId }
        : {}),
    });
    live.turnStartInFlight = true;
    if (options?.queuedInput) {
      live.queuedInputSubmission = {
        clientMessageId: options.queuedInput.clientMessageId,
        ...(options.queuedInput.clientTurnId
          ? { clientTurnId: options.queuedInput.clientTurnId }
          : {}),
        accepted: false,
        rpcUncertain: false,
      };
    }
    void live.client.request(
      "turn/start",
      {
        threadId: live.threadId,
        input: codexTurnInput(request),
        ...(request.clientMessageId
          ? { clientUserMessageId: request.clientMessageId }
          : {}),
        cwd: live.cwd,
        approvalPolicy: live.approvalPolicy,
        ...(live.approvalsReviewer === "auto_review"
          ? { approvalsReviewer: live.approvalsReviewer }
          : {}),
        sandboxPolicy: codexSandboxPolicyForTurn({
          sandboxMode: live.sandboxMode,
          cwd: live.cwd,
        }),
        ...(live.modelId ? { model: live.modelId } : {}),
        ...(live.reasoningId ? { effort: live.reasoningId } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
      },
      90_000,
    ).then((result) => {
      const turn =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as { turn?: { id?: unknown } }).turn
          : undefined;
      if (
        typeof turn?.id === "string" &&
        !live.currentTurnId &&
        !live.finishedTurnIds.has(turn.id)
      ) {
        live.currentTurnId = turn.id;
      }
      if (typeof turn?.id === "string") {
        if (
          options?.queuedInput &&
          live.queuedInputSubmission?.clientMessageId ===
            options.queuedInput.clientMessageId
        ) {
          live.queuedInputSubmission.accepted = true;
          if (
            deleteRuntimeQueuedInput(
              live.queuedInputs,
              options.queuedInput.clientMessageId,
            )
          ) {
            publishSessionInputAccepted(
              this.services,
              live.sessionId,
              options.queuedInput,
            );
            publishSessionInputQueue(
              this.services,
              live.sessionId,
              live.queuedInputs,
            );
          }
        }
        live.queuedInputDrainPaused = false;
        if (
          options?.queuedInput &&
          live.uncertainQueuedInputClientMessageId === options.queuedInput.clientMessageId
        ) {
          delete live.uncertainQueuedInputClientMessageId;
        }
      } else if (
        options?.queuedInput &&
        live.queuedInputSubmission?.clientMessageId ===
          options.queuedInput.clientMessageId
      ) {
        live.queuedInputSubmission.rpcUncertain = true;
        live.queuedInputDrainPaused = true;
        live.uncertainQueuedInputClientMessageId =
          options.queuedInput.clientMessageId;
        publishSessionInputQueue(this.services, live.sessionId, live.queuedInputs);
      }
      if (
        typeof turn?.id === "string" &&
        live.translationState.pendingRuntimeModel &&
        !live.translationState.runtimeModelByTurnId.has(turn.id)
      ) {
        live.translationState.runtimeModelByTurnId.set(
          turn.id,
          live.translationState.pendingRuntimeModel,
        );
        delete live.translationState.pendingRuntimeModel;
      }
      if (typeof turn?.id === "string") {
        bindCodexSubmittedUserMessageToTurn(live.translationState, turn.id);
      }
      if (typeof turn?.id === "string" && live.interruptWhenTurnStarts) {
        const turnId = turn.id;
        live.interruptWhenTurnStarts = false;
        if (!live.interruptingTurnIds.has(turnId)) {
          live.interruptingTurnIds.add(turnId);
          void live.client
            .request("turn/interrupt", {
              threadId: live.threadId,
              turnId,
            })
            .then(() => {
              this.scheduleInterruptFallback(live, turnId);
            })
            .catch((error) => {
              this.reportAsyncLiveError(
                live.sessionId,
                error instanceof Error ? error.message : String(error),
              );
            });
        }
      }
    }).catch((error) => {
      const queuedInputWasAccepted = Boolean(
        options?.queuedInput &&
          live.queuedInputSubmission?.clientMessageId ===
            options.queuedInput.clientMessageId &&
          live.queuedInputSubmission.accepted,
      );
      if (!queuedInputWasAccepted) {
        const rpcExplicitlyRejected = error instanceof CodexJsonRpcResponseError;
        if (rpcExplicitlyRejected) {
          discardPendingCodexSubmittedUserMessage(
            live.translationState,
            request.clientMessageId,
          );
          if (options?.queuedInput) {
            markRuntimeQueuedInputQueued(
              live.queuedInputs,
              options.queuedInput.clientMessageId,
            );
            if (
              live.queuedInputSubmission?.clientMessageId ===
              options.queuedInput.clientMessageId
            ) {
              delete live.queuedInputSubmission;
            }
          }
        } else if (
          options?.queuedInput &&
          live.queuedInputSubmission?.clientMessageId === options.queuedInput.clientMessageId
        ) {
          live.queuedInputSubmission.rpcUncertain = true;
        }
      }
      if (
        options?.queuedInput &&
        !queuedInputWasAccepted &&
        this.liveSessions.get(live.sessionId) === live &&
        !live.ephemeralExpired
      ) {
        live.queuedInputDrainPaused = true;
        live.uncertainQueuedInputClientMessageId =
          options.queuedInput.clientMessageId;
        publishSessionInputQueue(this.services, live.sessionId, live.queuedInputs);
      }
      if (!queuedInputWasAccepted) {
        this.reportAsyncLiveError(
          live.sessionId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }).finally(() => {
      live.turnStartInFlight = false;
      if (
        options?.queuedInput &&
        live.queuedInputSubmission?.clientMessageId ===
          options.queuedInput.clientMessageId &&
        live.queuedInputSubmission.accepted
      ) {
        delete live.queuedInputSubmission;
      }
      if (!live.currentTurnId) {
        live.interruptWhenTurnStarts = false;
      }
      this.drainQueuedInput(live);
    });
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const rawCachedModelCatalog = this.modelCatalog.getCached();
    const cachedModelCatalog =
      request.model || request.optionValues !== undefined
        ? mergeManualProviderModels(await this.modelCatalog.listModels())
        : rawCachedModelCatalog
          ? mergeManualProviderModels(rawCachedModelCatalog)
          : null;
    const response = await startCodexLiveSession({
      services: this.services,
      request,
      ...(cachedModelCatalog ? { initialModelCatalog: cachedModelCatalog } : {}),
      onLiveSessionReady: (liveSession) => {
        this.registerLiveSession(liveSession);
      },
    });
    const initialPrompt = request.initialPrompt?.trim();
    if (initialPrompt) {
      const clientMessageId = request.initialClientMessageId ?? randomUUID();
      this.sendInput(response.sessionId, {
        clientId: request.attach?.client.id ?? "system",
        text: initialPrompt,
        clientMessageId,
        ...(request.initialClientTurnId
          ? { clientTurnId: request.initialClientTurnId }
          : {}),
      });
      const live = this.liveSessions.get(response.sessionId);
      if (!live) {
        throw new Error("Codex Session closed before the initial question could be delivered.");
      }
      await this.waitForQueuedInputAcceptance(live, clientMessageId);
    }
    const current = this.services.sessionStore.getSession(response.sessionId);
    return { session: current ? toSessionSummary(current) : response.summary };
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const reused = reuseExistingProviderSessionForResume({
      services: this.services,
      provider: "codex",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: request.preferStoredReplay,
      historySourceSessionId: request.historySourceSessionId,
      rehydratedSessionIds: this.rehydratedSessionIds,
      ...(request.attach !== undefined ? { attach: request.attach } : {}),
    });
    if (reused) {
      return reused;
    }
    const preparedResume = prepareProviderSessionResume({
      services: this.services,
      provider: "codex",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: request.preferStoredReplay,
      historySourceSessionId: request.historySourceSessionId,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const record = findCodexStoredSessionRecord(request.providerSessionId);
    if (request.preferStoredReplay && !record) {
      throw new Error(`Unknown Codex session ${request.providerSessionId}.`);
    }
    if (!record && request.cwd === undefined) {
      throw new Error(`Unknown Codex session ${request.providerSessionId}.`);
    }

    if (request.preferStoredReplay && record) {
      return finalizeStoredReplayResume({
        services: this.services,
        provider: "codex",
        providerSessionId: request.providerSessionId,
        rehydratedSessionIds: this.rehydratedSessionIds,
        createSession: () =>
          resumeCodexStoredSession(
            request.attach !== undefined
              ? { services: this.services, record, attach: request.attach }
              : { services: this.services, record },
          ),
      });
    }

    if (record && request.cwd !== undefined && request.cwd !== record.ref.cwd) {
      record.ref = {
        ...record.ref,
        cwd: request.cwd,
        rootDir: request.cwd,
      };
    }

    const rawCachedModelCatalog = this.modelCatalog.getCached();
    const cachedModelCatalog =
      request.model || request.optionValues !== undefined
        ? mergeManualProviderModels(await this.modelCatalog.listModels())
        : rawCachedModelCatalog
          ? mergeManualProviderModels(rawCachedModelCatalog)
          : null;
    try {
      const response = await resumeCodexLiveSession({
        services: this.services,
        request,
        ...(record ? { record } : {}),
        ...(cachedModelCatalog ? { initialModelCatalog: cachedModelCatalog } : {}),
        onLiveSessionReady: (liveSession) => {
          this.registerLiveSession(liveSession);
        },
      });
      return { session: response.summary };
    } catch (error) {
      // A requested live resume must never masquerade as a successful
      // read-only replay. The caller may be carrying the user's first input;
      // returning replay here acknowledges a Session that cannot accept it.
      preparedResume.rollback();
      throw error;
    }
  }

  async forkSession(
    parentSessionId: string,
    request: ForkSessionRequest,
  ): Promise<ForkSessionResponse> {
    const parentState = this.services.sessionStore.getSession(parentSessionId);
    if (!parentState || parentState.session.provider !== "codex") {
      throw new Error(`Unknown Codex parent session ${parentSessionId}.`);
    }
    const parentLive = this.liveSessions.get(parentSessionId);
    const response = await forkCodexLiveSession({
      services: this.services,
      parentSummary: toSessionSummary(parentState),
      ...(parentLive ? { parentLive } : {}),
      request,
      onLiveSessionReady: (liveSession) => {
        this.registerLiveSession(liveSession);
      },
    });
    return { session: response.summary };
  }

  sendInput(sessionId: string, request: SessionInputRequest): void {
    const sideState = this.services.sessionStore.getSession(sessionId)?.session.relationship?.sideState;
    if (sideState === "expired") {
      throw new Error("This Side task expired in Codex. Start a new Side to continue.");
    }
    if (sideState === "cleanup_failed") {
      throw new Error("This Side task could not be cleaned up. Retry discard before continuing.");
    }
    const live = this.liveSessions.get(sessionId);
    if (live) {
      if (live.ephemeralExpired) {
        throw new Error("This Side task expired in Codex. Start a new Side to continue.");
      }
      // Accept every message into RAH's canonical queue before attempting the
      // provider RPC. An immediate turn/start rejection must never erase the
      // only owned copy of a user's question after HTTP already returned 200.
      this.enqueueInput(live, request);
      if (!live.queuedInputDrainPaused) {
        this.drainQueuedInput(live);
      }
      return;
    }
    throw new Error(
      "Rehydrated Codex sessions are currently read-only. Live Codex app-server control is not wired yet.",
    );
  }

  updateQueuedInput(
    sessionId: string,
    clientMessageId: string,
    request: UpdateQueuedInputRequest,
  ): SessionSummary {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error(`Session ${sessionId} has no live input queue.`);
    }
    if (!request.text.trim()) {
      throw new Error("Queued message cannot be empty.");
    }
    if (!updateRuntimeQueuedInput(live.queuedInputs, clientMessageId, request.text)) {
      throw new SessionInputQueueConflictError(
        "Queued message is no longer waiting and cannot be edited.",
      );
    }
    publishSessionInputQueue(this.services, sessionId, live.queuedInputs);
    if (live.uncertainQueuedInputClientMessageId === clientMessageId) {
      delete live.uncertainQueuedInputClientMessageId;
      live.queuedInputDrainPaused = false;
      this.drainQueuedInput(live);
    }
    return toSessionSummary(this.services.sessionStore.getSession(sessionId)!);
  }

  deleteQueuedInput(
    sessionId: string,
    clientMessageId: string,
    request: DeleteQueuedInputRequest,
  ): SessionSummary {
    void request;
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error(`Session ${sessionId} has no live input queue.`);
    }
    if (!withdrawRuntimeQueuedInput(live.queuedInputs, clientMessageId)) {
      throw new SessionInputQueueConflictError(
        "Queued message is no longer waiting and cannot be removed.",
      );
    }
    if (live.uncertainQueuedInputClientMessageId === clientMessageId) {
      delete live.uncertainQueuedInputClientMessageId;
      live.queuedInputDrainPaused = false;
    }
    publishSessionInputQueue(this.services, sessionId, live.queuedInputs);
    this.drainQueuedInput(live);
    return toSessionSummary(this.services.sessionStore.getSession(sessionId)!);
  }

  reorderQueuedInput(
    sessionId: string,
    clientMessageId: string,
    request: ReorderQueuedInputRequest,
  ): SessionSummary {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error(`Session ${sessionId} has no live input queue.`);
    }
    if (!reorderRuntimeQueuedInput(live.queuedInputs, clientMessageId, request.position)) {
      throw new SessionInputQueueConflictError(
        "Queued message is no longer waiting and cannot be reordered.",
      );
    }
    publishSessionInputQueue(this.services, sessionId, live.queuedInputs);
    return toSessionSummary(this.services.sessionStore.getSession(sessionId)!);
  }

  async steerQueuedInput(
    sessionId: string,
    clientMessageId: string,
    request: SteerQueuedInputRequest,
  ): Promise<SessionSummary> {
    void request;
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error(`Session ${sessionId} has no live input queue.`);
    }
    const queuedInput = live.queuedInputs.find(
      (item) => item.clientMessageId === clientMessageId,
    );
    if (queuedInput?.state === "submitting") {
      return toSessionSummary(this.services.sessionStore.getSession(sessionId)!);
    }
    if (!queuedInput) {
      const alreadyAccepted = this.services.eventBus
        .list({
          sessionIds: [sessionId],
          eventTypes: ["session.input.accepted"],
        })
        .some(
          (event) =>
            event.type === "session.input.accepted" &&
            event.payload.clientMessageId === clientMessageId,
        );
      if (alreadyAccepted) {
        return toSessionSummary(this.services.sessionStore.getSession(sessionId)!);
      }
    }
    if (!queuedInput || queuedInput.state !== "queued") {
      throw new SessionInputQueueConflictError(
        "Queued message is no longer waiting and cannot be guided.",
      );
    }
    if (!live.currentTurnId || live.turnStartInFlight) {
      // The active turn crossed its terminal boundary before the Guide click
      // reached the daemon. Keep the same message and naturally drain it as
      // the next turn; the user action is idempotently successful.
      this.drainQueuedInput(live);
      return toSessionSummary(this.services.sessionStore.getSession(sessionId)!);
    }
    await this.steerLiveTurn(live, queuedInput, queuedInput);
    return toSessionSummary(this.services.sessionStore.getSession(sessionId)!);
  }

  setInputQueuePolicy(
    sessionId: string,
    request: SetInputQueuePolicyRequest,
  ): SessionSummary {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error(`Session ${sessionId} has no live input queue.`);
    }
    void request.policy;
    live.inputQueuePolicy = "queue";
    publishSessionInputQueuePolicy(this.services, sessionId, "queue");
    return toSessionSummary(this.services.sessionStore.getSession(sessionId)!);
  }

  async listModels(options?: { cwd?: string; forceRefresh?: boolean }): Promise<ProviderModelCatalog> {
    void options?.cwd;
    return mergeManualProviderModels(await this.modelCatalog.listModels(options));
  }

  async setSessionModel(
    sessionId: string,
    request: SetSessionModelRequest,
  ): Promise<SessionSummary> {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Codex model switching is only available for running sessions.");
    }
    const nextModelId = request.modelId.trim();
    if (!nextModelId) {
      throw new Error("Session model is required.");
    }
    const catalog = mergeManualProviderModels(await this.modelCatalog.listModels());
    const model = catalog.models.find((entry) => entry.id === nextModelId);
    if (!model) {
      throw new Error(`Unsupported Codex model '${nextModelId}'.`);
    }
    const optionValues = resolveModelOptionValues({
      catalog,
      model,
      optionValues: request.optionValues,
      useDefaults: true,
      requireMutable: true,
    });
    const optionReasoningId = optionValueAsString(optionValues, "model_reasoning_effort");
    const nextReasoningId = optionReasoningId ?? model.defaultReasoningId ?? null;
    live.modelId = nextModelId;
    live.reasoningId = nextReasoningId;
    live.modelCatalog = catalog;
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
      model: {
        currentModelId: nextModelId,
        currentReasoningId: nextReasoningId,
        availableModels: catalog.models,
        mutable: true,
        source: catalog.source,
      },
      ...resolveCodexRuntimeCapabilityState({
        catalog,
        modelId: nextModelId,
        reasoningId: nextReasoningId,
        optionValues,
      }),
    });
    return toSessionSummary(nextState);
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<SessionSummary> {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Codex mode switching is only available for running sessions.");
    }
    const planAccessModeId = codexPlanAccessModeId(modeId);
    if (modeId === "plan" || planAccessModeId) {
      if (!live.planCollaborationMode) {
        live.planCollaborationMode = await loadCodexPlanCollaborationMode(live.client);
      }
      if (!live.planCollaborationMode) {
        throw new Error("Codex plan mode is not available for this session.");
      }
      if (planAccessModeId) {
        const parsed = parseCodexModeId(planAccessModeId);
        if (!parsed) {
          throw new Error(`Unsupported Codex mode '${modeId}'.`);
        }
        live.approvalPolicy = parsed.approvalPolicy;
        live.sandboxMode = parsed.sandboxMode;
        live.approvalsReviewer = parsed.approvalsReviewer ?? "user";
        live.lastNonPlanModeId = planAccessModeId;
      }
      live.activeModeId = "plan";
      const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
        mode: buildCodexModeState({
          currentModeId: "plan",
          mutable: true,
          preferredAccessModeId: live.lastNonPlanModeId,
          planAvailable: true,
        }),
      });
      return toSessionSummary(nextState);
    }
    const parsed = parseCodexModeId(modeId);
    if (!parsed) {
      throw new Error(`Unsupported Codex mode '${modeId}'.`);
    }
    live.approvalPolicy = parsed.approvalPolicy;
    live.sandboxMode = parsed.sandboxMode;
    live.approvalsReviewer = parsed.approvalsReviewer ?? "user";
    live.activeModeId = modeId;
    live.lastNonPlanModeId = modeId;
    const nextState = this.services.sessionStore.patchManagedSession(sessionId, {
      mode: buildCodexModeState({
        currentModeId: modeId,
        mutable: true,
        planAvailable: Boolean(live.planCollaborationMode),
      }),
    });
    return toSessionSummary(nextState);
  }

  async renameSession(sessionId: string, title: string): Promise<SessionSummary> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state?.session.providerSessionId) {
      throw new Error(`Session ${sessionId} does not have a provider session id.`);
    }

    const live = this.liveSessions.get(sessionId);
    if (live) {
      await live.client.request("thread/name/set", {
        threadId: live.threadId,
        name: title,
      });
    } else {
      const client = await createCodexAppServerClient();
      try {
        await client.request("thread/name/set", {
          threadId: state.session.providerSessionId,
          name: title,
        });
      } finally {
        await client.dispose();
      }
    }

    const nextState = this.services.sessionStore.patchManagedSession(sessionId, { title });
    patchCodexStoredSessionTitle(state.session.providerSessionId, title);
    return toSessionSummary(nextState);
  }

  async closeSession(sessionId: string, request: CloseSessionRequest): Promise<void> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    if (!this.services.sessionStore.hasAttachedClient(sessionId, request.clientId)) {
      throw new Error(`Client ${request.clientId} is not attached to ${sessionId}.`);
    }
    const live = this.liveSessions.get(sessionId);
    if (live) {
      await this.prepareLiveSessionForDisposal(live);
      this.liveSessions.delete(sessionId);
      this.clearInterruptFallback(live);
      await live.flushNotifications?.();
      await live.client.dispose();
    } else {
      await this.disposeDetachedEphemeralSide(sessionId);
    }
    this.rehydratedSessionIds.delete(sessionId);
  }

  async destroySession(sessionId: string): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      await this.prepareLiveSessionForDisposal(live);
      this.liveSessions.delete(sessionId);
      this.clearInterruptFallback(live);
      await live.flushNotifications?.();
      await live.client.dispose();
    } else {
      await this.disposeDetachedEphemeralSide(sessionId);
    }
    this.rehydratedSessionIds.delete(sessionId);
  }

  interruptSession(sessionId: string, _request: InterruptSessionRequest): SessionSummary {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      const state = this.services.sessionStore.getSession(sessionId);
      if (!state) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      const turnId = live.currentTurnId;
      this.clearQueuedInputs(live);
      if (turnId) {
        if (live.interruptingTurnIds.has(turnId)) {
          return toSessionSummary(state);
        }
        live.interruptingTurnIds.add(turnId);
        void live.client
          .request("turn/interrupt", {
            threadId: live.threadId,
            turnId,
          })
          .then(() => {
            this.scheduleInterruptFallback(live, turnId);
          })
          .catch((error) => {
            this.reportAsyncLiveError(
              sessionId,
              error instanceof Error ? error.message : String(error),
            );
          });
      } else if (live.turnStartInFlight && !live.interruptWhenTurnStarts) {
        live.interruptWhenTurnStarts = true;
      }
      return toSessionSummary(state);
    }
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return toSessionSummary(state);
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error(`Session ${sessionId} does not support live permission responses.`);
    }
    await respondToCodexLivePermission({
      services: this.services,
      liveSession: live,
      requestId,
      response,
    });
  }

  onPtyInput(sessionId: string, clientId: string, data: string): void {
    if (this.liveSessions.has(sessionId)) {
      throw new Error("Codex running sessions do not support PTY input bridging yet.");
    }
    void clientId;
    void data;
    throw new Error("Rehydrated Codex sessions do not accept PTY input.");
  }

  onPtyResize(sessionId: string, clientId: string, cols: number, rows: number): void {
    if (this.liveSessions.has(sessionId)) {
      return;
    }
    void sessionId;
    void clientId;
    void cols;
    void rows;
  }

  async getProviderDiagnostic(options?: { forceRefresh?: boolean; includeHealth?: boolean }) {
    return probeProviderDiagnostic("codex", await codexLaunchSpec(), options);
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.liveSessions.values()];
    this.liveSessions.clear();
    sessions.forEach((live) => this.clearInterruptFallback(live));
    const results = await Promise.allSettled(
      sessions.map(async (live) => {
        try {
          await this.prepareLiveSessionForDisposal(live);
          await live.flushNotifications?.();
        } finally {
          await live.client.dispose();
        }
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error("[rah] failed to dispose Codex running session during shutdown", {
          sessionId: sessions[index]?.sessionId,
          error: result.reason,
        });
      }
    });
  }
}
