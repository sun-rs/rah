import { randomUUID } from "node:crypto";
import {
  isPermissionDenied,
  isPermissionSessionGrant,
  type CloseSessionRequest,
  type InterruptSessionRequest,
  type PermissionResponseRequest,
  type SessionInputRequest,
  type StartSessionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { buildKimiModeState } from "./session-mode-utils";
import { toSessionSummary } from "./session-store";
import {
  applyActivity,
  attachRequestedClient,
  bindKimiClientStderr,
  createInitialKimiTurn,
  finalizeTurn,
  handleKimiEvent,
  handleKimiRequest,
  publishSessionBootstrap,
} from "./kimi-live-helpers";
import { createKimiClient } from "./kimi-live-rpc";
import {
  JSON_RPC_TIMEOUT_MS,
  PROMPT_TIMEOUT_MS,
  type LiveKimiSession,
  type LiveKimiTurn,
} from "./kimi-live-types";

export type { LiveKimiSession, LiveKimiTurn } from "./kimi-live-types";

export async function startKimiLiveSession(params: {
  services: RuntimeServices;
  request: StartSessionRequest;
}) {
  const { services, request } = params;
  const providerSessionId = randomUUID();
  const state = services.sessionStore.createManagedSession({
    provider: "kimi",
    providerSessionId,
    launchSource: "web",
    cwd: request.cwd,
    rootDir: request.cwd,
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.initialPrompt !== undefined ? { preview: request.initialPrompt } : {}),
    mode: buildKimiModeState({
      currentModeId: "default",
      mutable: true,
    }),
    capabilities: {
      livePermissions: true,
      steerInput: true,
      queuedInput: true,
      renameSession: true,
      actions: {
        info: true,
        archive: true,
        delete: true,
        rename: "native",
      },
      planMode: true,
    },
  });
  const liveSession: LiveKimiSession = {
    sessionId: state.session.id,
    providerSessionId,
    cwd: request.cwd,
    ...(request.model ? { model: request.model } : {}),
    approvalMode: request.approvalPolicy ?? "default",
    planMode: false,
    client: await createKimiClient({
      providerSessionId,
      cwd: request.cwd,
      onEvent: (event) => handleKimiEvent(services, liveSession, event),
      onRequest: (requestMessage) => handleKimiRequest(services, liveSession, requestMessage),
    }),
    activeTurn: null,
    pendingRequests: new Map(),
  };
  bindKimiClientStderr(services, liveSession);

  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = services.sessionStore.getSession(state.session.id);
  if (!session) {
    await liveSession.client.dispose();
    throw new Error("Failed to create runtime session for Kimi live session.");
  }
  publishSessionBootstrap(services, state.session.id, session.session);
  attachRequestedClient(services, state.session.id, request.attach);
  return {
    liveSession,
    summary: toSessionSummary(services.sessionStore.getSession(state.session.id)!),
  };
}

export async function resumeKimiLiveSession(params: {
  services: RuntimeServices;
  providerSessionId: string;
  cwd: string;
  attach?: StartSessionRequest["attach"];
  model?: string;
  approvalPolicy?: string;
}) {
  const { services } = params;
  const state = services.sessionStore.createManagedSession({
    provider: "kimi",
    providerSessionId: params.providerSessionId,
    launchSource: "web",
    cwd: params.cwd,
    rootDir: params.cwd,
    mode: buildKimiModeState({
      currentModeId: "default",
      mutable: true,
    }),
    capabilities: {
      livePermissions: true,
      steerInput: true,
      queuedInput: true,
      renameSession: true,
      actions: {
        info: true,
        archive: false,
        delete: true,
        rename: "native",
      },
      planMode: true,
    },
  });
  const liveSession: LiveKimiSession = {
    sessionId: state.session.id,
    providerSessionId: params.providerSessionId,
    cwd: params.cwd,
    ...(params.model ? { model: params.model } : {}),
    approvalMode: params.approvalPolicy ?? "default",
    planMode: false,
    client: await createKimiClient({
      providerSessionId: params.providerSessionId,
      cwd: params.cwd,
      onEvent: (event) => handleKimiEvent(services, liveSession, event),
      onRequest: (requestMessage) => handleKimiRequest(services, liveSession, requestMessage),
    }),
    activeTurn: null,
    pendingRequests: new Map(),
  };
  bindKimiClientStderr(services, liveSession);
  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = services.sessionStore.getSession(state.session.id);
  if (!session) {
    await liveSession.client.dispose();
    throw new Error("Failed to create runtime session for Kimi resume.");
  }
  publishSessionBootstrap(services, state.session.id, session.session);
  attachRequestedClient(services, state.session.id, params.attach);
  return {
    liveSession,
    summary: toSessionSummary(services.sessionStore.getSession(state.session.id)!),
  };
}

