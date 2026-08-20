import {
  type ForkSessionRequest,
  type ManagedSession,
  type ProviderModelCatalog,
  type PermissionResponseRequest,
  type ResumeSessionRequest,
  type StartSessionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "../provider-adapter";
import { applyProviderActivity } from "../provider-activity";
import {
  mapCodexPermissionResolution,
  createCodexAppServerTranslationState,
} from "../codex-app-server-activity";
import {
  patchCodexStoredSessionTitle,
  type CodexStoredSessionRecord,
} from "../codex-stored-sessions";
import { resolveCodexRuntimeCapabilityState } from "../codex-model-catalog";
import { toSessionSummary } from "../session-store";
import {
  buildCodexModeState,
  codexPlanAccessModeId,
  codexModeId,
  isCodexModeId,
  parseCodexModeId,
} from "../session-mode-utils";
import {
  attachCurrentTurn,
  attachRequestedClient,
  createLiveSessionBridge,
  isCodexInternalThreadMetadataText,
  publishSessionBootstrap,
  resolveCodexApprovalDecision,
} from "../codex-live-helpers";
import { runtimeStateFromCodexThreadStatus } from "../codex-thread-status";
import {
  createCodexAppServerClient,
  type CodexAppServerRpcClient,
} from "../codex-app-server-client";
import {
  THREAD_FORK_TIMEOUT_MS,
  TURN_START_TIMEOUT_MS,
  type LiveCodexSession,
} from "../codex-live-types";
import { optionValueAsString, resolveModelOptionValues } from "../session-model-options";
import {
  nativeLocalServerAttachSpec,
  nativeLocalServerRuntimeDiagnostics,
} from "../native-local-server-attach";
import {
  codexConfigOverridesForMcpServers,
  extraMcpServersFromRequest,
} from "../provider-mcp-server-spec";
import { resolveSessionTitleAndPreview } from "../session-title-resolver";
import { requestCodexThreadResumeWithoutTranscript } from "../codex-app-server-resume";
import { requestCodexThreadForkWithoutTranscript } from "../codex-app-server-fork";
import {
  CODEX_SIDE_DEVELOPER_INSTRUCTIONS,
  codexSideBoundaryItem,
} from "../codex-side-conversation";
import { publishSessionStateChanged } from "../runtime-session-events";
import { allocateForkSessionTitle } from "../session-branch-title";

export type { LiveCodexSession } from "../codex-live-types";

type CodexForkMode = ReturnType<typeof resolveCodexStartupMode>;

function codexNativeTuiAttachAvailable(args: {
  providerSessionId: string;
  endpoint?: string | undefined;
}): boolean {
  return Boolean(
    nativeLocalServerAttachSpec({
      provider: "codex",
      providerSessionId: args.providerSessionId,
      endpoint: args.endpoint,
    }),
  );
}

function resolveCodexStartupMode(args: {
  modeId?: string | undefined;
  fallbackApprovalPolicy?: string | undefined;
  fallbackSandboxMode?: string | undefined;
  fallbackApprovalsReviewer?: "user" | "auto_review" | undefined;
}): {
  activeModeId: string;
  accessModeId: string;
  approvalPolicy: string;
  sandboxMode: string;
  approvalsReviewer: "user" | "auto_review";
} {
  const fallbackApprovalPolicy = args.fallbackApprovalPolicy ?? "never";
  const fallbackSandboxMode = args.fallbackSandboxMode ?? "danger-full-access";
  const fallbackApprovalsReviewer = args.fallbackApprovalsReviewer ?? "user";
  const requestedModeId = args.modeId?.trim();
  if (requestedModeId) {
    if (!isCodexModeId(requestedModeId)) {
      throw new Error(`Unsupported Codex mode '${requestedModeId}'.`);
    }
    const planAccessModeId = codexPlanAccessModeId(requestedModeId);
    if (requestedModeId === "plan" || planAccessModeId) {
      const parsedAccessMode = planAccessModeId ? parseCodexModeId(planAccessModeId) : null;
      const approvalPolicy = parsedAccessMode?.approvalPolicy ?? fallbackApprovalPolicy;
      const sandboxMode = parsedAccessMode?.sandboxMode ?? fallbackSandboxMode;
      const approvalsReviewer =
        parsedAccessMode?.approvalsReviewer ?? fallbackApprovalsReviewer;
      const accessModeId =
        planAccessModeId ??
        codexAccessModeIdForConfig({
          approvalPolicy,
          sandboxMode,
          approvalsReviewer,
        });
      return {
        activeModeId: "plan",
        accessModeId,
        approvalPolicy,
        sandboxMode,
        approvalsReviewer,
      };
    }
    const parsed = parseCodexModeId(requestedModeId);
    if (!parsed) {
      throw new Error(`Unsupported Codex mode '${requestedModeId}'.`);
    }
    return {
      activeModeId: requestedModeId,
      accessModeId: requestedModeId,
      approvalPolicy: parsed.approvalPolicy,
      sandboxMode: parsed.sandboxMode,
      approvalsReviewer: parsed.approvalsReviewer ?? "user",
    };
  }
  const approvalPolicy = fallbackApprovalPolicy;
  const sandboxMode = fallbackSandboxMode;
  const accessModeId = codexAccessModeIdForConfig({
    approvalPolicy,
    sandboxMode,
    approvalsReviewer: fallbackApprovalsReviewer,
  });
  return {
    activeModeId: accessModeId,
    accessModeId,
    approvalPolicy,
    sandboxMode,
    approvalsReviewer: fallbackApprovalsReviewer,
  };
}

function codexAccessModeIdForConfig(args: {
  approvalPolicy: string;
  sandboxMode: string;
  approvalsReviewer: "user" | "auto_review";
}): string {
  if (
    args.approvalsReviewer === "auto_review" &&
    args.approvalPolicy === "on-request" &&
    args.sandboxMode === "workspace-write"
  ) {
    return "auto-review/workspace-write";
  }
  return codexModeId({
    approvalPolicy: args.approvalPolicy,
    sandboxMode: args.sandboxMode,
  });
}

function codexString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function codexRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function codexApprovalPolicyFromResponse(response: {
  approvalPolicy?: unknown;
  approval_policy?: unknown;
}): string | undefined {
  return codexString(response.approvalPolicy) ?? codexString(response.approval_policy);
}

function codexSandboxModeFromResponse(sandbox: unknown): string | undefined {
  const direct = codexString(sandbox);
  if (direct) {
    return direct;
  }
  const record = codexRecord(sandbox);
  if (!record) {
    return undefined;
  }
  const type = codexString(record.type);
  switch (type) {
    case "dangerFullAccess":
      return "danger-full-access";
    case "readOnly":
      return "read-only";
    case "workspaceWrite":
      return "workspace-write";
    case "externalSandbox":
      return "external-sandbox";
    default:
      return type;
  }
}

function codexApprovalsReviewerFromResponse(
  value: unknown,
): "user" | "auto_review" | undefined {
  if (value === "user" || value === "auto_review") {
    return value;
  }
  if (value === "guardian_subagent") {
    return "auto_review";
  }
  return undefined;
}

async function setCodexThreadNameIfRequested(
  client: CodexAppServerRpcClient,
  threadId: string,
  title?: string,
): Promise<void> {
  const name = title?.trim();
  if (!name) {
    return;
  }
  try {
    await client.request("thread/name/set", { threadId, name }, TURN_START_TIMEOUT_MS);
  } catch {
    // Naming is advisory for RAH; a failed native rename should not strand a live session.
  }
}

async function setCodexThreadName(
  client: CodexAppServerRpcClient,
  threadId: string,
  title: string,
): Promise<void> {
  await client.request(
    "thread/name/set",
    { threadId, name: title },
    TURN_START_TIMEOUT_MS,
  );
}

function cacheCodexThreadTitle(threadId: string, title: string): void {
  try {
    patchCodexStoredSessionTitle(threadId, title);
  } catch {
    // The provider name is authoritative. A rollout/cache race must not roll back a live Fork.
  }
}

async function unarchiveCodexThreadIfNeeded(args: {
  client: CodexAppServerRpcClient;
  threadId: string;
  record?: CodexStoredSessionRecord;
}): Promise<void> {
  if (args.record?.archived !== true && args.record?.ref.providerState?.archived !== true) {
    return;
  }
  try {
    await args.client.request("thread/unarchive", { threadId: args.threadId }, TURN_START_TIMEOUT_MS);
  } catch {
    // Resume remains the authority. If the thread was already restored or the
    // server rejects unarchive, the normal resume error path will decide.
  }
}

export async function pauseActiveCodexThreadGoal(
  client: CodexAppServerRpcClient,
  threadId: string,
  timeoutMs = TURN_START_TIMEOUT_MS,
): Promise<boolean> {
  const response = (await client.request("thread/goal/get", { threadId }, timeoutMs)) as {
    goal?: {
      status?: unknown;
    } | null;
  };
  if (response.goal?.status !== "active") {
    return false;
  }
  await client.request(
    "thread/goal/set",
    {
      threadId,
      status: "paused",
    },
    timeoutMs,
  );
  return true;
}

async function pauseActiveCodexGoalBeforeHistoryClaim(args: {
  client: CodexAppServerRpcClient;
  threadId: string;
  request: ResumeSessionRequest;
}): Promise<void> {
  if (args.request.preferStoredReplay === true || !args.request.historySourceSessionId) {
    return;
  }
  await pauseActiveCodexThreadGoal(args.client, args.threadId);
}

export async function loadCodexPlanCollaborationMode(client: CodexAppServerRpcClient): Promise<LiveCodexSession["planCollaborationMode"]> {
  const response = (await client.request("collaborationMode/list", {})) as {
    data?: Array<{
      name?: string;
      mode?: string | null;
      model?: string | null;
      reasoning_effort?: string | null | null;
    }>;
  };
  const planMask = response.data?.find((entry) => entry.mode === "plan");
  if (!planMask) {
    return null;
  }
  return {
    mode: "plan",
    settings: {
      model: planMask.model ?? null,
      reasoning_effort: planMask.reasoning_effort ?? null,
      developer_instructions: null,
    },
  };
}

export async function startCodexLiveSession(params: {
  services: RuntimeServices;
  request: StartSessionRequest;
  initialModelCatalog?: ProviderModelCatalog | null;
  onLiveSessionReady: (liveSession: LiveCodexSession) => void;
}) {
  const { services, request } = params;
  const client = await createCodexAppServerClient();
  const bridge = createLiveSessionBridge(services, client);
  const planCollaborationMode = await loadCodexPlanCollaborationMode(client);
  const initialMode = resolveCodexStartupMode({
    modeId: request.modeId,
  });
  if (initialMode.activeModeId === "plan" && !planCollaborationMode) {
    await client.dispose();
    throw new Error("Codex plan mode is not available for this session.");
  }

  const configOverrides = codexConfigOverridesForMcpServers(extraMcpServersFromRequest(request));
  const threadStart = (await client.request("thread/start", {
    ...(request.cwd ? { cwd: request.cwd } : {}),
    approvalPolicy: initialMode.approvalPolicy,
    sandbox: initialMode.sandboxMode,
    ...(initialMode.approvalsReviewer === "auto_review"
      ? { approvalsReviewer: initialMode.approvalsReviewer }
      : {}),
    ...(request.model ? { model: request.model } : {}),
    ...(configOverrides ? { config: configOverrides } : {}),
  })) as {
    thread?: { id?: string; modelProvider?: string; model_provider?: string };
    model?: string;
    modelProvider?: string;
    model_provider?: string;
    reasoningEffort?: string | null;
    reasoning_effort?: string | null;
  };
  const threadId = threadStart?.thread?.id;
  if (!threadId) {
    await client.dispose();
    throw new Error("Codex app-server did not return a thread id.");
  }
  await setCodexThreadNameIfRequested(client, threadId, request.title);
  const modelProvider =
    threadStart.modelProvider ??
    threadStart.model_provider ??
    threadStart.thread?.modelProvider ??
    threadStart.thread?.model_provider;
  const currentModelId =
    request.model ?? threadStart.model ?? params.initialModelCatalog?.currentModelId ?? null;
  const currentModel = currentModelId
    ? params.initialModelCatalog?.models.find((model) => model.id === currentModelId)
    : undefined;
  if (request.optionValues !== undefined && !currentModel) {
    await client.dispose();
    throw new Error(`Unsupported Codex model '${currentModelId ?? ""}'.`);
  }
  const currentOptionValues = currentModel
    ? resolveModelOptionValues({
        catalog: params.initialModelCatalog ?? null,
        model: currentModel,
        optionValues: request.optionValues,
      })
    : {};
  const currentReasoningId =
    optionValueAsString(currentOptionValues, "model_reasoning_effort") ??
    threadStart.reasoningEffort ??
    threadStart.reasoning_effort ??
    params.initialModelCatalog?.currentReasoningId ??
    null;
  const nativeTuiAttachAvailable = codexNativeTuiAttachAvailable({
    providerSessionId: threadId,
    endpoint: client.endpoint,
  });

  const state = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: threadId,
    ...(modelProvider ? { modelProvider } : {}),
    ...(request.origin !== undefined ? { origin: request.origin } : {}),
    launchSource: "web",
    liveBackend: "native_local_server",
    cwd: request.cwd,
    rootDir: request.cwd,
    runtimeDiagnostics: nativeLocalServerRuntimeDiagnostics({
      provider: "codex",
      providerSessionId: threadId,
      endpoint: client.endpoint ?? "stdio:codex app-server",
      ...(client.processId !== undefined ? { serverPid: client.processId } : {}),
      attachState: client.endpoint ? "ready" : "unavailable",
      lastEventCursor: `thread:${threadId}`,
    }),
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.initialPrompt !== undefined ? { preview: request.initialPrompt } : {}),
    mode: buildCodexModeState({
      currentModeId: initialMode.activeModeId,
      mutable: true,
      preferredAccessModeId: initialMode.accessModeId,
      planAvailable: Boolean(planCollaborationMode),
    }),
    model: {
      currentModelId,
      currentReasoningId,
      availableModels: params.initialModelCatalog?.models ?? [],
      mutable: true,
      source: params.initialModelCatalog?.source ?? "native",
    },
    ...resolveCodexRuntimeCapabilityState({
      catalog: params.initialModelCatalog ?? null,
      modelId: currentModelId,
      reasoningId: currentReasoningId,
      ...(Object.keys(currentOptionValues).length > 0
        ? { optionValues: currentOptionValues }
        : {}),
    }),
    capabilities: {
      modelSwitch: true,
      structuredControl: true,
      actions: {
        info: true,
        stop: true,
        archive: true,
        delete: true,
        rename: "native",
      },
      steerInput: true,
      queuedInput: true,
      branching: { sameWorkspace: true, worktree: false, side: true },
    },
  });
  services.sessionStore.patchManagedSession(state.session.id, {
    nativeTui: {
      terminalId: state.session.id,
      viewAvailable: nativeTuiAttachAvailable,
      promptState: "prompt_clean",
      queuedInputCount: 0,
    },
    capabilities: {
      nativeTui: nativeTuiAttachAvailable,
      rawPtyInput: nativeTuiAttachAvailable,
    },
  });
  services.ptyHub.ensureSession(state.session.id);
  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const runtimeSession = services.sessionStore.getSession(state.session.id);
  if (!runtimeSession) {
    await client.dispose();
    throw new Error("Failed to create runtime session for Codex running session.");
  }
  publishSessionBootstrap(services, state.session.id, runtimeSession.session);

  const liveSession: LiveCodexSession = {
    sessionId: state.session.id,
    threadId,
    cwd: request.cwd,
    approvalPolicy: initialMode.approvalPolicy,
    sandboxMode: initialMode.sandboxMode,
    approvalsReviewer: initialMode.approvalsReviewer,
    modelId: currentModelId,
    reasoningId: currentReasoningId,
    modelCatalog: params.initialModelCatalog ?? null,
    activeModeId: initialMode.activeModeId,
    lastNonPlanModeId: initialMode.accessModeId,
    planCollaborationMode,
    client,
    translationState: createCodexAppServerTranslationState(),
    currentTurnId: runtimeSession.activeTurnId ?? null,
    finishedTurnIds: new Set(),
    interruptingTurnIds: new Set(),
    turnStartInFlight: false,
    interruptWhenTurnStarts: false,
    queuedInputs: [],
    inputQueuePolicy: "queue",
    externalThreadMirrorSubscribeInFlight: false,
    externalThreadMirrorSubscribed: true,
    pendingQuestions: new Map(),
    pendingApprovals: new Map(),
  };
  bridge.activate(liveSession);
  attachRequestedClient(services, state.session.id, request.attach);
  params.onLiveSessionReady(liveSession);
  return {
    sessionId: state.session.id,
    summary: toSessionSummary(services.sessionStore.getSession(state.session.id)!),
  };
}

