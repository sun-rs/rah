import { randomUUID } from "node:crypto";
import {
  isPermissionDenied,
  isPermissionSessionGrant,
  type AttachSessionRequest,
  type CloseSessionRequest,
  type InterruptSessionRequest,
  type ManagedSession,
  type PermissionResponseRequest,
  type ProviderModelCatalog,
  type SessionInputRequest,
  type StartSessionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import { toSessionSummary } from "./session-store";
import {
  abortOpenCodeSession,
  createOpenCodeSession,
  getOpenCodeSession,
  respondOpenCodePermission,
  setOpenCodeSessionPermission,
  startOpenCodeServer,
  stopOpenCodeServer,
  type OpenCodePermissionRule,
  type OpenCodeServerHandle,
  type OpenCodeSessionInfo,
} from "./opencode-api";
import { OpenCodeAcpClient, waitForAcpDrain, type OpenCodeAcpPromptUsage } from "./opencode-acp-client";
import { translateOpenCodeAcpSessionUpdate } from "./opencode-acp-activity";
import {
  createOpenCodeActivityState,
  completeOpenCodeTurn,
  startOpenCodeTurn,
  type OpenCodeActivityState,
} from "./opencode-activity";
import {
  buildOpenCodeProviderModelId,
  resolveOpenCodeRuntimeCapabilityState,
} from "./opencode-model-catalog";
import {
  resolveModelContextWindow,
  type ModelContextWindowResolution,
  withModelContextWindow,
} from "./model-context-window";
import { buildOpenCodeModeState, isOpenCodeModeId } from "./session-mode-utils";

export interface LiveOpenCodeSession {
  sessionId: string;
  providerSessionId: string;
  cwd: string;
  server: OpenCodeServerHandle;
  acp: OpenCodeAcpClient;
  activityState: OpenCodeActivityState;
  lastAcpActivityAt: number;
  model?: string;
  contextWindow?: ModelContextWindowResolution;
  reasoningId?: string | null;
  modeId: string;
}

const SESSION_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

const OPENCODE_FULL_AUTO_MODE_ID = "opencode/full-auto";
const RAH_SESSION_MODE_CONFIG_KEY = "rah_session_mode";

function openCodePermissionOverride(action: OpenCodePermissionRule["action"]): OpenCodePermissionRule[] {
  return [{ permission: "*", pattern: "*", action }];
}

function openCodeNativeModeId(modeId: string): "build" | "plan" {
  return modeId === "plan" ? "plan" : "build";
}

function resolveRequestedOpenCodeModeId(
  modeId: string | undefined,
  providerConfig: StartSessionRequest["providerConfig"] | undefined,
): string {
  const requestedMode = modeId ?? providerConfig?.[RAH_SESSION_MODE_CONFIG_KEY];
  if (typeof requestedMode === "string" && requestedMode.trim()) {
    const normalized = requestedMode.trim();
    if (!isOpenCodeModeId(normalized)) {
      throw new Error(`Unsupported OpenCode mode '${normalized}'.`);
    }
    return normalized;
  }
  return OPENCODE_FULL_AUTO_MODE_ID;
}

async function applyOpenCodePermissionMode(
  liveSession: LiveOpenCodeSession,
  modeId: string,
): Promise<void> {
  if (modeId === OPENCODE_FULL_AUTO_MODE_ID) {
    await setOpenCodeSessionPermission({
      handle: liveSession.server,
      providerSessionId: liveSession.providerSessionId,
      permission: openCodePermissionOverride("allow"),
    });
    return;
  }
  if (modeId === "build" || liveSession.modeId === OPENCODE_FULL_AUTO_MODE_ID) {
    await setOpenCodeSessionPermission({
      handle: liveSession.server,
      providerSessionId: liveSession.providerSessionId,
      permission: openCodePermissionOverride("ask"),
    });
  }
}

function publishSessionBootstrap(
  services: RuntimeServices,
  sessionId: string,
  session: ManagedSession,
): void {
  services.eventBus.publish({
    sessionId,
    type: "session.created",
    source: SESSION_SOURCE,
    payload: { session },
  });
  services.eventBus.publish({
    sessionId,
    type: "session.started",
    source: SESSION_SOURCE,
    payload: { session },
  });
}

function resolveOpenCodeReasoningId(args: {
  catalog: ProviderModelCatalog | null | undefined;
  modelId: string | null | undefined;
  requestedReasoningId: string | null | undefined;
}): string | null {
  if (args.requestedReasoningId !== undefined) {
    return args.requestedReasoningId;
  }
  if (!args.modelId) {
    return args.catalog?.currentReasoningId ?? null;
  }
  const model = args.catalog?.models.find((entry) => entry.id === args.modelId);
  return model?.defaultReasoningId ?? null;
}

async function applyRequestedOpenCodeModel(args: {
  acp: OpenCodeAcpClient;
  providerSessionId: string;
  modelId: string | null | undefined;
  reasoningId: string | null | undefined;
}): Promise<void> {
  if (!args.modelId) {
    return;
  }
  await args.acp.setSessionModel(
    args.providerSessionId,
    buildOpenCodeProviderModelId({
      modelId: args.modelId,
      reasoningId: args.reasoningId,
    }),
  );
}

function attachRequestedClient(
  services: RuntimeServices,
  sessionId: string,
  attach: AttachSessionRequest | undefined,
): void {
  if (!attach) {
    return;
  }
  services.sessionStore.attachClient({
    sessionId,
    clientId: attach.client.id,
    kind: attach.client.kind,
    connectionId: attach.client.connectionId,
    attachMode: attach.mode,
    focus: true,
  });
  services.eventBus.publish({
    sessionId,
    type: "session.attached",
    source: SESSION_SOURCE,
    payload: {
      clientId: attach.client.id,
      clientKind: attach.client.kind,
    },
  });
  if (attach.claimControl) {
    services.sessionStore.claimControl(sessionId, attach.client.id, attach.client.kind);
    services.eventBus.publish({
      sessionId,
      type: "control.claimed",
      source: SESSION_SOURCE,
      payload: {
        clientId: attach.client.id,
        clientKind: attach.client.kind,
      },
    });
  }
}

function applyActivity(
  services: RuntimeServices,
  sessionId: string,
  activity: ProviderActivity,
  raw?: unknown,
): void {
  applyProviderActivity(
    services,
    sessionId,
    {
      provider: "opencode",
      channel: "structured_live",
      authority: "authoritative",
      ...(raw !== undefined ? { raw } : {}),
    },
    activity,
  );
}

export async function startOpenCodeLiveSession(params: {
  services: RuntimeServices;
  request: StartSessionRequest;
  modelCatalog?: ProviderModelCatalog | null;
}): Promise<{ liveSession: LiveOpenCodeSession; summary: ReturnType<typeof toSessionSummary> }> {
  const { services, request } = params;
  const initialModeId = resolveRequestedOpenCodeModeId(request.modeId, request.providerConfig);
  const currentModelId = request.model ?? params.modelCatalog?.currentModelId ?? null;
  const currentReasoningId = resolveOpenCodeReasoningId({
    catalog: params.modelCatalog,
    modelId: currentModelId,
    requestedReasoningId: request.reasoningId,
  });
  const runtimeCapabilityState = resolveOpenCodeRuntimeCapabilityState({
    catalog: params.modelCatalog,
    modelId: currentModelId,
    reasoningId: currentReasoningId,
  });
  const contextWindow = resolveModelContextWindow({
    provider: "opencode",
    modelId: currentModelId,
    catalog: params.modelCatalog ?? null,
  });
  const server = await startOpenCodeServer({ cwd: request.cwd });
  let providerSession: OpenCodeSessionInfo;
  let acp: OpenCodeAcpClient | undefined;
  try {
    providerSession = await createOpenCodeSession(
      server,
      request.title !== undefined ? { title: request.title } : {},
    );
    acp = await startAcpForSession({
      cwd: request.cwd,
      providerSessionId: providerSession.id,
    });
    if (request.model) {
      await applyRequestedOpenCodeModel({
        acp,
        providerSessionId: providerSession.id,
        modelId: request.model,
        reasoningId: currentReasoningId,
      });
    }
  } catch (error) {
    await acp?.close().catch(() => undefined);
    await stopOpenCodeServer(server).catch(() => undefined);
    throw error;
  }
  const state = services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: providerSession.id,
    launchSource: "web",
    cwd: request.cwd,
    rootDir: request.cwd,
    title: providerSession.title,
    ...(request.initialPrompt !== undefined ? { preview: request.initialPrompt } : {}),
    model: {
      currentModelId,
      currentReasoningId,
      availableModels: params.modelCatalog?.models ?? [],
      mutable: true,
      source: params.modelCatalog?.source ?? "native",
    },
    mode: buildOpenCodeModeState({
      currentModeId: initialModeId,
      mutable: true,
    }),
    ...runtimeCapabilityState,
    capabilities: {
      livePermissions: true,
      steerInput: true,
      queuedInput: false,
      renameSession: false,
      modelSwitch: true,
      actions: {
        info: true,
        archive: true,
        delete: false,
        rename: "none",
      },
    },
  });
  const liveSession: LiveOpenCodeSession = {
    sessionId: state.session.id,
    providerSessionId: providerSession.id,
    cwd: request.cwd,
    server,
    acp,
    activityState: createOpenCodeActivityState(providerSession.id, {
      userMessagesStartTurns: false,
      emitUserMessages: false,
    }),
    lastAcpActivityAt: Date.now(),
    modeId: initialModeId,
    ...(currentModelId ? { model: currentModelId } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(currentReasoningId !== undefined ? { reasoningId: currentReasoningId } : {}),
  };
  await acp.setSessionMode(providerSession.id, openCodeNativeModeId(initialModeId));
  await applyOpenCodePermissionMode(liveSession, initialModeId);
  attachAcpActivitySink({ services, liveSession });
  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = services.sessionStore.getSession(state.session.id);
  if (!session) {
    await closeOpenCodeLiveSession(liveSession);
    throw new Error("Failed to create runtime session for OpenCode live session.");
  }
  publishSessionBootstrap(services, state.session.id, session.session);
  attachRequestedClient(services, state.session.id, request.attach);
  const initialPrompt = request.initialPrompt?.trim();
  if (initialPrompt) {
    submitOpenCodePrompt({
      services,
      liveSession,
      text: initialPrompt,
    });
  }
  return {
    liveSession,
    summary: toSessionSummary(services.sessionStore.getSession(state.session.id)!),
  };
}

