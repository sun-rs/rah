import type {
  AttachClientDescriptor,
  AttachMode,
  ClientKind,
} from "@rah/runtime-protocol";
import type { EventBus } from "./event-bus";
import type { SessionStore, StoredSessionState } from "./session-store";

export const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

type RuntimeSessionEventDeps = {
  eventBus: EventBus;
  sessionStore: SessionStore;
};

type RuntimeSessionClient = Pick<AttachClientDescriptor, "id" | "kind" | "connectionId">;

export function attachClientAndPublish(
  deps: RuntimeSessionEventDeps,
  args: {
    sessionId: string;
    client: RuntimeSessionClient;
    mode: AttachMode;
    focus?: boolean;
  },
): StoredSessionState {
  const state = deps.sessionStore.attachClient({
    sessionId: args.sessionId,
    clientId: args.client.id,
    kind: args.client.kind,
    connectionId: args.client.connectionId,
    attachMode: args.mode,
    focus: args.focus ?? true,
  });
  deps.eventBus.publish({
    sessionId: args.sessionId,
    type: "session.attached",
    source: SYSTEM_SOURCE,
    payload: {
      clientId: args.client.id,
      clientKind: args.client.kind,
    },
  });
  return state;
}

export function ensureClientAttachedAndPublish(
  deps: RuntimeSessionEventDeps,
  args: {
    sessionId: string;
    client: RuntimeSessionClient;
    mode: AttachMode;
    focus?: boolean;
  },
): StoredSessionState | undefined {
  if (!deps.sessionStore.getSession(args.sessionId)) {
    return undefined;
  }
  if (!deps.sessionStore.hasAttachedClient(args.sessionId, args.client.id)) {
    return attachClientAndPublish(deps, args);
  }
  return deps.sessionStore.getSession(args.sessionId);
}

export function claimClientControlAndPublish(
  deps: RuntimeSessionEventDeps,
  args: {
    sessionId: string;
    clientId: string;
    clientKind: ClientKind;
  },
): StoredSessionState {
  const state = deps.sessionStore.claimControl(args.sessionId, args.clientId, args.clientKind);
  deps.eventBus.publish({
    sessionId: args.sessionId,
    type: "control.claimed",
    source: SYSTEM_SOURCE,
    payload: {
      clientId: args.clientId,
      clientKind: args.clientKind,
    },
  });
  return state;
}

export function attachClientAndMaybeClaimControl(
  deps: RuntimeSessionEventDeps,
  args: {
    sessionId: string;
    client: RuntimeSessionClient;
    mode: AttachMode;
    claimControl?: boolean;
  },
): StoredSessionState {
  const state = attachClientAndPublish(deps, args);
  if (args.claimControl) {
    claimClientControlAndPublish(deps, {
      sessionId: args.sessionId,
      clientId: args.client.id,
      clientKind: args.client.kind,
    });
  }
  return state;
}

export function publishSessionCreatedAndStarted(
  deps: RuntimeSessionEventDeps,
  sessionId: string,
): void {
  const state = deps.sessionStore.getSession(sessionId);
  if (!state) {
    return;
  }
  deps.eventBus.publish({
    sessionId,
    type: "session.created",
    source: SYSTEM_SOURCE,
    payload: { session: state.session },
  });
  deps.eventBus.publish({
    sessionId,
    type: "session.started",
    source: SYSTEM_SOURCE,
    payload: { session: state.session },
  });
}

export function publishSessionStarted(
  deps: RuntimeSessionEventDeps,
  sessionId: string,
): void {
  const state = deps.sessionStore.getSession(sessionId);
  if (!state) {
    return;
  }
  deps.eventBus.publish({
    sessionId,
    type: "session.started",
    source: SYSTEM_SOURCE,
    payload: { session: state.session },
  });
}

export function publishSessionStateChanged(
  deps: RuntimeSessionEventDeps,
  sessionId: string,
  state: "starting" | "idle" | "running" | "stopped" | "failed",
): void {
  deps.eventBus.publish({
    sessionId,
    type: "session.state.changed",
    source: SYSTEM_SOURCE,
    payload: { state },
  });
}