export async function resumeCodexLiveSession(params: {
  services: RuntimeServices;
  request: ResumeSessionRequest;
  record?: CodexStoredSessionRecord;
  initialModelCatalog?: ProviderModelCatalog | null;
  onLiveSessionReady: (liveSession: LiveCodexSession) => void;
}) {
  const { services, request, record } = params;
  const client = await createCodexAppServerClient();
  const bridge = createLiveSessionBridge(services, client);
  const planCollaborationMode = await loadCodexPlanCollaborationMode(client);
  try {
    const resumeModeOverride = request.modeId
      ? resolveCodexStartupMode({ modeId: request.modeId })
      : null;
    await unarchiveCodexThreadIfNeeded({
      client,
      threadId: request.providerSessionId,
      ...(record ? { record } : {}),
    });
    await pauseActiveCodexGoalBeforeHistoryClaim({
      client,
      threadId: request.providerSessionId,
      request,
    });
    const resumeResponse = (await requestCodexThreadResumeWithoutTranscript({
      client,
      params: {
        threadId: request.providerSessionId,
        ...(resumeModeOverride
          ? {
              approvalPolicy: resumeModeOverride.approvalPolicy,
              sandbox: resumeModeOverride.sandboxMode,
              ...(resumeModeOverride.approvalsReviewer === "auto_review"
                ? { approvalsReviewer: resumeModeOverride.approvalsReviewer }
                : {}),
            }
          : {}),
      },
      timeoutMs: TURN_START_TIMEOUT_MS,
    })) as {
      thread?: {
        id?: string;
        cwd?: string;
        preview?: string;
        name?: string | null;
        status?: unknown;
        modelProvider?: string;
        model_provider?: string;
      };
      cwd?: string;
      approvalPolicy?: unknown;
      approval_policy?: string;
      sandbox?: unknown;
      approvalsReviewer?: unknown;
      model?: string;
      modelProvider?: string;
      model_provider?: string;
      reasoningEffort?: string | null;
      reasoning_effort?: string | null;
    };
    const thread = resumeResponse.thread;
    const threadId =
      (thread && typeof thread.id === "string" ? thread.id : null) ?? request.providerSessionId;
    const cwd =
      (typeof resumeResponse.cwd === "string" ? resumeResponse.cwd : null) ??
      (thread && typeof thread.cwd === "string" ? thread.cwd : null) ??
      request.cwd ??
      record?.ref.cwd ??
      process.cwd();
    const modelProvider =
      resumeResponse.modelProvider ??
      resumeResponse.model_provider ??
      thread?.modelProvider ??
      thread?.model_provider ??
      record?.ref.modelProvider;
    const resumedMode = resolveCodexStartupMode({
      modeId: request.modeId,
      fallbackApprovalPolicy: codexApprovalPolicyFromResponse(resumeResponse),
      fallbackSandboxMode: codexSandboxModeFromResponse(resumeResponse.sandbox),
      fallbackApprovalsReviewer: codexApprovalsReviewerFromResponse(
        resumeResponse.approvalsReviewer,
      ),
    });
    const currentModelId =
      request.model ??
      resumeResponse.model ??
      params.initialModelCatalog?.currentModelId ??
      null;
    const currentModel = currentModelId
      ? params.initialModelCatalog?.models.find((model) => model.id === currentModelId)
      : undefined;
    if (request.optionValues !== undefined && !currentModel) {
      throw new Error(`Unsupported Codex model '${currentModelId ?? ""}'.`);
    }
    const currentOptionValues = currentModel
      ? resolveModelOptionValues({
          catalog: params.initialModelCatalog ?? null,
          model: currentModel,
          optionValues: request.optionValues,
        })
      : {};
    const currentReasoningId =
      optionValueAsString(currentOptionValues, "model_reasoning_effort") ??
      resumeResponse.reasoningEffort ??
      resumeResponse.reasoning_effort ??
      params.initialModelCatalog?.currentReasoningId ??
      null;
    const threadName =
      thread &&
      typeof thread.name === "string" &&
      thread.name.trim() &&
      !isCodexInternalThreadMetadataText(thread.name)
        ? thread.name.trim()
        : null;
    const threadPreview =
      thread &&
      typeof thread.preview === "string" &&
      thread.preview.trim() &&
      !isCodexInternalThreadMetadataText(thread.preview)
        ? thread.preview.trim()
        : null;
    const recordTitle =
      record?.ref.title && record.ref.title.trim() ? record.ref.title.trim() : null;
    const recordPreview =
      record?.ref.preview && record.ref.preview.trim() ? record.ref.preview.trim() : null;
    const sessionLabels = resolveSessionTitleAndPreview({
      canonicalTitle: recordTitle,
      providerTitle: threadName,
      providerPreview: threadPreview,
      fallbackPreview: recordPreview,
    });
    const nativeTuiAttachAvailable = codexNativeTuiAttachAvailable({
      providerSessionId: threadId,
      endpoint: client.endpoint,
    });
    if (resumedMode.activeModeId === "plan" && !planCollaborationMode) {
      throw new Error("Codex plan mode is not available for this session.");
    }
    const state = services.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: threadId,
      ...(modelProvider ? { modelProvider } : {}),
      ...(request.origin !== undefined ? { origin: request.origin } : {}),
      launchSource: "web",
      liveBackend: "native_local_server",
      cwd,
      rootDir: record?.ref.rootDir ?? cwd,
      runtimeDiagnostics: nativeLocalServerRuntimeDiagnostics({
        provider: "codex",
        providerSessionId: threadId,
        endpoint: client.endpoint ?? "stdio:codex app-server",
        ...(client.processId !== undefined ? { serverPid: client.processId } : {}),
        attachState: client.endpoint ? "ready" : "unavailable",
        lastEventCursor: `thread:${threadId}`,
      }),
      ...sessionLabels,
      mode: buildCodexModeState({
        currentModeId: resumedMode.activeModeId,
        mutable: true,
        preferredAccessModeId: resumedMode.accessModeId,
        planAvailable: Boolean(planCollaborationMode),
      }),
      model: {
        currentModelId,
        currentReasoningId,
        availableModels: params.initialModelCatalog?.models ?? [],
        mutable: true,
        source: params.initialModelCatalog?.source ?? "native",
      },
      ...resolveCodexRuntimeCapabilityState({
        catalog: params.initialModelCatalog ?? null,
        modelId: currentModelId,
        reasoningId: currentReasoningId,
        ...(Object.keys(currentOptionValues).length > 0
          ? { optionValues: currentOptionValues }
          : {}),
      }),
      capabilities: {
        modelSwitch: true,
        structuredControl: true,
        actions: {
          info: true,
          stop: true,
          archive: true,
          delete: true,
          rename: "native",
        },
        steerInput: true,
        queuedInput: true,
        branching: { sameWorkspace: true, worktree: false, side: true },
      },
    });
    services.sessionStore.patchManagedSession(state.session.id, {
      nativeTui: {
        terminalId: state.session.id,
        viewAvailable: nativeTuiAttachAvailable,
        promptState: "prompt_clean",
        queuedInputCount: 0,
      },
      capabilities: {
        nativeTui: nativeTuiAttachAvailable,
        rawPtyInput: nativeTuiAttachAvailable,
      },
    });
    services.ptyHub.ensureSession(state.session.id);
    services.sessionStore.setRuntimeState(
      state.session.id,
      runtimeStateFromCodexThreadStatus(thread?.status) ?? "idle",
    );
    const runtimeSession = services.sessionStore.getSession(state.session.id);
    if (!runtimeSession) {
      throw new Error("Failed to create runtime session for resumed Codex thread.");
    }
    publishSessionBootstrap(services, state.session.id, runtimeSession.session);

    const attachedBanner = `Attached to external Codex thread ${threadId}\r\n`;
    services.ptyHub.appendOutput(state.session.id, attachedBanner);

    const resumedState = services.sessionStore.getSession(state.session.id);
    if (!resumedState) {
      throw new Error("Failed to restore runtime state for resumed Codex thread.");
    }

    const liveSession: LiveCodexSession = {
      sessionId: state.session.id,
      threadId,
      cwd,
      approvalPolicy: resumedMode.approvalPolicy,
      sandboxMode: resumedMode.sandboxMode,
      approvalsReviewer: resumedMode.approvalsReviewer,
      modelId: currentModelId,
      reasoningId: currentReasoningId,
      modelCatalog: params.initialModelCatalog ?? null,
      activeModeId: resumedMode.activeModeId,
      lastNonPlanModeId: resumedMode.accessModeId,
      planCollaborationMode,
      client,
      translationState: createCodexAppServerTranslationState(),
      currentTurnId: resumedState.activeTurnId ?? null,
      finishedTurnIds: new Set(),
      interruptingTurnIds: new Set(),
      turnStartInFlight: false,
      interruptWhenTurnStarts: false,
      queuedInputs: [],
      inputQueuePolicy: "queue",
      externalThreadMirrorSubscribeInFlight: false,
      externalThreadMirrorSubscribed: true,
      pendingQuestions: new Map(),
      pendingApprovals: new Map(),
    };
    bridge.activate(liveSession);
    attachRequestedClient(services, state.session.id, request.attach);
    params.onLiveSessionReady(liveSession);
    return {
      sessionId: state.session.id,
      summary: toSessionSummary(services.sessionStore.getSession(state.session.id)!),
    };
  } catch (error) {
    await client.dispose();
    throw error;
  }
}