export async function resumeOpenCodeLiveSession(params: {
  services: RuntimeServices;
  providerSessionId: string;
  cwd: string;
  attach?: StartSessionRequest["attach"];
  providerConfig?: StartSessionRequest["providerConfig"];
  modeId?: string;
  model?: string;
  reasoningId?: string | null | undefined;
  modelCatalog?: ProviderModelCatalog | null;
}): Promise<{ liveSession: LiveOpenCodeSession; summary: ReturnType<typeof toSessionSummary> }> {
  const { services } = params;
  const initialModeId = resolveRequestedOpenCodeModeId(params.modeId, params.providerConfig);
  const currentModelId = params.model ?? params.modelCatalog?.currentModelId ?? null;
  const currentReasoningId = resolveOpenCodeReasoningId({
    catalog: params.modelCatalog,
    modelId: currentModelId,
    requestedReasoningId: params.reasoningId,
  });
  const runtimeCapabilityState = resolveOpenCodeRuntimeCapabilityState({
    catalog: params.modelCatalog,
    modelId: currentModelId,
    reasoningId: currentReasoningId,
  });
  const contextWindow = resolveModelContextWindow({
    provider: "opencode",
    modelId: currentModelId,
    catalog: params.modelCatalog ?? null,
  });
  const server = await startOpenCodeServer({ cwd: params.cwd });
  let providerSession: OpenCodeSessionInfo;
  let acp: OpenCodeAcpClient | undefined;
  try {
    providerSession = await getOpenCodeSession(server, params.providerSessionId);
    acp = await startAcpForSession({
      cwd: params.cwd,
      providerSessionId: params.providerSessionId,
    });
    if (params.model) {
      await applyRequestedOpenCodeModel({
        acp,
        providerSessionId: params.providerSessionId,
        modelId: params.model,
        reasoningId: currentReasoningId,
      });
    }
  } catch (error) {
    await acp?.close().catch(() => undefined);
    await stopOpenCodeServer(server).catch(() => undefined);
    throw error;
  }
  const state = services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: params.providerSessionId,
    launchSource: "web",
    cwd: params.cwd,
    rootDir: params.cwd,
    title: providerSession.title,
    model: {
      currentModelId,
      currentReasoningId,
      availableModels: params.modelCatalog?.models ?? [],
      mutable: true,
      source: params.modelCatalog?.source ?? "native",
    },
    mode: buildOpenCodeModeState({
      currentModeId: initialModeId,
      mutable: true,
    }),
    ...runtimeCapabilityState,
    capabilities: {
      livePermissions: true,
      steerInput: true,
      queuedInput: false,
      renameSession: false,
      modelSwitch: true,
      actions: {
        info: true,
        archive: true,
        delete: false,
        rename: "none",
      },
    },
  });
  const liveSession: LiveOpenCodeSession = {
    sessionId: state.session.id,
    providerSessionId: params.providerSessionId,
    cwd: params.cwd,
    server,
    acp,
    activityState: createOpenCodeActivityState(params.providerSessionId, {
      userMessagesStartTurns: false,
      emitUserMessages: false,
    }),
    lastAcpActivityAt: Date.now(),
    modeId: initialModeId,
    ...(currentModelId ? { model: currentModelId } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(currentReasoningId !== undefined ? { reasoningId: currentReasoningId } : {}),
  };
  await acp.setSessionMode(params.providerSessionId, openCodeNativeModeId(initialModeId));
  await applyOpenCodePermissionMode(liveSession, initialModeId);
  attachAcpActivitySink({ services, liveSession });
  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = services.sessionStore.getSession(state.session.id);
  if (!session) {
    await closeOpenCodeLiveSession(liveSession);
    throw new Error("Failed to create runtime session for OpenCode resume.");
  }
  publishSessionBootstrap(services, state.session.id, session.session);
  attachRequestedClient(services, state.session.id, params.attach);
  return {
    liveSession,
    summary: toSessionSummary(services.sessionStore.getSession(state.session.id)!),
  };
}

