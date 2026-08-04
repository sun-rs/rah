import type {
  AttachSessionRequest,
  PermissionResponseRequest,
  SessionInputAttachment,
  SessionInputAnnotation,
  SessionSummary,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import { conversationStateFromRuntimeState } from "@rah/runtime-protocol";
import * as api from "./api";
import { readErrorMessage } from "./session-store-bootstrap";
import {
  applyAttachedSessionState,
  applyClosedSessionState,
} from "./session-store-session-lifecycle";
import { updateSessionSummaryInProjectionMap } from "./session-store-projections";
import {
  appendOptimisticUserMessage,
  markPendingInterruptIntent,
  removeOptimisticUserMessage,
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
  sessionTopologyVersion: number;
  workspaceDir: string;
  selectedSessionId: string | null;
  newSessionProvider: "codex" | "claude" | "opencode";
  pendingSessionTransition: {
    kind: "new" | "history" | "resume_history";
    provider: StoredSessionRef["provider"];
    title?: string;
    cwd?: string;
  } | null;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "resume_history";
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

const sessionTransportCommandTails = new Map<string, Promise<void>>();

export async function serializeSessionTransportCommand<T>(
  sessionId: string,
  command: () => Promise<T>,
): Promise<T> {
  const previous = sessionTransportCommandTails.get(sessionId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(command);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  sessionTransportCommandTails.set(sessionId, tail);
  void tail.finally(() => {
    if (sessionTransportCommandTails.get(sessionId) === tail) {
      sessionTransportCommandTails.delete(sessionId);
    }
  });
  return await result;
}

export function createClientSideId(prefix: string): string {
  const randomUUID =
    typeof globalThis.crypto === "object" &&
    typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${randomUUID}`;
}

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
  ensureConversationLoaded: (sessionId: string) => Promise<void>;
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
    void args.ensureConversationLoaded(args.summary.session.id);
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
    void args.refreshWorkbenchState().catch((error) => {
      console.warn("[rah] stopped session metadata refresh failed", {
        sessionId: args.sessionId,
        error: readErrorMessage(error),
      });
    });
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

export async function setSessionModeCommand(args: {
  set: SessionCommandSetState;
  sessionId: string;
  modeId: string;
}) {
  try {
    const summary = await api.setSessionMode(args.sessionId, { modeId: args.modeId });
    args.set((state) => ({
      projections: updateSessionSummaryInProjectionMap(state.projections, summary),
      error: null,
    }));
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
    args.set((state) => {
      const projection = state.projections.get(args.sessionId);
      if (!projection) {
        return state;
      }
      const projections = new Map(state.projections);
      projections.set(args.sessionId, markPendingInterruptIntent(projection));
      return { projections };
    });
    const summary = await serializeSessionTransportCommand(args.sessionId, () =>
      api.interruptSession(args.sessionId, args.get().clientId),
    );
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
  attachments?: SessionInputAttachment[];
  annotations?: SessionInputAnnotation[];
  clientMessageId?: string;
  clientTurnId?: string;
  skipOptimisticQueue?: boolean;
}) {
  const previousProjection = args.get().projections.get(args.sessionId);
  const previousRuntimeState = previousProjection?.summary.session.runtimeState;
  const previousRuntimeStatus = previousProjection?.currentRuntimeStatus;
  const clientTurnId = args.clientTurnId ?? createClientSideId("client-turn");
  const clientMessageId = args.clientMessageId ?? createClientSideId("client-message");
  const inputWasAlreadyOptimistic = previousProjection?.feed.some(
    (entry) =>
      entry.kind === "timeline" &&
      entry.key.startsWith("optimistic:user:") &&
      entry.item.kind === "user_message" &&
      entry.item.clientMessageId === clientMessageId,
  ) ?? false;
  try {
    args.set((state) => {
      const projection = state.projections.get(args.sessionId);
      if (!projection) {
        return state;
      }
      const next = new Map(state.projections);
      const imageCount = args.attachments?.filter(
        (attachment) => attachment.kind === "image",
      ).length;
      const shouldQueueOptimistically =
        args.skipOptimisticQueue !== true &&
        projection.summary.session.capabilities.queuedInput === true &&
        (["starting", "working", "waiting_input", "waiting_permission"].includes(
          projection.summary.session.phase,
        ) ||
          projection.currentRuntimeStatus === "thinking" ||
          projection.currentRuntimeStatus === "streaming" ||
          projection.currentRuntimeStatus === "retrying");
      const optimistic = !shouldQueueOptimistically &&
        shouldAppendTranscriptOptimisticUserMessage(projection)
        ? appendOptimisticUserMessage(projection, args.text, {
            clientMessageId,
            clientTurnId,
            ...(args.attachments?.length ? { attachments: args.attachments } : {}),
            ...(imageCount !== undefined ? { imageCount } : {}),
          })
        : projection;
      const now = new Date().toISOString();
      const currentInputQueue = optimistic.summary.session.inputQueue ?? [];
      const nextInputQueue = shouldQueueOptimistically
        ? [
            ...currentInputQueue,
            {
              clientMessageId,
              clientTurnId,
              text: args.text,
              ...(args.attachments?.length ? { attachments: args.attachments } : {}),
              ...(args.annotations?.length ? { annotations: args.annotations } : {}),
              queuedAt: now,
              position: currentInputQueue.length + 1,
            },
          ]
        : optimistic.summary.session.inputQueue;
      const nativeTui = optimistic.summary.session.nativeTui;
      const willQueueInNativeTui =
        nativeTui !== undefined && nativeTui.promptState !== "prompt_clean";
      const nextNativeTui =
        nativeTui && willQueueInNativeTui
          ? {
              ...nativeTui,
              queuedInputCount: (nativeTui.queuedInputCount ?? 0) + 1,
            }
          : nativeTui;
      next.set(args.sessionId, {
        ...optimistic,
        currentRuntimeStatus: "thinking" as const,
        summary: {
          ...optimistic.summary,
          session: {
            ...optimistic.summary.session,
            ...conversationStateFromRuntimeState("running"),
            runtimeState: "running",
            ...(nextNativeTui ? { nativeTui: nextNativeTui } : {}),
            ...(nextInputQueue ? { inputQueue: nextInputQueue } : {}),
            updatedAt: now,
          },
          controlLease: {
            sessionId: optimistic.summary.session.id,
            holderClientId: state.clientId,
            holderKind: "web",
            grantedAt: now,
          },
        },
      });
      return { projections: next };
    });
    await serializeSessionTransportCommand(args.sessionId, () =>
      api.sendSessionInput(args.sessionId, {
        clientId: args.get().clientId,
        text: args.text,
        ...(args.attachments?.length ? { attachments: args.attachments } : {}),
        ...(args.annotations?.length ? { annotations: args.annotations } : {}),
        clientMessageId,
        clientTurnId,
      }),
    );
    args.set({ error: null });
  } catch (error) {
    const message = readErrorMessage(error);
    args.set((state) => {
      const projection = state.projections.get(args.sessionId);
      if (!projection) {
        return { error: message };
      }
      const next = new Map(state.projections);
      const projectionAdvanced =
        previousProjection !== undefined && projection.lastSeq !== previousProjection.lastSeq;
      const baseRestored =
        previousProjection && !projectionAdvanced
          ? removeOptimisticUserMessage(previousProjection, args.text, clientMessageId)
          : removeOptimisticUserMessage(projection, args.text, clientMessageId);
      const restoredInputQueue = baseRestored.summary.session.inputQueue
        ?.filter((item) => item.clientMessageId !== clientMessageId)
        .map((item, index) => ({ ...item, position: index + 1 }));
      const restoredSession = projectionAdvanced
        ? { ...baseRestored.summary.session }
        : {
            ...baseRestored.summary.session,
            ...conversationStateFromRuntimeState(
              previousRuntimeState ?? baseRestored.summary.session.runtimeState,
            ),
            runtimeState: previousRuntimeState ?? baseRestored.summary.session.runtimeState,
          };
      if (restoredInputQueue?.length) {
        restoredSession.inputQueue = restoredInputQueue;
      } else {
        delete restoredSession.inputQueue;
      }
      const restored: SessionProjection = {
        ...baseRestored,
        summary: {
          ...baseRestored.summary,
          session: restoredSession,
        },
      };
      if (!projectionAdvanced) {
        if (previousRuntimeStatus === undefined || (args.skipOptimisticQueue && inputWasAlreadyOptimistic)) {
          delete restored.currentRuntimeStatus;
        } else {
          restored.currentRuntimeStatus = previousRuntimeStatus;
        }
      }
      next.set(args.sessionId, restored);
      return { projections: next, error: message };
    });
    throw error;
  }
}

export async function updateQueuedInputCommand(args: {
  get: () => SessionCommandState;
  set: SessionCommandSetState;
  sessionId: string;
  clientMessageId: string;
  text: string;
}) {
  try {
    await serializeSessionTransportCommand(args.sessionId, () =>
      api.updateQueuedSessionInput(args.sessionId, args.clientMessageId, {
        clientId: args.get().clientId,
        text: args.text,
      }),
    );
    args.set((state) => {
      const projection = state.projections.get(args.sessionId);
      if (!projection) {
        return { error: null };
      }
      const projections = new Map(state.projections);
      let nextProjection = projection;
      const inputQueue = nextProjection.summary.session.inputQueue;
      if (inputQueue?.some((item) => item.clientMessageId === args.clientMessageId)) {
        nextProjection = {
          ...nextProjection,
          summary: {
            ...nextProjection.summary,
            session: {
              ...nextProjection.summary.session,
              inputQueue: inputQueue.map((item) =>
                item.clientMessageId === args.clientMessageId
                  ? { ...item, text: args.text }
                  : item,
              ),
            },
          },
        };
      }
      projections.set(args.sessionId, nextProjection);
      return { projections, error: null };
    });
  } catch (error) {
    args.set({ error: readErrorMessage(error) });
    throw error;
  }
}

export async function deleteQueuedInputCommand(args: {
  get: () => SessionCommandState;
  set: SessionCommandSetState;
  sessionId: string;
  clientMessageId: string;
}) {
  try {
    await serializeSessionTransportCommand(args.sessionId, () =>
      api.deleteQueuedSessionInput(args.sessionId, args.clientMessageId, {
        clientId: args.get().clientId,
      }),
    );
    args.set((state) => {
      const projection = state.projections.get(args.sessionId);
      if (!projection) {
        return { error: null };
      }
      const projections = new Map(state.projections);
      let nextProjection = projection;
      const inputQueue = nextProjection.summary.session.inputQueue;
      if (inputQueue?.some((item) => item.clientMessageId === args.clientMessageId)) {
        nextProjection = {
          ...nextProjection,
          summary: {
            ...nextProjection.summary,
            session: {
              ...nextProjection.summary.session,
              inputQueue: inputQueue.filter(
                (item) => item.clientMessageId !== args.clientMessageId,
              ),
            },
          },
        };
      }
      projections.set(args.sessionId, nextProjection);
      return { projections, error: null };
    });
  } catch (error) {
    args.set({ error: readErrorMessage(error) });
    throw error;
  }
}

export async function reorderQueuedInputCommand(args: {
  get: () => SessionCommandState;
  set: SessionCommandSetState;
  sessionId: string;
  clientMessageId: string;
  position: number;
}) {
  const previousQueue = args.get().projections.get(args.sessionId)?.summary.session.inputQueue;
  args.set((state) => {
    const projection = state.projections.get(args.sessionId);
    const queue = projection?.summary.session.inputQueue;
    if (!projection || !queue) {
      return state;
    }
    const currentIndex = queue.findIndex(
      (item) => item.clientMessageId === args.clientMessageId,
    );
    if (currentIndex < 0) {
      return state;
    }
    const reordered = [...queue];
    const [item] = reordered.splice(currentIndex, 1);
    if (!item) {
      return state;
    }
    reordered.splice(Math.max(0, Math.min(reordered.length, args.position - 1)), 0, item);
    const projections = new Map(state.projections);
    projections.set(args.sessionId, {
      ...projection,
      summary: {
        ...projection.summary,
        session: {
          ...projection.summary.session,
          inputQueue: reordered.map((entry, index) => ({
            ...entry,
            position: index + 1,
          })),
        },
      },
    });
    return { projections };
  });
  try {
    const summary = await serializeSessionTransportCommand(args.sessionId, () =>
      api.reorderQueuedSessionInput(args.sessionId, args.clientMessageId, {
        clientId: args.get().clientId,
        position: args.position,
      }),
    );
    args.set((state) => ({
      projections: updateSessionSummaryInProjectionMap(state.projections, summary),
      error: null,
    }));
  } catch (error) {
    args.set((state) => {
      const projection = state.projections.get(args.sessionId);
      if (!projection || !previousQueue) {
        return { error: readErrorMessage(error) };
      }
      const projections = new Map(state.projections);
      projections.set(args.sessionId, {
        ...projection,
        summary: {
          ...projection.summary,
          session: { ...projection.summary.session, inputQueue: previousQueue },
        },
      });
      return { projections, error: readErrorMessage(error) };
    });
    throw error;
  }
}

export async function steerQueuedInputCommand(args: {
  get: () => SessionCommandState;
  set: SessionCommandSetState;
  sessionId: string;
  clientMessageId: string;
}) {
  const queuedInput = args.get().projections
    .get(args.sessionId)
    ?.summary.session.inputQueue?.find(
      (item) => item.clientMessageId === args.clientMessageId,
    );
  if (!queuedInput) {
    return;
  }
  args.set((state) => {
    const projection = state.projections.get(args.sessionId);
    if (!projection) {
      return state;
    }
    const imageCount = queuedInput.attachments?.filter(
      (attachment) => attachment.kind === "image",
    ).length;
    const optimistic = appendOptimisticUserMessage(projection, queuedInput.text, {
      clientMessageId: queuedInput.clientMessageId,
      ...(queuedInput.clientTurnId ? { clientTurnId: queuedInput.clientTurnId } : {}),
      ...(queuedInput.attachments?.length ? { attachments: queuedInput.attachments } : {}),
      ...(imageCount !== undefined ? { imageCount } : {}),
    });
    const projections = new Map(state.projections);
    projections.set(args.sessionId, {
      ...optimistic,
      summary: {
        ...optimistic.summary,
        session: {
          ...optimistic.summary.session,
          ...(optimistic.summary.session.inputQueue
            ? {
                inputQueue: optimistic.summary.session.inputQueue.map((item) =>
                  item.clientMessageId === args.clientMessageId
                    ? { ...item, state: "submitting" as const }
                    : item,
                ),
              }
            : {}),
        },
      },
    });
    return { projections };
  });
  try {
    const summary = await api.steerQueuedSessionInput(
      args.sessionId,
      args.clientMessageId,
      { clientId: args.get().clientId },
    );
    args.set((state) => ({
      projections: updateSessionSummaryInProjectionMap(state.projections, summary),
      error: null,
    }));
  } catch (error) {
    args.set((state) => {
      const projection = state.projections.get(args.sessionId);
      if (!projection) {
        return { error: readErrorMessage(error) };
      }
      const restored = removeOptimisticUserMessage(
        projection,
        queuedInput.text,
        queuedInput.clientMessageId,
      );
      const projections = new Map(state.projections);
      projections.set(args.sessionId, {
        ...restored,
        summary: {
          ...restored.summary,
          session: {
            ...restored.summary.session,
            ...(restored.summary.session.inputQueue
              ? {
                  inputQueue: restored.summary.session.inputQueue.map((item) =>
                    item.clientMessageId === args.clientMessageId
                      ? { ...item, state: "queued" as const }
                      : item,
                  ),
                }
              : {}),
          },
        },
      });
      return { projections, error: readErrorMessage(error) };
    });
    throw error;
  }
}

function shouldAppendTranscriptOptimisticUserMessage(projection: SessionProjection): boolean {
  void projection;
  return true;
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