function createForkedManagedSession(args: {
  services: RuntimeServices;
  parent: ManagedSession;
  request: ForkSessionRequest;
  client: CodexAppServerRpcClient;
  threadId: string;
  threadStatus?: unknown;
  cwd: string;
  modelId: string | null;
  reasoningId: string | null;
  mode: CodexForkMode;
  planCollaborationMode: LiveCodexSession["planCollaborationMode"];
  nativeTuiAttachAvailable: boolean;
  title: string;
}) {
  const state = args.services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: args.threadId,
    ...(args.parent.modelProvider
      ? { modelProvider: args.parent.modelProvider }
      : {}),
    launchSource: "web",
    liveBackend: "native_local_server",
    cwd: args.cwd,
    rootDir: args.parent.rootDir,
    title: args.title,
    relationship: {
      parentSessionId: args.parent.id,
      ...(args.parent.providerSessionId
        ? { parentProviderSessionId: args.parent.providerSessionId }
        : {}),
      ...(args.request.lastTurnId ? { forkPointTurnId: args.request.lastTurnId } : {}),
      kind: args.request.kind,
      workspaceMode: args.request.workspaceMode,
      persistence: args.request.kind === "side" ? "ephemeral" : "persistent",
      ...(args.request.kind === "side" ? { sideState: "ready" as const } : {}),
    },
    runtimeDiagnostics: nativeLocalServerRuntimeDiagnostics({
      provider: "codex",
      providerSessionId: args.threadId,
      endpoint: args.client.endpoint ?? "stdio:codex app-server",
      ...(args.client.processId !== undefined ? { serverPid: args.client.processId } : {}),
      attachState: args.client.endpoint ? "ready" : "unavailable",
      lastEventCursor: `thread:${args.threadId}`,
    }),
    mode: buildCodexModeState({
      currentModeId: args.mode.activeModeId,
      mutable: true,
      preferredAccessModeId: args.mode.accessModeId,
      planAvailable: Boolean(args.planCollaborationMode),
    }),
    model: {
      currentModelId: args.modelId,
      currentReasoningId: args.reasoningId,
      availableModels: args.parent.model?.availableModels ?? [],
      mutable: true,
      source: args.parent.model?.source ?? "native",
    },
    ...(args.parent.config ? { config: args.parent.config } : {}),
    ...(args.parent.modelProfile ? { modelProfile: args.parent.modelProfile } : {}),
    capabilities: {
      modelSwitch: true,
      structuredControl: true,
      nativeTui: args.nativeTuiAttachAvailable,
      rawPtyInput: args.nativeTuiAttachAvailable,
      actions: {
        info: true,
        stop: true,
        archive: args.request.kind !== "side",
        delete: args.request.kind !== "side",
        rename: args.request.kind === "side" ? "none" : "native",
      },
      steerInput: true,
      queuedInput: true,
      branching:
        args.request.kind === "side"
          ? { sameWorkspace: false, worktree: false, side: false }
          : { sameWorkspace: true, worktree: false, side: true },
    },
  });
  prepareForkedManagedSessionInfrastructure({
    services: args.services,
    sessionId: state.session.id,
    nativeTuiAttachAvailable: args.nativeTuiAttachAvailable,
  });
  args.services.sessionStore.setRuntimeState(
    state.session.id,
    runtimeStateFromCodexThreadStatus(args.threadStatus) ?? "idle",
  );
  return args.services.sessionStore.getSession(state.session.id)!;
}