export function sendInputToOpenCodeLiveSession(params: {
  services: RuntimeServices;
  liveSession: LiveOpenCodeSession;
  request: SessionInputRequest;
}): void {
  const { services, liveSession, request } = params;
  if (liveSession.activityState.currentTurnId) {
    throw new Error("OpenCode session already has an active turn.");
  }
  if (!services.sessionStore.hasInputControl(liveSession.sessionId, request.clientId)) {
    throw new Error(
      `Client ${request.clientId} does not hold input control for ${liveSession.sessionId}.`,
    );
  }
  submitOpenCodePrompt({
    services,
    liveSession,
    text: request.text,
  });
}

export async function setOpenCodeLiveSessionMode(params: {
  services: RuntimeServices;
  liveSession: LiveOpenCodeSession;
  modeId: string;
}): Promise<ReturnType<typeof toSessionSummary>> {
  if (!isOpenCodeModeId(params.modeId)) {
    throw new Error(`Unsupported OpenCode mode '${params.modeId}'.`);
  }
  await params.liveSession.acp.setSessionMode(
    params.liveSession.providerSessionId,
    openCodeNativeModeId(params.modeId),
  );
  await applyOpenCodePermissionMode(params.liveSession, params.modeId);
  params.liveSession.modeId = params.modeId;
  const nextState = params.services.sessionStore.patchManagedSession(
    params.liveSession.sessionId,
    {
      mode: buildOpenCodeModeState({
        currentModeId: params.modeId,
        mutable: true,
      }),
    },
  );
  return toSessionSummary(nextState);
}

