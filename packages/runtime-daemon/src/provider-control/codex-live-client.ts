import {
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
  runtimeStateFromThreadStatus,
} from "../codex-live-helpers";
import {
  createCodexAppServerClient,
  type CodexAppServerRpcClient,
} from "../codex-app-server-client";
import {
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

export type { LiveCodexSession } from "../codex-live-types";

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
  approvalPolicy?: string | undefined;
  sandbox?: string | undefined;
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
  const approvalPolicy = args.approvalPolicy ?? fallbackApprovalPolicy;
  const sandboxMode = args.sandbox ?? fallbackSandboxMode;
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
    approvalPolicy: request.approvalPolicy,
    sandbox: request.sandbox,
  });
  if (initialMode.activeModeId === "plan" && !planCollaborationMode) {
    await client.dispose();
    throw new Error("Codex plan mode is not available for this session.");
  }

  const terminalTuiOwnsThreadStart =
    request.attach?.client.kind === "terminal" && request.initialPrompt === undefined;
  if (terminalTuiOwnsThreadStart) {
    const currentModelId = request.model ?? params.initialModelCatalog?.currentModelId ?? null;
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
          reasoningId: request.reasoningId,
        })
      : {};
    const currentReasoningId =
      optionValueAsString(currentOptionValues, "model_reasoning_effort") ??
      request.reasoningId ??
      params.initialModelCatalog?.currentReasoningId ??
      null;

    const state = services.sessionStore.createManagedSession({
      provider: "codex",
      ...(request.origin !== undefined ? { origin: request.origin } : {}),
      launchSource: "terminal",
      liveBackend: "native_local_server",
      cwd: request.cwd,
      rootDir: request.cwd,
      runtimeDiagnostics: nativeLocalServerRuntimeDiagnostics({
        provider: "codex",
        endpoint: client.endpoint ?? "stdio:codex app-server",
        ...(client.processId !== undefined ? { serverPid: client.processId } : {}),
        attachState: client.endpoint ? "ready" : "unavailable",
        lastEventCursor: "thread:pending",
      }),
      ...(request.title !== undefined ? { title: request.title } : {}),
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
        renameSession: true,
        actions: {
          info: true,
          stop: true,
          delete: true,
          rename: "native",
        },
        steerInput: true,
        queuedInput: true,
      },
    });
    services.ptyHub.ensureSession(state.session.id);
    services.sessionStore.setRuntimeState(state.session.id, "idle");
    const runtimeSession = services.sessionStore.getSession(state.session.id);
    if (!runtimeSession) {
      await client.dispose();
      throw new Error("Failed to create runtime session for Codex terminal running session.");
    }
    publishSessionBootstrap(services, state.session.id, runtimeSession.session);

    const liveSession: LiveCodexSession = {
      sessionId: state.session.id,
      // The official TUI creates the thread after attach. Bind the real id from
      // the app-server thread/started notification instead of resuming a
      // not-yet-materialized rollout file.
      threadId: "",
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
      externalThreadMirrorSubscribeInFlight: false,
      externalThreadMirrorSubscribed: false,
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
    thread?: { id?: string };
    model?: string;
    reasoningEffort?: string | null;
    reasoning_effort?: string | null;
  };
  const threadId = threadStart?.thread?.id;
  if (!threadId) {
    await client.dispose();
    throw new Error("Codex app-server did not return a thread id.");
  }
  await setCodexThreadNameIfRequested(client, threadId, request.title);
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
        reasoningId: request.reasoningId,
      })
    : {};
  const currentReasoningId =
    optionValueAsString(currentOptionValues, "model_reasoning_effort") ??
    request.reasoningId ??
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
      renameSession: true,
      actions: {
        info: true,
        stop: true,
        delete: true,
        rename: "native",
      },
      steerInput: true,
      queuedInput: true,
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
    const resumeResponse = (await client.request(
      "thread/resume",
      {
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
      TURN_START_TIMEOUT_MS,
    )) as {
      thread?: {
        id?: string;
        cwd?: string;
        preview?: string;
        name?: string | null;
        status?: unknown;
      };
      cwd?: string;
      approvalPolicy?: unknown;
      approval_policy?: string;
      sandbox?: unknown;
      approvalsReviewer?: unknown;
      model?: string;
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
          reasoningId: request.reasoningId,
        })
      : {};
    const currentReasoningId =
      optionValueAsString(currentOptionValues, "model_reasoning_effort") ??
      request.reasoningId ??
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
        renameSession: true,
        actions: {
          info: true,
          stop: true,
          delete: true,
          rename: "native",
        },
        steerInput: true,
        queuedInput: true,
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
      runtimeStateFromThreadStatus(thread?.status) ?? "idle",
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
    decision: resolveCodexApprovalDecision(params.response, pending.approvalProtocol ?? "v2"),
  });
}