function prepareForkedManagedSessionInfrastructure(args: {
  services: RuntimeServices;
  sessionId: string;
  nativeTuiAttachAvailable: boolean;
}): void {
  args.services.sessionStore.patchManagedSession(args.sessionId, {
    nativeTui: {
      terminalId: args.sessionId,
      viewAvailable: args.nativeTuiAttachAvailable,
      promptState: "prompt_clean",
      queuedInputCount: 0,
    },
  });
  args.services.ptyHub.ensureSession(args.sessionId);
}

function markForkRecoverySessionFailed(args: {
  services: RuntimeServices;
  sessionId: string;
  creationError: unknown;
  rollbackError: unknown;
}) {
  const state = args.services.sessionStore.getSession(args.sessionId);
  if (!state) {
    throw new Error(`Missing recovery session ${args.sessionId}.`);
  }
  const creationDetail =
    args.creationError instanceof Error ? args.creationError.message : String(args.creationError);
  const rollbackDetail =
    args.rollbackError instanceof Error ? args.rollbackError.message : String(args.rollbackError);
  args.services.sessionStore.patchManagedSession(args.sessionId, {
    ...(state.session.relationship?.kind === "side"
      ? {
          relationship: {
            ...state.session.relationship,
            sideState: "cleanup_failed" as const,
            sideStateDetail: `Provider rollback failed: ${rollbackDetail}`,
          },
        }
      : {}),
    runtimeDiagnostics: {
      ...(state.session.runtimeDiagnostics ?? {}),
      lastError: `Branch initialization failed: ${creationDetail}; provider rollback failed: ${rollbackDetail}`,
    },
  });
  args.services.sessionStore.setRuntimeState(args.sessionId, "failed");
  return args.services.sessionStore.getSession(args.sessionId)!;
}

