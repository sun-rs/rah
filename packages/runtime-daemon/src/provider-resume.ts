import type { ManagedSession, ResumeSessionRequest, ResumeSessionResponse } from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { toSessionSummary, type StoredSessionState } from "./session-store";

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

function isReplaceableProviderReplay(args: {
  existing: StoredSessionState;
  preferStoredReplay: boolean | undefined;
  historySourceSessionId?: string | undefined;
  rehydratedSessionIds: Set<string>;
}): boolean {
  if (args.preferStoredReplay) {
    return false;
  }
  const isReplaceableHistorySource =
    args.historySourceSessionId === args.existing.session.id &&
    args.existing.session.capabilities.steerInput === false;
  const isReplaceableStoredHistory =
    args.existing.session.runtime?.kind === "stored_history";
  return (
    args.rehydratedSessionIds.has(args.existing.session.id) ||
    isReplaceableHistorySource ||
    isReplaceableStoredHistory
  );
}

export function reuseExistingProviderSessionForResume(args: {
  services: RuntimeServices;
  provider: ManagedSession["provider"];
  providerSessionId: string;
  preferStoredReplay: boolean | undefined;
  historySourceSessionId?: string | undefined;
  rehydratedSessionIds: Set<string>;
  attach?: ResumeSessionRequest["attach"] | undefined;
}): ResumeSessionResponse | null {
  const existing = args.services.sessionStore.findManagedByProviderSession(
    args.provider,
    args.providerSessionId,
  );
  if (!existing) {
    return null;
  }
  if (isReplaceableProviderReplay({ ...args, existing })) {
    return null;
  }
  if (args.attach) {
    args.services.sessionStore.attachClient({
      sessionId: existing.session.id,
      clientId: args.attach.client.id,
      kind: args.attach.client.kind,
      connectionId: args.attach.client.connectionId,
      attachMode: args.attach.mode,
      focus: true,
    });
    args.services.eventBus.publish({
      sessionId: existing.session.id,
      type: "session.attached",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: args.attach.client.id,
        clientKind: args.attach.client.kind,
      },
    });
    if (args.attach.claimControl) {
      args.services.sessionStore.claimControl(
        existing.session.id,
        args.attach.client.id,
        args.attach.client.kind,
      );
      args.services.eventBus.publish({
        sessionId: existing.session.id,
        type: "control.claimed",
        source: SYSTEM_SOURCE,
        payload: {
          clientId: args.attach.client.id,
          clientKind: args.attach.client.kind,
        },
      });
    }
  }
  const state = args.services.sessionStore.getSession(existing.session.id);
  return state ? { session: toSessionSummary(state) } : null;
}

export function prepareProviderSessionResume(args: {
  services: RuntimeServices;
  provider: ManagedSession["provider"];
  providerSessionId: string;
  preferStoredReplay: boolean | undefined;
  historySourceSessionId?: string | undefined;
  rehydratedSessionIds: Set<string>;
}): { rollback: () => void } {
  const existing = args.services.sessionStore.findManagedByProviderSession(
    args.provider,
    args.providerSessionId,
  );
  if (!existing) {
    return { rollback: () => undefined };
  }
  if (isReplaceableProviderReplay({ ...args, existing })) {
    const removed = existing;
    args.rehydratedSessionIds.delete(existing.session.id);
    args.services.sessionStore.removeSession(existing.session.id);
    args.services.ptyHub.removeSession(existing.session.id);
    args.services.eventBus.publish({
      sessionId: existing.session.id,
      type: "session.closed",
      source: SYSTEM_SOURCE,
      payload: {},
    });
    return {
      rollback: () => restoreRemovedReplaySession(args, removed),
    };
  }
  throw new Error(
    `Provider session ${args.provider}:${args.providerSessionId} is already running; attach instead of resume.`,
  );
}

function restoreRemovedReplaySession(
  args: {
    services: RuntimeServices;
    provider: ManagedSession["provider"];
    providerSessionId: string;
    rehydratedSessionIds: Set<string>;
  },
  removed: StoredSessionState,
): void {
  if (args.services.sessionStore.getSession(removed.session.id)) {
    return;
  }
  if (
    args.services.sessionStore.findManagedByProviderSession(
      args.provider,
      args.providerSessionId,
    )
  ) {
    return;
  }
  const restored = args.services.sessionStore.restoreSession(removed);
  args.rehydratedSessionIds.add(restored.session.id);
  args.services.eventBus.publish({
    sessionId: restored.session.id,
    type: "session.created",
    source: SYSTEM_SOURCE,
    payload: { session: restored.session },
  });
  args.services.eventBus.publish({
    sessionId: restored.session.id,
    type: "session.started",
    source: SYSTEM_SOURCE,
    payload: { session: restored.session },
  });
}

export function finalizeStoredReplayResume(args: {
  services: RuntimeServices;
  provider: ManagedSession["provider"];
  providerSessionId: string;
  rehydratedSessionIds: Set<string>;
  createSession: () => { sessionId: string };
}): ResumeSessionResponse {
  const { sessionId } = args.createSession();
  args.rehydratedSessionIds.add(sessionId);
  const state = args.services.sessionStore.getSession(sessionId);
  if (!state) {
    throw new Error(`Failed to load ${args.provider} session ${args.providerSessionId}.`);
  }
  return {
    session: toSessionSummary(state),
  };
}