function submitOpenCodePrompt(params: {
  services: RuntimeServices;
  liveSession: LiveOpenCodeSession;
  text: string;
}): void {
  const { services, liveSession, text } = params;
  const turnId = randomUUID();
  liveSession.lastAcpActivityAt = Date.now();
  for (const activity of startOpenCodeTurn(liveSession.activityState, turnId)) {
    applyActivity(services, liveSession.sessionId, activity);
  }
  applyActivity(services, liveSession.sessionId, {
    type: "timeline_item",
    turnId,
    item: { kind: "user_message", text },
  });
  void liveSession.acp
    .prompt(liveSession.providerSessionId, text)
    .then(async (response) => {
      await waitForAcpDrain(() => liveSession.lastAcpActivityAt, 250);
      if (liveSession.activityState.currentTurnId !== turnId) {
        return;
      }
      const usage = contextUsageFromAcpPrompt(
        response.usage,
        liveSession.contextWindow,
      );
      if (usage) {
        applyActivity(services, liveSession.sessionId, {
          type: "usage",
          usage,
          turnId,
        });
      }
      for (const activity of completeOpenCodeTurn(liveSession.activityState)) {
        applyActivity(services, liveSession.sessionId, activity);
      }
    })
    .catch((error) => {
      if (liveSession.activityState.currentTurnId !== turnId) {
        return;
      }
      delete liveSession.activityState.currentTurnId;
      applyActivity(services, liveSession.sessionId, {
        type: "turn_failed",
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

async function startAcpForSession(params: {
  cwd: string;
  providerSessionId: string;
}): Promise<OpenCodeAcpClient> {
  const acp = new OpenCodeAcpClient(params.cwd, () => undefined);
  await acp.start();
  await acp.loadSession(params.providerSessionId, params.cwd);
  return acp;
}

function attachAcpActivitySink(params: {
  services: RuntimeServices;
  liveSession: LiveOpenCodeSession;
}): void {
  const { services, liveSession } = params;
  liveSession.acp.setSessionUpdateHandler((update) => {
    liveSession.lastAcpActivityAt = Date.now();
    for (const activity of translateOpenCodeAcpSessionUpdate(liveSession.activityState, update)) {
      applyActivity(services, liveSession.sessionId, activity, update);
    }
  });
}

function contextUsageFromAcpPrompt(
  usage: OpenCodeAcpPromptUsage | undefined,
  contextWindow?: ModelContextWindowResolution,
) {
  if (usage?.totalTokens === undefined) {
    return undefined;
  }
  return withModelContextWindow({
    usedTokens: usage.totalTokens,
    source: "opencode.prompt_response.usage",
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.thoughtTokens !== undefined && usage.thoughtTokens !== null
      ? { reasoningOutputTokens: usage.thoughtTokens }
      : {}),
  }, contextWindow);
}

export async function closeOpenCodeLiveSession(
  liveSession: LiveOpenCodeSession,
  _request?: CloseSessionRequest,
): Promise<void> {
  await liveSession.acp.close().catch(() => undefined);
  await stopOpenCodeServer(liveSession.server);
}

export function interruptOpenCodeLiveSession(params: {
  services: RuntimeServices;
  liveSession: LiveOpenCodeSession;
  request: InterruptSessionRequest;
}): ReturnType<typeof toSessionSummary> {
  const { services, liveSession, request } = params;
  if (!services.sessionStore.hasInputControl(liveSession.sessionId, request.clientId)) {
    throw new Error(
      `Client ${request.clientId} does not hold input control for ${liveSession.sessionId}.`,
    );
  }
  const turnId = liveSession.activityState.currentTurnId;
  void liveSession.acp.cancel(liveSession.providerSessionId);
  void abortOpenCodeSession({
    handle: liveSession.server,
    providerSessionId: liveSession.providerSessionId,
  }).catch((error) => {
    applyActivity(services, liveSession.sessionId, {
      type: "runtime_status",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
      ...(turnId ? { turnId } : {}),
    });
  });
  if (turnId) {
    delete liveSession.activityState.currentTurnId;
    applyActivity(services, liveSession.sessionId, {
      type: "turn_canceled",
      reason: "Stop requested",
      turnId,
    });
  }
  return toSessionSummary(services.sessionStore.getSession(liveSession.sessionId)!);
}

export async function respondToOpenCodeLivePermission(params: {
  liveSession: LiveOpenCodeSession;
  response: PermissionResponseRequest;
  requestId: string;
}): Promise<void> {
  await respondOpenCodePermission({
    handle: params.liveSession.server,
    requestId: params.requestId,
    reply: mapPermissionReply(params.response),
    ...(params.response.message ? { message: params.response.message } : {}),
  });
}

function mapPermissionReply(response: PermissionResponseRequest): "once" | "always" | "reject" {
  if (response.selectedActionId === "always" || isPermissionSessionGrant(response)) {
    return "always";
  }
  if (response.selectedActionId === "reject" || isPermissionDenied(response)) {
    return "reject";
  }
  return "once";
}
