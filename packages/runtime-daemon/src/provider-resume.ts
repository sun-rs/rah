import type { ManagedSession, ResumeSessionResponse } from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { toSessionSummary } from "./session-store";

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

export function prepareProviderSessionResume(args: {
  services: RuntimeServices;
  provider: ManagedSession["provider"];
  providerSessionId: string;
  preferStoredReplay: boolean | undefined;
  rehydratedSessionIds: Set<string>;
}): void {
  const existing = args.services.sessionStore.findManagedByProviderSession(
    args.provider,
    args.providerSessionId,
  );
  if (!existing) {
    return;
  }
  if (!args.preferStoredReplay && args.rehydratedSessionIds.has(existing.session.id)) {
    args.rehydratedSessionIds.delete(existing.session.id);
    args.services.sessionStore.removeSession(existing.session.id);
    args.services.ptyHub.removeSession(existing.session.id);
    args.services.eventBus.publish({
      sessionId: existing.session.id,
      type: "session.closed",
      source: SYSTEM_SOURCE,
      payload: {},
    });
    return;
  }
  throw new Error(
    `Provider session ${args.provider}:${args.providerSessionId} is already running; attach instead of resume.`,
  );
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
