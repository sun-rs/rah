import type { ProviderKind } from "@rah/runtime-protocol";
import type { SessionStore } from "./session-store";

export function requireStoredSessionClosed(
  sessionStore: SessionStore,
  provider: ProviderKind,
  providerSessionId: string,
  operation: "archive" | "delete" | "restore",
): void {
  const managed = sessionStore.listSessions().find(
    (state) =>
      state.session.provider === provider &&
      state.session.providerSessionId === providerSessionId,
  );
  if (!managed) {
    return;
  }
  throw new Error(
    `Close session ${managed.session.id} before attempting to ${operation} its provider history.`,
  );
}
