import type {
  DebugScenarioDescriptor,
  ResumeSessionRequest,
  SessionConfigValue,
  SessionSummary,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import * as api from "./api";
import { readErrorMessage } from "./session-store-bootstrap";
import {
  applyClaimedHistorySessionState,
  applyResumedStoredSessionState,
  applyStartedSessionState,
  buildFallbackStoredSessionRef,
  createEmptySessionProjection,
} from "./session-store-session-lifecycle";
import {
  createInteractiveAttachRequest,
  createObserveAttachRequest,
} from "./session-store-session-commands";
import type { PendingSessionTransition } from "./session-transition-contract";
import {
  createPendingScenarioTransition,
  createPendingStartTransition,
  createPendingStoredSessionTransition,
} from "./session-transition-contract";
import {
  findDaemonLiveSessionForStoredRef,
  resolveHistoryActivationMode,
} from "./session-store-workspace";
import { providerLabel, type SessionProjection } from "./types";

type ProviderChoice = "codex" | "claude" | "kimi" | "gemini" | "opencode";

type StartSessionOptions = {
  provider?: ProviderChoice;
  cwd?: string;
  title?: string;
  model?: string;
  optionValues?: Record<string, SessionConfigValue>;
  reasoningId?: string;
  modeId?: string;
  initialInput?: string;
};

type SessionStartupState = {
  clientId: string;
  connectionId: string;
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  hiddenWorkspaceDirs: Set<string>;
  workspaceDirs: string[];
  workspaceVisibilityVersion: number;
  workspaceDir: string;
  selectedSessionId: string | null;
  newSessionProvider: ProviderChoice;
  pendingSessionTransition: PendingSessionTransition | null;
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

type SessionStartupSetState = (
  partial:
    | Partial<SessionStartupState>
    | ((state: SessionStartupState) => Partial<SessionStartupState> | SessionStartupState),
) => void;

type SessionStartupDeps = {
  get: () => SessionStartupState;
  set: SessionStartupSetState;
  ensureSessionHistoryLoaded: (sessionId: string) => Promise<void>;
  sendInput: (sessionId: string, text: string) => Promise<void>;
  attachSession: (summary: SessionSummary) => Promise<void>;
  resumeStoredSession: (
    ref: StoredSessionRef,
    options?: { preferStoredReplay?: boolean; historyReplay?: "include" | "skip" },
  ) => Promise<void>;
  applySessionsResponse: (
    state: Pick<
      SessionStartupState,
      | "projections"
      | "workspaceDir"
      | "selectedSessionId"
      | "hiddenWorkspaceDirs"
      | "workspaceVisibilityVersion"
    >,
    sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
    options?: { workspaceVisibilityVersionAtRequest?: number },
  ) => Pick<
    SessionStartupState,
    | "projections"
    | "storedSessions"
    | "recentSessions"
    | "workspaceDirs"
    | "hiddenWorkspaceDirs"
    | "workspaceVisibilityVersion"
    | "workspaceDir"
    | "selectedSessionId"
  >;
  adoptExistingProjectionForProviderSession: (
    projections: Map<string, SessionProjection>,
    summary: SessionSummary,
  ) => Map<string, SessionProjection>;
  applyEventsToMap: (
    current: Map<string, SessionProjection>,
    events: import("@rah/runtime-protocol").RahEvent[],
  ) => Map<string, SessionProjection>;
  takePendingEventsForSessions: (sessionIds: Set<string>) => import("@rah/runtime-protocol").RahEvent[];
  confirmCreateMissingWorkspace: (dir: string) => Promise<boolean>;
};

export async function startSessionCommand(
  deps: SessionStartupDeps,
  options?: StartSessionOptions,
) {
  try {
    const state = deps.get();
    const cwd = options?.cwd?.trim() || state.workspaceDir.trim();
    if (!cwd) {
      deps.set({ error: "Choose a workspace directory first." });
      return;
    }
    const provider = options?.provider ?? state.newSessionProvider;
    deps.set({
      pendingSessionTransition: createPendingStartTransition({
        provider,
        cwd,
        ...(options?.title ? { title: options.title } : {}),
      }),
      error: null,
    });
    const initialInput = options?.initialInput?.trim();
    const response = await api.startSession({
      provider,
      cwd,
      title: options?.title ?? `${providerLabel(provider)} session`,
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.optionValues !== undefined ? { optionValues: options.optionValues } : {}),
      ...(options?.reasoningId ? { reasoningId: options.reasoningId } : {}),
      ...(options?.modeId ? { modeId: options.modeId } : {}),
      attach: createInteractiveAttachRequest(state.clientId, state.connectionId),
    });
    const session =
      options?.modeId &&
      response.session.session.mode?.mutable &&
      response.session.session.mode.currentModeId !== options.modeId
        ? await api.setSessionMode(response.session.session.id, { modeId: options.modeId })
        : response.session;
    deps.set((current) => {
      const next = deps.adoptExistingProjectionForProviderSession(
        new Map(current.projections),
        session,
      );
      const startedState = applyStartedSessionState(current, session, {
        cwd,
        provider,
        projections: next,
      });
      return {
        ...startedState,
        projections: deps.applyEventsToMap(
          startedState.projections ?? next,
          deps.takePendingEventsForSessions(new Set([session.session.id])),
        ),
      };
    });
    if (initialInput) {
      await deps.sendInput(session.session.id, initialInput);
    }
    void deps.ensureSessionHistoryLoaded(session.session.id);
  } catch (error) {
    deps.set({ pendingSessionTransition: null, error: readErrorMessage(error) });
    throw error;
  }
}

export async function startScenarioCommand(
  deps: SessionStartupDeps,
  scenario: DebugScenarioDescriptor,
) {
  try {
    deps.set({
      pendingSessionTransition: createPendingScenarioTransition(scenario),
      error: null,
    });
    const response = await api.startDebugScenario({
      scenarioId: scenario.id,
      attach: createInteractiveAttachRequest(deps.get().clientId, deps.get().connectionId),
    });
    deps.set((current) => {
      const next = new Map(current.projections);
      return applyStartedSessionState(current, response.session, {
        cwd: scenario.rootDir,
        projections: next,
      });
    });
    void deps.ensureSessionHistoryLoaded(response.session.session.id);
  } catch (error) {
    deps.set({ pendingSessionTransition: null, error: readErrorMessage(error) });
    throw error;
  }
}

export async function activateHistorySessionCommand(
  deps: SessionStartupDeps,
  ref: StoredSessionRef,
) {
  const state = deps.get();
  const existingLive = findDaemonLiveSessionForStoredRef(state.projections, ref);
  const mode = resolveHistoryActivationMode({
    existingLiveSummary: existingLive,
    clientId: state.clientId,
  });
  if (mode === "select" && existingLive) {
    deps.set({ selectedSessionId: existingLive.session.id });
    void deps.ensureSessionHistoryLoaded(existingLive.session.id);
    return;
  }
  if (mode === "attach" && existingLive) {
    await deps.attachSession(existingLive);
    return;
  }
  await deps.resumeStoredSession(ref, { preferStoredReplay: true });
}

export async function resumeStoredSessionCommand(
  deps: SessionStartupDeps,
  ref: StoredSessionRef,
  options?: { preferStoredReplay?: boolean; historyReplay?: "include" | "skip" },
) {
  try {
    deps.set({
      pendingSessionTransition: createPendingStoredSessionTransition(ref, "history"),
      error: null,
    });
    if (ref.source === "previous_live") {
      const workspaceVisibilityVersionAtRequest = deps.get().workspaceVisibilityVersion;
      const sessionsResponse = await api.listSessions();
      const running = sessionsResponse.sessions.find(
        (summary) =>
          summary.session.provider === ref.provider &&
          summary.session.providerSessionId === ref.providerSessionId,
      );
      if (running) {
        deps.set((state) => ({
          ...deps.applySessionsResponse(state, sessionsResponse, {
            workspaceVisibilityVersionAtRequest,
          }),
          workspaceDir:
            ref.rootDir ??
            ref.cwd ??
            running.session.rootDir ??
            running.session.cwd ??
            state.workspaceDir,
          pendingSessionTransition: state.pendingSessionTransition,
          error: null,
        }));
        await deps.attachSession(running);
        deps.set({ pendingSessionTransition: null });
        return;
      }
    }

    const request: ResumeSessionRequest = {
      provider: ref.provider,
      providerSessionId: ref.providerSessionId,
      preferStoredReplay: options?.preferStoredReplay ?? true,
      attach: createObserveAttachRequest(deps.get().clientId, deps.get().connectionId),
    };
    if (options?.historyReplay !== undefined) {
      request.historyReplay = options.historyReplay;
    }
    if (ref.cwd !== undefined) {
      request.cwd = ref.cwd;
    }
    const response = await api.resumeSession(request);
    deps.set((current) => {
      const next = deps.adoptExistingProjectionForProviderSession(
        new Map(current.projections),
        response.session,
      );
      const resumedState = applyResumedStoredSessionState(
        current,
        response.session,
        ref,
        {
          projections: next,
          replayProjection: createEmptySessionProjection(response.session),
        },
      );
      return {
        ...resumedState,
        projections: deps.applyEventsToMap(
          resumedState.projections ?? next,
          deps.takePendingEventsForSessions(new Set([response.session.session.id])),
        ),
      };
    });
    void deps.ensureSessionHistoryLoaded(response.session.session.id);
  } catch (error) {
    const message = readErrorMessage(error);
    if (message.includes("attach instead of resume")) {
      const workspaceVisibilityVersionAtRequest = deps.get().workspaceVisibilityVersion;
      const sessionsResponse = await api.listSessions();
      const running = sessionsResponse.sessions.find(
        (summary) =>
          summary.session.provider === ref.provider &&
          summary.session.providerSessionId === ref.providerSessionId,
      );
      if (running) {
        deps.set((state) => {
          const next = deps.applySessionsResponse(state, sessionsResponse, {
            workspaceVisibilityVersionAtRequest,
          });
          return {
            ...next,
            workspaceDir:
              ref.rootDir ??
              ref.cwd ??
              running.session.rootDir ??
              running.session.cwd ??
              next.workspaceDir,
            error: null,
          };
        });
        await deps.attachSession(running);
        deps.set({ pendingSessionTransition: null });
        return;
      }
    }
    deps.set({ pendingSessionTransition: null, error: message });
    throw error;
  }
}

export async function claimHistorySessionCommand(
  deps: SessionStartupDeps,
  sessionId: string,
  options?: {
    modeId?: string;
    modelId?: string;
    optionValues?: Record<string, SessionConfigValue>;
    reasoningId?: string | null;
  },
) {
  const state = deps.get();
  const projection = state.projections.get(sessionId);
  const summary = projection?.summary;
  const providerSessionId = summary?.session.providerSessionId;
  if (!projection || !summary || !providerSessionId) {
    const error = "Only persisted provider sessions can be claimed from history.";
    deps.set({ error });
    throw new Error(error);
  }

  const ref = buildFallbackStoredSessionRef(summary, state.recentSessions, state.storedSessions);
  if (!ref) {
    const error = "Only persisted provider sessions can be claimed from history.";
    deps.set({ error });
    throw new Error(error);
  }

  const preservedProjection: SessionProjection = {
    ...projection,
    summary,
  };

  const targetDir = ref.rootDir ?? ref.cwd ?? null;
  if (targetDir) {
    try {
      await api.listDirectory(targetDir);
    } catch {
      const shouldCreate = await deps.confirmCreateMissingWorkspace(targetDir);
      if (!shouldCreate) {
        return;
      }
      await api.ensureDirectory({ dir: targetDir });
    }
  }

  try {
    deps.set({
      pendingSessionAction: {
        kind: "claim_history",
        sessionId,
      },
      pendingSessionTransition: createPendingStoredSessionTransition(ref, "claim_history"),
      error: null,
    });
    const request: ResumeSessionRequest = {
      provider: ref.provider,
      providerSessionId: ref.providerSessionId,
      ...(options?.modelId ? { model: options.modelId } : {}),
      ...(options?.optionValues !== undefined ? { optionValues: options.optionValues } : {}),
      ...(options?.modelId && options.reasoningId !== undefined
        ? { reasoningId: options.reasoningId }
        : {}),
      ...(options?.modeId ? { modeId: options.modeId } : {}),
      preferStoredReplay: false,
      historyReplay: "skip",
      historySourceSessionId: sessionId,
      attach: createInteractiveAttachRequest(state.clientId, state.connectionId),
    };
    if (ref.cwd !== undefined) {
      request.cwd = ref.cwd;
    }
    const response = await api.resumeSession(request);
    let session = response.session;
    if (
      options?.modeId &&
      session.session.mode?.mutable &&
      session.session.mode.currentModeId !== options.modeId
    ) {
      session = await api.setSessionMode(session.session.id, { modeId: options.modeId });
    }
    if (
      options?.modelId &&
      session.session.model?.mutable &&
      (session.session.model.currentModelId !== options.modelId ||
        options.optionValues !== undefined ||
        (options.reasoningId !== undefined &&
          session.session.model.currentReasoningId !== options.reasoningId))
    ) {
      session = await api.setSessionModel(session.session.id, {
        modelId: options.modelId,
        ...(options.optionValues !== undefined ? { optionValues: options.optionValues } : {}),
        ...(options.reasoningId !== undefined ? { reasoningId: options.reasoningId } : {}),
      });
    }
    deps.set((current) => {
      const next = new Map(current.projections);
      const claimedState = applyClaimedHistorySessionState(
        current,
        session,
        sessionId,
        preservedProjection,
        ref,
        next,
      );
      return {
        ...claimedState,
        projections: deps.applyEventsToMap(
          claimedState.projections ?? next,
          deps.takePendingEventsForSessions(new Set([session.session.id])),
        ),
      };
    });
  } catch (error) {
    deps.set({
      pendingSessionAction: null,
      pendingSessionTransition: null,
      error: readErrorMessage(error),
    });
    throw error;
  }
}
