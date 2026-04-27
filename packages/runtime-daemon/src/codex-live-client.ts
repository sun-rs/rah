import { spawn } from "node:child_process";
import {
  type ProviderModelCatalog,
  type PermissionResponseRequest,
  type ResumeSessionRequest,
  type StartSessionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { applyProviderActivity } from "./provider-activity";
import {
  mapCodexPermissionResolution,
  createCodexAppServerTranslationState,
} from "./codex-app-server-activity";
import {
  replayCodexStoredSessionRollout,
  type CodexStoredSessionRecord,
} from "./codex-stored-sessions";
import { resolveCodexRuntimeCapabilityState } from "./codex-model-catalog";
import { toSessionSummary } from "./session-store";
import { resolveConfiguredBinary } from "./provider-binary-utils";
import { buildCodexModeState, codexModeId } from "./session-mode-utils";
import {
  attachCurrentTurn,
  attachRequestedClient,
  createLiveSessionBridge,
  isCodexInternalThreadMetadataText,
  publishSessionBootstrap,
  resolveCodexApprovalDecision,
  runtimeStateFromThreadStatus,
} from "./codex-live-helpers";
import { CodexJsonRpcClient } from "./codex-live-rpc";
import {
  TURN_START_TIMEOUT_MS,
  type LiveCodexSession,
} from "./codex-live-types";

export { CodexJsonRpcClient } from "./codex-live-rpc";
export type { LiveCodexSession } from "./codex-live-types";

function createInitializeParams() {
  return {
    clientInfo: {
      name: "rah",
      title: "rah",
      version: "0.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

async function resolveCodexBinary(): Promise<string> {
  return await resolveConfiguredBinary("RAH_CODEX_BINARY", "codex");
}

async function loadCodexPlanCollaborationMode(client: CodexJsonRpcClient): Promise<LiveCodexSession["planCollaborationMode"]> {
  const response = (await client.request("collaborationMode/list", {})) as {
    data?: Array<{
      name?: string;
      mode?: string | null;
      model?: string | null;
      reasoning_effort?: string | null | null;
    }>;
  };
  const planMask = response.data?.find((entry) => entry.mode === "plan");
  if (!planMask?.model) {
    return null;
  }
  return {
    mode: "plan",
    settings: {
      model: planMask.model,
      reasoning_effort: planMask.reasoning_effort ?? null,
      developer_instructions: null,
    },
  };
}

export async function createCodexAppServerClient(): Promise<CodexJsonRpcClient> {
  const binary = await resolveCodexBinary();
  const child = spawn(binary, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const client = new CodexJsonRpcClient(child);
  try {
    await client.request("initialize", createInitializeParams());
    client.notify("initialized", {});
    return client;
  } catch (error) {
    await client.dispose();
    throw error;
  }
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
  const initialAccessModeId = codexModeId({
    approvalPolicy: request.approvalPolicy ?? "never",
    sandboxMode: request.sandbox ?? "danger-full-access",
  });

  const threadStart = (await client.request("thread/start", {
    ...(request.cwd ? { cwd: request.cwd } : {}),
    approvalPolicy: request.approvalPolicy ?? "never",
    sandbox: request.sandbox ?? "danger-full-access",
    ...(request.model ? { model: request.model } : {}),
    experimentalRawEvents: false,
    persistExtendedHistory: true,
    ...(request.title ? { name: request.title } : {}),
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

  const state = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: threadId,
    launchSource: "web",
    cwd: request.cwd,
    rootDir: request.cwd,
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.initialPrompt !== undefined ? { preview: request.initialPrompt } : {}),
    mode: buildCodexModeState({
      currentModeId: initialAccessModeId,
      mutable: true,
    }),
    model: {
      currentModelId: request.model ?? threadStart.model ?? params.initialModelCatalog?.currentModelId ?? null,
      currentReasoningId:
        request.reasoningId ??
        threadStart.reasoningEffort ??
        threadStart.reasoning_effort ??
        params.initialModelCatalog?.currentReasoningId ??
        null,
      availableModels: params.initialModelCatalog?.models ?? [],
      mutable: true,
      source: params.initialModelCatalog?.source ?? "native",
    },
    ...resolveCodexRuntimeCapabilityState({
      catalog: params.initialModelCatalog ?? null,
      modelId: request.model ?? threadStart.model ?? params.initialModelCatalog?.currentModelId ?? null,
      reasoningId:
        request.reasoningId ??
        threadStart.reasoningEffort ??
        threadStart.reasoning_effort ??
        params.initialModelCatalog?.currentReasoningId ??
        null,
    }),
    capabilities: {
      modelSwitch: true,
      renameSession: true,
      actions: {
        info: true,
        archive: true,
        delete: true,
        rename: "native",
      },
      steerInput: true,
    },
  });
  services.ptyHub.ensureSession(state.session.id);
  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const runtimeSession = services.sessionStore.getSession(state.session.id);
  if (!runtimeSession) {
    await client.dispose();
    throw new Error("Failed to create runtime session for Codex live session.");
  }
  publishSessionBootstrap(services, state.session.id, runtimeSession.session);

  const liveSession: LiveCodexSession = {
    sessionId: state.session.id,
    threadId,
    cwd: request.cwd,
    approvalPolicy: request.approvalPolicy ?? "never",
    sandboxMode: request.sandbox ?? "danger-full-access",
    modelId: request.model ?? threadStart.model ?? params.initialModelCatalog?.currentModelId ?? null,
    reasoningId:
      request.reasoningId ??
      threadStart.reasoningEffort ??
      threadStart.reasoning_effort ??
      params.initialModelCatalog?.currentReasoningId ??
      null,
    modelCatalog: params.initialModelCatalog ?? null,
    activeModeId: initialAccessModeId,
    lastNonPlanModeId: initialAccessModeId,
    planCollaborationMode,
    client,
    translationState: createCodexAppServerTranslationState(),
    currentTurnId: runtimeSession.activeTurnId ?? null,
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
    const resumeResponse = (await client.request(
      "thread/resume",
      { threadId: request.providerSessionId },
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
      approval_policy?: string;
      sandbox?: string;
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
    const resumedAccessModeId = codexModeId({
      approvalPolicy:
        typeof resumeResponse.approval_policy === "string"
          ? resumeResponse.approval_policy
          : "never",
      sandboxMode:
        typeof resumeResponse.sandbox === "string"
          ? resumeResponse.sandbox
          : "danger-full-access",
    });
    const state = services.sessionStore.createManagedSession({
      provider: "codex",
      providerSessionId: threadId,
      launchSource: "web",
      cwd,
      rootDir: record?.ref.rootDir ?? cwd,
      ...(thread &&
      typeof thread.preview === "string" &&
      thread.preview.trim() &&
      !isCodexInternalThreadMetadataText(thread.preview)
        ? { title: thread.preview }
        : record?.ref.title !== undefined
          ? { title: record.ref.title }
          : thread &&
              typeof thread.name === "string" &&
              thread.name.trim() &&
              !isCodexInternalThreadMetadataText(thread.name)
            ? { title: thread.name }
            : {}),
      ...(thread &&
      typeof thread.preview === "string" &&
      thread.preview.trim() &&
      !isCodexInternalThreadMetadataText(thread.preview)
        ? { preview: thread.preview }
        : record?.ref.preview !== undefined
          ? { preview: record.ref.preview }
          : thread &&
              typeof thread.name === "string" &&
              thread.name.trim() &&
              !isCodexInternalThreadMetadataText(thread.name)
            ? { preview: thread.name }
          : {}),
      mode: buildCodexModeState({
        currentModeId: resumedAccessModeId,
        mutable: true,
      }),
      model: {
        currentModelId: resumeResponse.model ?? params.initialModelCatalog?.currentModelId ?? null,
        currentReasoningId:
          resumeResponse.reasoningEffort ??
          resumeResponse.reasoning_effort ??
          params.initialModelCatalog?.currentReasoningId ??
          null,
        availableModels: params.initialModelCatalog?.models ?? [],
        mutable: true,
        source: params.initialModelCatalog?.source ?? "native",
      },
      ...resolveCodexRuntimeCapabilityState({
        catalog: params.initialModelCatalog ?? null,
        modelId: resumeResponse.model ?? params.initialModelCatalog?.currentModelId ?? null,
        reasoningId:
          resumeResponse.reasoningEffort ??
          resumeResponse.reasoning_effort ??
          params.initialModelCatalog?.currentReasoningId ??
          null,
      }),
      capabilities: {
        modelSwitch: true,
        renameSession: true,
        actions: {
          info: true,
          archive: true,
          delete: true,
          rename: "native",
        },
        steerInput: true,
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
    if (record && request.historyReplay !== "skip") {
      try {
        replayCodexStoredSessionRollout({
          services,
          sessionId: state.session.id,
          record,
          bannerText: attachedBanner,
        });
        if (thread?.status !== undefined) {
          services.sessionStore.setRuntimeState(
            state.session.id,
            runtimeStateFromThreadStatus(thread.status) ?? runtimeSession.session.runtimeState,
          );
        }
      } catch {
        services.ptyHub.appendOutput(state.session.id, attachedBanner);
      }
    } else {
      services.ptyHub.appendOutput(state.session.id, attachedBanner);
    }

    const resumedState = services.sessionStore.getSession(state.session.id);
    if (!resumedState) {
      throw new Error("Failed to restore runtime state for resumed Codex thread.");
    }

    const liveSession: LiveCodexSession = {
      sessionId: state.session.id,
      threadId,
      cwd,
      approvalPolicy:
        typeof resumeResponse.approval_policy === "string"
          ? resumeResponse.approval_policy
          : "never",
      sandboxMode:
        typeof resumeResponse.sandbox === "string"
          ? resumeResponse.sandbox
          : "danger-full-access",
      modelId: resumeResponse.model ?? params.initialModelCatalog?.currentModelId ?? null,
      reasoningId:
        resumeResponse.reasoningEffort ??
        resumeResponse.reasoning_effort ??
        params.initialModelCatalog?.currentReasoningId ??
        null,
      modelCatalog: params.initialModelCatalog ?? null,
      activeModeId: resumedAccessModeId,
      lastNonPlanModeId: resumedAccessModeId,
      planCollaborationMode,
      client,
      translationState: createCodexAppServerTranslationState(),
      currentTurnId: resumedState.activeTurnId ?? null,
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