export async function sendInputToKimiLiveSession(params: {
  services: RuntimeServices;
  liveSession: LiveKimiSession;
  request: SessionInputRequest;
}) {
  const { services, liveSession, request } = params;
  if (liveSession.activeTurn) {
    throw new Error("Kimi session already has an active turn.");
  }
  if (!services.sessionStore.hasInputControl(liveSession.sessionId, request.clientId)) {
    throw new Error(
      `Client ${request.clientId} does not hold input control for ${liveSession.sessionId}.`,
    );
  }
  const turnId = randomUUID();
  liveSession.activeTurn = createInitialKimiTurn(turnId);
  services.sessionStore.setActiveTurn(liveSession.sessionId, turnId);
  applyActivity(services, liveSession.sessionId, { type: "turn_started", turnId });
  applyActivity(services, liveSession.sessionId, {
    type: "timeline_item",
    turnId,
    item: { kind: "user_message", text: request.text },
  });
  applyActivity(services, liveSession.sessionId, { type: "session_state", state: "running" });

  try {
    const result = await liveSession.client.request(
      "prompt",
      {
        user_input: request.text,
      },
      PROMPT_TIMEOUT_MS,
    );
    const record =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {};
    const status = typeof record.status === "string" ? record.status : "finished";
    if (status === "finished") {
      finalizeTurn(services, liveSession, { type: "turn_completed", turnId });
      return;
    }
    if (status === "cancelled") {
      finalizeTurn(services, liveSession, {
        type: "turn_canceled",
        turnId,
        reason: "cancelled",
      });
      return;
    }
    finalizeTurn(services, liveSession, {
      type: "turn_failed",
      turnId,
      error: status,
    });
  } catch (error) {
    finalizeTurn(services, liveSession, {
      type: "turn_failed",
      turnId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function respondToKimiLivePermission(params: {
  liveSession: LiveKimiSession;
  requestId: string;
  response: PermissionResponseRequest;
}) {
  const { liveSession, requestId, response } = params;
  const pending = liveSession.pendingRequests.get(requestId);
  if (!pending) {
    throw new Error(`Unknown pending Kimi request ${requestId}`);
  }
  if (pending.kind === "approval") {
    const decision =
      response.selectedActionId === "approve"
        ? "approve"
        : response.selectedActionId === "approve_for_session" ||
            isPermissionSessionGrant(response)
          ? "approve_for_session"
          : isPermissionDenied(response)
            ? "reject"
            : "approve";
    liveSession.client.respondSuccess(requestId, {
      request_id: requestId,
      response: decision,
      ...(response.message ? { feedback: response.message } : {}),
    });
    liveSession.pendingRequests.delete(requestId);
    return;
  }

  const answers: Record<string, string> = {};
  for (const question of pending.questions) {
    const raw = response.answers?.[question.id];
    const value = raw?.answers?.filter((entry): entry is string => typeof entry === "string").join(", ");
    if (value) {
      answers[question.question] = value;
    }
  }
  liveSession.client.respondSuccess(requestId, {
    request_id: requestId,
    answers,
  });
  liveSession.pendingRequests.delete(requestId);
}

export function interruptKimiLiveSession(params: {
  services: RuntimeServices;
  liveSession: LiveKimiSession;
  request: InterruptSessionRequest;
}) {
  const { services, liveSession, request } = params;
  if (!services.sessionStore.hasInputControl(liveSession.sessionId, request.clientId)) {
    throw new Error(
      `Client ${request.clientId} does not hold input control for ${liveSession.sessionId}.`,
    );
  }
  if (liveSession.activeTurn) {
    liveSession.activeTurn.aborted = true;
  }
  void liveSession.client.request("cancel", {}, JSON_RPC_TIMEOUT_MS).catch(() => undefined);
  const state = services.sessionStore.getSession(liveSession.sessionId);
  if (!state) {
    throw new Error(`Unknown session ${liveSession.sessionId}`);
  }
  return toSessionSummary(state);
}

export async function closeKimiLiveSession(
  liveSession: LiveKimiSession,
  _request?: CloseSessionRequest,
) {
  await liveSession.client.dispose();
}
