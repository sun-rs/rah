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
  type SessionRuntimeDiagnostics,
  type SessionInputRequest,
  type StartSessionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "../provider-adapter";
import { applyProviderActivity, type ProviderActivity } from "../provider-activity";
import { toSessionSummary } from "../session-store";
import {
  abortOpenCodeSession,
  createOpenCodeSession,
  getOpenCodeSession,
  promptOpenCodeSessionAsync,
  respondOpenCodePermission,
  setOpenCodeSessionPermission,
  startOpenCodeServer,
  stopOpenCodeServer,
  subscribeOpenCodeEvents,
  type OpenCodePermissionRule,
  type OpenCodeServerHandle,
  type OpenCodeSessionInfo,
} from "../opencode-api";
import {
  createOpenCodeActivityState,
  startOpenCodeTurn,
  translateOpenCodeMessage,
  translateOpenCodeEvent,
  type OpenCodeActivityState,
} from "../opencode-activity";
import type { OpenCodeMessageWithParts } from "../opencode-api";
import {
  findOpenCodeStoredSessionRecord,
  loadOpenCodeStoredMessages,
} from "../opencode-stored-sessions";
import { resolveOpenCodeRuntimeCapabilityState } from "../opencode-model-catalog";
import {
  resolveModelContextWindow,
  type ModelContextWindowResolution,
} from "../model-context-window";
import { buildOpenCodeModeState, isOpenCodeModeId } from "../session-mode-utils";
import { optionValueAsString, resolveModelOptionValues } from "../session-model-options";

export interface LiveOpenCodeSession {
  sessionId: string;
  providerSessionId: string;
  cwd: string;
  server: OpenCodeServerHandle;
  activityState: OpenCodeActivityState;
  stopEvents: () => void;
  stopHistoryMirror: () => void;
  mirroredMessageRevisions: Map<string, string>;
  model?: string;
  contextWindow?: ModelContextWindowResolution;
  reasoningId?: string | null;
  modeId: string;
  queuedInputs: SessionInputRequest[];
  abortRetryTimers?: Array<ReturnType<typeof setTimeout>>;
  abortPendingTurnId?: string;
}

const SESSION_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

const OPENCODE_FULL_AUTO_MODE_ID = "opencode/full-auto";
const RAH_SESSION_MODE_CONFIG_KEY = "rah_session_mode";
const OPENCODE_HISTORY_MIRROR_INTERVAL_MS = 750;

export function runtimeDiagnosticsForOpenCodeServer(
  server: OpenCodeServerHandle,
  providerSessionId: string,
): SessionRuntimeDiagnostics {
  return {
    serverEndpoint: server.baseUrl,
    ...(server.child.pid !== undefined ? { serverPid: server.child.pid } : {}),
    attachCommand: `opencode attach ${server.baseUrl} --session ${providerSessionId}`,
    attachState: "ready",
    lastEventCursor: `session:${providerSessionId}`,
  };
}

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

function isOpenCodeMessageReadyForHistoryMirror(message: OpenCodeMessageWithParts): boolean {
  if (message.info.role === "user") {
    return true;
  }
  return (
    message.parts.length > 0 ||
    message.info.finish !== undefined ||
    message.info.time?.completed !== undefined
  );
}

function openCodeMessageRevision(message: OpenCodeMessageWithParts): string {
  return JSON.stringify({
    info: message.info,
    parts: message.parts,
  });
}

function drainOpenCodeHistoryMirror(
  services: RuntimeServices,
  liveSession: LiveOpenCodeSession,
): void {
  const record = findOpenCodeStoredSessionRecord(liveSession.providerSessionId);
  if (!record) {
    return;
  }
  const messages = loadOpenCodeStoredMessages(record, { limit: 1000 });
  for (const message of messages) {
    if (!isOpenCodeMessageReadyForHistoryMirror(message)) {
      continue;
    }
    const revision = openCodeMessageRevision(message);
    if (liveSession.mirroredMessageRevisions.get(message.info.id) === revision) {
      continue;
    }
    liveSession.mirroredMessageRevisions.set(message.info.id, revision);
    for (const activity of translateOpenCodeMessage(liveSession.activityState, message)) {
      applyActivity(services, liveSession.sessionId, activity, {
        source: "opencode-history-mirror",
        messageId: message.info.id,
      });
    }
  }
}

