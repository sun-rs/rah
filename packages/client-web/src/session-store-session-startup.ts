import type {
  CoreLiveProvider,
  DebugScenarioDescriptor,
  ResumeSessionRequest,
  SessionConfigValue,
  SessionSummary,
  StartSessionRequest,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import {
  defaultLiveBackendForProvider,
  isCoreLiveProvider,
} from "@rah/runtime-protocol";
import * as api from "./api";
import { isReadOnlyReplay } from "./session-capabilities";
import { readErrorMessage } from "./session-store-bootstrap";
import {
  applyClaimedHistorySessionState,
  applyResumedStoredSessionState,
  applyStartedSessionState,
  buildFallbackStoredSessionRef,
  createEmptySessionProjection,
  createStoredHistoryReplayProjection,
} from "./session-store-session-lifecycle";
import {
  createInteractiveAttachRequest,
  createObserveAttachRequest,
} from "./session-store-session-commands";
import type { PendingSessionTransition } from "./session-transition-contract";
import {
  createPendingScenarioTransition,
  createPendingStartTransition,
} from "./session-transition-contract";
import {
  findDaemonReplaySessionForStoredRef,
  findDaemonRunningSessionForStoredRef,
  resolveHistoryActivationMode,
} from "./session-store-workspace";
import {
  rebindReadOnlyProjectionToLiveSession,
  updateSessionSummaryInProjectionMap,
} from "./session-store-projections";
import { providerLabel, type SessionProjection } from "./types";

type ProviderChoice = CoreLiveProvider;

type StartSessionOptions = {
  provider?: ProviderChoice;
  cwd?: string;
  title?: string;
  model?: string;
  optionValues?: Record<string, SessionConfigValue>;
  reasoningId?: string;
  modeId?: string;
  liveBackend?: StartSessionRequest["liveBackend"];
  initialInput?: string;
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  onSessionCreated?: (sessionId: string) => void;
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
    options?: {
      preferStoredReplay?: boolean;
      historyReplay?: "include" | "skip";
      confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
    },
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

function historyOnlyRunningMessage(provider: string): string {
  const label = isCoreLiveProvider(provider) ? providerLabel(provider) : provider;
  return `${label} is not a supported running provider. Use Codex, Claude, Gemini, or OpenCode.`;
}

function pruneReadOnlyReplaysForClaimedProviderSession(
  projections: Map<string, SessionProjection>,
  claimedSession: SessionSummary,
): void {
  const providerSessionId = claimedSession.session.providerSessionId;
  if (!providerSessionId) {
    return;
  }
  for (const [sessionId, projection] of projections) {
    if (
      sessionId !== claimedSession.session.id &&
      projection.summary.session.provider === claimedSession.session.provider &&
      projection.summary.session.providerSessionId === providerSessionId &&
      isReadOnlyReplay(projection.summary)
    ) {
      projections.delete(sessionId);
    }
  }
}

export async function startSessionCommand(
  deps: SessionStartupDeps,
  options?: StartSessionOptions,
): Promise<string | null> {
  try {
    const state = deps.get();
    const cwd = options?.cwd?.trim() || state.workspaceDir.trim();
    if (!cwd) {
      deps.set({ error: "Choose a workspace directory first." });
      return null;
    }
    const provider = options?.provider ?? state.newSessionProvider;
    if (!isCoreLiveProvider(provider)) {
      const error = historyOnlyRunningMessage(provider);
      deps.set({ pendingSessionTransition: null, error });
      throw new Error(error);
    }
    if (!(await ensureLaunchWorkspaceAvailable(deps, cwd))) {
      return null;
    }
    deps.set({
      pendingSessionTransition: createPendingStartTransition({
        provider,
        cwd,
        ...(options?.title ? { title: options.title } : {}),
      }),
      error: null,
    });
    const initialInput = options?.initialInput?.trim();
    const liveBackend = options?.liveBackend ?? defaultLiveBackendForProvider(provider);
    const launchInitialPrompt =
      provider === "gemini" &&
      (liveBackend === "tui_mux" || liveBackend === "native_tui") &&
      initialInput
        ? initialInput
        : undefined;
    const response = await api.startSession({
      provider,
      cwd,
      ...(liveBackend ? { liveBackend } : {}),
      title: options?.title ?? `${providerLabel(provider)} session`,
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.optionValues !== undefined ? { optionValues: options.optionValues } : {}),
      ...(options?.reasoningId ? { reasoningId: options.reasoningId } : {}),
      ...(options?.modeId ? { modeId: options.modeId } : {}),
      ...(launchInitialPrompt ? { initialPrompt: launchInitialPrompt } : {}),
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
    options?.onSessionCreated?.(session.session.id);
    if (initialInput && !launchInitialPrompt) {
      await deps.sendInput(session.session.id, initialInput);
    }
    return session.session.id;
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
  options?: { confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean> },
) {
  const state = deps.get();
  const existingRunning = findDaemonRunningSessionForStoredRef(state.projections, ref);
  const mode = resolveHistoryActivationMode({
    existingRunningSummary: existingRunning,
    clientId: state.clientId,
  });
  if (mode === "select" && existingRunning) {
    deps.set({ selectedSessionId: existingRunning.session.id });
    void deps.ensureSessionHistoryLoaded(existingRunning.session.id);
    return;
  }
  if (mode === "attach" && existingRunning) {
    await deps.attachSession(existingRunning);
    return;
  }
  const existingReplay = findDaemonReplaySessionForStoredRef(state.projections, ref);
  if (existingReplay) {
    deps.set({
      selectedSessionId: existingReplay.session.id,
      pendingSessionTransition: null,
      error: null,
    });
    void deps.ensureSessionHistoryLoaded(existingReplay.session.id);
    return;
  }
  await deps.resumeStoredSession(ref, {
    preferStoredReplay: true,
    ...(options?.confirmCreateMissingWorkspace
      ? { confirmCreateMissingWorkspace: options.confirmCreateMissingWorkspace }
      : {}),
  });
}

export async function resumeStoredSessionCommand(
  deps: SessionStartupDeps,
  ref: StoredSessionRef,
  options?: {
    preferStoredReplay?: boolean;
    historyReplay?: "include" | "skip";
    confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  },
) {
  try {
    const preferStoredReplay = options?.preferStoredReplay ?? true;
    const targetDir = ref.cwd ?? ref.rootDir;
    if (!preferStoredReplay && !(await ensureLaunchWorkspaceAvailable(deps, targetDir))) {
      return;
    }
    if (preferStoredReplay) {
      deps.set((current) => {
        let projections = new Map(current.projections);
        const shellProjection = createStoredHistoryReplayProjection(ref);
        let replayProjection = projections.get(shellProjection.summary.session.id);
        if (!replayProjection) {
          projections = deps.adoptExistingProjectionForProviderSession(
            projections,
            shellProjection.summary,
          );
          replayProjection =
            projections.get(shellProjection.summary.session.id) ?? shellProjection;
        }
        const openedState = applyResumedStoredSessionState(
          current,
          shellProjection.summary,
          ref,
          {
            projections,
            replayProjection,
          },
        );
        return {
          ...openedState,
          pendingSessionTransition: null,
          error: null,
        };
      });
    } else {
      deps.set({
        pendingSessionTransition: null,
        error: null,
      });
    }
    if (ref.source === "previous_running") {
      const workspaceVisibilityVersionAtRequest = deps.get().workspaceVisibilityVersion;
      const sessionsResponse = await api.listSessions({ storedSessions: "recent" });
      const running = sessionsResponse.sessions.find(
        (summary) =>
          !isReadOnlyReplay(summary) &&
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
      ...(!preferStoredReplay
        ? (() => {
            const liveBackend = defaultLiveBackendForProvider(ref.provider);
            return liveBackend ? { liveBackend } : {};
          })()
        : {}),
      preferStoredReplay,
      attach: createObserveAttachRequest(deps.get().clientId, deps.get().connectionId),
    };
    if (options?.historyReplay !== undefined) {
      request.historyReplay = options.historyReplay;
    }
    if (targetDir !== undefined) {
      request.cwd = targetDir;
    }
    const response = await api.resumeSession(request);
    deps.set((current) => {
      const next = deps.adoptExistingProjectionForProviderSession(
        new Map(current.projections),
        response.session,
      );
      const replayProjection =
        next.get(response.session.session.id) ?? createEmptySessionProjection(response.session);
      const resumedState = applyResumedStoredSessionState(
        current,
        response.session,
        ref,
        {
          projections: next,
          replayProjection,
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
      const sessionsResponse = await api.listSessions({ storedSessions: "recent" });
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
): Promise<string | null> {
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
  if (!isCoreLiveProvider(ref.provider)) {
    const error = historyOnlyRunningMessage(ref.provider);
    deps.set({ pendingSessionAction: null, pendingSessionTransition: null, error });
    throw new Error(error);
  }

  const preservedProjection: SessionProjection = {
    ...projection,
    summary,
  };
  const applyClaimedSession = (claimedSession: SessionSummary) => {
    deps.set((current) => {
      const next = new Map(current.projections);
      if (next.has(sessionId)) {
        const claimedState = applyClaimedHistorySessionState(
          current,
          claimedSession,
          sessionId,
          preservedProjection,
          ref,
          next,
        );
        pruneReadOnlyReplaysForClaimedProviderSession(
          claimedState.projections ?? next,
          claimedSession,
        );
        return {
          ...claimedState,
          projections: deps.applyEventsToMap(
            claimedState.projections ?? next,
            deps.takePendingEventsForSessions(new Set([claimedSession.session.id])),
          ),
        };
      }
      const existingProjection = next.get(claimedSession.session.id);
      const projectionForClaim = existingProjection ?? preservedProjection;
      next.set(
        claimedSession.session.id,
        isReadOnlyReplay(projectionForClaim.summary)
          ? rebindReadOnlyProjectionToLiveSession(projectionForClaim, claimedSession)
          : {
              ...projectionForClaim,
              summary: claimedSession,
            },
      );
      pruneReadOnlyReplaysForClaimedProviderSession(next, claimedSession);
      return {
        projections: deps.applyEventsToMap(
          next,
          deps.takePendingEventsForSessions(new Set([claimedSession.session.id])),
        ),
        unreadSessionIds: new Set(
          [...current.unreadSessionIds].filter(
            (sessionIdValue) =>
              sessionIdValue !== sessionId &&
              sessionIdValue !== claimedSession.session.id,
          ),
        ),
        selectedSessionId: claimedSession.session.id,
        pendingSessionAction: null,
        pendingSessionTransition: null,
        error: null,
      };
    });
  };
  const updateClaimedSessionSummary = (claimedSession: SessionSummary) => {
    deps.set((current) => ({
      projections: deps.applyEventsToMap(
        updateSessionSummaryInProjectionMap(current.projections, claimedSession),
        deps.takePendingEventsForSessions(new Set([claimedSession.session.id])),
      ),
      selectedSessionId: claimedSession.session.id,
      pendingSessionAction: null,
      pendingSessionTransition: null,
      error: null,
    }));
  };

  const targetDir = ref.cwd ?? ref.rootDir ?? null;
  if (!(await ensureLaunchWorkspaceAvailable(deps, targetDir))) {
    return null;
  }

  try {
    deps.set({
      pendingSessionAction: {
        kind: "claim_history",
        sessionId,
      },
      error: null,
    });
    const request: ResumeSessionRequest = {
      provider: ref.provider,
      providerSessionId: ref.providerSessionId,
      ...(() => {
        const liveBackend = defaultLiveBackendForProvider(ref.provider);
        return liveBackend ? { liveBackend } : {};
      })(),
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
    if (targetDir !== null) {
      request.cwd = targetDir;
    }
    const response = await api.resumeSession(request);
    let session = response.session;
    applyClaimedSession(session);
    try {
      if (
        options?.modeId &&
        session.session.mode?.mutable &&
        session.session.mode.currentModeId !== options.modeId
      ) {
        session = await api.setSessionMode(session.session.id, { modeId: options.modeId });
        updateClaimedSessionSummary(session);
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
        updateClaimedSessionSummary(session);
      }
    } catch (configurationError) {
      deps.set({
        pendingSessionAction: null,
        pendingSessionTransition: null,
        error: `Session was claimed, but updating session controls failed: ${readErrorMessage(configurationError)}`,
      });
    }
    return session.session.id;
  } catch (error) {
    const message = readErrorMessage(error);
    if (message.includes("attach instead of resume")) {
      const sessionsResponse = await api.listSessions({ storedSessions: "recent" });
      const running = sessionsResponse.sessions.find(
        (candidate) =>
          !isReadOnlyReplay(candidate) &&
          candidate.session.provider === ref.provider &&
          candidate.session.providerSessionId === ref.providerSessionId,
      );
      if (running) {
        let attached: SessionSummary;
        try {
          const attachResponse = await api.attachSession(
            running.session.id,
            createInteractiveAttachRequest(deps.get().clientId, deps.get().connectionId),
          );
          attached = attachResponse.session;
        } catch (attachError) {
          deps.set({
            pendingSessionAction: null,
            pendingSessionTransition: null,
            error: readErrorMessage(attachError),
          });
          throw attachError;
        }
        applyClaimedSession(attached);
        return attached.session.id;
      }
    }
    deps.set({
      pendingSessionAction: null,
      pendingSessionTransition: null,
      error: message,
    });
    throw error;
  }
}

async function ensureLaunchWorkspaceAvailable(
  deps: SessionStartupDeps,
  dir: string | null | undefined,
): Promise<boolean> {
  const targetDir = dir?.trim();
  if (!targetDir) {
    return true;
  }
  try {
    await api.listDirectory(targetDir);
    return true;
  } catch (error) {
    if (!isMissingWorkspaceError(error)) {
      throw error;
    }
    const shouldCreate = await deps.confirmCreateMissingWorkspace(targetDir);
    if (!shouldCreate) {
      deps.set({
        pendingSessionAction: null,
        pendingSessionTransition: null,
        error: null,
      });
      return false;
    }
    await api.ensureDirectory({ dir: targetDir });
    return true;
  }
}

function isMissingWorkspaceError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();
  return message.includes("enoent") || message.includes("no such file or directory");
}