function createForkedLiveSession(args: {
  sessionId: string;
  threadId: string;
  request: ForkSessionRequest;
  cwd: string;
  mode: CodexForkMode;
  modelId: string | null;
  reasoningId: string | null;
  modelCatalog: ProviderModelCatalog | null;
  planCollaborationMode: LiveCodexSession["planCollaborationMode"];
  client: CodexAppServerRpcClient;
}): LiveCodexSession {
  return {
    sessionId: args.sessionId,
    threadId: args.threadId,
    ...(args.request.kind === "side" ? { ephemeral: true } : {}),
    cwd: args.cwd,
    approvalPolicy: args.mode.approvalPolicy,
    sandboxMode: args.mode.sandboxMode,
    approvalsReviewer: args.mode.approvalsReviewer,
    modelId: args.modelId,
    reasoningId: args.reasoningId,
    modelCatalog: args.modelCatalog,
    activeModeId: args.mode.activeModeId,
    lastNonPlanModeId: args.mode.accessModeId,
    planCollaborationMode: args.planCollaborationMode,
    client: args.client,
    translationState: createCodexAppServerTranslationState(),
    currentTurnId: null,
    finishedTurnIds: new Set(),
    interruptingTurnIds: new Set(),
    turnStartInFlight: false,
    interruptWhenTurnStarts: false,
    queuedInputs: [],
    inputQueuePolicy: "queue",
    externalThreadMirrorSubscribeInFlight: false,
    externalThreadMirrorSubscribed: true,
    pendingQuestions: new Map(),
    pendingApprovals: new Map(),
  };
}

