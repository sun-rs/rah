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
  type ResumeSessionRequest,
  type SessionInputRequest,
  type SessionModeDescriptor,
  type SessionRuntimeDiagnostics,
  type StartSessionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "../provider-adapter";
import { applyProviderActivity, type ProviderActivity } from "../provider-activity";
import { toSessionSummary } from "../session-store";
import {
  abortOpenCodeSession,
  createOpenCodeMessageId,
  createOpenCodeSession,
  getOpenCodeMessages,
  getOpenCodeSession,
  promptOpenCodeSession,
  respondOpenCodePermission,
  startOpenCodeServer,
  stopOpenCodeServer,
  subscribeOpenCodeEvents,
  type OpenCodeServerHandle,
  type OpenCodeSessionInfo,
} from "../opencode-api";
import {
  createOpenCodeActivityState,
  recordOpenCodeSubmittedUserMessage,
  startOpenCodeTurn,
  translateOpenCodeMessage,
  translateOpenCodeEvent,
  type OpenCodeActivityState,
} from "../opencode-activity";
import type { OpenCodeMessageWithParts } from "../opencode-api";
import {
  normalizeOpenCodeOptionValues,
  normalizeOpenCodeReasoningId,
  resolveOpenCodeRuntimeCapabilityState,
} from "../opencode-model-catalog";
import {
  resolveModelContextWindow,
  type ModelContextWindowResolution,
} from "../model-context-window";
import {
  buildOpenCodeModeState,
  defaultProviderModeId,
  isOpenCodeModeId,
} from "../session-mode-utils";
import { optionValueAsString, resolveModelOptionValues } from "../session-model-options";
import { nativeLocalServerRuntimeDiagnostics } from "../native-local-server-attach";
import {
  extraMcpServersFromRequest,
  opencodeEnvForMcpServers,
} from "../provider-mcp-server-spec";

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
  availableModes: SessionModeDescriptor[];
  queuedInputs: SessionInputRequest[];
  abortRetryTimers?: Array<ReturnType<typeof setTimeout>>;
  abortPendingTurnId?: string;
  locallyCanceledTurnIds?: Set<string>;
  localCancelMirrorSuppressUntilMs?: number;
  providerReadyForInput?: boolean;
}

const SESSION_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

const OPENCODE_HISTORY_MIRROR_INTERVAL_MS = 1_000;
const OPENCODE_HISTORY_MIRROR_MESSAGE_LIMIT = 8;
const OPENCODE_HISTORY_PRIME_MESSAGE_LIMIT = 16;
const OPENCODE_HISTORY_MIRROR_REVISION_LIMIT = 64;

export function runtimeDiagnosticsForOpenCodeServer(
  server: OpenCodeServerHandle,
  providerSessionId: string,
): SessionRuntimeDiagnostics {
  return nativeLocalServerRuntimeDiagnostics({
    provider: "opencode",
    providerSessionId,
    endpoint: server.baseUrl,
    ...(server.child.pid !== undefined ? { serverPid: server.child.pid } : {}),
    attachState: "ready",
    lastEventCursor: `session:${providerSessionId}`,
  });
}

function openCodeNativeModeId(modeId: string): string {
  return modeId;
}

function resolveRequestedOpenCodeModeId(
  modeId: string | undefined,
  availableModes: readonly SessionModeDescriptor[],
): string {
  if (modeId?.trim()) {
    const normalized = modeId.trim();
    if (!isOpenCodeModeId(normalized, availableModes)) {
      throw new Error(`Unsupported OpenCode mode '${normalized}'.`);
    }
    return normalized;
  }
  return defaultProviderModeId("opencode") ?? "build";
}

async function applyOpenCodePermissionMode(
  _liveSession: LiveOpenCodeSession,
  _modeId: string,
): Promise<void> {
  // OpenCode exposes provider-native agents (for example build/plan) here.
  // Permission policy is not modeled as a RAH mode; do not synthesize
  // non-native modes such as "full auto" or rewrite OpenCode permissions.
}

