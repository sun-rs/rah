import type {
  AttachSessionRequest,
  PermissionResponseRequest,
  SessionSummary,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import * as api from "./api";
import { readErrorMessage } from "./session-store-bootstrap";
import {
  applyAttachedSessionState,
  applyClosedSessionState,
} from "./session-store-session-lifecycle";
import { updateSessionSummaryInProjectionMap } from "./session-store-projections";
import {
  appendOptimisticUserMessage,
  type SessionProjection,
} from "./types";

type SessionCommandState = {
  clientId: string;
  connectionId: string;
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  hiddenWorkspaceDirs: Set<string>;
  workspaceDirs: string[];
  workspaceVisibilityVersion: number;
  workspaceDir: string;
  selectedSessionId: string | null;
  newSessionProvider: "codex" | "claude" | "kimi" | "gemini" | "opencode";
  pendingSessionTransition: {
    kind: "new" | "history" | "claim_history";
    provider: StoredSessionRef["provider"];
    title?: string;
    cwd?: string;
  } | null;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "claim_history";
        sessionId: string;
      }
    | null;
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  error: string | null;
};

type SessionCommandSetState = (
  partial:
    | Partial<SessionCommandState>
    | ((state: SessionCommandState) => Partial<SessionCommandState> | SessionCommandState),
) => void;

export function createInteractiveAttachRequest(
  clientId: string,
  connectionId: string,
): AttachSessionRequest {
  return {
    client: {
      id: clientId,
      kind: "web",
      connectionId,
    },
    mode: "interactive",
    claimControl: true,
  };
}

export function createObserveAttachRequest(
  clientId: string,
  connectionId: string,
): AttachSessionRequest {
  return {
    client: {
      id: clientId,
      kind: "web",
      connectionId,
    },
    mode: "observe",
  };
}

export async function attachSessionCommand(args: {
  get: () => SessionCommandState;
  set: SessionCommandSetState;
  summary: SessionSummary;
  ensureSessionHistoryLoaded: (sessionId: string) => Promise<void>;
}) {
  try {
    args.set({
      pendingSessionAction: {
        kind: "attach_session",
        sessionId: args.summary.session.id,
      },
      error: null,
    });
    const response = await api.attachSession(
      args.summary.session.id,
      createObserveAttachRequest(args.get().clientId, args.get().connectionId),
    );
    args.set((state) => ({
      projections: updateSessionSummaryInProjectionMap(state.projections, response.session),
    }));
    args.set((state) => applyAttachedSessionState(state, response.session, args.summary));
    void args.ensureSessionHistoryLoaded(args.summary.session.id);
  } catch (error) {
    args.set({ pendingSessionAction: null, error: readErrorMessage(error) });
    throw error;
  }
}

export async function closeSessionCommand(args: {
  get: () => SessionCommandState;
  set: SessionCommandSetState;
  sessionId: string;
  refreshWorkbenchState: () => Promise<void>;
}) {
  try {
    const projection = args.get().projections.get(args.sessionId);
    const summary = projection?.summary ?? null;
    await api.closeSession(args.sessionId, {
      clientId: args.get().clientId,
    });
    args.set((state) => applyClosedSessionState(state, args.sessionId, summary));
    await args.refreshWorkbenchState();
  } catch (error) {
    args.set({ error: readErrorMessage(error) });
    throw error;
  }
}

export async function renameSessionCommand(args: {
  set: SessionCommandSetState;
  sessionId: string;
  title: string;
  refreshWorkbenchState: () => Promise<void>;
}) {
  try {
    const summary = await api.renameSession(args.sessionId, { title: args.title });
    args.set((state) => ({
      projections: updateSessionSummaryInProjectionMap(state.projections, summary),
      error: null,
    }));
    await args.refreshWorkbenchState();
  } catch (error) {
    args.set({ error: readErrorMessage(error) });
    throw error;
  }
}

export async function claimControlCommand(args: {
  get: () => SessionCommandState;
  set: SessionCommandSetState;
  sessionId: string;
}) {
  try {
    args.set({
      pendingSessionAction: {
        kind: "claim_control",
        sessionId: args.sessionId,
      },
      error: null,
    });
    const summary = await api.claimControl(
      args.sessionId,
      args.get().clientId,
      args.get().connectionId,
    );
    args.set((state) => ({
      projections: updateSessionSummaryInProjectionMap(state.projections, summary),
      pendingSessionAction: null,
      error: null,
    }));
  } catch (error) {
    args.set({ pendingSessionAction: null, error: readErrorMessage(error) });
    throw error;
  }
}

export async function releaseControlCommand(args: {
  get: () => SessionCommandState;
  set: SessionCommandSetState;
  sessionId: string;
}) {
  try {
    const summary = await api.releaseControl(args.sessionId, args.get().clientId);
    args.set((state) => ({
      projections: updateSessionSummaryInProjectionMap(state.projections, summary),
      error: null,
    }));
  } catch (error) {
    args.set({ error: readErrorMessage(error) });
    throw error;
  }
}

export async function interruptSessionCommand(args: {
  get: () => SessionCommandState;
  set: SessionCommandSetState;
  sessionId: string;
}) {
  try {
    const summary = await api.interruptSession(args.sessionId, args.get().clientId);
    args.set((state) => ({
      projections: updateSessionSummaryInProjectionMap(state.projections, summary),
      error: null,
    }));
  } catch (error) {
    args.set({ error: readErrorMessage(error) });
    throw error;
  }
}

export async function sendInputCommand(args: {
  get: () => SessionCommandState;
  set: SessionCommandSetState;
  sessionId: string;
  text: string;
}) {
  try {
    args.set((state) => {
      const projection = state.projections.get(args.sessionId);
      if (!projection) {
        return state;
      }
      const next = new Map(state.projections);
      next.set(args.sessionId, appendOptimisticUserMessage(projection, args.text));
      return { projections: next };
    });
    await api.sendSessionInput(args.sessionId, {
      clientId: args.get().clientId,
      text: args.text,
    });
    args.set({ error: null });
  } catch (error) {
    args.set({ error: readErrorMessage(error) });
    throw error;
  }
}

export async function respondToPermissionCommand(args: {
  set: SessionCommandSetState;
  sessionId: string;
  requestId: string;
  response: PermissionResponseRequest;
}) {
  try {
    await api.respondToPermission(args.sessionId, args.requestId, args.response);
    args.set({ error: null });
  } catch (error) {
    args.set({ error: readErrorMessage(error) });
    throw error;
  }
}
