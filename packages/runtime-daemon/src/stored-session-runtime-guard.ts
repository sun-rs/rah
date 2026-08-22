import type { ProviderKind } from "@rah/runtime-protocol";
import type { SessionStore } from "./session-store";
import { isReadOnlyReplaySession } from "./workbench-directory-utils";

export function requireStoredSessionClosed(
  sessionStore: SessionStore,
  provider: ProviderKind,
  providerSessionId: string,
  operation: "archive" | "delete" | "restore",
  allowedReadOnlyReplaySessionId?: string,
): void {
  const managed = sessionStore.listSessions().find(
    (state) =>
      state.session.provider === provider &&
      state.session.providerSessionId === providerSessionId,
  );
  if (
    !managed ||
    (operation === "archive" &&
      managed.session.id === allowedReadOnlyReplaySessionId &&
      isReadOnlyReplaySession(managed))
  ) {
    return;
  }
  throw new Error(
    `Close session ${managed.session.id} before attempting to ${operation} its provider history.`,
  );
}
