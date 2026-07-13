import type { ManagedSession, SessionSideLifecycleState } from "@rah/runtime-protocol";
import type { EventBus } from "./event-bus";
import type { SessionStore } from "./session-store";

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

type SideLifecycleDeps = {
  eventBus: EventBus;
  sessionStore: SessionStore;
};

export function isSideSession(session: ManagedSession): boolean {
  return session.relationship?.kind === "side" && session.relationship.persistence === "ephemeral";
}

export function setSessionSideLifecycleState(
  deps: SideLifecycleDeps,
  sessionId: string,
  state: SessionSideLifecycleState,
  detail?: string,
): boolean {
  const current = deps.sessionStore.getSession(sessionId);
  if (!current || !isSideSession(current.session)) {
    return false;
  }
  const relationship = current.session.relationship!;
  const { sideStateDetail: _previousDetail, ...relationshipWithoutDetail } = relationship;
  const normalizedDetail = detail?.trim() || undefined;
  if (
    relationship.sideState === state &&
    relationship.sideStateDetail === normalizedDetail
  ) {
    return false;
  }
  deps.sessionStore.patchManagedSession(sessionId, {
    relationship: {
      ...relationshipWithoutDetail,
      sideState: state,
      ...(normalizedDetail ? { sideStateDetail: normalizedDetail } : {}),
    },
  });
  deps.eventBus.publish({
    sessionId,
    type: "session.side.state.changed",
    source: SYSTEM_SOURCE,
    payload: {
      state,
      ...(normalizedDetail ? { detail: normalizedDetail } : {}),
    },
  });
  return true;
}
