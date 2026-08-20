import { randomUUID } from "node:crypto";
import type {
  InitialSessionInputAcceptance,
  RahEvent,
  SessionInputRequest,
  SessionSummary,
} from "@rah/runtime-protocol";
import type { EventBus } from "./event-bus";
import type { SessionStore } from "./session-store";
import { SYSTEM_SOURCE } from "./runtime-session-events";

type InitialSessionInputRuntime = {
  readonly eventBus: EventBus;
  readonly sessionStore: SessionStore;
  sendInput: (sessionId: string, request: SessionInputRequest) => void;
  getSessionSummary: (sessionId: string) => SessionSummary;
};

export type InitialSessionInputAcceptor = <T extends {
  session: SessionSummary;
  initialInputAcceptance?: InitialSessionInputAcceptance;
}>(
  response: T,
  initialInput: SessionInputRequest | undefined,
) => Promise<T>;

/**
 * A start/resume response is not a delivery receipt. Retain ownership until
 * the provider adapter emits an explicit receipt for the exact first input.
 * Queue disappearance is intentionally not treated as acceptance because
 * cancellation and shutdown can also remove queue entries.
 */
export function createInitialSessionInputAcceptor(
  runtime: InitialSessionInputRuntime,
): InitialSessionInputAcceptor {
  return async (response, initialInput) => {
    if (!initialInput) {
      return response;
    }
    const sessionId = response.session.session.id;
    const ownedInput = initialInput.clientMessageId
      ? initialInput
      : { ...initialInput, clientMessageId: randomUUID() };
    const clientMessageId = ownedInput.clientMessageId;
    let providerAcknowledged = false;
    const observe = (event: RahEvent): void => {
      if (
        event.type === "session.input.accepted" &&
        event.payload.clientMessageId === clientMessageId
      ) {
        providerAcknowledged = true;
      }
    };
    const unsubscribe = runtime.eventBus.subscribe(
      {
        sessionIds: [sessionId],
        eventTypes: ["session.input.accepted"],
      },
      observe,
    );

    try {
      runtime.sendInput(sessionId, ownedInput);
      const deadline = Date.now() + 90_000;
      while (!providerAcknowledged) {
        const state = runtime.sessionStore.getSession(sessionId);
        if (!state) {
          throw new Error("Session closed before the initial question was accepted.");
        }
        const queued = state.session.inputQueue?.find(
          (item) => item.clientMessageId === clientMessageId,
        );
        if (state.session.runtimeState === "failed") {
          throw new Error(
            state.session.runtimeDiagnostics?.lastError ??
              "The provider rejected the initial question.",
          );
        }
        if (Date.now() >= deadline) {
          const detail = queued
            ? "RAH kept it in the Session input queue"
            : "the input never entered the canonical Session input queue";
          throw new Error(
            `Timed out waiting for the provider to accept the initial question; ${detail}.`,
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      return {
        ...response,
        session: runtime.getSessionSummary(sessionId),
        initialInputAcceptance: {
          clientMessageId,
          ...(ownedInput.clientTurnId
            ? { clientTurnId: ownedInput.clientTurnId }
            : {}),
          acceptedAt: new Date().toISOString(),
        },
      };
    } finally {
      unsubscribe();
    }
  };
}

export function markSessionInputPending(
  sessionStore: SessionStore,
  eventBus: EventBus,
  sessionId: string,
): void {
  const state = sessionStore.getSession(sessionId);
  if (
    !state ||
    state.activeTurnId ||
    state.session.runtimeState === "running" ||
    state.session.runtimeState === "starting" ||
    state.session.runtimeState === "waiting_input" ||
    state.session.runtimeState === "waiting_permission"
  ) {
    return;
  }
  sessionStore.setRuntimeState(sessionId, "starting");
  eventBus.publish({
    sessionId,
    type: "runtime.status",
    source: SYSTEM_SOURCE,
    payload: { status: "thinking" },
  });
}