export async function forkCodexLiveSession(params: {
  services: RuntimeServices;
  parentSummary: ReturnType<typeof toSessionSummary>;
  parentLive?: LiveCodexSession;
  request: ForkSessionRequest;
  onLiveSessionReady: (liveSession: LiveCodexSession) => void;
}) {
  const { services, parentSummary, parentLive, request } = params;
  const parent = parentSummary.session;
  const parentTitle = parent.title ?? parent.preview ?? "Codex";
  const branchTitle =
    request.kind === "side"
      ? `Side of ${parentTitle}`
      : allocateForkSessionTitle(
          parentTitle,
          [
            ...services.sessionStore
              .listSessions()
              .filter(
                (state) =>
                  (state.session.rootDir || state.session.cwd) ===
                  (parent.rootDir || parent.cwd),
              )
              .map((state) => state.session.title),
            ...(services.workbenchState?.snapshot().sessions ?? [])
              .filter(
                (session) =>
                  (session.rootDir || session.cwd) === (parent.rootDir || parent.cwd),
              )
              .map((session) => session.title),
          ],
          { parentIsFork: parent.relationship?.kind === "fork" },
        );
  const parentThreadId = parent.providerSessionId;
  if (!parentThreadId) {
    throw new Error(`Session ${parent.id} does not have a Codex thread id.`);
  }
  if (request.workspaceMode !== "shared") {
    throw new Error("Codex worktree forks are not implemented yet.");
  }

  const client = await createCodexAppServerClient();
  const bridge = createLiveSessionBridge(services, client);
  let forkedThreadId: string | undefined;
  let provisionalSessionId: string | undefined;
  let provisionalLiveSession: LiveCodexSession | undefined;
  let bootstrapPublished = false;
  let bridgeActivated = false;
  let planCollaborationMode: LiveCodexSession["planCollaborationMode"] =
    parentLive?.planCollaborationMode ?? null;
  const parentModeId = parentLive?.activeModeId ?? parent.mode?.currentModeId ?? undefined;
  const forkMode = resolveCodexStartupMode({
    ...(parentModeId ? { modeId: parentModeId } : {}),
    ...(parentLive?.approvalPolicy
      ? { fallbackApprovalPolicy: parentLive.approvalPolicy }
      : {}),
    ...(parentLive?.sandboxMode ? { fallbackSandboxMode: parentLive.sandboxMode } : {}),
    ...(parentLive?.approvalsReviewer
      ? { fallbackApprovalsReviewer: parentLive.approvalsReviewer }
      : {}),
  });
  let resolvedMode = forkMode;
  let forkCwd = parent.cwd;
  let forkModelId = parentLive?.modelId ?? parent.model?.currentModelId ?? null;
  let forkReasoningId = parentLive?.reasoningId ?? parent.model?.currentReasoningId ?? null;
  let forkThreadStatus: unknown;
  try {
    planCollaborationMode = await loadCodexPlanCollaborationMode(client);
    const forkResponse = (await requestCodexThreadForkWithoutTranscript({
      client,
      params: {
        threadId: parentThreadId,
        ...(request.lastTurnId ? { lastTurnId: request.lastTurnId } : {}),
        cwd: parent.cwd,
        approvalPolicy: forkMode.approvalPolicy,
        sandbox: forkMode.sandboxMode,
        ...(forkMode.approvalsReviewer === "auto_review"
          ? { approvalsReviewer: forkMode.approvalsReviewer }
          : {}),
        ...(forkModelId ? { model: forkModelId } : {}),
        ephemeral: request.kind === "side",
        ...(request.kind === "side"
          ? {
              developerInstructions: CODEX_SIDE_DEVELOPER_INSTRUCTIONS,
              threadSource: "sideConversation",
            }
          : { threadSource: "fork" }),
      },
      timeoutMs: THREAD_FORK_TIMEOUT_MS,
    })) as {
      thread?: { id?: string; status?: unknown };
      model?: string;
      reasoningEffort?: string | null;
      reasoning_effort?: string | null;
      cwd?: string;
      approvalPolicy?: unknown;
      approval_policy?: unknown;
      sandbox?: unknown;
      approvalsReviewer?: unknown;
    };
    const threadId = forkResponse.thread?.id;
    if (!threadId) {
      throw new Error("Codex app-server did not return a forked thread id.");
    }
    forkedThreadId = threadId;

    if (request.kind === "fork") {
      // A persistent Fork title is part of the transaction, not advisory UI metadata.
      await setCodexThreadName(client, threadId, branchTitle);
    }

    forkCwd = forkResponse.cwd ?? parent.cwd;
    forkModelId = forkResponse.model ?? forkModelId;
    forkReasoningId =
      forkResponse.reasoningEffort ?? forkResponse.reasoning_effort ?? forkReasoningId;
    forkThreadStatus = forkResponse.thread?.status;
    resolvedMode = resolveCodexStartupMode({
      modeId: forkMode.activeModeId,
      fallbackApprovalPolicy:
        codexApprovalPolicyFromResponse(forkResponse) ?? forkMode.approvalPolicy,
      fallbackSandboxMode:
        codexSandboxModeFromResponse(forkResponse.sandbox) ?? forkMode.sandboxMode,
      fallbackApprovalsReviewer:
        codexApprovalsReviewerFromResponse(forkResponse.approvalsReviewer) ??
        forkMode.approvalsReviewer,
    });
    const nativeTuiAttachAvailable =
      request.kind !== "side" &&
      codexNativeTuiAttachAvailable({ providerSessionId: threadId, endpoint: client.endpoint });
    if (request.kind === "side") {
      await client.request(
        "thread/inject_items",
        {
          threadId,
          items: [codexSideBoundaryItem()],
        },
        TURN_START_TIMEOUT_MS,
      );
    }
    const state = createForkedManagedSession({
      services,
      parent,
      request,
      client,
      threadId,
      threadStatus: forkThreadStatus,
      cwd: forkCwd,
      modelId: forkModelId,
      reasoningId: forkReasoningId,
      mode: resolvedMode,
      planCollaborationMode,
      nativeTuiAttachAvailable,
      title: branchTitle,
    });
    provisionalSessionId = state.session.id;
    const liveSession = createForkedLiveSession({
      sessionId: state.session.id,
      threadId,
      request,
      cwd: forkCwd,
      mode: resolvedMode,
      modelId: forkModelId,
      reasoningId: forkReasoningId,
      modelCatalog: parentLive?.modelCatalog ?? null,
      planCollaborationMode,
      client,
    });
    provisionalLiveSession = liveSession;

    publishSessionBootstrap(services, state.session.id, state.session);
    bootstrapPublished = true;
    bridge.activate(liveSession);
    bridgeActivated = true;
    attachRequestedClient(services, state.session.id, request.attach);
    const summary = toSessionSummary(services.sessionStore.getSession(state.session.id)!);
    params.onLiveSessionReady(liveSession);
    if (request.kind === "fork") {
      cacheCodexThreadTitle(threadId, branchTitle);
      services.workbenchState?.setSessionTitleOverride(
        { provider: "codex", providerSessionId: threadId },
        branchTitle,
      );
    }
    return {
      sessionId: state.session.id,
      summary,
    };
  } catch (error) {
    let rollbackError: unknown;
    if (forkedThreadId) {
      try {
        await client.request(
          request.kind === "side" ? "thread/unsubscribe" : "thread/archive",
          { threadId: forkedThreadId },
          TURN_START_TIMEOUT_MS,
        );
      } catch (caught) {
        rollbackError = caught;
      }
    }

    if (!rollbackError) {
      if (provisionalSessionId) {
        services.sessionStore.removeSession(provisionalSessionId);
        services.ptyHub.removeSession(provisionalSessionId);
      }
      await client.dispose();
      throw error;
    }

    if (provisionalSessionId && provisionalLiveSession) {
      const recoveryState = markForkRecoverySessionFailed({
        services,
        sessionId: provisionalSessionId,
        creationError: error,
        rollbackError,
      });
      if (!bootstrapPublished) {
        publishSessionBootstrap(services, provisionalSessionId, recoveryState.session);
      } else {
        publishSessionStateChanged(services, provisionalSessionId, "failed");
      }
      if (!bridgeActivated) {
        bridge.activate(provisionalLiveSession);
      }
      attachRequestedClient(services, provisionalSessionId, request.attach);
      params.onLiveSessionReady(provisionalLiveSession);
      return {
        sessionId: provisionalSessionId,
        summary: toSessionSummary(services.sessionStore.getSession(provisionalSessionId)!),
      };
    } else if (forkedThreadId) {
      try {
        const existingRecoveryState = services.sessionStore.findManagedByProviderSession(
          "codex",
          forkedThreadId,
        );
        const recoveryState =
          existingRecoveryState ??
          createForkedManagedSession({
            services,
            parent,
            request,
            client,
            threadId: forkedThreadId,
            threadStatus: forkThreadStatus,
            cwd: forkCwd,
            modelId: forkModelId,
            reasoningId: forkReasoningId,
            mode: resolvedMode,
            planCollaborationMode,
            nativeTuiAttachAvailable: false,
            title: branchTitle,
          });
        prepareForkedManagedSessionInfrastructure({
          services,
          sessionId: recoveryState.session.id,
          nativeTuiAttachAvailable: false,
        });
        const failedRecoveryState = markForkRecoverySessionFailed({
          services,
          sessionId: recoveryState.session.id,
          creationError: error,
          rollbackError,
        });
        const recoveryLive = createForkedLiveSession({
          sessionId: failedRecoveryState.session.id,
          threadId: forkedThreadId,
          request,
          cwd: forkCwd,
          mode: resolvedMode,
          modelId: forkModelId,
          reasoningId: forkReasoningId,
          modelCatalog: parentLive?.modelCatalog ?? null,
          planCollaborationMode,
          client,
        });
        publishSessionBootstrap(
          services,
          failedRecoveryState.session.id,
          failedRecoveryState.session,
        );
        bridge.activate(recoveryLive);
        attachRequestedClient(services, failedRecoveryState.session.id, request.attach);
        params.onLiveSessionReady(recoveryLive);
        if (request.kind === "fork") {
          cacheCodexThreadTitle(forkedThreadId, branchTitle);
          services.workbenchState?.setSessionTitleOverride(
            { provider: "codex", providerSessionId: forkedThreadId },
            branchTitle,
          );
        }
        return {
          sessionId: failedRecoveryState.session.id,
          summary: toSessionSummary(
            services.sessionStore.getSession(failedRecoveryState.session.id)!,
          ),
        };
      } catch (recoveryError) {
        await client.dispose();
        throw new AggregateError(
          [error, rollbackError, recoveryError],
          `Failed to create, roll back, or register recovery for Codex ${request.kind} thread ${forkedThreadId}.`,
        );
      }
    } else {
      await client.dispose();
    }
    throw new AggregateError(
      [error, rollbackError],
      `Failed to create and roll back Codex ${request.kind} thread ${forkedThreadId ?? "unknown"}.`,
    );
  }
}

