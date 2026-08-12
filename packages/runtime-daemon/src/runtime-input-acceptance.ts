import { randomUUID } from "node:crypto";
import type { SessionInputRequest, SessionSummary } from "@rah/runtime-protocol";
import type { EventBus } from "./event-bus";
import type { SessionStore } from "./session-store";
import { SYSTEM_SOURCE } from "./runtime-session-events";

type InitialSessionInputRuntime = {
  readonly sessionStore: SessionStore;
  sendInput: (sessionId: string, request: SessionInputRequest) => void;
  getSessionSummary: (sessionId: string) => SessionSummary;
};

export type InitialSessionInputAcceptor = <T extends { session: SessionSummary }>(
  response: T,
  initialInput: SessionInputRequest | undefined,
) => Promise<T>;

/**
 * A start/resume response is not a delivery receipt. Retain ownership until
 * the exact first input leaves the canonical queue, which is the provider
 * adapter's acceptance boundary.
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
    runtime.sendInput(sessionId, ownedInput);

    const clientMessageId = ownedInput.clientMessageId;
    const deadline = Date.now() + 90_000;
    while (true) {
      const state = runtime.sessionStore.getSession(sessionId);
      if (!state) {
        throw new Error("Session closed before the initial question was accepted.");
      }
      const queued = state.session.inputQueue?.find(
        (item) => item.clientMessageId === clientMessageId,
      );
      if (!queued) {
        break;
      }
      if (state.session.runtimeState === "failed") {
        throw new Error(
          state.session.runtimeDiagnostics?.lastError ??
            "The provider rejected the initial question.",
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for the provider to accept the initial question; RAH kept it in the Session input queue.",
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return {
      ...response,
      session: runtime.getSessionSummary(sessionId),
    };
  };
}

export function markAcceptedSessionInput(
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