function openCodeAvailableModes(
  catalog: ProviderModelCatalog | null | undefined,
): SessionModeDescriptor[] {
  const modes = catalog?.modes ?? [];
  if (modes.length > 0) {
    return modes;
  }
  return buildOpenCodeModeState({
    currentModeId: defaultProviderModeId("opencode") ?? "build",
    mutable: true,
  }).availableModes;
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
}): string | null {
  if (!args.modelId) {
    return normalizeOpenCodeReasoningId(args.catalog?.currentReasoningId) ?? null;
  }
  const model = args.catalog?.models.find((entry) => entry.id === args.modelId);
  return normalizeOpenCodeReasoningId(model?.defaultReasoningId) ?? null;
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

function markOpenCodeTurnLocallyCanceled(liveSession: LiveOpenCodeSession, turnId: string): void {
  const current = liveSession.locallyCanceledTurnIds ?? new Set<string>();
  current.add(turnId);
  while (current.size > 128) {
    const oldest = current.values().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    current.delete(oldest);
  }
  liveSession.locallyCanceledTurnIds = current;
  liveSession.localCancelMirrorSuppressUntilMs = Date.now() + 10_000;
}

function clearOpenCodeLocalCancelSuppression(liveSession: LiveOpenCodeSession): void {
  delete liveSession.localCancelMirrorSuppressUntilMs;
}

function shouldSuppressMirroredOpenCodeActivity(
  liveSession: LiveOpenCodeSession,
  activity: ProviderActivity,
): boolean {
  const activityTurnId = "turnId" in activity && typeof activity.turnId === "string"
    ? activity.turnId
    : undefined;
  if (activityTurnId && liveSession.locallyCanceledTurnIds?.has(activityTurnId)) {
    return !(
      activity.type === "timeline_item" &&
      activity.item.kind === "user_message"
    );
  }
  const withinLocalCancelWindow =
    liveSession.localCancelMirrorSuppressUntilMs !== undefined &&
    Date.now() <= liveSession.localCancelMirrorSuppressUntilMs;
  if (
    activity.type === "turn_canceled" &&
    withinLocalCancelWindow
  ) {
    return true;
  }
  return (
    activity.type === "turn_failed" &&
    withinLocalCancelWindow &&
    liveSession.activityState.currentTurnId === undefined &&
    (liveSession.locallyCanceledTurnIds?.size ?? 0) > 0
  );
}

export function normalizeOpenCodeLiveActivities(
  liveSession: LiveOpenCodeSession,
  activities: readonly ProviderActivity[],
): ProviderActivity[] {
  return normalizeOpenCodeAbortActivities(liveSession, activities).filter(
    (activity) => !shouldSuppressMirroredOpenCodeActivity(liveSession, activity),
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

function rememberOpenCodeHistoryMirrorRevision(
  liveSession: LiveOpenCodeSession,
  messageId: string,
  revision: string,
): boolean {
  if (liveSession.mirroredMessageRevisions.get(messageId) === revision) {
    return false;
  }
  liveSession.mirroredMessageRevisions.delete(messageId);
  liveSession.mirroredMessageRevisions.set(messageId, revision);
  while (liveSession.mirroredMessageRevisions.size > OPENCODE_HISTORY_MIRROR_REVISION_LIMIT) {
    const oldest = liveSession.mirroredMessageRevisions.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    liveSession.mirroredMessageRevisions.delete(oldest);
  }
  return true;
}

async function drainOpenCodeHistoryMirror(
  services: RuntimeServices,
  liveSession: LiveOpenCodeSession,
  signal?: AbortSignal,
): Promise<void> {
  const messages = await getOpenCodeMessages(
    liveSession.server,
    liveSession.providerSessionId,
    {
      limit: OPENCODE_HISTORY_MIRROR_MESSAGE_LIMIT,
      ...(signal ? { signal } : {}),
    },
  );
  for (const message of messages) {
    if (!isOpenCodeMessageReadyForHistoryMirror(message)) {
      continue;
    }
    const revision = openCodeMessageRevision(message);
    if (!rememberOpenCodeHistoryMirrorRevision(liveSession, message.info.id, revision)) {
      continue;
    }
    for (const activity of normalizeOpenCodeLiveActivities(
      liveSession,
      translateOpenCodeMessage(liveSession.activityState, message),
    )) {
      applyActivity(services, liveSession.sessionId, activity, {
        source: "opencode-history-mirror",
        messageId: message.info.id,
      });
    }
  }
}

export function primeOpenCodeHistoryMirrorState(
  liveSession: LiveOpenCodeSession,
  messages: readonly OpenCodeMessageWithParts[],
): void {
  for (const message of messages) {
    if (!isOpenCodeMessageReadyForHistoryMirror(message)) {
      continue;
    }
    rememberOpenCodeHistoryMirrorRevision(
      liveSession,
      message.info.id,
      openCodeMessageRevision(message),
    );
    // Resume with historyReplay=skip transfers the already rendered client
    // projection. Rebuild only provider identity state here; emitting these
    // activities would replay the same history over the wire.
    translateOpenCodeMessage(liveSession.activityState, message);
  }
  delete liveSession.activityState.currentTurnId;
}

async function primeOpenCodeHistoryMirror(liveSession: LiveOpenCodeSession): Promise<void> {
  primeOpenCodeHistoryMirrorState(
    liveSession,
    await getOpenCodeMessages(liveSession.server, liveSession.providerSessionId, {
      limit: OPENCODE_HISTORY_PRIME_MESSAGE_LIMIT,
    }),
  );
}

function startOpenCodeHistoryMirror(params: {
  services: RuntimeServices;
  liveSession: LiveOpenCodeSession;
}): () => void {
  const { services, liveSession } = params;
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      await drainOpenCodeHistoryMirror(services, liveSession, controller.signal);
      if (stopped) {
        return;
      }
      drainQueuedOpenCodeInput(services, liveSession);
    } catch (error) {
      if (!stopped) {
        patchOpenCodeRuntimeError(services, liveSession, error);
      }
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), OPENCODE_HISTORY_MIRROR_INTERVAL_MS);
        timer.unref?.();
      }
    }
  };
  drainQueuedOpenCodeInput(services, liveSession);
  void tick();
  return () => {
    stopped = true;
    controller.abort();
    if (timer) {
      clearTimeout(timer);
    }
  };
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
  const message = error instanceof Error ? error.message : String(error);
  const previous = state.session.runtimeDiagnostics?.lastError;
  if (
    previous &&
    !isGenericOpenCodeUnexpectedError(previous) &&
    isGenericOpenCodeUnexpectedError(message)
  ) {
    return;
  }
  services.sessionStore.patchManagedSession(liveSession.sessionId, {
    runtimeDiagnostics: {
      ...(state.session.runtimeDiagnostics ?? {}),
      lastError: message,
    },
  });
}