export async function respondToCodexLivePermission(params: {
  services: RuntimeServices;
  liveSession: LiveCodexSession;
  requestId: string;
  response: PermissionResponseRequest;
}) {
  const pending = params.liveSession.pendingApprovals.get(params.requestId);
  if (!pending) {
    throw new Error(`Unknown pending Codex permission request ${params.requestId}.`);
  }
  params.liveSession.pendingApprovals.delete(params.requestId);

  const resolution = mapCodexPermissionResolution({
    requestId: params.requestId,
    behavior: params.response.behavior,
    ...(params.response.message !== undefined ? { message: params.response.message } : {}),
    ...(params.response.selectedActionId !== undefined ? { selectedActionId: params.response.selectedActionId } : {}),
    ...(params.response.decision !== undefined ? { decision: params.response.decision } : {}),
    ...(params.response.answers !== undefined ? { answers: params.response.answers } : {}),
  });
  applyProviderActivity(
    params.services,
    params.liveSession.sessionId,
    { provider: "codex", channel: "structured_live", authority: "derived" },
    attachCurrentTurn(resolution.activity, params.liveSession.currentTurnId),
  );

  if (pending.kind === "question") {
    pending.resolve({
      answers: params.response.answers ?? {},
    });
    return;
  }

  if (pending.kind === "mcp_elicitation") {
    pending.resolve({
      action: params.response.behavior === "allow" ? "accept" : "decline",
      content: params.response.answers ?? null,
      _meta: null,
    });
    return;
  }

  if (pending.kind === "permissions") {
    const requested =
      pending.requestedPermissions &&
      typeof pending.requestedPermissions === "object" &&
      !Array.isArray(pending.requestedPermissions)
        ? (pending.requestedPermissions as Record<string, unknown>)
        : {};
    pending.resolve({
      permissions:
        params.response.behavior === "allow"
          ? {
              ...(requested.network !== undefined && requested.network !== null
                ? { network: requested.network }
                : {}),
              ...(requested.fileSystem !== undefined && requested.fileSystem !== null
                ? { fileSystem: requested.fileSystem }
                : {}),
            }
          : {},
      scope: "turn",
    });
    return;
  }

  pending.resolve({
    decision: resolveCodexApprovalDecision(
      params.response,
      pending.approvalResponseShape ?? "action",
    ),
  });
}