function startOpenCodeHistoryMirror(params: {
  services: RuntimeServices;
  liveSession: LiveOpenCodeSession;
}): () => void {
  const { services, liveSession } = params;
  const tick = () => {
    try {
      drainOpenCodeHistoryMirror(services, liveSession);
      drainQueuedOpenCodeInput(services, liveSession);
    } catch (error) {
      patchOpenCodeRuntimeError(services, liveSession, error);
    }
  };
  tick();
  const timer = setInterval(tick, OPENCODE_HISTORY_MIRROR_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function patchOpenCodeRuntimeError(
  services: RuntimeServices,
  liveSession: LiveOpenCodeSession,
  error: unknown,
): void {
  const state = services.sessionStore.getSession(liveSession.sessionId);
  if (!state) {
    return;
  }
  services.sessionStore.patchManagedSession(liveSession.sessionId, {
    runtimeDiagnostics: {
      ...(state.session.runtimeDiagnostics ?? {}),
      lastError: error instanceof Error ? error.message : String(error),
    },
  });
}

export async function startOpenCodeLiveSession(params: {
  services: RuntimeServices;
  request: StartSessionRequest;
  modelCatalog?: ProviderModelCatalog | null;
}): Promise<{ liveSession: LiveOpenCodeSession; summary: ReturnType<typeof toSessionSummary> }> {
  const { services, request } = params;
  const initialModeId = resolveRequestedOpenCodeModeId(request.modeId, request.providerConfig);
  const currentModelId = request.model ?? params.modelCatalog?.currentModelId ?? null;
  const currentModel = currentModelId
    ? params.modelCatalog?.models.find((model) => model.id === currentModelId)
    : undefined;
  if (request.optionValues !== undefined && !currentModel) {
    throw new Error(`Unsupported OpenCode model '${currentModelId ?? ""}'.`);
  }
  const optionValues = currentModel
    ? resolveModelOptionValues({
        catalog: params.modelCatalog ?? null,
        model: currentModel,
        optionValues: request.optionValues,
        reasoningId: request.reasoningId,
        useDefaults: Boolean(request.model),
      })
    : {};
  const optionReasoningId = optionValueAsString(optionValues, "model_reasoning_variant");
  const currentReasoningId =
    optionReasoningId !== undefined
      ? optionReasoningId
      : resolveOpenCodeReasoningId({
          catalog: params.modelCatalog,
          modelId: currentModelId,
          requestedReasoningId: request.reasoningId,
        });
  const runtimeCapabilityState = resolveOpenCodeRuntimeCapabilityState({
    catalog: params.modelCatalog,
    modelId: currentModelId,
    reasoningId: currentReasoningId,
    ...(Object.keys(optionValues).length > 0 ? { optionValues } : {}),
  });
  const contextWindow = resolveModelContextWindow({
    provider: "opencode",
    modelId: currentModelId,
    catalog: params.modelCatalog ?? null,
  });
  const server = await startOpenCodeServer({ cwd: request.cwd });
  let providerSession: OpenCodeSessionInfo;
  try {
    providerSession = await createOpenCodeSession(
      server,
      request.title !== undefined ? { title: request.title } : {},
    );
  } catch (error) {
    await stopOpenCodeServer(server).catch(() => undefined);
    throw error;
  }
  const state = services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: providerSession.id,
    launchSource: request.attach?.client.kind === "terminal" ? "terminal" : "web",
    liveBackend: "native_local_server",
    cwd: request.cwd,
    rootDir: request.cwd,
    title: providerSession.title,
    runtimeDiagnostics: runtimeDiagnosticsForOpenCodeServer(server, providerSession.id),
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
      structuredControl: true,
      steerInput: true,
      queuedInput: true,
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
  services.sessionStore.patchManagedSession(state.session.id, {
    nativeTui: {
      terminalId: state.session.id,
      viewAvailable: true,
      promptState: "prompt_clean",
      queuedInputCount: 0,
    },
    capabilities: {
      nativeTui: true,
      rawPtyInput: true,
    },
  });
  const liveSession: LiveOpenCodeSession = {
    sessionId: state.session.id,
    providerSessionId: providerSession.id,
    cwd: request.cwd,
    server,
    activityState: createOpenCodeActivityState(providerSession.id),
    stopEvents: () => undefined,
    stopHistoryMirror: () => undefined,
    mirroredMessageRevisions: new Map(),
    modeId: initialModeId,
    queuedInputs: [],
    ...(currentModelId ? { model: currentModelId } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(currentReasoningId !== undefined ? { reasoningId: currentReasoningId } : {}),
  };
  await applyOpenCodePermissionMode(liveSession, initialModeId);
  liveSession.stopEvents = attachOpenCodeEventSink({ services, liveSession });
  liveSession.stopHistoryMirror = startOpenCodeHistoryMirror({ services, liveSession });
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
      request: { clientId: "system", text: initialPrompt },
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
  optionValues?: StartSessionRequest["optionValues"];
  reasoningId?: string | null | undefined;
  modelCatalog?: ProviderModelCatalog | null;
}): Promise<{ liveSession: LiveOpenCodeSession; summary: ReturnType<typeof toSessionSummary> }> {
  const { services } = params;
  const initialModeId = resolveRequestedOpenCodeModeId(params.modeId, params.providerConfig);
  const currentModelId = params.model ?? params.modelCatalog?.currentModelId ?? null;
  const currentModel = currentModelId
    ? params.modelCatalog?.models.find((model) => model.id === currentModelId)
    : undefined;
  if (params.optionValues !== undefined && !currentModel) {
    throw new Error(`Unsupported OpenCode model '${currentModelId ?? ""}'.`);
  }
  const optionValues = currentModel
    ? resolveModelOptionValues({
        catalog: params.modelCatalog ?? null,
        model: currentModel,
        optionValues: params.optionValues,
        reasoningId: params.reasoningId,
        useDefaults: Boolean(params.model),
      })
    : {};
  const optionReasoningId = optionValueAsString(optionValues, "model_reasoning_variant");
  const currentReasoningId =
    optionReasoningId !== undefined
      ? optionReasoningId
      : resolveOpenCodeReasoningId({
          catalog: params.modelCatalog,
          modelId: currentModelId,
          requestedReasoningId: params.reasoningId,
        });
  const runtimeCapabilityState = resolveOpenCodeRuntimeCapabilityState({
    catalog: params.modelCatalog,
    modelId: currentModelId,
    reasoningId: currentReasoningId,
    ...(Object.keys(optionValues).length > 0 ? { optionValues } : {}),
  });
  const contextWindow = resolveModelContextWindow({
    provider: "opencode",
    modelId: currentModelId,
    catalog: params.modelCatalog ?? null,
  });
  const server = await startOpenCodeServer({ cwd: params.cwd });
  let providerSession: OpenCodeSessionInfo;
  try {
    providerSession = await getOpenCodeSession(server, params.providerSessionId);
  } catch (error) {
    await stopOpenCodeServer(server).catch(() => undefined);
    throw error;
  }
  const state = services.sessionStore.createManagedSession({
    provider: "opencode",
    providerSessionId: params.providerSessionId,
    launchSource: params.attach?.client.kind === "terminal" ? "terminal" : "web",
    liveBackend: "native_local_server",
    cwd: params.cwd,
    rootDir: params.cwd,
    title: providerSession.title,
    runtimeDiagnostics: runtimeDiagnosticsForOpenCodeServer(server, params.providerSessionId),
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
      structuredControl: true,
      steerInput: true,
      queuedInput: true,
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
  services.sessionStore.patchManagedSession(state.session.id, {
    nativeTui: {
      terminalId: state.session.id,
      viewAvailable: true,
      promptState: "prompt_clean",
      queuedInputCount: 0,
    },
    capabilities: {
      nativeTui: true,
      rawPtyInput: true,
    },
  });
  const liveSession: LiveOpenCodeSession = {
    sessionId: state.session.id,
    providerSessionId: params.providerSessionId,
    cwd: params.cwd,
    server,
    activityState: createOpenCodeActivityState(params.providerSessionId),
    stopEvents: () => undefined,
    stopHistoryMirror: () => undefined,
    mirroredMessageRevisions: new Map(),
    modeId: initialModeId,
    queuedInputs: [],
    ...(currentModelId ? { model: currentModelId } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(currentReasoningId !== undefined ? { reasoningId: currentReasoningId } : {}),
  };
  await applyOpenCodePermissionMode(liveSession, initialModeId);
  liveSession.stopEvents = attachOpenCodeEventSink({ services, liveSession });
  liveSession.stopHistoryMirror = startOpenCodeHistoryMirror({ services, liveSession });
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
    liveSession.queuedInputs.push(request);
    return;
  }
  submitOpenCodePrompt({
    services,
    liveSession,
    request,
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
  request: SessionInputRequest;
}): void {
  const { services, liveSession, request } = params;
  // Abort retries belong to the previously interrupted turn. If a recovery
  // prompt starts, stale retry timers must not cancel that new provider turn.
  clearOpenCodeAbortRetries(liveSession);
  const { text } = request;
  const turnId = randomUUID();
  for (const activity of startOpenCodeTurn(liveSession.activityState, turnId)) {
    applyActivity(services, liveSession.sessionId, activity);
  }
  applyActivity(services, liveSession.sessionId, {
    type: "timeline_item",
    turnId,
    item: {
      kind: "user_message",
      text,
      ...(request.clientMessageId !== undefined ? { clientMessageId: request.clientMessageId } : {}),
      ...(request.clientTurnId !== undefined ? { clientTurnId: request.clientTurnId } : {}),
    },
  });
  void promptOpenCodeSessionAsync({
    handle: liveSession.server,
    providerSessionId: liveSession.providerSessionId,
    text,
    ...(liveSession.model ? { model: liveSession.model } : {}),
    ...(liveSession.reasoningId && liveSession.reasoningId !== "default"
      ? { variant: liveSession.reasoningId }
      : {}),
    agent: openCodeNativeModeId(liveSession.modeId),
  })
    .catch((error) => {
      patchOpenCodeRuntimeError(services, liveSession, error);
      if (liveSession.activityState.currentTurnId !== turnId) {
        drainQueuedOpenCodeInput(services, liveSession);
        return;
      }
      delete liveSession.activityState.currentTurnId;
      applyActivity(services, liveSession.sessionId, {
        type: "turn_failed",
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
      drainQueuedOpenCodeInput(services, liveSession);
    });
}

function drainQueuedOpenCodeInput(
  services: RuntimeServices,
  liveSession: LiveOpenCodeSession,
): void {
  if (liveSession.activityState.currentTurnId) {
    return;
  }
  const next = liveSession.queuedInputs.shift();
  if (!next) {
    return;
  }
  submitOpenCodePrompt({ services, liveSession, request: next });
}

function attachOpenCodeEventSink(params: {
  services: RuntimeServices;
  liveSession: LiveOpenCodeSession;
}): () => void {
  const { services, liveSession } = params;
  return subscribeOpenCodeEvents({
    handle: liveSession.server,
    onEvent: (event) => {
      const activities = translateOpenCodeEvent(liveSession.activityState, event);
      for (const activity of activities) {
        applyActivity(services, liveSession.sessionId, activity, event);
      }
      reconcileOpenCodeAbortProgress(liveSession, activities);
      drainQueuedOpenCodeInput(services, liveSession);
    },
    onError: (error) => {
      patchOpenCodeRuntimeError(services, liveSession, error);
      applyActivity(services, liveSession.sessionId, {
        type: "runtime_status",
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
        ...(liveSession.activityState.currentTurnId
          ? { turnId: liveSession.activityState.currentTurnId }
          : {}),
      });
    }
  });
}

export async function closeOpenCodeLiveSession(
  liveSession: LiveOpenCodeSession,
  _request?: CloseSessionRequest,
): Promise<void> {
  liveSession.queuedInputs.length = 0;
  clearOpenCodeAbortRetries(liveSession);
  liveSession.stopEvents();
  liveSession.stopHistoryMirror();
  await stopOpenCodeServer(liveSession.server);
}

function clearOpenCodeAbortRetries(liveSession: LiveOpenCodeSession): void {
  for (const timer of liveSession.abortRetryTimers ?? []) {
    clearTimeout(timer);
  }
  liveSession.abortRetryTimers = [];
}

function clearOpenCodePendingAbort(liveSession: LiveOpenCodeSession): void {
  clearOpenCodeAbortRetries(liveSession);
  delete liveSession.abortPendingTurnId;
}

function activityFinishesOpenCodeTurn(activity: ProviderActivity, turnId: string): boolean {
  return (
    (activity.type === "turn_completed" ||
      activity.type === "turn_canceled" ||
      activity.type === "turn_failed") &&
    activity.turnId === turnId
  );
}

function reconcileOpenCodeAbortProgress(
  liveSession: LiveOpenCodeSession,
  activities: readonly ProviderActivity[],
): void {
  const abortTurnId = liveSession.abortPendingTurnId;
  if (!abortTurnId) {
    return;
  }
  if (activities.some((activity) => activityFinishesOpenCodeTurn(activity, abortTurnId))) {
    clearOpenCodePendingAbort(liveSession);
  }
}

export function interruptOpenCodeLiveSession(params: {
  services: RuntimeServices;
  liveSession: LiveOpenCodeSession;
  request: InterruptSessionRequest;
}): ReturnType<typeof toSessionSummary> {
  const { services, liveSession } = params;
  const turnId = liveSession.activityState.currentTurnId;
  liveSession.queuedInputs.length = 0;
  if (!turnId) {
    return toSessionSummary(services.sessionStore.getSession(liveSession.sessionId)!);
  }
  liveSession.abortPendingTurnId = turnId;
  const abortOnce = () => {
    if (liveSession.abortPendingTurnId !== turnId) {
      return;
    }
    void abortOpenCodeSession({
      handle: liveSession.server,
      providerSessionId: liveSession.providerSessionId,
    }).catch((error) => {
      patchOpenCodeRuntimeError(services, liveSession, error);
      applyActivity(services, liveSession.sessionId, {
        type: "runtime_status",
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
        ...(turnId ? { turnId } : {}),
      });
    });
  };
  abortOnce();
  clearOpenCodeAbortRetries(liveSession);
  liveSession.abortRetryTimers = [250, 750, 1500, 2500, 4000, 6500, 9000].map((delayMs) => {
    const timer = setTimeout(() => {
      abortOnce();
    }, delayMs);
    timer.unref?.();
    return timer;
  });
  applyActivity(services, liveSession.sessionId, {
    type: "runtime_status",
    status: "thinking",
    detail: "Interrupt requested",
    turnId,
  });
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