function isGenericOpenCodeUnexpectedError(message: string): boolean {
  return message.includes("Unexpected server error. Check server logs for details.");
}

export async function startOpenCodeLiveSession(params: {
  services: RuntimeServices;
  request: StartSessionRequest;
  modelCatalog?: ProviderModelCatalog | null;
}): Promise<{ liveSession: LiveOpenCodeSession; summary: ReturnType<typeof toSessionSummary> }> {
  const { services, request } = params;
  const availableModes = openCodeAvailableModes(params.modelCatalog);
  const initialModeId = resolveRequestedOpenCodeModeId(
    request.modeId,
    availableModes,
  );
  const currentModelId = request.model ?? params.modelCatalog?.currentModelId ?? null;
  const currentModel = currentModelId
    ? params.modelCatalog?.models.find((model) => model.id === currentModelId)
    : undefined;
  const requestedOptionValues = normalizeOpenCodeOptionValues(request.optionValues);
  const optionValues = currentModel
    ? normalizeOpenCodeOptionValues(
        resolveModelOptionValues({
          catalog: params.modelCatalog ?? null,
          model: currentModel,
          optionValues: requestedOptionValues,
          useDefaults: Boolean(request.model),
        }),
      ) ?? {}
    : requestedOptionValues ?? {};
  const optionReasoningId = optionValueAsString(optionValues, "model_reasoning_variant");
  const currentReasoningId =
    optionReasoningId !== undefined
      ? optionReasoningId
      : resolveOpenCodeReasoningId({
          catalog: params.modelCatalog,
          modelId: currentModelId,
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
  const extraMcpEnv = opencodeEnvForMcpServers(extraMcpServersFromRequest(request));
  const server = await startOpenCodeServer({
    cwd: request.cwd,
    ...(extraMcpEnv ? { env: extraMcpEnv } : {}),
  });
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
    ...(request.origin !== undefined ? { origin: request.origin } : {}),
    launchSource: "web",
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
      availableModes,
    }),
    ...runtimeCapabilityState,
    capabilities: {
      livePermissions: true,
      structuredControl: true,
      steerInput: true,
      queuedInput: true,
      modelSwitch: true,
      actions: {
        info: true,
        stop: true,
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
    activityState: createOpenCodeActivityState(providerSession.id, {
      userMessagesStartTurns: false,
      statusStartsTurns: false,
      statusCompletesTurns: false,
    }),
    stopEvents: () => undefined,
    stopHistoryMirror: () => undefined,
    mirroredMessageRevisions: new Map(),
    providerReadyForInput: true,
    modeId: initialModeId,
    availableModes,
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
    throw new Error("Failed to create runtime session for OpenCode running session.");
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
  origin?: StartSessionRequest["origin"];
  modeId?: string;
  model?: string;
  optionValues?: StartSessionRequest["optionValues"];
  modelCatalog?: ProviderModelCatalog | null;
  historyReplay?: ResumeSessionRequest["historyReplay"];
}): Promise<{ liveSession: LiveOpenCodeSession; summary: ReturnType<typeof toSessionSummary> }> {
  const { services } = params;
  const availableModes = openCodeAvailableModes(params.modelCatalog);
  const initialModeId = resolveRequestedOpenCodeModeId(
    params.modeId,
    availableModes,
  );
  const currentModelId = params.model ?? params.modelCatalog?.currentModelId ?? null;
  const currentModel = currentModelId
    ? params.modelCatalog?.models.find((model) => model.id === currentModelId)
    : undefined;
  const requestedOptionValues = normalizeOpenCodeOptionValues(params.optionValues);
  const optionValues = currentModel
    ? normalizeOpenCodeOptionValues(
        resolveModelOptionValues({
          catalog: params.modelCatalog ?? null,
          model: currentModel,
          optionValues: requestedOptionValues,
          useDefaults: Boolean(params.model),
        }),
      ) ?? {}
    : requestedOptionValues ?? {};
  const optionReasoningId = optionValueAsString(optionValues, "model_reasoning_variant");
  const currentReasoningId =
    optionReasoningId !== undefined
      ? optionReasoningId
      : resolveOpenCodeReasoningId({
          catalog: params.modelCatalog,
          modelId: currentModelId,
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
    ...(params.origin !== undefined ? { origin: params.origin } : {}),
    launchSource: "web",
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
      availableModes,
    }),
    ...runtimeCapabilityState,
    capabilities: {
      livePermissions: true,
      structuredControl: true,
      steerInput: true,
      queuedInput: true,
      modelSwitch: true,
      actions: {
        info: true,
        stop: true,
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
    activityState: createOpenCodeActivityState(params.providerSessionId, {
      userMessagesStartTurns: false,
      statusStartsTurns: false,
      statusCompletesTurns: false,
    }),
    stopEvents: () => undefined,
    stopHistoryMirror: () => undefined,
    mirroredMessageRevisions: new Map(),
    providerReadyForInput: true,
    modeId: initialModeId,
    availableModes,
    queuedInputs: [],
    ...(currentModelId ? { model: currentModelId } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(currentReasoningId !== undefined ? { reasoningId: currentReasoningId } : {}),
  };
  await applyOpenCodePermissionMode(liveSession, initialModeId);
  if (params.historyReplay === "skip") {
    await primeOpenCodeHistoryMirror(liveSession);
  }
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
  if (
    liveSession.activityState.currentTurnId ||
    liveSession.providerReadyForInput === false
  ) {
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
  if (!isOpenCodeModeId(params.modeId, params.liveSession.availableModes)) {
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
        availableModes: params.liveSession.availableModes,
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
  clearOpenCodeLocalCancelSuppression(liveSession);
  liveSession.providerReadyForInput = false;
  const { text } = request;
  const turnId = randomUUID();
  const providerMessageId = createOpenCodeMessageId();
  for (const activity of startOpenCodeTurn(liveSession.activityState, turnId)) {
    applyActivity(services, liveSession.sessionId, activity);
  }
  recordOpenCodeSubmittedUserMessage(liveSession.activityState, {
    text,
    turnId,
    providerMessageId,
    ...(request.clientMessageId !== undefined ? { clientMessageId: request.clientMessageId } : {}),
    ...(request.clientTurnId !== undefined ? { clientTurnId: request.clientTurnId } : {}),
  });
  void promptOpenCodeSession({
    handle: liveSession.server,
    providerSessionId: liveSession.providerSessionId,
    text,
    messageId: providerMessageId,
    ...(liveSession.model ? { model: liveSession.model } : {}),
    ...(liveSession.reasoningId && liveSession.reasoningId !== "default"
      ? { variant: liveSession.reasoningId }
      : {}),
    agent: openCodeNativeModeId(liveSession.modeId),
  })
    .then((message) => {
      for (const activity of translateOpenCodeMessage(liveSession.activityState, message)) {
        applyActivity(services, liveSession.sessionId, activity, {
          source: "opencode-prompt-response",
          messageId: message.info.id,
        });
      }
      drainQueuedOpenCodeInput(services, liveSession);
    })
    .catch((error) => {
      if (liveSession.abortPendingTurnId === turnId) {
        clearOpenCodePendingAbort(liveSession);
        if (liveSession.activityState.currentTurnId === turnId) {
          delete liveSession.activityState.currentTurnId;
        }
        markOpenCodeTurnLocallyCanceled(liveSession, turnId);
        applyActivity(services, liveSession.sessionId, {
          type: "turn_canceled",
          turnId,
          reason: "interrupted",
        });
        drainQueuedOpenCodeInput(services, liveSession);
        return;
      }
      patchOpenCodeRuntimeError(services, liveSession, error);
      if (liveSession.activityState.currentTurnId !== turnId) {
        drainQueuedOpenCodeInput(services, liveSession);
        return;
      }
      delete liveSession.activityState.currentTurnId;
      liveSession.providerReadyForInput = true;
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
  if (liveSession.providerReadyForInput === false) {
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
      if (event.type === "session.status") {
        const status = event.properties?.status;
        const statusType =
          status && typeof status === "object" && !Array.isArray(status)
            ? (status as { type?: unknown }).type
            : undefined;
        if (statusType === "busy" || statusType === "retry") {
          liveSession.providerReadyForInput = false;
        } else if (statusType === "idle") {
          liveSession.providerReadyForInput = true;
        }
      }
      const activities = normalizeOpenCodeLiveActivities(
        liveSession,
        translateOpenCodeEvent(liveSession.activityState, event),
      );
      for (const activity of activities) {
        if (activity.type === "turn_failed") {
          patchOpenCodeRuntimeError(services, liveSession, activity.error);
        }
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

function normalizeOpenCodeAbortActivities(
  liveSession: LiveOpenCodeSession,
  activities: readonly ProviderActivity[],
): ProviderActivity[] {
  const abortTurnId = liveSession.abortPendingTurnId;
  if (!abortTurnId) {
    return [...activities];
  }
  return activities.map((activity) =>
    activity.type === "turn_failed" && activity.turnId === abortTurnId
      ? {
          type: "turn_canceled",
          turnId: abortTurnId,
          reason: "interrupted",
        }
      : activity,
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
  if (
    activities.some(
      (activity) => activity.type === "turn_canceled" && activity.turnId === abortTurnId,
    )
  ) {
    markOpenCodeTurnLocallyCanceled(liveSession, abortTurnId);
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
    })
      .then(() => {
        if (liveSession.abortPendingTurnId !== turnId) {
          return;
        }
        clearOpenCodePendingAbort(liveSession);
        if (liveSession.activityState.currentTurnId === turnId) {
          delete liveSession.activityState.currentTurnId;
        }
        markOpenCodeTurnLocallyCanceled(liveSession, turnId);
        applyActivity(services, liveSession.sessionId, {
          type: "turn_canceled",
          turnId,
          reason: "interrupted",
        });
        drainQueuedOpenCodeInput(services, liveSession);
      })
      .catch((error) => {
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
